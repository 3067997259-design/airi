import type { JournalEvent, JournalEventInput, JournalStore, ProjectionRegistry } from '@proj-airi/core-agent'

import { createContextSectionUnit, createJournalStore, createTaskMemoryUnit, createToolEvidenceIndexUnit, ProjectionRegistry as ProjectionRegistryImpl } from '@proj-airi/core-agent'
import { defineStore } from 'pinia'
import { computed, ref, shallowRef } from 'vue'

const DEFAULT_SESSION_ID = 'stage-session'

/**
 * Durable journal storage, installed by the app shell.
 *
 * The store stays the source of truth in memory; this port only mirrors the
 * stream to disk and reads it back, so a renderer without persistence behaves
 * exactly as before (HARNESS-PLAN §9.1).
 */
export interface JournalPersistencePort {
  append: (sessionId: string, lines: string[]) => Promise<void>
  read: (sessionId: string) => Promise<{ lines: string[], truncated: boolean }>
}

let persistencePort: JournalPersistencePort | undefined

/** Registers the durable journal owner for this renderer. */
export function installJournalPersistence(port: JournalPersistencePort | undefined): void {
  persistencePort = port
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
  let flushScheduled = false
  const projections = new Map<string, ProjectionRegistry>()
  const projectionSnapshots = shallowRef<Record<string, unknown>>({})

  function ensureSession(sessionId = DEFAULT_SESSION_ID): JournalStore {
    let store = stores.get(sessionId)
    if (!store) {
      store = createJournalStore(sessionId)
      store.append({
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

    const record = store.append(event)
    projections.get(sessionId)?.ingest(record)
    events.value = store.readAll()
    projectionSnapshots.value = projections.get(sessionId)?.snapshot().values ?? {}
    queuePersist(sessionId, record)
    return record
  }

  /**
   * Mirrors one event to disk on the next microtask batch.
   *
   * A tool loop appends many events in a row; one write per event would make
   * the loop disk-bound. Persistence failures never reach the caller: the
   * journal keeps working in memory, which is what the running turn needs.
   */
  function queuePersist(sessionId: string, record: JournalEvent): void {
    if (!persistencePort)
      return

    const batch = pendingWrites.get(sessionId) ?? []
    batch.push(JSON.stringify(record))
    pendingWrites.set(sessionId, batch)
    if (flushScheduled)
      return

    flushScheduled = true
    void Promise.resolve().then(async () => {
      flushScheduled = false
      const batches = [...pendingWrites.entries()]
      pendingWrites.clear()
      for (const [id, lines] of batches) {
        try {
          await persistencePort?.append(id, lines)
        }
        catch {
          // Losing durability is not losing the session; the next append tries
          // again and the in-memory journal is unaffected.
        }
      }
    })
  }

  /**
   * Replays a persisted session into memory.
   *
   * Called before a session is used, so restored state comes from the same
   * events the live stream produces. Unparsable lines are skipped rather than
   * failing the whole replay: one corrupt tail must not cost the history.
   */
  async function hydrate(sessionId = DEFAULT_SESSION_ID): Promise<number> {
    if (!persistencePort)
      return 0

    const store = ensureSession(sessionId)
    if (store.readAll().length > 1)
      return 0

    const { lines } = await persistencePort.read(sessionId)
    let replayed = 0
    for (const line of lines) {
      try {
        const event = JSON.parse(line) as JournalEvent
        if (event.type === 'session/header')
          continue
        store.append(event)
        projections.get(sessionId)?.ingest(event)
        replayed++
      }
      catch {
        continue
      }
    }

    events.value = store.readAll()
    projectionSnapshots.value = projections.get(sessionId)?.snapshot().values ?? {}
    return replayed
  }

  function appendActive(event: JournalEventInput): JournalEvent {
    return append(currentSessionId.value ?? DEFAULT_SESSION_ID, event)
  }

  function readSession(sessionId = currentSessionId.value ?? DEFAULT_SESSION_ID): JournalEvent[] {
    return ensureSession(sessionId).readAll()
  }

  function reset() {
    stores.clear()
    projections.clear()
    currentSessionId.value = undefined
    events.value = []
    projectionSnapshots.value = {}
  }

  return {
    currentSessionId,
    events,
    toolEvidence,
    pendingApprovals,
    pendingReviews,
    projectionSnapshots,
    ensureSession,
    hydrate,
    append,
    appendActive,
    readSession,
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
