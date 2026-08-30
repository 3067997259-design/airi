import { describe, expect, it } from 'vitest'

import { buildTurnProjection } from './turn-projection'

describe('buildTurnProjection', () => {
  // The live plan run had the model treat a plain chat reply as the
  // human_approval evidence its step was waiting for. The projection now
  // states the approval and completion rules next to the step itself.
  it('states that chat text never satisfies approval and how completion works', () => {
    const result = buildTurnProjection({
      plan: {
        goal: 'Sign-off flow',
        horizon: 'session',
        steps: [{
          id: 'sign',
          lane: 'conversation',
          intent: 'Get user sign-off',
          allowedTools: [],
          expectedEvidence: [{ source: 'human_approval', description: 'user approves' }],
          riskLevel: 'low',
          approvalRequired: true,
        }],
      },
      state: {
        currentStepId: 'sign',
        completedSteps: [],
        failedSteps: [],
        skippedSteps: [],
        blockers: [],
        evidenceRefs: [],
      },
    })

    expect(result.text).toContain('chat text never satisfies human approval')
    expect(result.text).toContain('never announce completion in words alone')
  })

  it('keeps one turn bounded to the current step and recent evidence', () => {
    const result = buildTurnProjection({
      plan: {
        goal: 'Repair the coding host',
        horizon: 'session',
        steps: [{
          id: 'step-2',
          lane: 'coding',
          intent: 'Run the focused test suite',
          allowedTools: ['bash'],
          expectedEvidence: [{ source: 'tool_result', description: 'test output' }],
          riskLevel: 'low',
          approvalRequired: false,
        }],
      },
      state: {
        currentStepId: 'step-2',
        completedSteps: ['step-1'],
        failedSteps: [],
        skippedSteps: [],
        blockers: [],
        evidenceRefs: Array.from({ length: 6 }, (_, index) => ({
          stepId: 'step-2',
          source: 'tool_result' as const,
          summary: `evidence-${index}`,
        })),
      },
      previousToolResult: 'The focused tests passed.',
    })

    expect(result.currentStep?.id).toBe('step-2')
    expect(result.evidence.map(ref => ref.summary)).toEqual(['evidence-2', 'evidence-3', 'evidence-4', 'evidence-5'])
    expect(result.text).toContain('Plan completion claims require trusted evidence before final verification.')
    expect(result.text).toContain('Previous tool result: The focused tests passed.')
    expect(result.text.length).toBeLessThan(2_000)
  })
})
