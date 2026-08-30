import { useJournalStore } from '@proj-airi/stage-ui/stores/journal'
import { usePlanStore } from '@proj-airi/stage-ui/stores/plans'
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

  it('requires goal and steps when starting', async () => {
    const missingSteps = await executePlanUpdate({ action: 'start', goal: 'Goal' })
    expect(missingSteps).toContain('requires both goal and steps')
  })

  it('supersedes the previous plan when starting a new one', async () => {
    const planStore = usePlanStore()

    await executePlanUpdate({ action: 'start', goal: 'First plan', steps: [codingStep('a1', 'First')] })
    await executePlanUpdate({ action: 'start', goal: 'Second plan', steps: [codingStep('b1', 'Second')] })

    expect(planStore.activePlan?.spec.goal).toBe('Second plan')
    const superseded = planStore.planViews.find(view => view.spec.goal === 'First plan')
    expect(superseded?.status).toBe('blocked')
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
