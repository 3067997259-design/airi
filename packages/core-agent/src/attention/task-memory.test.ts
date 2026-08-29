import { describe, expect, it } from 'vitest'

import { normalizeTaskMemory, TASK_MEMORY_LIMITS } from './task-memory'

describe('task memory normalization', () => {
  it('bounds long fields and deduplicates repeated facts', () => {
    const snapshot = normalizeTaskMemory({
      status: 'active',
      goal: 'g'.repeat(TASK_MEMORY_LIMITS.goal + 50),
      confirmedFacts: ['same', 'same', 'f'.repeat(TASK_MEMORY_LIMITS.fact + 50)],
      sourceTurnId: 'turn-1',
    })

    expect(snapshot.goal).toHaveLength(TASK_MEMORY_LIMITS.goal)
    expect(snapshot.confirmedFacts).toEqual(['same', 'f'.repeat(TASK_MEMORY_LIMITS.fact)])
  })

  it('rejects invalid status and artifact shapes', () => {
    const snapshot = normalizeTaskMemory({
      status: 'invalid',
      artifacts: [{ label: 'file', value: 'a', kind: 'unknown' }],
    }, { status: 'blocked', sourceTurnId: 'turn-2' })

    expect(snapshot.status).toBe('blocked')
    expect(snapshot.artifacts).toEqual([])
  })
})
