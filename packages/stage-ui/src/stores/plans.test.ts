import type { PlanSpec } from '@proj-airi/core-agent'

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { usePlanStore } from './plans'

const SPEC: PlanSpec = {
  goal: 'Verify a coding change',
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
  })

  it('keeps a plan blocked until trusted tool evidence completes its gate', () => {
    const store = usePlanStore()
    const id = store.start(SPEC, 'plan-1')

    expect(id).toBe('plan-1')
    expect(store.planViews[0]?.status).toBe('blocked')
    expect(store.planViews[0]?.state.completedSteps).toEqual([])

    store.recordToolResult({
      planId: id,
      stepId: 'verify',
      toolName: 'bash',
      ok: true,
      summary: 'tests pass',
      provenance: 'builtin',
    })

    expect(store.planViews[0]?.status).toBe('completed')
    expect(store.planViews[0]?.state.completedSteps).toEqual(['verify'])
  })
})
