/**
 * Verification gate (WORKSPACE-DESIGN §2.4): mechanical completion check.
 *
 * A step may only be marked `completed` when every `expectedEvidence` item
 * announced at plan time is backed by a ref with a matching source. For a
 * side-effect step, at least one matched ref must also prove the mutation. The
 * model can never declare completion; only this function can.
 */
import type { PlanEvidenceRef, PlanExpectedEvidence, PlanningAuthorityRule } from './contract'

export interface GateRef extends PlanEvidenceRef {
  provenance: PlanningAuthorityRule
}

export interface VerificationGateInput {
  step: {
    id: string
    riskLevel: 'low' | 'medium' | 'high'
    approvalRequired: boolean
    expectedEvidence: PlanExpectedEvidence[]
    /** Steps with no declared tools cannot act; a decided approval is their whole work. */
    allowedTools: string[]
  }
  refs: GateRef[]
}

export interface VerificationGateSatisfied {
  expected: PlanExpectedEvidence
  ref: GateRef
}

export interface VerificationGateMissing {
  expected: PlanExpectedEvidence
  reason: 'no_ref' | 'wrong_source' | 'not_mutation_proof'
}

export interface VerificationGateVerdict {
  passed: boolean
  stepId: string
  satisfied: VerificationGateSatisfied[]
  missing: VerificationGateMissing[]
}

/**
 * A step has side effects unless it is explicitly a pure read. The gate
 * requires mutation-provable evidence exactly for these steps.
 */
export function stepHasSideEffects(step: VerificationGateInput['step']): boolean {
  return step.riskLevel !== 'low' || step.approvalRequired
}

/** Whether the step can act at all: a tool-less step is pure conversation/sign-off. */
export function stepCanAct(step: VerificationGateInput['step']): boolean {
  return step.allowedTools.length > 0
}

/**
 * Evaluates the verification gate for one step. A matching ref with the
 * wrong source (e.g. a `runtime_trace` where `tool_result` was announced)
 * counts as missing with `wrong_source`, so the caller can show exactly why
 * the step is stuck. A tool-less sign-off step cannot act at all, so a
 * decided approval card is its whole work and completes without tool
 * provenance; steps that declare tools still need mutation-provable evidence.
 */
export function evaluateVerificationGate(input: VerificationGateInput): VerificationGateVerdict {
  const stepRefs = input.refs.filter(ref => ref.stepId === input.step.id)
  const satisfied: VerificationGateSatisfied[] = []
  const missing: VerificationGateMissing[] = []

  for (const expected of input.step.expectedEvidence) {
    const match = stepRefs.find(ref => ref.source === expected.source)

    if (!match) {
      const wrongSource = stepRefs[0]
      missing.push({
        expected,
        reason: wrongSource ? 'wrong_source' : 'no_ref',
      })
      continue
    }

    satisfied.push({ expected, ref: match })
  }

  if (
    stepHasSideEffects(input.step)
    && stepCanAct(input.step)
    && satisfied.length > 0
    && !satisfied.some(({ ref }) => ref.provenance.maySatisfyMutationProof)
  ) {
    const index = satisfied.findIndex(({ expected }) => expected.source === 'tool_result')
    const [unproven] = satisfied.splice(index >= 0 ? index : 0, 1)
    if (unproven) {
      missing.push({
        expected: unproven.expected,
        reason: 'not_mutation_proof',
      })
    }
  }

  return {
    passed: missing.length === 0,
    stepId: input.step.id,
    satisfied,
    missing,
  }
}
