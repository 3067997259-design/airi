import type { JournalEvent } from './types'

import { describe, expect, it } from 'vitest'

import { createArchivePointer, DEFAULT_ARCHIVE_THRESHOLD_BYTES, estimateJournalBytes, shouldArchiveJournal } from './archive'
import { createJournalStore, journalToJSONL } from './store'
import { createBranch, createBranchStore, deserializeBranch, serializeBranch } from './tree'

function header(sessionId = 's1'): JournalEvent {
  return { type: 'session/header', seq: 0, sessionId, createdAt: 1, delegationDepth: 0 }
}

describe('journal tree', () => {
  it('forks at a seq, keeping the parent prefix and adding one fork/point', () => {
    const store = createJournalStore('s1')
    store.append({ type: 'session/header', sessionId: 's1', createdAt: 1, delegationDepth: 0 })
    store.append({ type: 'user/message', text: 'try variant A', timestamp: 1 })

    const branch = createBranch(store.readAll(), 1, { branchId: 'fork-a' })
    expect(branch.parentSeq).toBe(1)
    expect(branch.events.map(event => event.type)).toEqual(['session/header', 'user/message', 'fork/point'])
    expect(branch.forkEvent.parentSeq).toBe(1)
  })

  it('continues seq from the fork point on the branch store', () => {
    const store = createJournalStore('s1')
    store.append({ type: 'session/header', sessionId: 's1', createdAt: 1, delegationDepth: 0 })
    store.append({ type: 'user/message', text: 'try variant A', timestamp: 1 })
    const branch = createBranch(store.readAll(), 1, { branchId: 'fork-a' })

    const branchStore = createBranchStore(branch)
    expect(branchStore.sessionId).toBe('fork-a')
    // The branch carries the fork/point event at seq 2, so the next append
    // continues at seq 3.
    const next = branchStore.append({ type: 'tool/call', toolName: 'read', args: { path: 'x' } })
    expect(next.seq).toBe(3)
    expect(branchStore.readAll().map(event => event.seq)).toEqual([0, 1, 2, 3])
  })

  it('leaves the parent untouched and rejects out-of-range forks', () => {
    const store = createJournalStore('s1')
    store.append({ type: 'session/header', sessionId: 's1', createdAt: 1, delegationDepth: 0 })
    createBranch(store.readAll(), 0, { branchId: 'fork-x' })
    expect(store.readAll()).toHaveLength(1)
    expect(() => createBranch(store.readAll(), 5)).toThrow(/cannot fork/)
  })

  it('round-trips a branch through JSONL', () => {
    const store = createJournalStore('s1')
    store.append({ type: 'session/header', sessionId: 's1', createdAt: 1, delegationDepth: 0 })
    store.append({ type: 'user/message', text: 'watch CI', timestamp: 1 })
    const branch = createBranch(store.readAll(), 1, { branchId: 'ci-watch' })

    const restored = deserializeBranch(serializeBranch(branch))
    expect(restored).not.toBeNull()
    expect(restored?.branchId).toBe('ci-watch')
    expect(restored?.events).toEqual(branch.events)
  })

  it('returns null for payloads without a fork/point', () => {
    expect(deserializeBranch(journalToJSONL([header('s1')]))).toBeNull()
    expect(deserializeBranch('not json at all')).toBeNull()
  })
})

describe('journal archive', () => {
  it('never archives an open session', () => {
    const events: JournalEvent[] = [header('s1'), { type: 'user/message', seq: 1, text: 'x', timestamp: 1 }]
    const decision = shouldArchiveJournal(events)
    expect(decision.shouldArchive).toBe(false)
    expect(decision.reason).toBe('open_session')
  })

  it('archives only closed sessions over the threshold', () => {
    const small: JournalEvent[] = [header('s1'), { type: 'user/message', seq: 1, text: 'x', timestamp: 1 }]
    expect(shouldArchiveJournal(small, { sessionClosed: true }).shouldArchive).toBe(false)
    expect(shouldArchiveJournal(small, { sessionClosed: true }).reason).toBe('under_threshold')

    const big: JournalEvent[] = Array.from({ length: 10 }, (_, i): JournalEvent => ({ type: 'tool/result', seq: i + 1, toolName: 'bash', ok: true, summary: 'x'.repeat(1000) }))
    const decision = shouldArchiveJournal([header('s1'), ...big], { sessionClosed: true, thresholdBytes: 1024 })
    expect(decision.shouldArchive).toBe(true)
    expect(decision.reason).toBe('over_threshold')
  })

  it('estimates serialized bytes consistently with JSONL', () => {
    const events: JournalEvent[] = [header('s1'), { type: 'user/message', seq: 1, text: 'hi', timestamp: 1 }]
    const estimate = estimateJournalBytes(events)
    expect(estimate).toBe(journalToJSONL(events).length + 1)
    expect(DEFAULT_ARCHIVE_THRESHOLD_BYTES).toBe(10 * 1024 * 1024)
  })

  it('builds a pointer payload without requiring the seq', () => {
    const pointer = createArchivePointer({ archivePath: '/archive/s1.jsonl', startSeq: 0, endSeq: 99, byteLength: 12_345, archivedAt: 7 })
    expect(pointer).toEqual({
      type: 'archived/pointer',
      archivePath: '/archive/s1.jsonl',
      startSeq: 0,
      endSeq: 99,
      archivedAt: 7,
      byteLength: 12_345,
    })
  })
})
