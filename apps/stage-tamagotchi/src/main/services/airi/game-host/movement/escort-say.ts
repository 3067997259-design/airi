/** What the escort asks the target's pilot to do (escort design D3). */
export type EscortSuggestionKind = 'hold_heading' | 'slow_down'

/** Rate limit from the design: two suggestions per minute. */
export const ESCORT_SUGGESTION_LIMIT_PER_MINUTE = 2

/** Sliding window the limit is measured over. */
const ESCORT_SUGGESTION_WINDOW_MS = 60_000

/**
 * Human name for a Minecraft yaw, 16 points so the ask is not coarse.
 *
 * Minecraft yaw grows clockwise from south: 0 = south, -90 = east, 90 = west,
 * ±180 = north. Each name covers a 22.5° sector centered on its direction.
 *
 * @example
 * escortHeadingName(274)
 * // => '东偏北'
 */
export function escortHeadingName(yaw: number): string {
  const sectors = ['南', '南偏西', '西南', '西偏南', '西', '西偏北', '西北', '北偏西', '北', '北偏东', '东北', '东偏北', '东', '东偏南', '东南', '南偏东']
  const normalized = ((yaw % 360) + 360) % 360
  return sectors[Math.round(normalized / 22.5) % 16]
}

/**
 * Composes one cooperative suggestion.
 *
 * Contains the target's current heading and what is expected of the pilot. The
 * kinds read differently on purpose: `hold_heading` asks the pilot to keep the
 * heading, `slow_down` asks for less speed, because a chase that stalls while
 * the target already flies straight needs the speed answered, not the turn.
 *
 * One line, no newline, under ~120 characters: the text is spoken in game chat.
 */
export function escortSuggestionText(input: {
  /** The target's heading in Minecraft yaw degrees (0 = south, -90 = east). */
  heading: number
  kind: EscortSuggestionKind
  /** Current horizontal gap to the target, in blocks; used to make the ask concrete. */
  gapBlocks: number
}): string {
  const heading = Math.round(input.heading)
  const gapBlocks = Math.max(0, Math.round(input.gapBlocks))
  const headingPart = `yaw ${heading}°，${escortHeadingName(heading)}`
  const ask = input.kind === 'hold_heading'
    ? `请保持当前航向（${headingPart}），稳定飞一段`
    : `请收油降速（当前航向 ${headingPart}），我快跟不上了`
  return `${ask}，我还差 ${gapBlocks} 格`
}

export interface EscortSuggestionChannel {
  /** Sends one suggestion unless the rate limit, the dedupe or the close blocks it. */
  send: (input: { heading: number, kind: EscortSuggestionKind, gapBlocks: number }) => Promise<EscortSuggestionOutcome>
  /** Closes the channel: every later send reports `closed`. */
  close: () => void
  /** How many messages actually left the application. */
  sentCount: () => number
  /** The last text that was sent, for the receipt. */
  lastText: () => string | undefined
}

export type EscortSuggestionOutcome = 'sent' | 'rate_limited' | 'unchanged' | 'closed' | 'failed'

/**
 * Creates the suggestion channel one follow command holds (escort design D3).
 *
 * The channel owns the two rules that keep the ask from becoming chat spam: at
 * most two messages per minute, and never the same text twice in a row. It is
 * also the whole of the chat surface — the caller injects `say`, so this module
 * never talks to the game, and the caller's receipt only counts a message that
 * actually left the application.
 *
 * Only a message that actually left the application consumes budget: a rejection
 * from `say` is reported as `failed` and leaves the window untouched, so a broken
 * chat bridge cannot spend the command's two asks per minute.
 *
 * @example
 * const channel = createEscortSuggestionChannel({ say: text => game.chat(text), now: Date.now })
 * await channel.send({ heading: 274, kind: 'hold_heading', gapBlocks: 180 })
 * // => 'sent'
 */
export function createEscortSuggestionChannel(options: {
  say: (text: string) => Promise<void>
  now: () => number
  limitPerMinute?: number
}): EscortSuggestionChannel {
  const limit = options.limitPerMinute ?? ESCORT_SUGGESTION_LIMIT_PER_MINUTE
  /** Send timestamps inside the sliding window; one entry per message that left. */
  let sentAt: number[] = []
  /**
   * Messages sent over the channel's whole life. The receipt reports this, so
   * it must not be read off `sentAt`: pruning the window drops old timestamps,
   * and a pruned window would understate what the command already asked for.
   */
  let sentTotal = 0
  let lastSentText: string | undefined
  let closed = false

  function prune(now: number): void {
    sentAt = sentAt.filter(at => now - at < ESCORT_SUGGESTION_WINDOW_MS)
  }

  return {
    send: async (input) => {
      if (closed)
        return 'closed'
      const now = options.now()
      prune(now)
      if (sentAt.length >= limit)
        return 'rate_limited'
      const text = escortSuggestionText(input)
      if (text === lastSentText)
        return 'unchanged'
      try {
        await options.say(text)
      }
      catch {
        // The chat bridge rejected the message, so nothing was said. The
        // channel answers with `failed` instead of throwing: a broken chat
        // surface must not abort the chase, and it must not consume the
        // command's rate-limit budget either.
        return 'failed'
      }
      sentAt.push(now)
      sentTotal += 1
      lastSentText = text
      return 'sent'
    },
    close: () => {
      closed = true
    },
    sentCount: () => sentTotal,
    lastText: () => lastSentText,
  }
}
