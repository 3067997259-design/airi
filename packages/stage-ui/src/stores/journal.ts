import type { JournalEvent, JournalEventInput, JournalStore, ProjectionRegistry, TaskRun } from '@proj-airi/core-agent'

import { errorMessageFrom } from '@moeru/std'
import { createContextSectionUnit, createJournalStore, createTaskMemoryUnit, createToolEvidenceIndexUnit, deriveTaskRuns, ProjectionRegistry as ProjectionRegistryImpl } from '@proj-airi/core-agent'
import { defineStore } from 'pinia'
import { computed, ref, shallowRef } from 'vue'

const DEFAULT_SESSION_ID = 'stage-session'

/** How long a mirror write may stay unanswered before the batch is retried. */
const FLUSH_ACK_TIMEOUT_MS = 10_000

/** Structural facts about the persisted session file, reported by the host. */
export interface JournalReplayAnalysis {
  truncated: boolean
  lastSeq: number
  gaps: number[]
  corruptLines: number
  duplicateLines: number
}

/**
 * Durable journal storage, installed by the app shell.
 *
 * The store stays the source of truth in memory; this port only mirrors the
 * stream to disk and reads it back, so a renderer without persistence behaves
 * exactly as before (HARNESS-PLAN §9.1).
 */
export interface JournalPersistencePort {
  append: (sessionId: string, lines: string[]) => Promise<void>
  read: (sessionId: string) => Promise<{ lines: string[] } & Partial<JournalReplayAnalysis>>
  exportAll?: () => Promise<{ files: Array<{ name: string, content: string }> }>
}

let persistencePort: JournalPersistencePort | undefined

/** Registers the durable journal owner for this renderer. */
export function installJournalPersistence(port: JournalPersistencePort | undefined): void {
  persistencePort = port
}

/**
 * Event types whose contract leaves the timestamp optional.
 *
 * They describe work that happened at some moment the event itself does not
 * fix, so the social consideration boundary ages them by the closest wall
 * clock the journal does record instead of trusting their presence.
 */
const ACTIVITY_EVENT_TYPES: ReadonlySet<JournalEvent['type']> = new Set(['plan/update', 'task/update', 'tool/result'])

type ActivityEvent = Extract<JournalEvent, { type: 'plan/update' | 'task/update' | 'tool/result' }>

function isActivityEvent(event: JournalEvent): event is ActivityEvent {
  return ACTIVITY_EVENT_TYPES.has(event.type)
}

/** Reads the wall clock an event recorded, if its contract has one. */
function readEventTimestamp(event: JournalEvent): number | undefined {
  return 'timestamp' in event ? event.timestamp : undefined
}

/**
 * Gives a replayed activity event the age its own turn recorded.
 *
 * Activity events carry no timestamp in their contract, and only the append
 * path stamps new ones. Files written before that stamping existed therefore
 * hold `tool/result`, `plan/update`, and `task/update` records with none:
 * `occurredAt` stayed undefined, the consideration boundary can never expire
 * an undefined age, and an eight-hour-old tool result reached the model as if
 * it had just happened (ACC-20260910 S18 follow-up). Neighbouring events of
 * the same turn do carry a timestamp, so the closest one is this event's real
 * age. An activity event with no timestamp on either side is left untouched —
 * filling in `Date.now()` would recreate exactly the bug this guards against.
 */
function backfillActivityTimestamps(events: readonly JournalEvent[]): JournalEvent[] {
  let previous: number | undefined
  const stamped = events.map((event) => {
    const timestamp = readEventTimestamp(event)
    if (timestamp !== undefined) {
      previous = timestamp
      return event
    }
    if (previous === undefined || !isActivityEvent(event))
      return event
    return { ...event, timestamp: previous }
  })

  // A run whose header was never persisted can start with an activity event.
  // The first later timestamp gives that leading run one shared age.
  let next: number | undefined
  for (let index = stamped.length - 1; index >= 0; index -= 1) {
    const event = stamped[index]!
    const timestamp = readEventTimestamp(event)
    if (timestamp !== undefined) {
      next = timestamp
      continue
    }
    if (next !== undefined && isActivityEvent(event))
      stamped[index] = { ...event, timestamp: next }
  }
  return stamped
}

/**
 * UI projection of one append-only runtime journal.
 *
 * The store keeps raw events as the source of truth. Cards and diagnostics
 * derive their views from `events`, so websocket, approval, and chat inputs
 * use one ordered stream.
 */
export const useJournalStore = defineStore('runtime-journal', () => {
  const currentSessionId = ref<string>()
  const events = ref<JournalEvent[]>([])
  const toolEvidence = computed(() => events.value.filter((event): event is Extract<JournalEvent, { type: 'tool/result' }> => event.type === 'tool/result'))
  /**
   * Task runs of the current session, derived from the event stream.
   *
   * The journal stays the only source of truth: chat surfaces read this
   * projection instead of re-assembling task identity from flow and plan
   * state, so a replayed session shows exactly the tasks it recorded.
   */
  const taskRuns = computed<TaskRun[]>(() => deriveTaskRuns(events.value))
  const pendingApprovals = computed(() => {
    const asked = new Map<string, Extract<JournalEvent, { type: 'approval/asked' }>>()
    const decided = new Set<string>()
    for (const event of events.value) {
      if (event.type === 'approval/asked')
        asked.set(event.requestId, event)
      if (event.type === 'approval/decided')
        decided.add(event.requestId)
    }
    return [...asked.values()].filter(event => !decided.has(event.requestId))
  })

  /** Self-authored skills waiting for a human review decision. */
  const pendingReviews = computed(() => {
    const asked = new Map<string, Extract<JournalEvent, { type: 'review/asked' }>>()
    const decided = new Set<string>()
    for (const event of events.value) {
      if (event.type === 'review/asked')
        asked.set(event.reviewRequestId, event)
      if (event.type === 'review/decided')
        decided.add(event.reviewRequestId)
    }
    return [...asked.values()].filter(event => !decided.has(event.reviewRequestId))
  })

  const stores = new Map<string, JournalStore>()
  const pendingWrites = new Map<string, string[]>()
  const inFlightSessions = new Set<string>()
  let flushScheduled = false
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let retryBackoffMs = 0
  const projections = new Map<string, ProjectionRegistry>()
  const projectionSnapshots = shallowRef<Record<string, unknown>>({})

  const pendingCount = shallowRef(0)
  const lastPersistError = shallowRef<string>()
  const replayAnalysis = shallowRef<JournalReplayAnalysis>()
  /** Seq where identity-preserving replay stopped because the file has a hole. */
  const identityBrokenFrom = shallowRef<number>()
  /**
   * Sessions this renderer replayed from disk (or confirmed there is no file).
   * Appending to a session that was never replayed would start at seq 0 and
   * collide with the persisted seqs; callers hydrate through the chat store
   * entry points, and this set keeps repeat calls from re-reading the file.
   */
  const hydratedSessions = new Set<string>()

  function ensureSession(sessionId = DEFAULT_SESSION_ID): JournalStore {
    let store = stores.get(sessionId)
    if (!store) {
      store = createJournalStore(sessionId)
      const header = store.append({
        type: 'session/header',
        sessionId,
        createdAt: Date.now(),
        delegationDepth: 0,
      })
      stores.set(sessionId, store)
      const registry = new ProjectionRegistryImpl()
      registry.register(createTaskMemoryUnit())
      registry.register(createToolEvidenceIndexUnit())
      registry.register(createContextSectionUnit())
      projections.set(sessionId, registry)
      // The header is persisted so a replayed file is self-contained; legacy
      // files written before this lack it and the replay synthesizes one.
      queuePersist(sessionId, header)
    }

    currentSessionId.value = sessionId
    events.value = store.readAll()
    projectionSnapshots.value = projections.get(sessionId)?.snapshot().values ?? {}
    return store
  }

  function append(sessionId: string, event: JournalEventInput): JournalEvent {
    const store = ensureSession(sessionId)
    const duplicate = dedupeKey(event)
      ? store.readAll().find(existing => dedupeKey(existing) === dedupeKey(event))
      : undefined
    if (duplicate)
      return duplicate

    // Activity events carry no timestamp in their contract, but the social
    // consideration boundary ages them against wall-clock time. Stamp the
    // record here so a tool/result or plan/update cannot pose as "just now"
    // after a restart (ACC-20260910 S18).
    const stamped = (event.type === 'plan/update' || event.type === 'task/update' || event.type === 'tool/result')
      && event.timestamp === undefined
      ? { ...event, timestamp: Date.now() }
      : event
    const record = store.append(stamped)
    projections.get(sessionId)?.ingest(record)
    events.value = store.readAll()
    projectionSnapshots.value = projections.get(sessionId)?.snapshot().values ?? {}
    queuePersist(sessionId, record)
    return record
  }

  function syncPendingCount(): void {
    let total = 0
    for (const lines of pendingWrites.values())
      total += lines.length
    pendingCount.value = total
  }

  /**
   * Mirrors queued events to disk.
   *
   * The whole per-session queue is sent on every attempt, including lines a
   * previous attempt may have already persisted: the host drops lines whose
   * seq it has, so a lost IPC receipt converges on the next attempt instead of
   * duplicating events. Batches stay ordered per session (FIFO, single
   * in-flight write), and a failed attempt keeps the queue and retries with
   * backoff — losing durability must not be silent.
   */
  async function flushPending(): Promise<void> {
    if (!persistencePort)
      return

    for (const [sessionId, queued] of pendingWrites.entries()) {
      if (queued.length === 0 || inFlightSessions.has(sessionId))
        continue

      inFlightSessions.add(sessionId)
      let appendSucceeded = false
      try {
        const snapshot = [...queued]
        // A lost IPC receipt must not wedge the queue: an append that never
        // settles would keep the per-session lock forever, every later flush
        // would skip the session, and nothing would report an error
        // (ACC-20260909: twenty minutes of events never reached disk). Race
        // the write against a timeout; a timeout takes the same failure path
        // as a rejected write, and the retry re-sends the whole queue — the
        // host drops lines whose seq it already persisted.
        let ackTimer: ReturnType<typeof setTimeout> | undefined
        try {
          await Promise.race([
            persistencePort.append(sessionId, snapshot),
            new Promise<never>((_, reject) => {
              ackTimer = setTimeout(
                () => reject(new Error(`Journal append did not answer within ${FLUSH_ACK_TIMEOUT_MS}ms`)),
                FLUSH_ACK_TIMEOUT_MS,
              )
            }),
          ])
        }
        finally {
          clearTimeout(ackTimer)
        }
        appendSucceeded = true
        const remaining = pendingWrites.get(sessionId) ?? []
        // Keep lines that were queued while the write was in flight; they sit
        // after the snapshot in the same FIFO array.
        pendingWrites.set(sessionId, remaining.slice(snapshot.length))
        retryBackoffMs = 0
        lastPersistError.value = undefined
      }
      catch (error) {
        lastPersistError.value = errorMessageFrom(error) ?? 'Journal persist failed'
        scheduleRetry()
      }
      finally {
        inFlightSessions.delete(sessionId)
        // An event can arrive after this flush passes the session in the loop
        // but before the host acknowledges the batch. Schedule the remaining
        // tail now that the per-session lock is free; otherwise it can stay in
        // memory until an unrelated journal append or retry wakes the queue.
        if (appendSucceeded && (pendingWrites.get(sessionId)?.length ?? 0) > 0)
          scheduleFlush()
      }
    }
    syncPendingCount()
  }

  function scheduleFlush(): void {
    if (flushScheduled)
      return
    flushScheduled = true
    void Promise.resolve().then(async () => {
      flushScheduled = false
      await flushPending()
    })
  }

  function scheduleRetry(): void {
    if (retryTimer)
      return
    retryBackoffMs = retryBackoffMs === 0 ? 1_000 : Math.min(retryBackoffMs * 2, 30_000)
    retryTimer = setTimeout(() => {
      retryTimer = undefined
      void flushPending()
    }, retryBackoffMs)
  }

  function queuePersist(sessionId: string, record: JournalEvent): void {
    if (!persistencePort)
      return

    const batch = pendingWrites.get(sessionId) ?? []
    batch.push(JSON.stringify(record))
    pendingWrites.set(sessionId, batch)
    syncPendingCount()
    scheduleFlush()
  }

  /**
   * Flushes everything queued so far and reports what still awaits disk.
   *
   * Wired to `beforeunload`: a normal close gets a best-effort drain, while a
   * forced kill is covered by the host's gap detection on the next boot.
   */
  async function flushNow(): Promise<number> {
    if (retryTimer) {
      clearTimeout(retryTimer)
      retryTimer = undefined
    }
    await flushPending()
    return pendingCount.value
  }

  /** Flushes the leader queue before reading full archives from their owner. */
  async function exportSnapshot(): Promise<{ files: Array<{ name: string, content: string }> }> {
    if (!persistencePort?.exportAll)
      throw new Error('The journal owner does not support full archive export.')
    if (await flushNow() !== 0)
      throw new Error('Journal writes are still pending. The snapshot was not captured.')
    return persistencePort.exportAll()
  }

  /**
   * Whether this renderer appended to a session before its replay.
   *
   * The header alone does not count: every store starts with one, and a store
   * created by `ensureSession` is the reason the replay has to own seq 0.
   */
  function hasLiveEvents(sessionId: string): boolean {
    const store = stores.get(sessionId)
    return store !== undefined && store.readAll().length > 1
  }

  /**
   * Drops queued headers for a session whose file already carries seq 0.
   *
   * Only a header can be queued at that point: a queued event with a later seq
   * means this renderer appended before the replay, and `hydrate` leaves that
   * live history alone instead of seeding over it.
   *
   * @returns whether the queue changed.
   */
  function dropQueuedHeader(sessionId: string): boolean {
    const queued = pendingWrites.get(sessionId)
    if (queued === undefined || queued.length === 0)
      return false

    const kept = queued.filter((line) => {
      try {
        const event = JSON.parse(line) as JournalEvent
        return event.seq !== 0 || event.type !== 'session/header'
      }
      catch {
        // An unreadable queued line is not provably a redundant header.
        return true
      }
    })
    if (kept.length === queued.length)
      return false

    if (kept.length > 0) {
      pendingWrites.set(sessionId, kept)
      return true
    }

    pendingWrites.delete(sessionId)
    // The rejected header was the only unpersisted work. Keeping the conflict
    // error would report a wedged queue that no longer exists.
    if ([...pendingWrites.values()].every(lines => lines.length === 0))
      lastPersistError.value = undefined
    return true
  }

  /**
   * Replays a persisted session into memory with event identity intact.
   *
   * The file is indexed by seq and the store is seeded through
   * `initialEvents`, so a replayed event keeps the seq it was written with —
   * evidence references, decision watermarks, and diagnostics keep pointing
   * at the same event across restarts. The load walks the contiguous seq run
   * from the start of the file and stops at the first hole; events beyond the
   * hole stay on disk untouched and the break is surfaced through the
   * replay status instead of being silently renumbered away.
   *
   * Called before a session is used, so restored state comes from the same
   * events the live stream produces.
   */
  async function hydrate(sessionId = DEFAULT_SESSION_ID): Promise<number> {
    if (!persistencePort)
      return 0
    if (hydratedSessions.has(sessionId))
      return 0

    // A store with live events was already appended to before replay. Its
    // seqs belong to this process, not the file; re-seeding would reject the
    // live history, so leave it in place. The host rejects seq conflicts
    // instead of silently dropping the batch (R04-adoption, 2026-09-10).
    //
    // The store must not be created before the read: a fresh store owns seq 0
    // with a header of its own, and queueing that header for a session whose
    // file already has seq 0 makes the durable owner reject every later flush
    // of that session (live R04 copy, 2026-09-11).
    if (hasLiveEvents(sessionId)) {
      currentSessionId.value = sessionId
      return 0
    }

    const read = await persistencePort.read(sessionId)
    replayAnalysis.value = {
      truncated: read.truncated ?? false,
      lastSeq: read.lastSeq ?? -1,
      gaps: read.gaps ?? [],
      corruptLines: read.corruptLines ?? 0,
      duplicateLines: read.duplicateLines ?? 0,
    }

    const bySeq = new Map<number, JournalEvent>()
    for (const line of read.lines) {
      try {
        const event = JSON.parse(line) as JournalEvent
        if (!bySeq.has(event.seq))
          bySeq.set(event.seq, event)
      }
      catch {
        continue
      }
    }

    if (bySeq.size === 0) {
      // No persisted events for this session, so this renderer owns seq 0 and
      // the header has to reach disk. A store created during the read owns the
      // same starting point, so reuse it instead of seeding a second one.
      ensureSession(sessionId)
      hydratedSessions.add(sessionId)
      return 0
    }

    if (hasLiveEvents(sessionId)) {
      currentSessionId.value = sessionId
      return 0
    }

    // The file owns seq 0 from here on. A header queued by an ensureSession
    // that ran before this replay can never be accepted: its content differs
    // from the persisted header, so the durable owner rejects the seq and the
    // session's whole queue stops moving. Dropping it loses nothing, because
    // the queue can only hold that header at this point.
    if (dropQueuedHeader(sessionId))
      syncPendingCount()

    const fileHeader = bySeq.get(0)
    const header = fileHeader?.type === 'session/header'
      ? fileHeader
      : { type: 'session/header', seq: 0, sessionId, createdAt: Date.now(), delegationDepth: 0 } as JournalEvent
    const initialEvents: JournalEvent[] = [header]
    let replayed = 0
    let expected = 1
    while (bySeq.has(expected)) {
      const event = bySeq.get(expected)!
      // A header deeper in the file is a legacy artifact the store cannot
      // seed (its seq invariant starts at 0), so it ends the replay like any
      // other break in the seq run.
      if (event.type === 'session/header')
        break
      initialEvents.push(event)
      replayed += 1
      expected += 1
    }
    const maxSeq = bySeq.size > 0 ? Math.max(...bySeq.keys()) : -1
    identityBrokenFrom.value = expected <= maxSeq ? expected : undefined

    const seeded = createJournalStore(sessionId, { initialEvents: backfillActivityTimestamps(initialEvents) })
    stores.set(sessionId, seeded)
    // The replayed session becomes the projection this window shows, which is
    // what a store created here used to do on the way in.
    currentSessionId.value = sessionId

    const registry = new ProjectionRegistryImpl()
    registry.register(createTaskMemoryUnit())
    registry.register(createToolEvidenceIndexUnit())
    registry.register(createContextSectionUnit())
    for (const event of seeded.readAll()) {
      if (event.type === 'session/header')
        continue
      registry.ingest(event)
    }
    projections.set(sessionId, registry)

    events.value = seeded.readAll()
    projectionSnapshots.value = registry.snapshot().values ?? {}
    hydratedSessions.add(sessionId)
    return replayed
  }

  function appendActive(event: JournalEventInput): JournalEvent {
    return append(currentSessionId.value ?? DEFAULT_SESSION_ID, event)
  }

  function readSession(sessionId = currentSessionId.value ?? DEFAULT_SESSION_ID): JournalEvent[] {
    return ensureSession(sessionId).readAll()
  }

  /**
   * Reads a loaded session without changing the journal projection selected by
   * this window. Plan projections use this when a long goal is bound to a
   * different chat window's conversation.
   */
  function snapshotSession(sessionId: string): JournalEvent[] {
    return stores.get(sessionId)?.readAll() ?? []
  }

  /** Structural health of persistence for this window. */
  const persistenceStatus = computed(() => {
    const analysis = replayAnalysis.value
    return {
      pendingCount: pendingCount.value,
      lastError: lastPersistError.value,
      truncated: analysis?.truncated ?? false,
      lastSeq: analysis?.lastSeq ?? -1,
      gaps: analysis?.gaps ?? [],
      corruptLines: analysis?.corruptLines ?? 0,
      duplicateLines: analysis?.duplicateLines ?? 0,
      identityBrokenFrom: identityBrokenFrom.value,
      complete: pendingCount.value === 0
        && lastPersistError.value === undefined
        && !(analysis?.truncated ?? false)
        && (analysis?.gaps.length ?? 0) === 0
        && (analysis?.corruptLines ?? 0) === 0
        && (analysis?.duplicateLines ?? 0) === 0
        && identityBrokenFrom.value === undefined,
    }
  })

  function reset() {
    if (retryTimer) {
      clearTimeout(retryTimer)
      retryTimer = undefined
    }
    stores.clear()
    projections.clear()
    pendingWrites.clear()
    inFlightSessions.clear()
    hydratedSessions.clear()
    syncPendingCount()
    lastPersistError.value = undefined
    replayAnalysis.value = undefined
    identityBrokenFrom.value = undefined
    currentSessionId.value = undefined
    events.value = []
    projectionSnapshots.value = {}
  }

  return {
    currentSessionId,
    events,
    toolEvidence,
    taskRuns,
    pendingApprovals,
    pendingReviews,
    projectionSnapshots,
    persistenceStatus,
    ensureSession,
    hydrate,
    append,
    appendActive,
    readSession,
    snapshotSession,
    flushNow,
    exportSnapshot,
    reset,
  }
}, {
  synced: {
    state: false,
  },
})

function dedupeKey(event: JournalEventInput | JournalEvent): string | undefined {
  switch (event.type) {
    case 'context/inject':
      return event.eventId ? `context:${event.eventId}` : undefined
    case 'event/reaction':
      return `reaction:${event.eventId}`
    case 'approval/asked':
      return `approval-asked:${event.requestId}`
    case 'approval/decided':
      return `approval-decided:${event.requestId}`
    case 'review/asked':
      return `review-asked:${event.reviewRequestId}`
    case 'review/decided':
      return `review-decided:${event.reviewRequestId}`
    default:
      return undefined
  }
}
