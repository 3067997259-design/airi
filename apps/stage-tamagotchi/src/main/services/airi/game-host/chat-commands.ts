/**
 * MC-3c X-10: MC chat trigger policy (pure).
 *
 * Chat on a server is untrusted input. Delivery follows three tiers: admins
 * deliver every message (a leading `\` opts out), the blocklist delivers
 * nothing and stays out of the context, and everyone else delivers on a
 * mention or on a sampled fraction of unaddressed messages. The trigger
 * decision lives here so the poller stays thin and tests can inject
 * randomness.
 */
import type { GameHostChatCommandConfig, GameHostChatContextLine, GameHostChatTrigger } from '../../../../shared/eventa'

/** Ignore mention and sampled deliveries that arrive closer together than this. */
export const CHAT_COMMAND_MIN_INTERVAL_MS = 2_000

/** Recent chat lines the main process keeps for delivery context. */
export const CHAT_CONTEXT_BUFFER_LINES = 20

/** Per-line context cap; longer lines are truncated for prompt safety. */
export const CHAT_CONTEXT_LINE_MAX_CHARS = 200

export interface GameHostChatEvent {
  id: number
  sender: string
  senderUuid: string
  text: string
}

/** Local player identity used to drop the own chat echo. */
export interface ChatSelfIdentity {
  uuid?: string
}

export type ChatCommandVerdict
  = | { eligible: true, trigger: GameHostChatTrigger, text: string }
    | { eligible: false, reason: 'disabled' | 'malformed' | 'self' | 'blocked' | 'escaped' | 'no-trigger' }

/** Normalizes the persisted chat-command config; missing fields are safe defaults. */
export function parseChatCommandsConfig(raw: unknown): GameHostChatCommandConfig | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return undefined
  const record = raw as Record<string, unknown>
  return {
    enabled: record.enabled === true,
    admins: normalizeNames(record.admins),
    blocked: normalizeNames(record.blocked),
    mentionlessSampleRate: normalizeSampleRate(record.mentionlessSampleRate),
    contextLines: normalizeContextLines(record.contextLines),
  }
}

function normalizeNames(raw: unknown): string[] {
  if (!Array.isArray(raw))
    return []
  const seen = new Set<string>()
  const names: string[] = []
  for (const entry of raw) {
    if (typeof entry !== 'string')
      continue
    const name = entry.trim()
    if (!name || seen.has(name.toLowerCase()))
      continue
    seen.add(name.toLowerCase())
    names.push(name)
  }
  return names
}

function normalizeSampleRate(raw: unknown): number {
  const value = Number(raw)
  if (!Number.isFinite(value))
    return 0.2
  return Math.min(Math.max(value, 0), 1)
}

function normalizeContextLines(raw: unknown): number {
  const value = Number(raw)
  if (!Number.isFinite(value))
    return 5
  return Math.min(Math.max(Math.round(value), 0), 20)
}

/**
 * Normalizes one bridge event into a chat line.
 *
 * The client bridge reports `{ text, sender, uuid? }`; the dedicated-server
 * bridge reports `{ text, player, uuid }`. Both shapes carry the same facts,
 * so callers see one shape.
 */
export function chatEventOf(entry: unknown): GameHostChatEvent | undefined {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry))
    return undefined
  const event = entry as Record<string, unknown>
  // `type` keeps system and other event kinds out even when a caller does not
  // filter server-side.
  if (event.type !== 'chat')
    return undefined
  const data = event.data && typeof event.data === 'object' && !Array.isArray(event.data)
    ? event.data as Record<string, unknown>
    : undefined
  const id = Number(event.id)
  if (!Number.isFinite(id) || !data)
    return undefined
  // The client shape uses `sender`; the dedicated-server shape uses `player`.
  let sender: string | undefined
  if (typeof data.sender === 'string' && data.sender.trim())
    sender = data.sender
  else if (typeof data.player === 'string' && data.player.trim())
    sender = data.player
  if (!sender || typeof data.text !== 'string')
    return undefined
  // The client-rendered chat carries a "<sender> " prefix; the command text
  // is what follows it.
  const prefix = `<${sender}>`
  const text = data.text.startsWith(prefix) ? data.text.slice(prefix.length).trimStart() : data.text
  return {
    id,
    sender,
    senderUuid: typeof data.uuid === 'string' ? data.uuid : '',
    text,
  }
}

/** Extracts chat events and the bus cursor from an `events.getRecent` result. */
/**
 * Cursor policy for the chat event ring.
 *
 * The client mod's event ring restarts with the game client, so its ids can
 * fall below the last seen cursor. A cursor ahead of every new id goes
 * permanently deaf (live 2026-09-14: ring max 8 while the cursor sat at 32),
 * so a backwards `lastId` counts as a new ring and the cursor reseeds to zero.
 *
 * @example
 * nextChatCursor(32, 8)
 * // => 0
 */
export function nextChatCursor(cursor: number, lastId: number | undefined): number {
  if (lastId === undefined)
    return cursor
  if (lastId < cursor)
    return 0
  return Math.max(cursor, lastId)
}

export function chatCommandEventsOf(record: Record<string, unknown> | undefined): { events: GameHostChatEvent[], lastId?: number } {
  const events: GameHostChatEvent[] = []
  if (Array.isArray(record?.events)) {
    for (const entry of record.events) {
      const event = chatEventOf(entry)
      if (event)
        events.push(event)
    }
  }
  const lastId = Number(record?.lastId)
  return { events, ...(Number.isFinite(lastId) ? { lastId } : {}) }
}

/**
 * Decides whether one chat event is delivered and with which trigger.
 *
 * @example
 * classifyChatEvent({ id: 1, sender: 'Steve', senderUuid: 'u', text: 'AIRI 过来' }, config, {}, () => 0.5)
 * // => { eligible: true, trigger: 'mention', text: 'AIRI 过来' }
 */
export function classifyChatEvent(
  event: GameHostChatEvent,
  config: GameHostChatCommandConfig | undefined,
  self: ChatSelfIdentity = {},
  random: () => number = Math.random,
): ChatCommandVerdict {
  if (!config?.enabled)
    return { eligible: false, reason: 'disabled' }
  if (!event.sender || !event.text.trim())
    return { eligible: false, reason: 'malformed' }
  if (self.uuid && event.senderUuid && event.senderUuid === self.uuid)
    return { eligible: false, reason: 'self' }
  if (isListed(config.blocked, event.sender))
    return { eligible: false, reason: 'blocked' }
  if (isListed(config.admins, event.sender)) {
    if (event.text.startsWith('\\'))
      return { eligible: false, reason: 'escaped' }
    return { eligible: true, trigger: 'admin', text: event.text }
  }
  if (event.text.toLowerCase().includes('airi'))
    return { eligible: true, trigger: 'mention', text: event.text }
  if (random() < config.mentionlessSampleRate)
    return { eligible: true, trigger: 'mentionless-sample', text: event.text }
  return { eligible: false, reason: 'no-trigger' }
}

/**
 * True when a chat line may enter the context buffer. The blocklist and the
 * own echo stay out of every delivered message's context.
 */
export function isContextEligible(
  event: GameHostChatEvent,
  config: GameHostChatCommandConfig | undefined,
  self: ChatSelfIdentity = {},
): boolean {
  if (!event.sender || !event.text.trim())
    return false
  if (self.uuid && event.senderUuid && event.senderUuid === self.uuid)
    return false
  if (isListed(config?.blocked ?? [], event.sender))
    return false
  return true
}

/**
 * Returns the delivery context: the most recent buffered lines, capped in
 * count and per line.
 */
export function chatContextOf(buffer: GameHostChatContextLine[], contextLines: number): GameHostChatContextLine[] {
  // `slice(-0)` copies the whole array, so guard the empty window explicitly.
  const count = Math.max(0, Math.floor(contextLines))
  if (count === 0)
    return []
  const lines = buffer.slice(-count)
  return lines.map(line => ({ sender: line.sender, text: line.text.slice(0, CHAT_CONTEXT_LINE_MAX_CHARS) }))
}

function isListed(names: string[], sender: string): boolean {
  return names.some(name => name.toLowerCase() === sender.toLowerCase())
}
