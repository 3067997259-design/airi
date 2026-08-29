import type { TaskMemory } from '@proj-airi/core-agent'
import type { WebSocketEventOf } from '@proj-airi/server-sdk'
import type {} from 'pinia-plugin-synced'

import { normalizeTaskMemory } from '@proj-airi/core-agent'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

export type AttentionTaskEvent
  = | WebSocketEventOf<'task:start'>
    | WebSocketEventOf<'task:progress'>
    | WebSocketEventOf<'task:blocked'>
    | WebSocketEventOf<'task:done'>

/** Task state projected from the append-only attention event log. */
export interface AttentionTask {
  taskId: string
  goal: string
  kind: string
  status: TaskMemory['status']
  memory: TaskMemory
  startedAt: number
  updatedAt: number
  estimatedDurationMs?: number
  logRef?: string
  needsInput?: string
  conclusion?: string
  sourceEventId: string
}

function eventId(event: AttentionTaskEvent): string {
  return event.data.id
}

function eventTime(event: AttentionTaskEvent, fallback: number): number {
  if ('memory' in event.data && typeof event.data.memory.updatedAt === 'number')
    return event.data.memory.updatedAt
  return fallback
}

function withStatus(memory: TaskMemory, status: TaskMemory['status']): TaskMemory {
  return { ...memory, status }
}

function projectTasks(events: readonly AttentionTaskEvent[], receivedAtByEventId: ReadonlyMap<string, number>): AttentionTask[] {
  const taskMap = new Map<string, AttentionTask>()

  for (const event of events) {
    const updatedAt = eventTime(event, receivedAtByEventId.get(eventId(event)) ?? 0)

    if (event.type === 'task:start') {
      const memory = normalizeTaskMemory({
        status: 'active',
        goal: event.data.goal,
        sourceTurnId: event.data.eventId ?? event.data.id,
        updatedAt,
      }, {
        goal: event.data.goal,
        sourceTurnId: event.data.eventId ?? event.data.id,
        updatedAt,
      })
      const existing = taskMap.get(event.data.taskId)
      taskMap.set(event.data.taskId, {
        taskId: event.data.taskId,
        goal: event.data.goal,
        kind: event.data.kind,
        status: 'active',
        memory,
        startedAt: existing?.startedAt ?? updatedAt,
        updatedAt,
        estimatedDurationMs: event.data.estimatedDurationMs,
        sourceEventId: eventId(event),
      })
      continue
    }

    const existing = taskMap.get(event.data.taskId)
    const previous = existing ?? {
      taskId: event.data.taskId,
      goal: event.data.memory.goal ?? 'Task',
      kind: 'task',
      status: 'active' as const,
      memory: normalizeTaskMemory(event.data.memory, { sourceTurnId: event.data.eventId ?? event.data.id }),
      startedAt: updatedAt,
      updatedAt,
      sourceEventId: eventId(event),
    }
    const memory = normalizeTaskMemory(event.data.memory, {
      ...previous.memory,
      sourceTurnId: event.data.eventId ?? event.data.id,
      updatedAt,
    })
    const next: AttentionTask = {
      ...previous,
      memory,
      updatedAt,
      sourceEventId: eventId(event),
    }

    if (event.type === 'task:progress') {
      next.status = 'active'
      next.memory = withStatus(memory, 'active')
      next.logRef = event.data.logRef
      next.needsInput = undefined
      next.conclusion = undefined
    }
    else if (event.type === 'task:blocked') {
      next.status = 'blocked'
      next.memory = withStatus(memory, 'blocked')
      next.logRef = event.data.logRef
      next.needsInput = event.data.needsInput
    }
    else {
      next.status = 'done'
      next.memory = withStatus(memory, 'done')
      next.logRef = event.data.logRef
      next.needsInput = undefined
      next.conclusion = event.data.conclusion
    }

    taskMap.set(event.data.taskId, next)
  }

  return [...taskMap.values()].sort((left, right) => left.updatedAt - right.updatedAt)
}

export const useTaskStore = defineStore('attention-tasks', () => {
  const eventLog = ref<AttentionTaskEvent[]>([])
  const receivedAtByEventId = new Map<string, number>()
  const tasks = computed(() => projectTasks(eventLog.value, receivedAtByEventId))
  const activeTasks = computed(() => tasks.value.filter(task => task.status === 'active'))

  /** Appends one task event and ignores a duplicate event id. */
  function ingest(event: AttentionTaskEvent): boolean {
    if (eventLog.value.some(existing => eventId(existing) === eventId(event)))
      return false

    receivedAtByEventId.set(eventId(event), Date.now())
    eventLog.value = [...eventLog.value, event]
    return true
  }

  function clear() {
    receivedAtByEventId.clear()
    eventLog.value = []
  }

  return {
    eventLog,
    tasks,
    activeTasks,
    ingest,
    clear,
  }
}, {
  synced: {
    state: false,
  },
})
