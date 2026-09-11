import type { PlanSpec, PlanState } from '../authority/contract'

import { describe, expect, it } from 'vitest'

import { evaluateFlowCompletion, flowCompletionStepInputs, parseFlowReviewVerdict } from './flow-completion'

describe('evaluateFlowCompletion', () => {
  it('passes when every step is gate-completed', () => {
    const verdict = evaluateFlowCompletion([
      { planId: 'p1', stepId: 's1', gateCompleted: true, declaredComplete: false },
      { planId: 'p1', stepId: 's2', gateCompleted: true, declaredComplete: false },
    ])
    expect(verdict.pass).toBe(true)
    expect(verdict.blockers).toEqual([])
    expect(verdict.unverifiedClosed).toEqual([])
  })

  it('passes vacuously when the flow touched no plan step', () => {
    const verdict = evaluateFlowCompletion([])
    expect(verdict.pass).toBe(true)
  })

  it('counts declared closures as finished but reports them unverified', () => {
    const verdict = evaluateFlowCompletion([
      { planId: 'p1', stepId: 's1', gateCompleted: true, declaredComplete: false },
      { planId: 'p1', stepId: 's2', gateCompleted: false, declaredComplete: true, status: 'pending' },
    ])
    expect(verdict.pass).toBe(true)
    expect(verdict.unverifiedClosed).toEqual([
      { planId: 'p1', stepId: 's2', reason: 'closed by declaration without evidence' },
    ])
  })

  it('blocks on open, blocked, approval-waiting, and failed steps', () => {
    const verdict = evaluateFlowCompletion([
      { planId: 'p1', stepId: 'open', gateCompleted: false, declaredComplete: false, status: 'in_progress' },
      { planId: 'p1', stepId: 'stuck', gateCompleted: false, declaredComplete: false, status: 'blocked' },
      { planId: 'p1', stepId: 'card', gateCompleted: false, declaredComplete: false, approvalBlocked: true },
      { planId: 'p2', stepId: 'dead', gateCompleted: false, declaredComplete: false, status: 'failed' },
    ])
    expect(verdict.pass).toBe(false)
    expect(verdict.blockers).toEqual([
      { planId: 'p1', stepId: 'open', reason: 'step is still in progress' },
      { planId: 'p1', stepId: 'stuck', reason: 'step is blocked' },
      { planId: 'p1', stepId: 'card', reason: 'waiting for the approval card decision' },
      { planId: 'p2', stepId: 'dead', reason: 'step failed' },
    ])
  })

  it('does not let a declaration override approval or failure', () => {
    const verdict = evaluateFlowCompletion([
      { planId: 'p1', stepId: 'approval', gateCompleted: false, declaredComplete: true, approvalBlocked: true },
      { planId: 'p1', stepId: 'failed', gateCompleted: false, declaredComplete: true, status: 'failed' },
      { planId: 'p1', stepId: 'stale-gate', gateCompleted: true, declaredComplete: false, approvalBlocked: true },
    ])
    expect(verdict).toEqual({
      pass: false,
      blockers: [
        { planId: 'p1', stepId: 'approval', reason: 'waiting for the approval card decision' },
        { planId: 'p1', stepId: 'failed', reason: 'step failed' },
        { planId: 'p1', stepId: 'stale-gate', reason: 'waiting for the approval card decision' },
      ],
      unverifiedClosed: [],
    })
  })
})

describe('flowCompletionStepInputs', () => {
  function planInput(overrides: { state?: Partial<PlanState>, steps?: PlanSpec['steps'] } = {}) {
    return {
      id: 'p1',
      spec: {
        goal: 'Verify a change',
        horizon: 'session' as const,
        steps: overrides.steps ?? [
          { id: 's1', lane: 'coding' as const, intent: 'Write the result', allowedTools: ['read'], expectedEvidence: [], riskLevel: 'low' as const, approvalRequired: false },
          { id: 's2', lane: 'coding' as const, intent: 'Read it back', allowedTools: ['read'], expectedEvidence: [], riskLevel: 'low' as const, approvalRequired: false },
        ],
      },
      state: {
        completedSteps: [],
        failedSteps: [],
        skippedSteps: [],
        evidenceRefs: [],
        blockers: [],
        ...overrides.state,
      } as PlanState,
    }
  }

  it('maps completed, declared, focused, and pending steps for the gate', () => {
    const inputs = flowCompletionStepInputs(planInput({
      state: {
        completedSteps: ['s1'],
        unverifiedSteps: ['s1'],
        currentStepId: 's2',
        blockers: ['missing tool_result evidence: read'],
      },
    }))
    expect(inputs).toEqual([
      { planId: 'p1', stepId: 's1', title: 'Write the result', gateCompleted: false, declaredComplete: true, status: 'pending' },
      { planId: 'p1', stepId: 's2', title: 'Read it back', gateCompleted: false, declaredComplete: false, status: 'blocked' },
    ])
  })

  it('leaves skipped steps out of the conjunction', () => {
    // ROOT CAUSE:
    //
    // ACC-20260909 FIX1 (journal 40ae9ae5, flow 52yJKrJH): a replaced plan's
    // current step stayed in the gate as blocked ("superseded by a new
    // plan"). A closed-by-decision step cannot collect evidence anymore, so
    // it blocked every later done declaration and the flow looped on plan
    // rebuilds. Skipped steps are decisions, not open work: the conjunction
    // must not read them.
    const inputs = flowCompletionStepInputs(planInput({
      state: { skippedSteps: ['s1'], currentStepId: 's1' },
    }))
    expect(inputs).toEqual([
      { planId: 'p1', stepId: 's2', title: 'Read it back', gateCompleted: false, declaredComplete: false, status: 'pending' },
    ])
  })
})

describe('parseFlowReviewVerdict', () => {
  it('does not turn an explicit abstention into a pass from its feedback', () => {
    // ROOT CAUSE:
    // Unhandled JSON verdicts fell through to a whole-response word search.
    // The word "pass" inside abstention feedback became a passing verdict.
    expect(parseFlowReviewVerdict('{"verdict":"abstain","feedback":"Cannot confirm that tests pass"}'))
      .toEqual({ verdict: 'abstain' })
    expect(parseFlowReviewVerdict('{"verdict":"unknown","feedback":"Do not approve"}'))
      .toEqual({ verdict: 'abstain' })
  })

  it('does not approve a negated or malformed review', () => {
    expect(parseFlowReviewVerdict('Do not approve: no test receipt'))
      .toEqual({ verdict: 'abstain' })
    expect(parseFlowReviewVerdict('{"verdict":"pass",}'))
      .toEqual({ verdict: 'abstain' })
  })

  it('keeps a prose rejection even when its feedback mentions passing tests', () => {
    expect(parseFlowReviewVerdict('bounce: bash seq 12 did not pass'))
      .toEqual({ verdict: 'bounce', feedback: 'bounce: bash seq 12 did not pass' })
  })

  it('reads a JSON pass verdict', () => {
    expect(parseFlowReviewVerdict('{"verdict":"pass","feedback":"receipts cover every step"}'))
      .toEqual({ verdict: 'pass', feedback: 'receipts cover every step' })
  })

  it('reads a JSON bounce verdict with a receipt citation', () => {
    expect(parseFlowReviewVerdict('{"verdict":"bounce","feedback":"bash seq 12 only probed the port"}'))
      .toEqual({ verdict: 'bounce', feedback: 'bash seq 12 only probed the port' })
  })

  it('downgrades a citation-free bounce to an abstain', () => {
    // A rejection the model cannot act on must not loop the flow; only a
    // bounce that cites a receipt may.
    expect(parseFlowReviewVerdict('{"verdict":"bounce","feedback":"not good enough"}'))
      .toEqual({ verdict: 'abstain' })
  })

  it('abstains on empty, unparseable, or unknown verdicts', () => {
    expect(parseFlowReviewVerdict(undefined)).toEqual({ verdict: 'abstain' })
    expect(parseFlowReviewVerdict('  ')).toEqual({ verdict: 'abstain' })
    expect(parseFlowReviewVerdict('the reviewer rambled about the weather'))
      .toEqual({ verdict: 'abstain' })
    expect(parseFlowReviewVerdict('{"verdict":"unsure"}')).toEqual({ verdict: 'abstain' })
  })

  it('reads prose answers defensively', () => {
    expect(parseFlowReviewVerdict('pass — the test receipt at seq 9 covers the failing case'))
      .toEqual({ verdict: 'pass' })
    expect(parseFlowReviewVerdict('bounce: the write receipt never built the project'))
      .toEqual({ verdict: 'bounce', feedback: 'bounce: the write receipt never built the project' })
  })
})
