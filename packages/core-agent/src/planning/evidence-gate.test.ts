import type { JournalEvent } from '../journal/types'
import type { StepGateSpec } from './evidence-gate'

import { describe, expect, it } from 'vitest'

import { stepHasSideEffects } from '../authority/gate'
import { collectStepGateRefs, projectStepGateStates, verdictForStep } from './evidence-gate'

function toolResult(event: Partial<Extract<JournalEvent, { type: 'tool/result' }>>): JournalEvent {
  return {
    type: 'tool/result',
    seq: 1,
    toolName: 'edit',
    ok: true,
    summary: 'applied',
    ...event,
  }
}

function step(overrides: Partial<StepGateSpec> = {}): StepGateSpec {
  return {
    id: 'step-1',
    riskLevel: 'medium',
    approvalRequired: false,
    expectedEvidence: [{ source: 'tool_result', description: 'edit applied' }],
    ...overrides,
  }
}

const COMPLETED_JOURNEY: JournalEvent[] = [
  { type: 'session/header', seq: 0, sessionId: 's1', createdAt: 1, delegationDepth: 0 },
  { type: 'plan/update', seq: 1, stepId: 'step-1', status: 'in_progress' },
  toolResult({ seq: 2, stepId: 'step-1', provenance: 'builtin' }),
]

describe('evidence gate runtime', () => {
  it('completes a side-effect step backed by builtin tool evidence', () => {
    const snapshot = projectStepGateStates(COMPLETED_JOURNEY, [step()])
    expect(snapshot.steps['step-1']).toMatchObject({ status: 'completed' })
  })

  it('never completes a step on unreviewed self-authored evidence alone', () => {
    const events: JournalEvent[] = [
      { type: 'session/header', seq: 0, sessionId: 's1', createdAt: 1, delegationDepth: 0 },
      { type: 'plan/update', seq: 1, stepId: 'step-1', status: 'in_progress' },
      toolResult({ seq: 2, stepId: 'step-1', provenance: 'unreviewed_self_authored' }),
    ]
    const snapshot = projectStepGateStates(events, [step()])
    const state = snapshot.steps['step-1']!
    expect(state.status).toBe('blocked')
    expect(state.reason).toContain('not_mutation_proof')
  })

  // ROOT CAUSE:
  //
  // The evidence projection accepted a trusted tool result without checking
  // its `ok` flag. A failed mutation could therefore complete its plan step.
  it('never completes a step from a failed trusted tool result', () => {
    const events: JournalEvent[] = [
      { type: 'session/header', seq: 0, sessionId: 's1', createdAt: 1, delegationDepth: 0 },
      { type: 'plan/update', seq: 1, stepId: 'step-1', status: 'in_progress' },
      toolResult({ seq: 2, stepId: 'step-1', provenance: 'builtin', ok: false, summary: 'write failed' }),
    ]

    const state = projectStepGateStates(events, [step()]).steps['step-1']

    expect(state?.status).toBe('failed')
    expect(state?.verdict?.passed).toBe(false)
  })

  it('blocks when announced evidence is missing entirely', () => {
    const events: JournalEvent[] = [
      { type: 'session/header', seq: 0, sessionId: 's1', createdAt: 1, delegationDepth: 0 },
      { type: 'plan/update', seq: 1, stepId: 'step-1', status: 'in_progress' },
    ]
    const snapshot = projectStepGateStates(events, [step()])
    const state = snapshot.steps['step-1']!
    expect(state.status).toBe('blocked')
    expect(state.reason).toContain('missing tool_result evidence: no_ref')
  })

  it('stays pending without any activity', () => {
    const snapshot = projectStepGateStates([{ type: 'session/header', seq: 0, sessionId: 's1', createdAt: 1, delegationDepth: 0 }], [step()])
    expect(snapshot.steps['step-1']?.status).toBe('pending')
  })

  it('passes the gate once a human approval is recorded for the step', () => {
    const events: JournalEvent[] = [
      { type: 'session/header', seq: 0, sessionId: 's1', createdAt: 1, delegationDepth: 0 },
      { type: 'plan/update', seq: 1, stepId: 'step-1', status: 'in_progress' },
      { type: 'approval/asked', seq: 2, requestId: 'a1', stepId: 'step-1', reason: 'push to origin', riskLevel: 'high' },
      { type: 'approval/decided', seq: 3, requestId: 'a1', decision: 'allowed-once' },
      toolResult({ seq: 4, stepId: 'step-1', provenance: 'builtin' }),
    ]
    const stepWithHumanEvidence: StepGateSpec = {
      ...step(),
      expectedEvidence: [
        { source: 'tool_result', description: 'edit applied' },
        { source: 'human_approval', description: 'user approved push' },
      ],
    }
    const snapshot = projectStepGateStates(events, [stepWithHumanEvidence])
    expect(snapshot.steps['step-1']?.status).toBe('completed')
  })

  it('does not accept a decision recorded before its approval request', () => {
    const events: JournalEvent[] = [
      { type: 'approval/decided', seq: 0, requestId: 'a1', decision: 'allowed-once' },
      { type: 'approval/asked', seq: 1, requestId: 'a1', stepId: 'step-1', reason: 'write', riskLevel: 'high' },
    ]

    expect(collectStepGateRefs(events, 'step-1')).toEqual([])
  })

  it('uses the latest decision for an approval request', () => {
    const events: JournalEvent[] = [
      { type: 'approval/asked', seq: 0, requestId: 'a1', stepId: 'step-1', reason: 'write', riskLevel: 'high' },
      { type: 'approval/decided', seq: 1, requestId: 'a1', decision: 'allowed-once' },
      { type: 'approval/decided', seq: 2, requestId: 'a1', decision: 'rejected' },
    ]

    expect(collectStepGateRefs(events, 'step-1')).toEqual([])
  })

  it('collects only refs bound to the step', () => {
    const events: JournalEvent[] = [
      toolResult({ seq: 1, stepId: 'step-1', provenance: 'builtin' }),
      toolResult({ seq: 2, stepId: 'step-2', provenance: 'builtin' }),
    ]
    const refs = collectStepGateRefs(events, 'step-1')
    expect(refs).toHaveLength(1)
    expect(refs[0]?.provenance.maySatisfyMutationProof).toBe(true)
  })

  it('defaults unlabeled tool results to unreviewed (least trusted)', () => {
    const refs = collectStepGateRefs([toolResult({ seq: 1, stepId: 'step-1' })], 'step-1')
    expect(refs[0]?.provenance.source).toBe('unreviewed_self_authored_tool_result')
  })

  it('exposes the verdict used by the review card', () => {
    const verdict = verdictForStep(COMPLETED_JOURNEY, step())
    expect(verdict.passed).toBe(true)
    // The step has side effects, so its completion required mutation-provable
    // evidence — the gate's core invariant.
    expect(stepHasSideEffects(step())).toBe(true)
  })
})
