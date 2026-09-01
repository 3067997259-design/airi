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
  /** Producer tool for `tool_result` refs; absent for approvals and traces. */
  toolName?: string
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
 * A step has side effects when the model grades it risky, or when its own
 * tool whitelist contains an unambiguous mutation tool. The whitelist is
 * structure and the risk level is a model proposal, so a "low risk" step that
 * declares `write`/`edit` still owes mutation-proof evidence — under-grading
 * a write step must not lower the gate (2026-09-01: a 3-step plan whose steps
 * all declared `low` completed from read-only tool spam). `bash` stays out of
 * this list: its effect is not statically knowable, and its evidence is
 * graded per-run by {@link refProvesMutation}.
 */
const MUTATING_TOOL_NAMES = new Set(['write', 'edit'])

/** Tools that can only observe; their results never prove a change. */
const READ_ONLY_TOOL_NAMES = new Set(['read', 'readRaw', 'list', 'grep'])

export function stepHasSideEffects(step: VerificationGateInput['step']): boolean {
  if (step.riskLevel !== 'low' || step.approvalRequired)
    return true
  return step.allowedTools.some(tool => MUTATING_TOOL_NAMES.has(tool))
}

/**
 * Whether one matched ref proves an actual change: the producer bucket must
 * allow mutation proof at all, the tool must be able to mutate, and a `bash`
 * run counts only when its recorded tier is not read-only.
 */
export function refProvesMutation(ref: GateRef): boolean {
  if (!ref.provenance.maySatisfyMutationProof)
    return false
  if (ref.source !== 'tool_result')
    return false
  if (ref.toolName === undefined)
    return true
  if (ref.toolName === 'bash')
    return !/read-only tier/.test(ref.summary)
  if (READ_ONLY_TOOL_NAMES.has(ref.toolName))
    return false
  return true
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
    // A mutation-proving ref wins over an earlier matching ref of the same
    // source: a step that ran bash (read-only) and then write has satisfied
    // its evidence with the write, not with the read-only shell run.
    const match = stepRefs.find(ref => ref.source === expected.source && refProvesMutation(ref))
      ?? stepRefs.find(ref => ref.source === expected.source)

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
    && !satisfied.some(({ ref }) => refProvesMutation(ref))
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
