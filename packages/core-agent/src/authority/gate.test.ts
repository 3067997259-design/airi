import type { GateRef, VerificationGateInput } from './gate'

import { describe, expect, it } from 'vitest'

import { evaluateVerificationGate, stepHasSideEffects } from './gate'

function makeStep(overrides: Partial<VerificationGateInput['step']> = {}): VerificationGateInput['step'] {
  return {
    id: 'write-adapter',
    riskLevel: 'medium',
    approvalRequired: false,
    allowedTools: ['bash'],
    expectedEvidence: [{ source: 'tool_result', description: 'adapter written' }],
    ...overrides,
  }
}

function makeRef(overrides: Partial<GateRef> = {}): GateRef {
  return {
    stepId: 'write-adapter',
    source: 'tool_result',
    summary: 'wrote file',
    provenance: {
      source: 'trusted_current_run_tool_evidence',
      precedence: 40,
      label: 'Trusted current-run tool evidence',
      maySatisfyVerificationGate: false,
      maySatisfyMutationProof: true,
    },
    ...overrides,
  }
}

describe('verification gate', () => {
  // ROOT CAUSE:
  // Generic check/verify wording required execution even for file observation.
  // File receipts and test execution must remain separate evidence kinds.
  it('accepts a successful read for a file inspection', () => {
    const verdict = evaluateVerificationGate({
      step: makeStep({ riskLevel: 'low', allowedTools: ['read'], intent: '检查文件内容', expectedEvidence: [{ source: 'tool_result', description: '验证文件内容' }] }),
      refs: [makeRef({ toolName: 'read', outcome: 'ok', summary: 'notes.txt: expected content' })],
    })
    expect(verdict.passed).toBe(true)
  })

  it('requires an observation receipt after a write for readback', () => {
    const step = makeStep({ allowedTools: ['write', 'read'], intent: '写入后读回检查文件内容' })
    const write = makeRef({ toolName: 'write', outcome: 'ok' })
    const read = makeRef({ toolName: 'read', outcome: 'ok', summary: 'notes.txt: expected content' })
    expect(evaluateVerificationGate({ step, refs: [write] }).passed).toBe(false)
    expect(evaluateVerificationGate({ step, refs: [read, write] }).passed).toBe(false)
    expect(evaluateVerificationGate({ step, refs: [write, read] }).passed).toBe(true)
  })

  it('keeps file inspection distinct from the following test command', () => {
    const step = makeStep({ riskLevel: 'low', allowedTools: ['read', 'bash'], intent: 'Read the file and run tests' })
    const verdict = evaluateVerificationGate({ step, refs: [
      makeRef({ toolName: 'read', outcome: 'ok', summary: 'notes.txt: expected contents' }),
      makeRef({ toolName: 'bash', tier: 'medium', outcome: 'ok', summary: 'vitest passed' }),
    ] })
    expect(verdict.passed).toBe(true)
    expect(verdict.satisfied[0]?.ref.toolName).toBe('bash')
  })

  it('does not count a written test or a failed execution as passing tests', () => {
    const step = makeStep({ allowedTools: ['write', 'bash'], intent: '运行测试并验证' })
    const write = makeRef({ toolName: 'write', outcome: 'ok', summary: 'wrote feature.test.ts' })
    expect(evaluateVerificationGate({ step, refs: [write] }).passed).toBe(false)
    expect(evaluateVerificationGate({ step, refs: [write, makeRef({ toolName: 'bash', outcome: 'failed', summary: 'vitest failed' })] }).passed).toBe(false)
    expect(evaluateVerificationGate({ step, refs: [write, makeRef({ toolName: 'bash', outcome: 'ok', summary: 'vitest passed' })] }).passed).toBe(true)
  })
  it('passes a side-effect step backed by mutation-provable evidence', () => {
    const verdict = evaluateVerificationGate({ step: makeStep(), refs: [makeRef()] })
    expect(verdict.passed).toBe(true)
    expect(verdict.missing).toEqual([])
  })

  it('fails when no ref exists for the step', () => {
    const verdict = evaluateVerificationGate({ step: makeStep(), refs: [] })
    expect(verdict.passed).toBe(false)
    expect(verdict.missing[0]?.reason).toBe('no_ref')
  })

  it('reports wrong_source when a ref exists but with the wrong evidence type', () => {
    const verdict = evaluateVerificationGate({
      step: makeStep(),
      refs: [makeRef({ source: 'runtime_trace', provenance: { source: 'current_run_task_memory', precedence: 60, label: 'Current-run TaskMemory', maySatisfyVerificationGate: false, maySatisfyMutationProof: false } })],
    })
    expect(verdict.passed).toBe(false)
    expect(verdict.missing[0]?.reason).toBe('wrong_source')
  })

  // ROOT CAUSE:
  // If unreviewed self-authored evidence (47) satisfied the gate, a tool the
  // user never reviewed could "prove" a mutation — the self-proof loop from
  // SELF-AUTHORED-TOOLS-DESIGN §1.1 would close through the gate itself.
  it('rejects non-mutation-provable evidence for side-effect steps', () => {
    const unreviewed = makeRef({
      provenance: {
        source: 'unreviewed_self_authored_tool_result',
        precedence: 47,
        label: 'Unreviewed self-authored tool result',
        maySatisfyVerificationGate: false,
        maySatisfyMutationProof: false,
      },
    })
    const verdict = evaluateVerificationGate({ step: makeStep(), refs: [unreviewed] })
    expect(verdict.passed).toBe(false)
    expect(verdict.missing[0]?.reason).toBe('not_mutation_proof')
  })

  it('lets reviewed self-authored evidence pass the gate', () => {
    const reviewed = makeRef({
      provenance: {
        source: 'reviewed_self_authored_tool_result',
        precedence: 42,
        label: 'Reviewed self-authored tool result',
        maySatisfyVerificationGate: false,
        maySatisfyMutationProof: true,
      },
    })
    const verdict = evaluateVerificationGate({ step: makeStep(), refs: [reviewed] })
    expect(verdict.passed).toBe(true)
  })

  // ROOT CAUSE:
  //
  // A side-effect step can require both human approval and a tool result.
  // Requiring every evidence item to prove a mutation rejected the human
  // approval even when the trusted tool result proved the write.
  it('accepts human approval beside a trusted mutation proof', () => {
    const step = makeStep({
      approvalRequired: true,
      expectedEvidence: [
        { source: 'human_approval', description: 'user approved the write' },
        { source: 'tool_result', description: 'adapter written' },
      ],
    })
    const approval = makeRef({
      source: 'human_approval',
      summary: 'approved by the user',
      provenance: {
        // NOTICE:
        // Human approval evidence resolves to the approval/safety policy
        // authority (provenance.ts); the contract has no
        // `explicit_user_statement` source, so tests must use the real one.
        source: 'approval_safety_policy',
        precedence: 20,
        label: 'Approval/safety policy',
        maySatisfyVerificationGate: false,
        maySatisfyMutationProof: false,
      },
    })

    const verdict = evaluateVerificationGate({ step, refs: [approval, makeRef()] })

    expect(verdict.passed).toBe(true)
    expect(verdict.satisfied).toHaveLength(2)
  })

  it('does not let approval alone prove a side effect', () => {
    const step = makeStep({
      approvalRequired: true,
      expectedEvidence: [{ source: 'human_approval', description: 'user approved the write' }],
    })
    const approval = makeRef({
      source: 'human_approval',
      provenance: {
        source: 'approval_safety_policy',
        precedence: 20,
        label: 'Approval/safety policy',
        maySatisfyVerificationGate: false,
        maySatisfyMutationProof: false,
      },
    })

    const verdict = evaluateVerificationGate({ step, refs: [approval] })

    expect(verdict.passed).toBe(false)
    expect(verdict.missing[0]?.reason).toBe('not_mutation_proof')
  })

  // A tool-less sign-off step cannot act; the decided approval card IS the
  // whole work, so it completes without tool provenance.
  it('lets a decided approval complete a tool-less sign-off step', () => {
    const step = makeStep({
      riskLevel: 'low',
      approvalRequired: true,
      allowedTools: [],
      expectedEvidence: [{ source: 'human_approval', description: 'user approves' }],
    })
    const approval = makeRef({
      source: 'human_approval',
      provenance: {
        source: 'approval_safety_policy',
        precedence: 20,
        label: 'Approval/safety policy',
        maySatisfyVerificationGate: false,
        maySatisfyMutationProof: false,
      },
    })

    const verdict = evaluateVerificationGate({ step, refs: [approval] })

    expect(verdict.passed).toBe(true)
  })

  it('does not demand mutation proof for read-only steps', () => {
    const step = makeStep({ riskLevel: 'low' })
    expect(stepHasSideEffects(step)).toBe(false)
    const verdict = evaluateVerificationGate({
      step,
      refs: [makeRef({
        provenance: {
          source: 'current_run_task_memory',
          precedence: 60,
          label: 'Current-run TaskMemory',
          maySatisfyVerificationGate: false,
          maySatisfyMutationProof: false,
        },
      })],
    })
    expect(verdict.passed).toBe(true)
  })

  it('does not treat a git log receipt as reading diff content', () => {
    const verdict = evaluateVerificationGate({
      step: makeStep({
        riskLevel: 'low',
        allowedTools: ['bash', 'read'],
        expectedEvidence: [{ source: 'tool_result', description: '查看 diff' }],
      }),
      refs: [makeRef({
        toolName: 'bash',
        tier: 'read-only',
        summary: '{"status":"ok","stdout":"commit abc123\\nAuthor: AIRI\\nDate: today\\n    update workspace"}',
      })],
    })

    expect(verdict.passed).toBe(false)
    expect(verdict.missing[0]?.reason).toBe('not_diff_content')
  })

  it('accepts a read receipt that contains a unified diff hunk', () => {
    const verdict = evaluateVerificationGate({
      step: makeStep({
        riskLevel: 'low',
        allowedTools: ['bash', 'read'],
        expectedEvidence: [{ source: 'tool_result', description: '查看 diff' }],
      }),
      refs: [makeRef({
        toolName: 'read',
        summary: 'patches/change.patch  (4 lines)\n1  diff --git a/src/a.ts b/src/a.ts\n2  @@ -1 +1 @@\n3  -old\n4  +new',
      })],
    })

    expect(verdict.passed).toBe(true)
  })
})
