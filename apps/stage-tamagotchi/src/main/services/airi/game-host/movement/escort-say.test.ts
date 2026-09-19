import type { EscortSuggestionChannel } from './escort-say'

import { describe, expect, it } from 'vitest'

import { createEscortSuggestionChannel, ESCORT_SUGGESTION_LIMIT_PER_MINUTE, escortHeadingName, escortSuggestionText } from './escort-say'

/** Local copy of the air-track helper; the channel only needs the clock seam. */
function fakeClock() {
  let clock = 0
  return {
    now: () => clock,
    advance: (ms: number) => { clock += ms },
  }
}

/** A chat bridge double: it records the text, and can reject on demand. */
function fakeSay(shouldFail?: () => boolean) {
  const said: string[] = []
  return {
    said,
    say: async (text: string): Promise<void> => {
      if (shouldFail?.())
        throw new Error('chat bridge unavailable')
      said.push(text)
    },
  }
}

function openChannel(clock: ReturnType<typeof fakeClock>, shouldFail?: () => boolean) {
  const bridge = fakeSay(shouldFail)
  const channel: EscortSuggestionChannel = createEscortSuggestionChannel({ say: bridge.say, now: clock.now })
  return { channel, said: bridge.said }
}

describe('escortSuggestionText (escort D3)', () => {
  it('names the rounded heading and the rounded gap', () => {
    const text = escortSuggestionText({ heading: 274.4, kind: 'hold_heading', gapBlocks: 179.6 })
    expect(text).toContain('yaw 274°')
    expect(text).toContain(escortHeadingName(274))
    expect(text).toContain('180 格')
    // One line, spoken in chat: the design caps the message well below 120.
    expect(text).not.toContain('\n')
    expect(text.length).toBeLessThan(120)
  })

  it('asks for a different thing per kind while keeping the heading', () => {
    const hold = escortSuggestionText({ heading: -90, kind: 'hold_heading', gapBlocks: 180 })
    const slow = escortSuggestionText({ heading: -90, kind: 'slow_down', gapBlocks: 180 })
    expect(hold).not.toBe(slow)
    expect(hold).toContain('保持当前航向')
    expect(slow).toContain('降速')
    expect(slow).toContain(escortHeadingName(-90))
  })

  it('reads the heading the way Minecraft yaw counts', () => {
    expect(escortHeadingName(0)).toBe('南')
    expect(escortHeadingName(-90)).toBe('东')
    expect(escortHeadingName(90)).toBe('西')
    expect(escortHeadingName(180)).toBe('北')
  })
})

describe('escort suggestion channel (escort D3)', () => {
  it('sends the first suggestion and counts it', async () => {
    const clock = fakeClock()
    const { channel, said } = openChannel(clock)
    const outcome = await channel.send({ heading: 274, kind: 'hold_heading', gapBlocks: 180 })
    expect(outcome).toBe('sent')
    expect(channel.sentCount()).toBe(1)
    expect(said).toEqual([escortSuggestionText({ heading: 274, kind: 'hold_heading', gapBlocks: 180 })])
    expect(channel.lastText()).toBe(said[0])
  })

  it('reports an identical follow-up as unchanged and does not repeat it', async () => {
    const clock = fakeClock()
    const { channel, said } = openChannel(clock)
    const suggestion = { heading: 274, kind: 'hold_heading', gapBlocks: 180 } as const
    expect(await channel.send(suggestion)).toBe('sent')
    clock.advance(30_000)
    expect(await channel.send(suggestion)).toBe('unchanged')
    expect(said).toHaveLength(1)
    expect(channel.sentCount()).toBe(1)
  })

  it('rate limits a changed suggestion until the window slides past a minute', async () => {
    const clock = fakeClock()
    const { channel, said } = openChannel(clock)
    expect(await channel.send({ heading: 0, kind: 'hold_heading', gapBlocks: 200 })).toBe('sent')
    clock.advance(10_000)
    expect(await channel.send({ heading: 0, kind: 'slow_down', gapBlocks: 200 })).toBe('sent')
    expect(channel.sentCount()).toBe(ESCORT_SUGGESTION_LIMIT_PER_MINUTE)

    // A third, different ask inside the minute is refused before `say` is called.
    clock.advance(10_000)
    expect(await channel.send({ heading: 0, kind: 'slow_down', gapBlocks: 150 })).toBe('rate_limited')
    expect(said).toHaveLength(2)
    expect(channel.sentCount()).toBe(2)

    // The window is 60 s: at 61 s only the send at 10 s is still inside it.
    clock.advance(41_000)
    expect(await channel.send({ heading: 0, kind: 'slow_down', gapBlocks: 150 })).toBe('sent')
    // `sentCount` is the command's lifetime total, not the live window: the
    // first message slid out of the window but it was still said.
    expect(channel.sentCount()).toBe(3)
    expect(said).toHaveLength(3)
  })

  it('keeps the window full until a whole minute has passed', async () => {
    const clock = fakeClock()
    const { channel } = openChannel(clock)
    expect(await channel.send({ heading: 0, kind: 'hold_heading', gapBlocks: 200 })).toBe('sent')
    clock.advance(10_000)
    expect(await channel.send({ heading: 0, kind: 'slow_down', gapBlocks: 200 })).toBe('sent')
    // 59 999 ms after the first send the window is still full.
    clock.advance(49_999)
    expect(await channel.send({ heading: 45, kind: 'slow_down', gapBlocks: 100 })).toBe('rate_limited')
    clock.advance(1)
    expect(await channel.send({ heading: 45, kind: 'slow_down', gapBlocks: 100 })).toBe('sent')
  })

  it('reports closed after close and says nothing more', async () => {
    const clock = fakeClock()
    const { channel, said } = openChannel(clock)
    channel.close()
    expect(await channel.send({ heading: 120, kind: 'slow_down', gapBlocks: 90 })).toBe('closed')
    expect(said).toEqual([])
    expect(channel.sentCount()).toBe(0)
    expect(channel.lastText()).toBeUndefined()
  })

  it('reports a rejected say as failed without spending budget or counting it', async () => {
    const clock = fakeClock()
    let failing = true
    const { channel, said } = openChannel(clock, () => failing)
    expect(await channel.send({ heading: 274, kind: 'hold_heading', gapBlocks: 180 })).toBe('failed')
    expect(channel.sentCount()).toBe(0)
    expect(channel.lastText()).toBeUndefined()

    // Nothing was said, so the two-per-minute window is still fully available.
    failing = false
    expect(await channel.send({ heading: 274, kind: 'hold_heading', gapBlocks: 180 })).toBe('sent')
    expect(await channel.send({ heading: 274, kind: 'slow_down', gapBlocks: 180 })).toBe('sent')
    expect(channel.sentCount()).toBe(2)
    expect(said).toHaveLength(2)
  })
})
