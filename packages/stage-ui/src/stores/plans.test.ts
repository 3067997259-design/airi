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

  it('keeps a paused plan visible but removes it from runnable session plans', async () => {
    const store = usePlanStore()
    await store.start(SPEC, 'plan-paused', { sessionId: 'session-1' })

    await store.pausePlan('plan-paused')

    expect(store.planViews.find(plan => plan.id === 'plan-paused')?.state.paused).toBe(true)
    expect(store.scopedActivePlans('session-1').map(plan => plan.id)).not.toContain('plan-paused')

    await store.resumePlan('plan-paused')
    expect(store.scopedActivePlans('session-1').map(plan => plan.id)).toContain('plan-paused')
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

  it('advances the focus to the next unresolved step once evidence completes one', async () => {
    // ROOT CAUSE:
    //
    // currentStepId was derived only from steps the gate marked in_progress or
    // blocked. The moment a step completed, no step held either status, the
    // fallback snapshot pointed at the finished step and was dropped, and the
    // projection stopped naming any step at all — so the model had nothing to
    // focus and the plan stalled with work left (HARNESS-PLAN §4.1).
    const twoSteps: PlanSpec = {
      ...SPEC,
      steps: [
        SPEC.steps[0],
        {
          id: 'report',
          lane: 'coding',
          intent: 'Summarize the result',
          allowedTools: ['read'],
          expectedEvidence: [{ source: 'tool_result', description: 'summary read' }],
          riskLevel: 'low',
          approvalRequired: false,
        },
      ],
    }
    const store = usePlanStore()
    const id = await store.start(twoSteps, 'plan-advance')

    expect(store.planViews[0]?.state.currentStepId).toBe('verify')

    await store.recordToolResult({
      planId: id,
      stepId: 'verify',
      toolName: 'bash',
      ok: true,
      summary: 'tests pass',
      provenance: 'builtin',
    })

    // No focusStep call happened; the next step is derived from the gate.
    expect(store.planViews[0]?.state.completedSteps).toEqual(['verify'])
    expect(store.planViews[0]?.state.currentStepId).toBe('report')
    expect(store.planViews[0]?.status).toBe('in_progress')
  })

  it('reports a failed plan database instead of dropping plans in silence', async () => {
    // ROOT CAUSE:
    //
    // A failed hydration only reached console.warn, so a session ran with no
    // persistence at all and the user learned about it when the plans were
    // gone after a restart (HARNESS-PLAN §0.2 R4).
    persistence.loadPlans.mockRejectedValueOnce(new Error('OPFS handle is busy'))
    const store = usePlanStore()

    await store.initialize()

    expect(store.persistence).toEqual({ status: 'failed', error: 'OPFS handle is busy' })

    // The chip's retry button re-opens the database and clears the state.
    persistence.loadPlans.mockResolvedValue([])
    expect(await store.retryPersistence()).toEqual({ status: 'ready' })
  })

  it('reports a follower window as unavailable rather than failed', async () => {
    vi.stubGlobal('location', new URL('http://localhost/?synced-leader=false'))
    const store = usePlanStore()

    await store.initialize()

    expect(store.persistence.status).toBe('unavailable')
  })

  it('reports a failing save without stopping the plan', async () => {
    const store = usePlanStore()
    await store.start(SPEC, 'plan-save-failure')
    persistence.savePlan.mockRejectedValueOnce(new Error('disk is full'))

    await store.persistPlan('plan-save-failure')

    expect(store.persistence).toEqual({ status: 'failed', error: 'disk is full' })
    expect(store.planViews.find(plan => plan.id === 'plan-save-failure')).toBeDefined()
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

  // pinia-plugin-synced structuredClones every synchronized action result;
  // focusStep used to return the reactive step proxy, which threw "could not
  // be cloned" in the live app (plan_update focus failed on Window). The
  // returned snapshot must stay clone-safe.
  it('returns a structuredClone-safe snapshot from focusStep', async () => {
    const store = usePlanStore()
    await store.start(SPEC, 'plan-1')

    const step = await store.focusStep('plan-1', 'verify')

    expect(step?.id).toBe('verify')
    expect(() => structuredClone(step)).not.toThrow()
  })
})
