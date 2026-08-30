import type { PlanSpec } from '@proj-airi/core-agent'

import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { usePlanStore } from './plans'

const persistence = vi.hoisted(() => ({
  loadPlans: vi.fn(),
  savePlan: vi.fn(),
  softDeletePlan: vi.fn(),
}))

vi.mock('../composables/use-duck-db', () => ({
  useDuckDb: () => ({
    db: { value: { execute: vi.fn() } },
    getDb: vi.fn().mockResolvedValue(undefined),
  }),
}))

vi.mock('../services/memory/local-memory', () => ({
  createDuckDbMemoryRepository: () => persistence,
}))

const SPEC: PlanSpec = {
  goal: 'Verify a coding change',
  horizon: 'session',
  steps: [{
    id: 'verify',
    lane: 'coding',
    intent: 'Run the focused tests',
    allowedTools: ['bash'],
    expectedEvidence: [{ source: 'tool_result', description: 'tests pass' }],
    riskLevel: 'low',
    approvalRequired: false,
  }],
}

describe('plan store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.stubGlobal('location', new URL('http://localhost/?synced-leader=true'))
    persistence.loadPlans.mockReset().mockResolvedValue([])
    persistence.savePlan.mockReset().mockResolvedValue(undefined)
    persistence.softDeletePlan.mockReset().mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('keeps a plan blocked until trusted tool evidence completes its gate', async () => {
    const store = usePlanStore()
    const id = await store.start(SPEC, 'plan-1')

    expect(id).toBe('plan-1')
    expect(store.planViews[0]?.status).toBe('blocked')
    expect(store.planViews[0]?.state.completedSteps).toEqual([])

    await store.recordToolResult({
      planId: id,
      stepId: 'verify',
      toolName: 'bash',
      ok: true,
      summary: 'tests pass',
      provenance: 'builtin',
    })

    expect(store.planViews[0]?.status).toBe('completed')
    expect(store.planViews[0]?.state.completedSteps).toEqual(['verify'])
    expect(persistence.savePlan).toHaveBeenLastCalledWith(expect.objectContaining({
      id: 'plan-1',
      state: expect.objectContaining({ completedSteps: ['verify'] }),
    }))
  })

  it('hydrates the persisted state snapshot when the journal is empty', async () => {
    persistence.loadPlans.mockResolvedValueOnce([{
      id: 'plan-restored',
      spec: SPEC,
      state: {
        currentStepId: 'verify',
        completedSteps: [],
        failedSteps: [],
        skippedSteps: [],
        evidenceRefs: [{ stepId: 'prepare', source: 'tool_result', summary: 'prepared' }],
        blockers: ['waiting for the test runner'],
      },
      status: 'blocked',
      createdAt: 10,
      updatedAt: 20,
    }])

    const store = usePlanStore()
    await store.initialize()

    expect(store.planViews[0]).toEqual(expect.objectContaining({
      id: 'plan-restored',
      updatedAt: 20,
      state: expect.objectContaining({
        currentStepId: 'verify',
        blockers: ['waiting for the test runner'],
      }),
    }))
  })

  it('rewrites an active long goal without changing its id or row count', async () => {
    const store = usePlanStore()
    const longSpec = { ...SPEC, goal: 'Maintain the workspace', horizon: 'long' as const }
    const id = await store.start(longSpec, 'goal-1')

    const rewrittenId = await store.start({
      ...longSpec,
      steps: [{ ...longSpec.steps[0]!, id: 'next', intent: 'Inspect the next change' }],
    })

    expect(rewrittenId).toBe(id)
    expect(store.plans).toHaveLength(1)
    expect(store.plans[0]?.spec.steps[0]?.id).toBe('next')
    expect(persistence.savePlan).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'goal-1' }))
  })

  it('does not open or write DuckDB in a follower window', async () => {
    vi.stubGlobal('location', new URL('http://localhost/?synced-leader=false'))
    const store = usePlanStore()

    await store.initialize()
    await store.start(SPEC, 'follower-plan')

    expect(persistence.loadPlans).not.toHaveBeenCalled()
    expect(persistence.savePlan).not.toHaveBeenCalled()
  })
})
