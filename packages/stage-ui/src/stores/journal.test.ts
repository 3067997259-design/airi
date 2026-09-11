import type { JournalEvent } from '@proj-airi/core-agent'

import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { installJournalPersistence, useJournalStore } from './journal'

const port = {
  append: vi.fn<(sessionId: string, lines: string[]) => Promise<void>>(async () => {}),
  read: vi.fn<(sessionId: string) => Promise<{ lines: string[], truncated: boolean, lastSeq: number, gaps: number[], corruptLines: number, duplicateLines: number }>>(async () => ({ lines: [], truncated: false, lastSeq: -1, gaps: [], corruptLines: 0, duplicateLines: 0 })),
}

function headerLine(sessionId: string): string {
  return JSON.stringify({ type: 'session/header', seq: 0, sessionId, createdAt: 1, delegationDepth: 0 })
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
    store.append('session-a', { type: 'user/message', text: 'first', timestamp: 1 })
    store.append('session-a', { type: 'user/message', text: 'second', timestamp: 2 })

    // Batched: a tool loop appends many events, and one write per event would
    // make the loop disk-bound (HARNESS-PLAN §9.1).
    expect(port.append).not.toHaveBeenCalled()
    await Promise.resolve()
    await Promise.resolve()

    expect(port.append).toHaveBeenCalledTimes(1)
    const [sessionId, lines] = port.append.mock.calls[0] as unknown as [string, string[]]
    expect(sessionId).toBe('session-a')
    // The header is mirrored too, so a replayed file is self-contained.
    expect(lines).toHaveLength(3)
    const parsed = lines.map(line => JSON.parse(line) as JournalEvent)
    expect(parsed[0]?.type).toBe('session/header')
    expect(parsed[0]?.seq).toBe(0)
    expect(parsed[1]?.seq).toBe(1)
    expect(parsed[2]?.seq).toBe(2)
  })

  it('stamps activity events with a wall-clock time', () => {
    // The social consideration boundary ages tool/result and plan/update
    // candidates; without a recorded time a stale activity could pose as new
    // (ACC-20260910 S18).
    const store = useJournalStore()
    const record = store.append('session-stamped', { type: 'tool/result', toolName: 'read', ok: true, summary: 'ok' })
    expect(record.type).toBe('tool/result')
    if (record.type !== 'tool/result')
      throw new Error('expected a tool/result record')
    expect(typeof record.timestamp).toBe('number')
    expect(record.timestamp).toBeGreaterThan(0)
  })

  it('flushes events queued while the previous batch is in flight', async () => {
    // ROOT CAUSE:
    //
    // If a journal event arrives while the host is writing the current
    // per-session batch, the event stays in the queue after the first batch
    // succeeds. The old flush stopped after releasing the session lock, so
    // that tail was not written until an unrelated append or retry.
    //
    // We fixed this by scheduling another flush after a successful write when
    // the same session still has queued lines.
    let releaseFirstAppend!: () => void
    const firstAppend = new Promise<void>((resolve) => {
      releaseFirstAppend = resolve
    })
    port.append.mockImplementationOnce(async () => {
      await firstAppend
    })

    const store = useJournalStore()
    store.append('session-in-flight', { type: 'user/message', text: 'first', timestamp: 1 })
    await vi.waitFor(() => expect(port.append).toHaveBeenCalledTimes(1))

    store.append('session-in-flight', { type: 'user/message', text: 'second', timestamp: 2 })
    expect(store.persistenceStatus.pendingCount).toBe(3)

    releaseFirstAppend()
    await vi.waitFor(() => expect(port.append).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(store.persistenceStatus.pendingCount).toBe(0))

    const [, secondLines] = port.append.mock.calls[1] as unknown as [string, string[]]
    expect(secondLines.map(line => (JSON.parse(line) as JournalEvent).seq)).toEqual([2])
  })

  it('replays a persisted session with its event identity intact', async () => {
    const persisted: JournalEvent[] = [
      { type: 'session/header', seq: 0, sessionId: 'session-b', createdAt: 1, delegationDepth: 0 },
      { type: 'user/message', seq: 1, text: 'restored question', timestamp: 2 },
      { type: 'tool/result', seq: 2, toolName: 'read', ok: true, summary: 'restored evidence' },
    ]
    port.read.mockResolvedValueOnce({
      lines: persisted.map(event => JSON.stringify(event)),
      truncated: false,
      lastSeq: 2,
      gaps: [],
      corruptLines: 0,
      duplicateLines: 0,
    })

    const store = useJournalStore()
    const replayed = await store.hydrate('session-b')

    expect(replayed).toBe(2)
    expect(store.events.filter(event => event.type === 'session/header')).toHaveLength(1)
    // Identity survives the replay: seqs are the ones the file carries, not a
    // fresh renumbering, so evidence refs and decision watermarks stay valid.
    expect(store.events.map(event => event.seq)).toEqual([0, 1, 2])
    expect(store.toolEvidence.map(event => event.summary)).toEqual(['restored evidence'])
    expect(store.persistenceStatus.complete).toBe(true)
  })

  it('does not wedge a replayed session behind a header queued before the read', async () => {
    // ROOT CAUSE:
    //
    // Hydrate created the session store before reading the file, and a fresh
    // store queues its own `session/header` at seq 0. On a restored profile
    // the file already owns seq 0, so the durable owner rejected that line and
    // kept rejecting it on every retry; all later events of that session
    // stayed in memory with `complete: false` (R04-adoption, live 2026-09-11).
    //
    // We fixed this by reading the file before any store exists, seeding the
    // store from the file, and dropping the redundant queued header.
    const persisted: JournalEvent[] = [
      { type: 'session/header', seq: 0, sessionId: 'session-file', createdAt: 1, delegationDepth: 0 },
      { type: 'user/message', seq: 1, text: 'persisted question', timestamp: 2 },
    ]
    port.read.mockResolvedValueOnce({
      lines: persisted.map(event => JSON.stringify(event)),
      truncated: false,
      lastSeq: 1,
      gaps: [],
      corruptLines: 0,
      duplicateLines: 0,
    })

    // The durable owner compares seq fingerprints, exactly like the journal
    // host: the same seq with different content is a conflict, not a retry.
    const fingerprints = new Map<number, string>()
    fingerprints.set(0, JSON.stringify(persisted[0]))
    port.append.mockImplementation(async (_sessionId: string, lines: string[]) => {
      for (const line of lines) {
        const seq = (JSON.parse(line) as JournalEvent).seq
        const existing = fingerprints.get(seq)
        if (existing !== undefined && existing !== line)
          throw new Error(`journal sequence conflict at seq ${seq}`)
        fingerprints.set(seq, line)
      }
    })

    const store = useJournalStore()
    // A projection asks for the session before anything replays it, which is
    // what the restore path does while the session list loads.
    store.ensureSession('session-file')
    await store.flushNow()
    expect(store.persistenceStatus.lastError).toContain('sequence conflict')

    const replayed = await store.hydrate('session-file')
    expect(replayed).toBe(1)

    store.append('session-file', { type: 'user/message', text: 'after restore', timestamp: 3 })
    await store.flushNow()

    // The session's own events keep reaching disk after the replay instead of
    // stopping behind the rejected header.
    expect(store.events.map(event => event.seq)).toEqual([0, 1, 2])
    expect(store.persistenceStatus).toMatchObject({ pendingCount: 0, lastError: undefined, complete: true })
    expect(fingerprints.get(2)).toContain('after restore')
  })

  it('synthesizes a sequenced header for a legacy replay without one', async () => {
    // ROOT CAUSE:
    //
    // Older journal files begin at seq 1 because the header was not persisted.
    // The replay path synthesized a header without seq, so createJournalStore
    // rejected the otherwise contiguous file during every application restart.
    //
    // We fixed this by giving the synthetic header the seq 0 identity that the
    // store requires, while leaving the persisted events unchanged.
    const persisted: JournalEvent[] = [
      { type: 'user/message', seq: 1, text: 'legacy event', timestamp: 2 },
      { type: 'tool/result', seq: 2, toolName: 'read', ok: true, summary: 'legacy evidence' },
    ]
    port.read.mockResolvedValueOnce({
      lines: persisted.map(event => JSON.stringify(event)),
      truncated: false,
      lastSeq: 2,
      gaps: [],
      corruptLines: 0,
      duplicateLines: 0,
    })

    const store = useJournalStore()
    const replayed = await store.hydrate('session-legacy')

    expect(replayed).toBe(2)
    expect(store.events.map(event => event.seq)).toEqual([0, 1, 2])
    expect(store.toolEvidence.map(event => event.summary)).toEqual(['legacy evidence'])
    expect(store.persistenceStatus.identityBrokenFrom).toBeUndefined()
  })

  it('ages replayed activity events by the timestamps of their own turn', async () => {
    // ROOT CAUSE:
    //
    // Activity events contractually carry no timestamp, and only the append
    // path stamps new ones. Files written before that stamping therefore held
    // `tool/result` and `plan/update` records with none, so the social
    // consideration boundary read `occurredAt` as undefined, never expired
    // them, and an eight-hour-old tool result reached the model as if it had
    // just happened (ACC-20260910 S18 follow-up).
    //
    // The replay now gives each unstamped activity event the closest wall
    // clock its turn recorded. An activity event with no timestamp on either
    // side stays untouched: filling in `Date.now()` would recreate the bug.
    const persisted: JournalEvent[] = [
      { type: 'session/header', seq: 0, sessionId: 'session-activity', createdAt: 1, delegationDepth: 0 },
      { type: 'user/message', seq: 1, text: 'do the thing', timestamp: 1_000 },
      { type: 'tool/result', seq: 2, toolName: 'read', ok: true, summary: 'read evidence' },
      { type: 'plan/update', seq: 3, planId: 'plan-1', status: 'in_progress' },
      { type: 'user/message', seq: 4, text: 'still waiting', timestamp: 2_000 },
      { type: 'tool/result', seq: 5, toolName: 'write', ok: true, summary: 'write evidence' },
    ]
    port.read.mockResolvedValueOnce({
      lines: persisted.map(event => JSON.stringify(event)),
      truncated: false,
      lastSeq: 5,
      gaps: [],
      corruptLines: 0,
      duplicateLines: 0,
    })

    const store = useJournalStore()
    await store.hydrate('session-activity')

    const timestampOf = (seq: number) => {
      const event = store.events.find(candidate => candidate.seq === seq)
      return event && 'timestamp' in event ? event.timestamp : undefined
    }
    expect(timestampOf(2)).toBe(1_000)
    expect(timestampOf(3)).toBe(1_000)
    expect(timestampOf(5)).toBe(2_000)
    // Events that already carried an age keep it.
    expect(timestampOf(1)).toBe(1_000)
    expect(timestampOf(4)).toBe(2_000)
  })

  it('leaves an activity event without any neighbouring timestamp unaged', async () => {
    const persisted: JournalEvent[] = [
      { type: 'session/header', seq: 0, sessionId: 'session-bare', createdAt: 1, delegationDepth: 0 },
      { type: 'tool/result', seq: 1, toolName: 'read', ok: true, summary: 'evidence without a clock' },
    ]
    port.read.mockResolvedValueOnce({
      lines: persisted.map(event => JSON.stringify(event)),
      truncated: false,
      lastSeq: 1,
      gaps: [],
      corruptLines: 0,
      duplicateLines: 0,
    })

    const store = useJournalStore()
    await store.hydrate('session-bare')

    const event = store.events.find(candidate => candidate.seq === 1)
    expect(event && 'timestamp' in event ? event.timestamp : undefined).toBeUndefined()
  })

  it('keeps identity for a replay larger than 2000 events', async () => {
    const lines = [headerLine('session-long')]
    for (let seq = 1; seq <= 2500; seq++) {
      lines.push(JSON.stringify({ type: 'user/message', seq, text: `m${seq}`, timestamp: seq }))
    }
    port.read.mockResolvedValueOnce({ lines, truncated: false, lastSeq: 2500, gaps: [], corruptLines: 0, duplicateLines: 0 })

    const store = useJournalStore()
    await store.hydrate('session-long')

    expect(store.events).toHaveLength(2501)
    expect(store.events.at(-1)?.seq).toBe(2500)
  })

  it('stops at a seq gap, reports the break, and never renumbers', async () => {
    const lines = [
      headerLine('session-gap'),
      JSON.stringify({ type: 'user/message', seq: 1, text: 'kept', timestamp: 1 }),
      // seq 2 was lost to a failed write batch; the file also keeps later
      // events, which stay on disk untouched.
      JSON.stringify({ type: 'user/message', seq: 3, text: 'beyond the hole', timestamp: 3 }),
    ]
    port.read.mockResolvedValueOnce({ lines, truncated: false, lastSeq: 1, gaps: [2], corruptLines: 0, duplicateLines: 0 })

    const store = useJournalStore()
    const replayed = await store.hydrate('session-gap')

    expect(replayed).toBe(1)
    expect(store.events.map(event => event.seq)).toEqual([0, 1])
    expect(store.persistenceStatus.identityBrokenFrom).toBe(2)
    expect(store.persistenceStatus.complete).toBe(false)
  })

  it('skips a trailing corrupt line and reports the corruption', async () => {
    port.read.mockResolvedValueOnce({
      lines: [
        headerLine('session-c'),
        JSON.stringify({ type: 'user/message', seq: 1, text: 'kept', timestamp: 2 }),
        'not json at all',
      ],
      truncated: false,
      lastSeq: 1,
      gaps: [],
      corruptLines: 1,
      duplicateLines: 0,
    })

    const store = useJournalStore()
    const replayed = await store.hydrate('session-c')

    expect(replayed).toBe(1)
    expect(store.persistenceStatus.corruptLines).toBe(1)
    expect(store.persistenceStatus.complete).toBe(false)
  })

  it('treats a corrupt mid-file line as the end of the trustworthy run', async () => {
    port.read.mockResolvedValueOnce({
      lines: [
        headerLine('session-corrupt-mid'),
        JSON.stringify({ type: 'user/message', seq: 1, text: 'kept', timestamp: 2 }),
        'not json at all',
        JSON.stringify({ type: 'user/message', seq: 3, text: 'after the corrupt line', timestamp: 3 }),
      ],
      truncated: false,
      lastSeq: 1,
      gaps: [2],
      corruptLines: 1,
      duplicateLines: 0,
    })

    const store = useJournalStore()
    const replayed = await store.hydrate('session-corrupt-mid')

    expect(replayed).toBe(1)
    expect(store.events.map(event => event.seq)).toEqual([0, 1])
    expect(store.persistenceStatus.identityBrokenFrom).toBe(2)
  })

  it('requeues a failed batch and delivers it in order on flushNow', async () => {
    port.append.mockRejectedValueOnce(new Error('disk is full'))
    const store = useJournalStore()

    store.append('session-d', { type: 'user/message', text: 'still here', timestamp: 1 })
    // The rejection crosses one more promise hop through the ack timeout
    // race, so wait for it instead of counting microtask ticks.
    await vi.waitFor(() => expect(store.persistenceStatus.lastError).toContain('disk is full'))

    // The failed batch stays queued instead of vanishing, and the failure is
    // visible rather than silent.
    expect(store.persistenceStatus.pendingCount).toBe(2)
    expect(store.persistenceStatus.complete).toBe(false)
    expect(store.events.some(event => event.type === 'user/message')).toBe(true)

    port.append.mockResolvedValueOnce(undefined)
    const remaining = await store.flushNow()

    expect(remaining).toBe(0)
    expect(store.persistenceStatus.complete).toBe(true)
    // Retry re-sends the whole queue; the host dedupes already-persisted seqs.
    const [, retryLines] = port.append.mock.calls[1] as unknown as [string, string[]]
    expect(retryLines).toHaveLength(2)
    expect(retryLines.map(line => (JSON.parse(line) as JournalEvent).seq)).toEqual([0, 1])
  })

  it('retries a batch whose append never answers, instead of wedging the queue', async () => {
    // ROOT CAUSE:
    //
    // ACC-20260909: the desktop journal stopped writing for 20 minutes while
    // the app kept running and journaling in memory. An append IPC that never
    // settled left the session in the in-flight set forever: every later
    // flush skipped the session, no retry was scheduled, and no error was
    // reported anywhere. The write is now raced against a timeout, and a
    // timeout takes the same failure path as a rejected write.
    vi.useFakeTimers()
    try {
      port.append.mockImplementation(() => new Promise(() => {}))
      const store = useJournalStore()
      store.append('session-stuck', { type: 'user/message', text: 'first', timestamp: 1 })

      await vi.advanceTimersByTimeAsync(1)
      expect(port.append).toHaveBeenCalledTimes(1)
      expect(store.persistenceStatus.pendingCount).toBe(2)

      await vi.advanceTimersByTimeAsync(15_000)
      expect(store.persistenceStatus.lastError).toContain('did not answer')

      // The backoff retry re-sends the batch after the timeout releases the
      // per-session lock.
      await vi.advanceTimersByTimeAsync(5_000)
      expect(port.append).toHaveBeenCalledTimes(2)
      expect(store.persistenceStatus.pendingCount).toBe(2)

      // Recovery: once the host answers again, the queued events drain and
      // the whole batch reaches the owner — the timeout never drops data.
      port.append.mockImplementation(async () => {})
      await vi.advanceTimersByTimeAsync(60_000)
      expect(store.persistenceStatus.pendingCount).toBe(0)
      const [sessionId, lines] = port.append.mock.calls.at(-1) as unknown as [string, string[]]
      expect(sessionId).toBe('session-stuck')
      expect(lines).toHaveLength(2)
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('derives task runs from live appends, one identity per flow', async () => {
    // TASK-RUN-AND-UI-PLAN A: the projection reads the same events the store
    // records, so chat surfaces never re-assemble task identity themselves.
    const store = useJournalStore()
    store.append('session-task', { type: 'user/message', text: 'Ship the fix', timestamp: 1 })
    store.append('session-task', { type: 'flow/start', flowId: 'f1', taskId: 't1', trigger: 'tool', timestamp: 2 })
    store.append('session-task', { type: 'plan/update', planId: 'p1', stepId: 'step-1', status: 'in_progress', taskId: 't1' })
    store.append('session-task', { type: 'user/steering', text: 'also run lint', flowId: 'f1', taskId: 't1', timestamp: 3 })

    expect(store.taskRuns).toHaveLength(1)
    expect(store.taskRuns[0]).toMatchObject({
      taskId: 't1',
      flowId: 'f1',
      title: 'Ship the fix',
      planIds: ['p1'],
      currentStepId: 'step-1',
      status: 'running',
    })

    store.append('session-task', { type: 'flow/end', flowId: 'f1', taskId: 't1', reason: 'done', iterations: 2, timestamp: 4 })
    expect(store.taskRuns[0]!.status).toBe('completed')
    expect(store.taskRuns[0]!.taskId).toBe('t1')
  })

  it('keeps task identity stable across a replayed session', async () => {
    const persisted: JournalEvent[] = [
      { type: 'session/header', seq: 0, sessionId: 'session-replay', createdAt: 1, delegationDepth: 0 },
      { type: 'flow/start', seq: 1, flowId: 'f1', taskId: 't1', trigger: 'command', timestamp: 2 },
      { type: 'plan/update', seq: 2, planId: 'p1', stepId: 'step-2', status: 'completed', taskId: 't1' },
      { type: 'flow/end', seq: 3, flowId: 'f1', taskId: 't1', reason: 'done', iterations: 2, timestamp: 9 },
    ]
    port.read.mockResolvedValueOnce({
      lines: persisted.map(event => JSON.stringify(event)),
      truncated: false,
      lastSeq: 3,
      gaps: [],
      corruptLines: 0,
      duplicateLines: 0,
    })

    const store = useJournalStore()
    await store.hydrate('session-replay')

    expect(store.taskRuns).toHaveLength(1)
    expect(store.taskRuns[0]).toMatchObject({ taskId: 't1', flowId: 'f1', planIds: ['p1'], status: 'completed' })
  })
})
