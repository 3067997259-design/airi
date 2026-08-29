import { usePlanStore } from '@proj-airi/stage-ui/stores/plans'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { executePlanUpdate } from './plan'

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
    expect(planStore.activePlan?.state.currentStepId).toBe('step-1')
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
