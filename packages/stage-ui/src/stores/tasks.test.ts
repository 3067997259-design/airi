import type { WebSocketEventOf } from '@proj-airi/server-sdk'

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useTaskStore } from './tasks'

function memory(status: 'active' | 'blocked' | 'done', facts: string[], updatedAt: number) {
  return {
    status,
    goal: 'Watch the build',
    currentStep: 'Read the result',
    confirmedFacts: facts,
    artifacts: [],
    blockers: [],
    nextStep: status === 'done' ? null : 'Wait',
    updatedAt,
    sourceTurnId: `turn-${updatedAt}`,
  }
}

describe('attention task projection', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('replaces progress snapshots instead of accumulating them', () => {
    const store = useTaskStore()
    const start = {
      type: 'task:start',
      data: {
        id: 'event-start',
        taskId: 'task-1',
        goal: 'Watch the build',
        kind: 'ci',
      },
    } satisfies WebSocketEventOf<'task:start'>
    const firstProgress = {
      type: 'task:progress',
      data: {
        id: 'event-progress-1',
        taskId: 'task-1',
        memory: memory('active', ['first'], 10),
      },
    } satisfies WebSocketEventOf<'task:progress'>
    const secondProgress = {
      type: 'task:progress',
      data: {
        id: 'event-progress-2',
        taskId: 'task-1',
        memory: memory('active', ['second'], 20),
      },
    } satisfies WebSocketEventOf<'task:progress'>

    store.ingest(start)
    store.ingest(firstProgress)
    store.ingest(secondProgress)

    expect(store.tasks).toHaveLength(1)
    expect(store.tasks[0]?.memory.confirmedFacts).toEqual(['second'])
    expect(store.eventLog).toHaveLength(3)
  })

  it('deduplicates events and projects blocked and done states', () => {
    const store = useTaskStore()
    const blocked = {
      type: 'task:blocked',
      data: {
        id: 'event-blocked',
        taskId: 'task-2',
        memory: memory('active', [], 30),
        needsInput: 'Choose whether to retry',
      },
    } satisfies WebSocketEventOf<'task:blocked'>
    const done = {
      type: 'task:done',
      data: {
        id: 'event-done',
        taskId: 'task-2',
        memory: memory('done', ['complete'], 40),
        conclusion: 'The build passed',
      },
    } satisfies WebSocketEventOf<'task:done'>

    expect(store.ingest(blocked)).toBe(true)
    expect(store.ingest(blocked)).toBe(false)
    store.ingest(done)

    expect(store.tasks[0]?.status).toBe('done')
    expect(store.tasks[0]?.conclusion).toBe('The build passed')
    expect(store.activeTasks).toHaveLength(0)
  })

  // ROOT CAUSE:
  //
  // A task:start event has no protocol timestamp. Replaying the event log
  // called Date.now() during every computed projection and reset startedAt.
  it('keeps the received start time stable across later projections', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    const store = useTaskStore()
    store.ingest({
      type: 'task:start',
      data: { id: 'start', taskId: 'task-1', goal: 'Watch', kind: 'ci' },
    })
    expect(store.tasks[0]?.startedAt).toBe(1_000)

    now.mockReturnValue(5_000)
    store.ingest({
      type: 'task:progress',
      data: { id: 'progress', taskId: 'task-1', memory: memory('active', [], 5_000) },
    })

    expect(store.tasks[0]?.startedAt).toBe(1_000)
    now.mockRestore()
  })
})
