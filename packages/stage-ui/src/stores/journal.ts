import type { JournalEvent, JournalEventInput, JournalStore, ProjectionRegistry } from '@proj-airi/core-agent'

import { createContextSectionUnit, createJournalStore, createTaskMemoryUnit, createToolEvidenceIndexUnit, ProjectionRegistry as ProjectionRegistryImpl } from '@proj-airi/core-agent'
import { defineStore } from 'pinia'
import { computed, ref, shallowRef } from 'vue'

const DEFAULT_SESSION_ID = 'stage-session'

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

  const stores = new Map<string, JournalStore>()
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
    return record
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
    projectionSnapshots,
    ensureSession,
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
