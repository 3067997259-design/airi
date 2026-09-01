import type { JournalEvent } from '@proj-airi/core-agent'

import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { installJournalPersistence, useJournalStore } from './journal'

const port = {
  append: vi.fn(async () => {}),
  read: vi.fn(async () => ({ lines: [] as string[], truncated: false })),
}

describe('journal persistence', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    port.append.mockClear()
    port.read.mockClear()
    installJournalPersistence(port)
  })

  afterEach(() => {
    installJournalPersistence(undefined)
  })

  it('mirrors appended events to the durable owner in one batch per tick', async () => {
    const store = useJournalStore()
    store.append('session-a', { type: 'user/message', text: 'first' })
    store.append('session-a', { type: 'user/message', text: 'second' })

    // Batched: a tool loop appends many events, and one write per event would
    // make the loop disk-bound (HARNESS-PLAN §9.1).
    expect(port.append).not.toHaveBeenCalled()
    await Promise.resolve()
    await Promise.resolve()

    expect(port.append).toHaveBeenCalledTimes(1)
    const [sessionId, lines] = port.append.mock.calls[0] as unknown as [string, string[]]
    expect(sessionId).toBe('session-a')
    // The session header is created by ensureSession on every load, so only
    // the two real events are mirrored.
    expect(lines).toHaveLength(2)
  })

  it('replays a persisted session into memory without its old header', async () => {
    const persisted: JournalEvent[] = [
      { type: 'session/header', seq: 1, sessionId: 'session-b', createdAt: 1, delegationDepth: 0 },
      { type: 'user/message', seq: 2, text: 'restored question' },
      { type: 'tool/result', seq: 3, toolName: 'read', ok: true, summary: 'restored evidence' },
    ]
    port.read.mockResolvedValueOnce({ lines: persisted.map(event => JSON.stringify(event)), truncated: false })

    const store = useJournalStore()
    const replayed = await store.hydrate('session-b')

    expect(replayed).toBe(2)
    expect(store.events.filter(event => event.type === 'session/header')).toHaveLength(1)
    expect(store.toolEvidence.map(event => event.summary)).toEqual(['restored evidence'])
  })

  it('skips a corrupt line instead of losing the whole history', async () => {
    port.read.mockResolvedValueOnce({
      lines: ['{"type":"user/message","seq":2,"text":"kept"}', 'not json at all'],
      truncated: false,
    })

    const store = useJournalStore()
    const replayed = await store.hydrate('session-c')

    expect(replayed).toBe(1)
  })

  it('keeps working when the durable owner fails', async () => {
    port.append.mockRejectedValueOnce(new Error('disk is full'))
    const store = useJournalStore()

    store.append('session-d', { type: 'user/message', text: 'still here' })
    await Promise.resolve()
    await Promise.resolve()

    expect(store.events.some(event => event.type === 'user/message')).toBe(true)
  })
})
