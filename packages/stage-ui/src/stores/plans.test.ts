import type { PlanSpec, PlanState } from '@proj-airi/core-agent'

import type { PlanView } from './plans'

import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { beginRestoreGate, completeRestoreGate } from '../services/restore-gate'
import { useJournalStore } from './journal'
import { findLongPlanOwningRun, formatRecentPlanProjection, hasOpenPlanSteps, installLongGoalRevisionHandler, planSurfaceLane, planSurfaceLanes, resolveFlowEvidencePlan, selectFlowCompletionPlans, usePlanStore } from './plans'

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

// ROOT CAUSE:
//
// `authorizeFlowToolExecution` resolved the owning long plan only through
// `goal.activeRun` while the goal was `running`. A constraint revision clears
// `activeRun`, so a resumed Flow without a `planId` resolved no plan, fell
// through the `!plan` branch, and the late mutation was allowed. Ownership now
// resolves from `activeRun` or the durable `lastRun` identity.
describe('findLongPlanOwningRun', () => {
  const run = { sessionId: 'session-1', flowId: 'flow-1', taskId: 'task-1' }

  function view(horizon: PlanSpec['horizon'], longGoal: PlanState['longGoal']): PlanView {
    return {
      id: 'plan-1',
      goal: 'long goal',
      spec: { ...SPEC, horizon },
      state: { longGoal } as PlanState,
      status: 'pending',
      updatedAt: 1000,
    }
  }

  it('matches the live active run', () => {
    const plan = view('long', { lifecycle: 'running', constraintVersion: 1, activeRun: { ...run, startedAt: 1 } })
    expect(findLongPlanOwningRun([plan], run)?.id).toBe('plan-1')
  })

  it('matches a run that a revision moved out of activeRun', () => {
    const plan = view('long', { lifecycle: 'executable', constraintVersion: 2, lastRun: { ...run, startedAt: 1 } })
    expect(findLongPlanOwningRun([plan], run)?.id).toBe('plan-1')
  })

  it('ignores session-horizon plans', () => {
    const plan = view('session', { lifecycle: 'running', constraintVersion: 1, activeRun: { ...run, startedAt: 1 } })
    expect(findLongPlanOwningRun([plan], run)).toBeUndefined()
  })

  it('ignores a different run identity', () => {
    const plan = view('long', { lifecycle: 'running', constraintVersion: 1, activeRun: { ...run, flowId: 'flow-2', startedAt: 1 } })
    expect(findLongPlanOwningRun([plan], run)).toBeUndefined()
  })
})

describe('planSurfaceLane', () => {
  // ROOT CAUSE:
  //
  // Chat rendered every plan in the store: long goals from other sessions and
  // terminal goals stayed forever, so dozens of completed/cancelled cards
  // accumulated in the timeline across sessions (2026-09-11 field report).
  // The lane keeps live current work in the timeline and routes the rest to
  // the plan center.
  function view(
    id: string,
    options: { horizon?: PlanSpec['horizon'], sessionId?: string, status?: PlanView['status'], unverified?: string[] } = {},
  ): PlanView {
    return {
      id,
      goal: id,
      spec: { ...SPEC, horizon: options.horizon ?? 'session' },
      state: {
        completedSteps: [],
        failedSteps: [],
        skippedSteps: [],
        evidenceRefs: [],
        blockers: [],
        ...(options.unverified ? { unverifiedSteps: options.unverified } : {}),
      } as PlanState,
      status: options.status ?? 'in_progress',
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      updatedAt: 1,
    }
  }

  it('keeps a live plan of the shown session on the timeline', () => {
    expect(planSurfaceLane(view('p', { sessionId: 's1' }), 's1')).toBe('current')
  })

  it('routes a live goal of another session to the plan center', () => {
    expect(planSurfaceLane(view('p', { horizon: 'long', sessionId: 's2' }), 's1')).toBe('other-session')
  })

  it('routes a plan with no session binding to the unattributed lane', () => {
    expect(planSurfaceLane(view('p'), 's1')).toBe('unattributed')
  })

  it('archives finished goals so they cannot pile up in the timeline', () => {
    expect(planSurfaceLane(view('p', { sessionId: 's1', status: 'completed' }), 's1')).toBe('archived')
    expect(planSurfaceLane(view('p', { sessionId: 's1', status: 'cancelled' }), 's1')).toBe('archived')
    expect(planSurfaceLane(view('p', { sessionId: 's1', status: 'failed' }), 's1')).toBe('archived')
  })

  it('archives a completed plan with unverified steps instead of treating it as live work', () => {
    // Invariant 6 keeps the amber unverified mark on the card and the plan
    // center counts it separately; the chat body only shows active work
    // (invariant 5), and nine such cards stacked in one session during the
    // 2026-09-11 acceptance run.
    expect(planSurfaceLane(view('p', { sessionId: 's1', status: 'completed', unverified: ['verify'] }), 's1')).toBe('archived')
  })

  it('archives session plans superseded by a newer plan in the same lane', () => {
    // The session lane holds one standing plan: a newer start replaces the
    // older record for the gate and the evidence channel, so the older one
    // must not render as live work.
    const older = view('older', { sessionId: 's1' })
    const newer = view('newer', { sessionId: 's1' })
    const lanes = planSurfaceLanes([older, newer], 's1')

    expect(lanes.get('older')).toBe('archived')
    expect(lanes.get('newer')).toBe('current')
  })

  it('keeps the standing plan of every session lane independent', () => {
    const currentSessionPlan = view('current-plan', { sessionId: 's1' })
    const otherSessionPlan = view('other-plan', { sessionId: 's2' })
    const lanes = planSurfaceLanes([currentSessionPlan, otherSessionPlan], 's1')

    expect(lanes.get('current-plan')).toBe('current')
    expect(lanes.get('other-plan')).toBe('other-session')
  })
})

describe('selectFlowCompletionPlans', () => {
  // ROOT CAUSE:
  //
  // `evaluateFlowCompletion` evaluated every plan the flow had touched. A long
  // goal replan creates a new plan and leaves the previous one behind, so the
  // abandoned predecessor's steps could never complete and the gate rejected
  // the declaration forever with "step has not started".
  function view(
    id: string,
    horizon: PlanSpec['horizon'],
    options: { sessionId?: string, status?: PlanView['status'], paused?: boolean } = {},
  ): PlanView {
    return {
      id,
      goal: id,
      spec: { ...SPEC, horizon },
      state: {
        completedSteps: [],
        failedSteps: [],
        skippedSteps: [],
        evidenceRefs: [],
        blockers: [],
        ...(options.paused ? { paused: true } : {}),
      } as PlanState,
      status: options.status ?? 'pending',
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      updatedAt: 1,
    }
  }

  it('keeps only the newest touched long plan across a replan', () => {
    const plans = [
      view('long-old', 'long', { sessionId: 's1' }),
      view('long-new', 'long', { sessionId: 's1' }),
    ]
    // A replan by the running flow stamps both plans' events with the flow's
    // task, so both are touched and the newest must win.
    const selected = selectFlowCompletionPlans(plans, { sessionId: 's1', touchedPlanIds: new Set(['long-old', 'long-new']) })
    expect(selected.map(plan => plan.id)).toEqual(['long-new'])
  })

  it('holds the flow on the goal it touched, not on a newer untouched goal', () => {
    // Two live long goals share one session. A flow that runs goal A must not
    // be held open by goal B's steps, whatever their relative age.
    const plans = [
      view('goal-a', 'long', { sessionId: 's1' }),
      view('goal-b', 'long', { sessionId: 's1' }),
    ]
    const selected = selectFlowCompletionPlans(plans, { sessionId: 's1', touchedPlanIds: new Set(['goal-a']) })
    expect(selected.map(plan => plan.id)).toEqual(['goal-a'])
  })

  it('ignores zombie session plans behind a newer standing plan', () => {
    // ROOT CAUSE:
    //
    // ACC-20260909 FIX1 retest (journal 40ae9ae5, rejection at seq 4322):
    // every session plan the model had ever started in the chat session kept
    // its open steps in the completion conjunction — twelve plans across two
    // days, thirty-one blockers. A plan behind a newer plan in the session
    // lane is replaced by definition; only the lane's newest plan may hold
    // the flow open.
    const plans = [
      view('zombie-1', 'session', { sessionId: 's1', status: 'blocked' }),
      view('zombie-2', 'session', { sessionId: 's1', status: 'pending' }),
      view('standing', 'session', { sessionId: 's1' }),
    ]
    const selected = selectFlowCompletionPlans(plans, { sessionId: 's1', touchedPlanIds: new Set(['zombie-1', 'zombie-2', 'standing']) })
    expect(selected.map(plan => plan.id)).toEqual(['standing'])
  })

  it('keeps the newest session plan even when it already completed', () => {
    // A completed newest plan still names its unverified closures in the
    // wrap-up, and its completion retires the whole lane behind it.
    const plans = [
      view('zombie', 'session', { sessionId: 's1' }),
      view('newest-done', 'session', { sessionId: 's1', status: 'completed' }),
    ]
    const selected = selectFlowCompletionPlans(plans, { sessionId: 's1', touchedPlanIds: new Set(['zombie', 'newest-done']) })
    expect(selected.map(plan => plan.id)).toEqual(['newest-done'])
  })

  it('keeps only the newest long plan when neither carries a session binding', () => {
    const plans = [
      view('long-old', 'long'),
      view('long-new', 'long'),
    ]
    const selected = selectFlowCompletionPlans(plans, {
      sessionId: 's1',
      touchedPlanIds: new Set(['long-old', 'long-new']),
    })
    expect(selected.map(plan => plan.id)).toEqual(['long-new'])
  })

  it('keeps a touched session plan even when it already completed', () => {
    const plans = [
      view('sess-touched', 'session', { sessionId: 's1', status: 'completed' }),
      view('sess-other', 'session', { sessionId: 's2' }),
    ]
    const selected = selectFlowCompletionPlans(plans, { sessionId: 's1', touchedPlanIds: new Set(['sess-touched']) })
    expect(selected.map(plan => plan.id)).toEqual(['sess-touched'])
  })

  it('keeps an active session plan of the flow session', () => {
    const selected = selectFlowCompletionPlans([view('sess-active', 'session', { sessionId: 's1' })], {
      sessionId: 's1',
      touchedPlanIds: new Set(),
    })
    expect(selected.map(plan => plan.id)).toEqual(['sess-active'])
  })

  it('drops a paused session plan', () => {
    const selected = selectFlowCompletionPlans([view('sess-paused', 'session', { sessionId: 's1', paused: true })], {
      sessionId: 's1',
      touchedPlanIds: new Set(),
    })
    expect(selected).toEqual([])
  })

  it('drops a touched plan that can no longer hold open work', () => {
    // ROOT CAUSE:
    //
    // ACC-20260909 FIX1: the touched-plan branch bypassed every terminal
    // filter, so a paused or failed plan the flow had touched kept its open
    // steps in the conjunction forever. Being touched proves attribution, not
    // liveness.
    const plans = [
      view('sess-failed', 'session', { sessionId: 's1', status: 'failed' }),
      view('sess-paused', 'session', { sessionId: 's1', paused: true }),
    ]
    const selected = selectFlowCompletionPlans(plans, { sessionId: 's1', touchedPlanIds: new Set(['sess-failed', 'sess-paused']) })
    expect(selected).toEqual([])
  })

  it('keeps a session-less long plan only when the flow touched it', () => {
    const plans = [view('long-detached', 'long')]
    expect(selectFlowCompletionPlans(plans, { sessionId: 's1', touchedPlanIds: new Set() })).toEqual([])
    const touched = selectFlowCompletionPlans(plans, { sessionId: 's1', touchedPlanIds: new Set(['long-detached']) })
    expect(touched.map(plan => plan.id)).toEqual(['long-detached'])
  })
})

describe('resolveFlowEvidencePlan', () => {
  // ROOT CAUSE:
  //
  // ACC-20260909 FIX1 (journal 40ae9ae5, flow 52yJKrJH): the send path bound
  // the newest ACTIVE session plan, but a completed-with-unverified plan
  // stays active forever. Every tool receipt of that flow went out unstamped
  // because the bound plan had no open step to accept it, so the completion
  // gate never saw evidence for the live plan and rejected the declaration
  // five times while the model rebuilt plan after plan.
  function view(id: string, options: { completed?: boolean, sessionId?: string, horizon?: PlanSpec['horizon'] } = {}): PlanView {
    return {
      id,
      goal: id,
      spec: { ...SPEC, ...(options.horizon ? { horizon: options.horizon } : {}) },
      state: {
        completedSteps: options.completed ? ['verify'] : [],
        failedSteps: [],
        skippedSteps: [],
        evidenceRefs: [],
        blockers: [],
      } as PlanState,
      status: options.completed ? 'completed' : 'pending',
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      updatedAt: 1,
    }
  }

  it('returns the bound plan while it still has open steps', () => {
    const plans = [view('bound', { sessionId: 's1' })]
    expect(resolveFlowEvidencePlan(plans, { sessionId: 's1', boundPlanId: 'bound' })?.id).toBe('bound')
  })

  it('falls back to the newest open plan when the bound plan has none left', () => {
    const plans = [
      view('done-old', { completed: true, sessionId: 's1' }),
      view('live', { sessionId: 's1' }),
    ]
    expect(resolveFlowEvidencePlan(plans, { sessionId: 's1', boundPlanId: 'done-old' })?.id).toBe('live')
  })

  it('falls back when the bound plan id is unknown', () => {
    const plans = [view('live', { sessionId: 's1' })]
    expect(resolveFlowEvidencePlan(plans, { sessionId: 's1', boundPlanId: 'ghost' })?.id).toBe('live')
  })

  it('returns undefined when no scoped plan can collect evidence', () => {
    const plans = [view('done-old', { completed: true, sessionId: 's1' })]
    expect(resolveFlowEvidencePlan(plans, { sessionId: 's1', boundPlanId: 'done-old' })).toBeUndefined()
    expect(hasOpenPlanSteps(plans[0]!)).toBe(false)
  })
})

describe('plan store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.stubGlobal('location', new URL('http://localhost/?synced-leader=true'))
    persistence.loadPlans.mockReset().mockResolvedValue([])
    persistence.savePlan.mockReset().mockResolvedValue(undefined)
    persistence.softDeletePlan.mockReset().mockResolvedValue(undefined)
  })

  afterEach(() => {
    completeRestoreGate()
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

  it('adds exploration tools structurally to mutation steps', async () => {
    const store = usePlanStore()
    await store.start(SPEC, 'plan-normalized')

    expect(store.planViews[0]?.spec.steps[0]?.allowedTools).toEqual(['bash', 'read', 'grep', 'list'])
  })

  it('keeps a model-completed unverified plan in the active set', async () => {
    const store = usePlanStore()
    const id = await store.start(SPEC, 'plan-unverified')

    await store.completeStep(id, 'verify', 'The model declared completion before running the tests.')

    expect(store.planViews[0]?.status).toBe('completed')
    expect(store.planViews[0]?.state.unverifiedSteps).toEqual(['verify'])
    expect(store.activePlans.map(plan => plan.id)).toContain(id)
  })

  it('keeps a declared completion blocked while approval is pending', async () => {
    const store = usePlanStore()
    const approvalSpec: PlanSpec = {
      ...SPEC,
      steps: [{ ...SPEC.steps[0]!, approvalRequired: true }],
    }
    const id = await store.start(approvalSpec, 'plan-approval-boundary')

    await store.completeStep(id, 'verify', 'The model declared completion before approval.')

    expect(store.planViews[0]?.status).toBe('blocked')
    expect(store.planViews[0]?.state.completedSteps).toEqual([])
    expect(store.planViews[0]?.state.unverifiedSteps).toEqual([])
    expect(store.planViews[0]?.state.blockers).toEqual(['approval required: verify'])
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
    const longSpec = {
      ...SPEC,
      goal: 'Maintain the workspace',
      horizon: 'long' as const,
      scope: { userId: 'local', characterId: 'default' },
      workspaceRoot: 'D:/workspace',
    }
    const id = await store.start(longSpec, 'goal-1')

    expect(store.planViews[0]?.state.longGoal).toMatchObject({ lifecycle: 'executable', constraintVersion: 1 })
    await store.completeStep(id, longSpec.steps[0]!.id)

    const rewrittenId = await store.start({
      ...longSpec,
      steps: [{ ...longSpec.steps[0]!, id: 'next', intent: 'Inspect the next change' }],
    })

    expect(rewrittenId).toBe(id)
    expect(store.plans).toHaveLength(1)
    expect(store.plans[0]?.spec.steps[0]?.id).toBe('next')
    expect(store.planViews[0]?.state.longGoal).toMatchObject({ lifecycle: 'executable', constraintVersion: 2 })
    expect(store.planViews[0]?.state.completedSteps).toEqual([])
    expect(persistence.savePlan).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'goal-1' }))
  })

  it('notifies the active Flow before revising long-goal constraints', async () => {
    const store = usePlanStore()
    const longSpec = {
      ...SPEC,
      horizon: 'long' as const,
      scope: { userId: 'local', characterId: 'default' },
      workspaceRoot: 'D:/workspace',
    }
    const id = await store.start(longSpec, 'goal-revision-bridge')
    const run = { taskId: 'task-revision', flowId: 'flow-revision', sessionId: 'session-1', startedAt: 100 }
    await store.transitionLongGoal(id, {
      lifecycle: 'running',
      reason: 'scheduler claimed the run',
      source: 'scheduler',
      timestamp: 100,
      run,
    })

    const handler = vi.fn()
    const dispose = installLongGoalRevisionHandler(handler)
    try {
      await store.start({ ...longSpec, goal: 'Revised workspace goal' })
    }
    finally {
      dispose()
    }

    expect(handler).toHaveBeenCalledWith({
      planId: id,
      run,
      constraintVersion: 2,
      reason: 'long-goal constraints revised',
    })
  })

  it('does not hydrate the empty database while profile import is pending', async () => {
    // ROOT CAUSE:
    // Normal boot initialized the plan owner concurrently with restore. It
    // cached the empty database before the archived plans were imported.
    beginRestoreGate()
    const store = usePlanStore()
    const initializing = store.initialize()
    await new Promise(resolve => setTimeout(resolve, 25))
    expect(persistence.loadPlans).not.toHaveBeenCalled()
    completeRestoreGate()
    await initializing
    expect(persistence.loadPlans).toHaveBeenCalledOnce()
  })

  it('keeps a long goal waiting when a persisted row has no execution scope', async () => {
    persistence.loadPlans.mockResolvedValueOnce([{
      id: 'legacy-goal',
      spec: { ...SPEC, horizon: 'long' },
      state: {
        completedSteps: [],
        failedSteps: [],
        skippedSteps: [],
        evidenceRefs: [],
        blockers: [],
      },
      status: 'blocked',
      createdAt: 10,
      updatedAt: 20,
    }])

    const store = usePlanStore()
    await store.initialize()

    expect(store.planViews[0]?.state.longGoal).toMatchObject({
      lifecycle: 'waiting-condition',
      waitReason: 'This goal has no execution scope. Review it before running.',
    })
    expect(store.planViews[0]?.status).toBe('blocked')
  })

  it('keeps long-goal evidence in the plan origin session', async () => {
    const journal = useJournalStore()
    const store = usePlanStore()
    const sessionId = 'goal-origin-session'
    const id = await store.start({
      ...SPEC,
      horizon: 'long',
      scope: { userId: 'local', characterId: 'default' },
      workspaceRoot: 'D:/workspace',
    }, 'goal-origin', { sessionId })

    expect(store.planViews.find(plan => plan.id === id)?.sessionId).toBe(sessionId)
    expect(journal.snapshotSession(sessionId)).toContainEqual(expect.objectContaining({
      type: 'plan/update',
      planId: id,
    }))
    expect(journal.snapshotSession('stage-session')).not.toContainEqual(expect.objectContaining({ planId: id }))
  })

  it('ignores a late completion from a superseded long-goal run', async () => {
    const store = usePlanStore()
    const longSpec = {
      ...SPEC,
      goal: 'Keep the workspace healthy',
      horizon: 'long' as const,
      scope: { userId: 'local', characterId: 'default' },
      workspaceRoot: 'D:/workspace',
    }
    const id = await store.start(longSpec, 'goal-stale')
    const run = { taskId: 'task-old', flowId: 'flow-old', sessionId: 'session-1', startedAt: 100 }

    await store.transitionLongGoal(id, {
      lifecycle: 'running',
      reason: 'scheduler claimed the run',
      source: 'scheduler',
      timestamp: 100,
      run,
    })
    await store.start({ ...longSpec, goal: 'Revised workspace goal' })
    await store.transitionLongGoal(id, {
      lifecycle: 'completed',
      reason: 'late old run completed',
      source: 'flow',
      timestamp: 200,
      run: { ...run, endedAt: 200, outcome: 'completed' },
    })

    expect(store.planViews[0]?.state.longGoal).toMatchObject({ lifecycle: 'executable', constraintVersion: 2 })
  })

  it('keeps the last accepted run environment visible after a failed retry', async () => {
    const store = usePlanStore()
    const longSpec = {
      ...SPEC,
      goal: 'Keep the workspace healthy',
      horizon: 'long' as const,
      scope: { userId: 'local', characterId: 'default' },
      workspaceRoot: 'D:/workspace',
    }
    const id = await store.start(longSpec, 'goal-environment')
    const environment = {
      providerId: 'provider-a',
      modelId: 'model-a',
      workspaceRoot: 'D:/workspace',
      toolNames: ['list', 'read'],
    }
    const run = { taskId: 'task-environment', flowId: 'flow-environment', sessionId: 'session-1', startedAt: 100 }

    await store.transitionLongGoal(id, {
      lifecycle: 'running',
      reason: 'scheduler claimed the run',
      source: 'scheduler',
      timestamp: 100,
      run,
      environment,
    })
    await store.transitionLongGoal(id, {
      lifecycle: 'waiting-condition',
      reason: 'provider changed while the goal was asleep',
      source: 'flow',
      timestamp: 200,
      nextReviewAt: 300,
      waitReason: 'provider changed while the goal was asleep',
      run: { ...run, endedAt: 200, outcome: 'failed' },
    })

    expect(store.planViews[0]?.state.longGoal).toMatchObject({
      lifecycle: 'waiting-condition',
      lastEnvironment: environment,
    })
  })

  it('does not let a late run completion revive a cancelled long goal', async () => {
    const store = usePlanStore()
    const longSpec = {
      ...SPEC,
      goal: 'Keep the workspace healthy',
      horizon: 'long' as const,
      scope: { userId: 'local', characterId: 'default' },
      workspaceRoot: 'D:/workspace',
    }
    const id = await store.start(longSpec, 'goal-cancelled')
    const run = { taskId: 'task-cancelled', flowId: 'flow-cancelled', sessionId: 'session-1', startedAt: 100 }

    await store.transitionLongGoal(id, {
      lifecycle: 'running',
      reason: 'scheduler claimed the run',
      source: 'scheduler',
      timestamp: 100,
      run,
    })
    await store.cancelLongGoal(id)
    await store.transitionLongGoal(id, {
      lifecycle: 'completed',
      reason: 'late completion after cancellation',
      source: 'flow',
      timestamp: 200,
      run: { ...run, endedAt: 200, outcome: 'completed' },
    })

    expect(store.planViews[0]?.state.longGoal?.lifecycle).toBe('cancelled')
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

  it('stamps plan updates with the open flow task and attributes nothing without one', async () => {
    // TASK-RUN-AND-UI-PLAN A: plan events join the task whose flow is open at
    // write time; plan activity outside any flow stays unattributed.
    const journal = useJournalStore()
    const store = usePlanStore()

    await store.start(SPEC, 'plan-unattributed', { sessionId: 'session-1' })
    expect(journal.events.filter(event => event.type === 'plan/update'))
      .toEqual(expect.not.arrayContaining([expect.objectContaining({ taskId: expect.any(String) })]))

    journal.appendActive({ type: 'flow/start', flowId: 'f1', taskId: 't1', trigger: 'command', timestamp: 1 })
    await store.updateStep('plan-unattributed', 'verify', 'in_progress')

    const stamped = journal.events.filter(event => event.type === 'plan/update' && (event as { taskId?: string }).taskId === 't1')
    expect(stamped).toHaveLength(1)
    expect(stamped[0]).toMatchObject({ planId: 'plan-unattributed', stepId: 'verify' })
  })

  it('applies a deterministic goal revision for a /goal send during a running flow', async () => {
    // ROOT CAUSE:
    //
    // ACC-20260910 REV (journal 40ae9ae5, seq 4885): a /goal revision sent
    // while a Flow runs is consumed as steering text, and the structured
    // revision that plan_update start would perform never happens. The goal
    // plan kept its obsolete eight-step spec, the completion conjunction
    // held those steps open, and the model improvised a session plan for the
    // revised work. The revision transition is now deterministic.
    const journal = useJournalStore()
    const store = usePlanStore()
    await store.start({
      ...SPEC,
      horizon: 'long',
      scope: { userId: 'local', characterId: 'default' },
      workspaceRoot: 'D:/workspace',
    }, 'goal-revise', { sessionId: 'session-1' })

    const revised = await store.reviseLongGoalConstraints('session-1')

    expect(revised).toBe(true)
    expect(store.planViews[0]?.state.longGoal).toMatchObject({ lifecycle: 'executable', constraintVersion: 2 })
    expect(journal.snapshotSession('session-1')).toContainEqual(expect.objectContaining({
      type: 'goal/update',
      goalId: 'goal-revise',
      revision: true,
      constraintVersion: 2,
      reason: 'long-goal constraints revised',
    }))
  })

  it('interrupts the active run of a goal it revises, like a start-time revision', async () => {
    const store = usePlanStore()
    const longSpec = {
      ...SPEC,
      horizon: 'long' as const,
      scope: { userId: 'local', characterId: 'default' },
      workspaceRoot: 'D:/workspace',
    }
    await store.start(longSpec, 'goal-revise-run', { sessionId: 'session-1' })
    const run = { taskId: 'task-1', flowId: 'flow-1', sessionId: 'session-1', startedAt: 100 }
    await store.transitionLongGoal('goal-revise-run', {
      lifecycle: 'running',
      reason: 'scheduler claimed the run',
      source: 'scheduler',
      timestamp: 100,
      run,
    })

    const handler = vi.fn()
    const dispose = installLongGoalRevisionHandler(handler)
    try {
      await store.reviseLongGoalConstraints('session-1')
    }
    finally {
      dispose()
    }

    expect(handler).toHaveBeenCalledWith({
      planId: 'goal-revise-run',
      run,
      constraintVersion: 2,
      reason: 'long-goal constraints revised',
    })
  })

  it('revises nothing when the session has no live long goal', async () => {
    const store = usePlanStore()
    expect(await store.reviseLongGoalConstraints('session-1')).toBe(false)

    await store.start({
      ...SPEC,
      horizon: 'long',
      scope: { userId: 'local', characterId: 'default' },
      workspaceRoot: 'D:/workspace',
    }, 'goal-dead', { sessionId: 'session-1' })
    await store.cancelLongGoal('goal-dead')

    expect(await store.reviseLongGoalConstraints('session-1')).toBe(false)
    expect(store.planViews.find(plan => plan.id === 'goal-dead')?.state.longGoal).toMatchObject({ constraintVersion: 1 })
  })
})

describe('formatRecentPlanProjection', () => {
  function view(id: string, status: PlanView['status'], updatedAt: number): PlanView {
    return {
      id,
      goal: `Goal of ${id}`,
      spec: SPEC,
      state: {
        completedSteps: [],
        failedSteps: [],
        skippedSteps: [],
        evidenceRefs: [],
        blockers: [],
        unverifiedSteps: status === 'completed' ? [] : ['verify'],
      },
      status,
      updatedAt,
    }
  }

  it('summarizes finished plans and ignores live ones (mq-2 m07)', () => {
    const text = formatRecentPlanProjection([
      view('plan-live', 'in_progress', 30),
      view('plan-done', 'completed', 20),
      view('plan-failed', 'failed', 10),
    ])

    expect(text).toContain('Recent work')
    expect(text).toContain('[plan:plan-done]')
    expect(text).toContain('unverified: none')
    expect(text).toContain('[plan:plan-failed]')
    expect(text).toContain('unverified: verify')
    expect(text).not.toContain('plan-live')
    expect(text).toContain('never present an unverified or unfinished step as done')
  })

  it('returns nothing without finished history', () => {
    expect(formatRecentPlanProjection([view('plan-live', 'in_progress', 30)])).toBe('')
    expect(formatRecentPlanProjection([])).toBe('')
  })
})
