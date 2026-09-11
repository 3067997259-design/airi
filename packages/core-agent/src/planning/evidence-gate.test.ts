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
    allowedTools: ['edit'],
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

  it('closes a skipped step as a decision, without a blocker reason', () => {
    // Supersession writes plan/update skipped for the replaced plan's open
    // steps. The step can no longer collect evidence, so reporting it blocked
    // would hold a flow open forever over work no one will run.
    const events: JournalEvent[] = [
      { type: 'session/header', seq: 0, sessionId: 's1', createdAt: 1, delegationDepth: 0 },
      { type: 'plan/update', seq: 1, stepId: 'step-1', status: 'in_progress' },
      { type: 'plan/update', seq: 2, stepId: 'step-1', status: 'skipped', reason: 'superseded by a new plan' },
    ]
    const snapshot = projectStepGateStates(events, [step()])
    expect(snapshot.steps['step-1']).toMatchObject({ status: 'skipped' })
    expect(snapshot.steps['step-1']?.reason).toBeUndefined()
  })

  it('keeps gate evidence louder than a later skip', () => {
    const events: JournalEvent[] = [
      ...COMPLETED_JOURNEY,
      { type: 'plan/update', seq: 3, stepId: 'step-1', status: 'skipped' },
    ]
    const snapshot = projectStepGateStates(events, [step()])
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
  // 2026-09-01 dsh-web exam: a plan whose steps all declared riskLevel 'low'
  // completed 3/3 from seven read-only calls (bash/grep/read/list) — the
  // mutation-proof branch keyed on the model's own risk grade, so a step that
  // whitelisted write never raised it. The whitelist is structure; the grade
  // is only a proposal.
  it('requires mutation evidence for a low-risk step whose whitelist declares write', () => {
    const events: JournalEvent[] = [
      { type: 'session/header', seq: 0, sessionId: 's1', createdAt: 1, delegationDepth: 0 },
      { type: 'plan/update', seq: 1, stepId: 'step-1', status: 'in_progress' },
      toolResult({ seq: 2, stepId: 'step-1', provenance: 'builtin', toolName: 'bash', summary: 'bash ok (read-only tier, exit 0, git-bash)' }),
      toolResult({ seq: 3, stepId: 'step-1', provenance: 'builtin', toolName: 'grep', summary: 'grep "ws" · 50 matches in 19 files' }),
    ]
    const snapshot = projectStepGateStates(events, [step({ riskLevel: 'low', allowedTools: ['bash', 'write', 'read'] })])
    const state = snapshot.steps['step-1']!
    expect(state.status).toBe('blocked')
    expect(state.reason).toContain('not_mutation_proof')
  })

  it('completes the same low-risk write step once a write lands', () => {
    const events: JournalEvent[] = [
      { type: 'session/header', seq: 0, sessionId: 's1', createdAt: 1, delegationDepth: 0 },
      { type: 'plan/update', seq: 1, stepId: 'step-1', status: 'in_progress' },
      toolResult({ seq: 2, stepId: 'step-1', provenance: 'builtin', toolName: 'bash', summary: 'bash ok (read-only tier, exit 0, git-bash)' }),
      toolResult({ seq: 3, stepId: 'step-1', provenance: 'builtin', toolName: 'write', summary: 'written' }),
    ]
    const snapshot = projectStepGateStates(events, [step({ riskLevel: 'low', allowedTools: ['bash', 'write', 'read'] })])
    expect(snapshot.steps['step-1']).toMatchObject({ status: 'completed' })
  })

  it('counts a non-read-only bash run as mutation evidence for a side-effect step', () => {
    const events: JournalEvent[] = [
      { type: 'session/header', seq: 0, sessionId: 's1', createdAt: 1, delegationDepth: 0 },
      { type: 'plan/update', seq: 1, stepId: 'step-1', status: 'in_progress' },
      toolResult({ seq: 2, stepId: 'step-1', provenance: 'builtin', toolName: 'bash', summary: 'bash ok (medium tier, exit 0, git-bash)' }),
    ]
    const snapshot = projectStepGateStates(events, [step()])
    expect(snapshot.steps['step-1']).toMatchObject({ status: 'completed' })
  })

  it('still completes a pure-read step from read-only evidence', () => {
    const events: JournalEvent[] = [
      { type: 'session/header', seq: 0, sessionId: 's1', createdAt: 1, delegationDepth: 0 },
      { type: 'plan/update', seq: 1, stepId: 'step-1', status: 'in_progress' },
      toolResult({ seq: 2, stepId: 'step-1', provenance: 'builtin', toolName: 'grep', summary: 'grep "ws" · 50 matches in 19 files' }),
    ]
    const readStep = step({ riskLevel: 'low', allowedTools: ['grep', 'read', 'list'] })
    const snapshot = projectStepGateStates(events, [readStep])
    expect(snapshot.steps['step-1']).toMatchObject({ status: 'completed' })
  })

  // ROOT CAUSE:
  //
  // 2026-09-01 dsh-web field run (FLOW-DIAGNOSIS §1.2): a "write tests and
  // verify" step completed from a bare liveness probe. The focused step
  // rejected bash, the fallback stamping attached the probe to the verify
  // step, and a successful-but-irrelevant bash result satisfied its
  // tool_result evidence before the real test ever ran.
  it('does not complete a verify step from an unrelated successful bash receipt', () => {
    const events: JournalEvent[] = [
      { type: 'session/header', seq: 0, sessionId: 's1', createdAt: 1, delegationDepth: 0 },
      { type: 'plan/update', seq: 1, stepId: 'step-1', status: 'in_progress' },
      toolResult({ seq: 2, stepId: 'step-1', provenance: 'builtin', toolName: 'bash', summary: '{"tier":"medium","status":"ok","stdout":"workspace.list ok"}' }),
    ]
    const verifyStep = step({
      riskLevel: 'low',
      allowedTools: ['bash', 'read'],
      intent: 'run the integration tests and verify',
      expectedEvidence: [{ source: 'tool_result', description: 'tests written and verification passed' }],
    })
    const state = projectStepGateStates(events, [verifyStep]).steps['step-1']
    expect(state?.status).toBe('blocked')
    expect(state?.reason).toContain('not_verified_outcome')
  })

  it('completes the verify step once a receipt carries real verification output', () => {
    const events: JournalEvent[] = [
      { type: 'session/header', seq: 0, sessionId: 's1', createdAt: 1, delegationDepth: 0 },
      { type: 'plan/update', seq: 1, stepId: 'step-1', status: 'in_progress' },
      toolResult({ seq: 2, stepId: 'step-1', provenance: 'builtin', toolName: 'bash', summary: 'node src/tools/dsh_bridge_test.js · ALL INTEGRATION TESTS PASSED · exitCode 0' }),
    ]
    const verifyStep = step({
      riskLevel: 'low',
      allowedTools: ['bash', 'read'],
      intent: 'run the integration tests and verify',
      expectedEvidence: [{ source: 'tool_result', description: 'tests written and verification passed' }],
    })
    expect(projectStepGateStates(events, [verifyStep]).steps['step-1']).toMatchObject({ status: 'completed' })
  })

  it('never counts writing a test file as running it', () => {
    const events: JournalEvent[] = [
      { type: 'session/header', seq: 0, sessionId: 's1', createdAt: 1, delegationDepth: 0 },
      { type: 'plan/update', seq: 1, stepId: 'step-1', status: 'in_progress' },
      toolResult({ seq: 2, stepId: 'step-1', provenance: 'builtin', toolName: 'write', summary: '{"path":"src/tools/dsh_bridge_test.js","status":"written"}' }),
    ]
    const verifyStep = step({
      riskLevel: 'low',
      allowedTools: ['bash', 'write', 'read'],
      intent: 'write the tests and verify they pass',
      expectedEvidence: [{ source: 'tool_result', description: 'tests pass' }],
    })
    const state = projectStepGateStates(events, [verifyStep]).steps['step-1']
    expect(state?.status).toBe('blocked')
    expect(state?.reason).toContain('not_verified_outcome')
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

    expect(state?.status).toBe('blocked')
    expect(state?.verdict?.passed).toBe(false)
  })

  // ROOT CAUSE (FLOW-KNOWLEDGE principle one):
  //
  // A failed receipt used to flip the step (and through the terminal-status
  // projection, the whole plan) to `failed` one event after creation. The
  // 2026-09-03 acceptance run lost 35 iterations to exactly that: one
  // `cd /d` probe stamped its failure onto step-1, the plan left the active
  // set, and the evidence-stamping channel went deaf for the rest of the
  // flow. A failed receipt is an observation — the step stays `blocked`
  // until evidence lands or the model explicitly declares the step failed.
  it('keeps a step blocked after a failed receipt instead of failing it', () => {
    const events: JournalEvent[] = [
      { type: 'session/header', seq: 0, sessionId: 's1', createdAt: 1, delegationDepth: 0 },
      { type: 'plan/update', seq: 1, stepId: 'step-1', status: 'in_progress' },
      toolResult({
        seq: 2,
        stepId: 'step-1',
        toolName: 'bash',
        provenance: 'builtin',
        outcome: 'failed',
        tier: 'medium',
        summary: '{"status":"error","tier":"medium","exitCode":1}',
      }),
    ]

    const state = projectStepGateStates(events, [step({ allowedTools: ['bash'] })]).steps['step-1']

    expect(state?.status).toBe('blocked')
    expect(state?.verdict?.passed).toBe(false)
  })

  it('fails a step only from a model-declared plan failure', () => {
    const events: JournalEvent[] = [
      { type: 'session/header', seq: 0, sessionId: 's1', createdAt: 1, delegationDepth: 0 },
      { type: 'plan/update', seq: 1, stepId: 'step-1', status: 'in_progress' },
      toolResult({ seq: 2, stepId: 'step-1', provenance: 'builtin', ok: false, summary: 'write failed' }),
      { type: 'plan/update', seq: 3, stepId: 'step-1', status: 'failed', reason: 'abandoned: wrong approach' },
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

  it('projects a rejected approval instead of hiding it behind a generic blocker', () => {
    const events: JournalEvent[] = [
      { type: 'plan/update', seq: 1, stepId: 'step-1', status: 'in_progress' },
      { type: 'approval/asked', seq: 2, requestId: 'a1', stepId: 'step-1', reason: 'write', riskLevel: 'high' },
      { type: 'approval/decided', seq: 3, requestId: 'a1', decision: 'rejected' },
    ]

    expect(projectStepGateStates(events, [step({ approvalRequired: true })]).steps['step-1']).toMatchObject({
      status: 'blocked',
      reason: 'approval rejected: step-1',
    })
  })

  it('projects a cancelled approval distinctly from a pending approval', () => {
    const events: JournalEvent[] = [
      { type: 'plan/update', seq: 1, stepId: 'step-1', status: 'in_progress' },
      { type: 'approval/asked', seq: 2, requestId: 'a1', stepId: 'step-1', reason: 'write', riskLevel: 'high' },
      { type: 'approval/decided', seq: 3, requestId: 'a1', decision: 'cancelled' },
    ]

    expect(projectStepGateStates(events, [step({ approvalRequired: true })]).steps['step-1']).toMatchObject({
      status: 'blocked',
      reason: 'approval cancelled: step-1',
    })
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
