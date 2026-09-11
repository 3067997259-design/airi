import { evaluateFlowCompletion, flowCompletionStepInputs } from '@proj-airi/core-agent'
import { installCodingHostClient, useCodingToolsStore } from '@proj-airi/stage-ui/stores/coding'
import { useJournalStore } from '@proj-airi/stage-ui/stores/journal'
import { selectFlowCompletionPlans, usePlanStore } from '@proj-airi/stage-ui/stores/plans'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { executePlanUpdate, installPlanApprovalInvoker, installPlanSessionProvider } from './plan'

function codingStep(id: string, intent: string) {
  return {
    id,
    lane: 'coding' as const,
    intent,
    allowedTools: ['read'],
    expectedEvidence: [{ source: 'tool_result' as const, description: 'tool output' }],
    riskLevel: 'low' as const,
    approvalRequired: false,
  }
}

describe('plan_update executor', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    installPlanApprovalInvoker(undefined)
    installPlanSessionProvider(() => 'test-session')
  })

  it('starts a plan and reports the focused step', async () => {
    const planStore = usePlanStore()

    const result = await executePlanUpdate({
      action: 'start',
      goal: 'Add a footer component',
      steps: [codingStep('step-1', 'Read the layout file'), codingStep('step-2', 'Write the footer')],
    })

    expect(result).toContain('created with 2 step(s)')
    expect(planStore.activePlan?.spec.goal).toBe('Add a footer component')
    expect(planStore.activePlan?.spec.horizon).toBe('session')
    expect(planStore.activePlan?.state.currentStepId).toBe('step-1')
  })

  it('starts a long-horizon goal when requested', async () => {
    await executePlanUpdate({ action: 'start', horizon: 'long', goal: 'Maintain the workspace', steps: [codingStep('step-1', 'Inspect it')] })

    expect(usePlanStore().activePlan?.spec.horizon).toBe('long')
  })

  it('captures the current host workspace when a long goal starts', async () => {
    let workspaceRoot = 'old-workspace'
    installCodingHostClient({
      listDir: async () => ({ entries: [] }),
      readFile: async () => ({ content: '' }),
      listTools: async () => ({
        workspaceRoot,
        tools: [{ name: 'read', description: 'Read files', available: true }],
      }),
      runCommand: async () => ({ tier: 'read-only', status: 'ok', stdout: '', stderr: '' }),
      runProgram: async () => ({ ok: true, logs: [], traces: [] }),
      setApprovalMode: async () => {},
      setWorkspaceRoot: async ({ root }) => ({ status: 'switched', workspaceRoot: root }),
    })
    await useCodingToolsStore().refreshStatus()
    workspaceRoot = 'current-workspace'

    await executePlanUpdate({
      action: 'start',
      horizon: 'long',
      goal: 'Use the current workspace',
      steps: [codingStep('step-1', 'Inspect it')],
    })

    expect(usePlanStore().activePlan?.spec.workspaceRoot).toBe('current-workspace')
  })

  it('uses the runtime session binding when the local selection differs', async () => {
    await executePlanUpdate({
      action: 'start',
      horizon: 'long',
      goal: 'Keep the origin conversation attached',
      steps: [codingStep('step-1', 'Inspect it')],
      __airiSessionId: 'runtime-session',
    })

    expect(usePlanStore().longPlans[0]?.sessionId).toBe('runtime-session')
  })

  it('requires goal and steps when starting', async () => {
    const missingSteps = await executePlanUpdate({ action: 'start', goal: 'Goal' })
    expect(missingSteps).toContain('requires both goal and steps')
  })

  it('closes the replaced plan by skipping its open steps, not blocking them', async () => {
    const planStore = usePlanStore()

    await executePlanUpdate({ action: 'start', goal: 'First plan', steps: [codingStep('a1', 'First'), codingStep('a2', 'Second')] })
    await executePlanUpdate({ action: 'start', goal: 'Second plan', steps: [codingStep('b1', 'Next')] })

    expect(planStore.activePlan?.spec.goal).toBe('Second plan')
    const superseded = planStore.planViews.find(view => view.spec.goal === 'First plan')
    // A skipped step is closed by decision: it leaves the completion gate
    // instead of holding every later Flow open over work no one will run.
    expect(superseded?.state.skippedSteps).toEqual(['a1', 'a2'])
    expect(superseded?.state.blockers).toEqual([])
  })

  it('folds the whole superseded pile when a new plan starts', async () => {
    // ROOT CAUSE:
    //
    // ACC-20260909 FIX1 retest: supersession folded only the newest active
    // session plan. When its steps were already resolved, the start wrote no
    // skip events at all and every older session plan in the lane kept its
    // open steps — the completion gate then demanded steps of plans the
    // model could no longer reach ("Unknown stepId"). A new start retires
    // the whole session lane behind it, not one plan.
    const planStore = usePlanStore()
    await executePlanUpdate({ action: 'start', goal: 'First plan', steps: [codingStep('a1', 'Write'), codingStep('a2', 'Read back')] })
    await executePlanUpdate({ action: 'start', goal: 'Second plan', steps: [codingStep('b1', 'Write again')] })
    await executePlanUpdate({ action: 'start', goal: 'Third plan', steps: [codingStep('c1', 'Finish it')] })

    for (const goal of ['First plan', 'Second plan']) {
      const superseded = planStore.planViews.find(view => view.spec.goal === goal)
      expect(superseded?.state.skippedSteps).toEqual(superseded?.spec.steps.map(step => step.id))
      expect(superseded?.state.blockers).toEqual([])
    }
    expect(planStore.planViews.find(view => view.spec.goal === 'Third plan')?.state.skippedSteps).toEqual([])
  })

  it('completes a step by id on the plan that owns it, behind a newer plan', async () => {
    // ROOT CAUSE:
    //
    // ACC-20260909 FIX1 retest (journal 40ae9ae5, seq 4465): focus and
    // complete resolved only scopedActivePlans().at(-1), so the model could
    // not close a step of the standing session plan while a long plan was
    // newer in scope — the gate demanded those steps and every attempt
    // returned "Unknown stepId". The target now resolves by step id across
    // the plans the model can still steer.
    const planStore = usePlanStore()
    await executePlanUpdate({ action: 'start', goal: 'Session work', steps: [codingStep('s1', 'Do the work')] })
    await executePlanUpdate({ action: 'start', horizon: 'long', goal: 'Long goal', steps: [codingStep('l1', 'Keep going')] })

    const sessionResult = await executePlanUpdate({ action: 'complete', stepId: 's1', rationale: 'evidence recorded in the journal' })
    expect(sessionResult).toContain('s1')

    const sessionPlan = planStore.planViews.find(view => view.spec.goal === 'Session work')
    expect(sessionPlan?.state.completedSteps).toContain('s1')
    expect(sessionPlan?.state.unverifiedSteps).toContain('s1')

    const longResult = await executePlanUpdate({ action: 'focus', stepId: 'l1' })
    expect(longResult).toContain('Focusing step "l1"')
  })

  it('folds the open session plan away when a long goal takes over', async () => {
    const planStore = usePlanStore()

    await executePlanUpdate({ action: 'start', goal: 'Session work', steps: [codingStep('s1', 'Do it')] })
    await executePlanUpdate({ action: 'start', horizon: 'long', goal: 'Long goal', steps: [codingStep('l1', 'Keep going')] })

    const sessionPlan = planStore.planViews.find(view => view.spec.goal === 'Session work')
    expect(sessionPlan?.state.skippedSteps).toEqual(['s1'])
  })

  it('lets a Flow complete after a replan instead of looping on the replaced plan', async () => {
    // ROOT CAUSE:
    //
    // ACC-20260909 FIX1 (journal 40ae9ae5, flow 52yJKrJH): starting a new
    // plan marked the replaced plan's current step blocked ("superseded by a
    // new plan"). The completion conjunction then carried a blocker that
    // could never resolve — the replaced plan's steps never run again — and
    // the flow was rejected five times while the model rebuilt plan after
    // plan. Supersession now skips the replaced plan's open steps.
    const planStore = usePlanStore()
    await executePlanUpdate({ action: 'start', goal: 'First plan', steps: [codingStep('a1', 'Write the result'), codingStep('a2', 'Read it back')] })
    await executePlanUpdate({ action: 'start', goal: 'Second plan', steps: [codingStep('b1', 'Write the revised result'), codingStep('b2', 'Read the revised file back')] })
    const planIds = planStore.planViews.map(view => view.id)
    const secondId = planIds.at(-1)!

    await planStore.recordToolResult({ planId: secondId, stepId: 'b1', toolName: 'read', ok: true, summary: 'wrote revised-result.txt', provenance: 'builtin' })
    await planStore.recordToolResult({ planId: secondId, stepId: 'b2', toolName: 'read', ok: true, summary: 'content matches the token', provenance: 'builtin' })

    const selected = selectFlowCompletionPlans(planStore.planViews, {
      sessionId: 'test-session',
      touchedPlanIds: new Set(planIds),
    })
    const verdict = evaluateFlowCompletion(selected.flatMap(flowCompletionStepInputs))
    expect(verdict.pass).toBe(true)
    expect(verdict.blockers).toEqual([])
  })

  it('focuses a step and rejects unknown step ids', async () => {
    await executePlanUpdate({ action: 'start', goal: 'Goal', steps: [codingStep('step-1', 'Only step')] })

    const planStore = usePlanStore()
    await executePlanUpdate({ action: 'focus', stepId: 'step-1' })
    expect(planStore.activePlan?.state.currentStepId).toBe('step-1')

    const unknown = await executePlanUpdate({ action: 'focus', stepId: 'nope' })
    expect(unknown).toContain('Unknown stepId')
  })

  // ROOT CAUSE:
  //
  // The live test plan created a step whose only expected evidence was
  // human_approval with approvalRequired false. Nothing in the app emits
  // approval/asked for such a step, so it blocked forever on
  // "missing human_approval evidence: no_ref" while the model narrated
  // completion in chat. We fixed this in three layers: start rejects the
  // ghost combination, focusing an approvalRequired step raises a real
  // approval card whose decision satisfies the gate, and other steps can be
  // self-completed with an unverified flag instead of blocking forever.
  it('rejects ghost approval steps that can never complete', async () => {
    const result = await executePlanUpdate({
      action: 'start',
      goal: 'Demo',
      steps: [{
        ...codingStep('s1', 'Nod once'),
        expectedEvidence: [{ source: 'human_approval' as const, description: 'user agrees' }],
      }],
    })
    expect(result).toContain('approvalRequired')
  })

  it('raises the approval card on focus and completes the step when approved', async () => {
    const journal = useJournalStore()
    installPlanApprovalInvoker(async (payload) => {
      journal.appendActive({ type: 'approval/asked', requestId: payload.requestId, stepId: payload.stepId, planId: payload.planId, riskLevel: payload.riskLevel, reason: payload.subject, subject: payload.subject })
      journal.appendActive({ type: 'approval/decided', requestId: payload.requestId, planId: payload.planId, decision: 'allowed-once' })
      return { requestId: payload.requestId, decision: 'approved', planId: payload.planId }
    })

    await executePlanUpdate({
      action: 'start',
      goal: 'Sign-off flow',
      steps: [{
        id: 'sign',
        lane: 'conversation',
        intent: 'Get user sign-off',
        allowedTools: [],
        expectedEvidence: [{ source: 'human_approval' as const, description: 'user approves' }],
        riskLevel: 'low',
        approvalRequired: true,
      }],
    })
    const result = await executePlanUpdate({ action: 'focus', stepId: 'sign' })

    expect(result).toContain('Approval granted')
    const view = usePlanStore().planViews.find(candidate => candidate.spec.goal === 'Sign-off flow')
    expect(view?.state.completedSteps).toContain('sign')
    expect(view?.state.blockers).toHaveLength(0)
  })

  it('keeps the step blocked when approval is rejected', async () => {
    installPlanApprovalInvoker(async payload => ({ requestId: payload.requestId, decision: 'rejected' }))

    await executePlanUpdate({
      action: 'start',
      goal: 'Sign-off flow',
      steps: [{
        id: 'sign',
        lane: 'conversation',
        intent: 'Get user sign-off',
        allowedTools: [],
        expectedEvidence: [{ source: 'human_approval' as const, description: 'user approves' }],
        riskLevel: 'low',
        approvalRequired: true,
      }],
    })
    const result = await executePlanUpdate({ action: 'focus', stepId: 'sign' })

    expect(result).toContain('not granted')
    const view = usePlanStore().activePlan
    expect(view?.state.completedSteps).not.toContain('sign')
    expect(view?.status).toBe('blocked')
  })

  it('flags self-completed steps as unverified instead of blocking forever', async () => {
    await executePlanUpdate({ action: 'start', goal: 'Goal', steps: [codingStep('step-1', 'Only step')] })

    const result = await executePlanUpdate({ action: 'complete', stepId: 'step-1', rationale: 'checked by hand' })

    expect(result).toContain('unverified')
    const view = usePlanStore().planViews.find(candidate => candidate.spec.goal === 'Goal')
    expect(view?.state.unverifiedSteps).toContain('step-1')
    expect(view?.state.completedSteps).toContain('step-1')
    expect(view?.status).toBe('completed')
  })

  it('refuses to self-complete human_approval steps', async () => {
    await executePlanUpdate({
      action: 'start',
      goal: 'Sign-off flow',
      steps: [{
        id: 'sign',
        lane: 'conversation',
        intent: 'Get user sign-off',
        allowedTools: [],
        expectedEvidence: [{ source: 'human_approval' as const, description: 'user approves' }],
        riskLevel: 'low',
        approvalRequired: true,
      }],
    })

    const result = await executePlanUpdate({ action: 'complete', stepId: 'sign' })

    expect(result).toContain('approval card')
    expect(usePlanStore().activePlan?.state.completedSteps).not.toContain('sign')
  })

  it('cancels the active plan and refuses to act without one', async () => {
    const withoutPlan = await executePlanUpdate({ action: 'cancel' })
    expect(withoutPlan).toContain('No active plan')

    await executePlanUpdate({ action: 'start', goal: 'Goal', steps: [codingStep('step-1', 'Only step')] })

    const cancelled = await executePlanUpdate({ action: 'cancel' })
    expect(cancelled).toContain('cancelled')
    // The cancelled plan leaves the active projection and reports failed.
    expect(usePlanStore().activePlan).toBeUndefined()
    expect(usePlanStore().planViews.find(view => view.spec.goal === 'Goal')?.status).toBe('failed')
  })
})
