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
  outcome?: 'ok' | 'failed' | 'denied' | 'timeout'
  tier?: 'read-only' | 'medium' | 'high'
}

export interface VerificationGateInput {
  step: {
    id: string
    riskLevel: 'low' | 'medium' | 'high'
    approvalRequired: boolean
    expectedEvidence: PlanExpectedEvidence[]
    /** Steps with no declared tools cannot act; a decided approval is their whole work. */
    allowedTools: string[]
    /** Step intent, when the caller has it; feeds the verification-semantic check. */
    intent?: string
  }
  /** Receipts in journal order; readback must follow the latest mutation. */
  refs: GateRef[]
}

export interface VerificationGateSatisfied {
  expected: PlanExpectedEvidence
  ref: GateRef
}

export interface VerificationGateMissing {
  expected: PlanExpectedEvidence
  reason: 'no_ref' | 'wrong_source' | 'not_mutation_proof' | 'not_verified_outcome' | 'not_diff_content' | 'not_observed_content'
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
  if (ref.outcome && ref.outcome !== 'ok')
    return false
  if (ref.toolName === undefined)
    return true
  if (ref.toolName === 'bash')
    return ref.tier ? ref.tier !== 'read-only' : !/read-only tier/.test(ref.summary)
  if (READ_ONLY_TOOL_NAMES.has(ref.toolName))
    return false
  return true
}

/** Whether the step can act at all: a tool-less step is pure conversation/sign-off. */
export function stepCanAct(step: VerificationGateInput['step']): boolean {
  return step.allowedTools.length > 0
}

// Verification-semantic matching (FLOW-DIAGNOSIS P0-1, 2026-09-02): a step
// whose declared intent or evidence descriptions say test/verify/build must
// not complete from a receipt that carries no verification semantics — in the
// field run a bare liveness probe (`node -e` hitting a port) satisfied a
// "write tests and verify" step because it was merely a successful bash
// result. Receipts from execution tools count when their summary names a
// test/spec/build artifact or an explicit pass/fail outcome; writing a test
// file (write/edit) never counts as running it.
// Removal condition: when plan steps can declare structured verification
// commands instead of free-text intent/description.
const VERIFICATION_STEP_PATTERN = /\b(?:tests?|testing|verify|verification|build|lint|check|typecheck)\b|检查|验证|测试|构建/i
const EXECUTION_STEP_PATTERN = /\b(?:tests?|testing|build|lint|typecheck)\b|测试|构建/i
const OBSERVATION_STEP_PATTERN = /\b(?:read|inspect|readback)\b|(?:check|verify|verification).*(?:file|content)|(?:file|content).*(?:check|verification)|读回|读取|查看|(?:检查|验证).*(?:文件|内容)/i
const VERIFICATION_RECEIPT_PATTERN = /_test\.|\.test\.|\.spec\.|_spec\.|\b(?:test|tests|spec|verify|verification|vitest|jest|pytest|build|compile|lint|check|typecheck|tsc|eslint)\b/i
/** Receipts that can carry verification semantics: execution tools only. */
const VERIFICATION_RECEIPT_TOOLS = new Set(['bash', 'code_mode', 'job_output'])

// A diff step requires the result body, not a command name or a successful
// read-only command. Unified diff markers are the stable common denominator
// for `git diff`, a patch file, and a background job that prints the diff.
// Removal condition: when tool results carry structured evidence kinds instead
// of bounded text summaries, use that diff-content field directly.
const DIFF_STEP_PATTERN = /diff|patch|差异|补丁内容|变更内容/i
const DIFF_RECEIPT_TOOLS = new Set(['bash', 'read', 'readRaw', 'job_output', 'code_mode'])
const DIFF_CONTENT_PATTERN = /diff --git\s+a\/\S+\s+b\/\S+|@@\s+-\d+(?:,\d+)?\s+\+\d+(?:,\d+)?\s+@@|(?:^|\\n|\r?\n)(?:---|\+\+\+)\s+(?:a\/|b\/)\S+/m

function stepExpectsVerification(step: VerificationGateInput['step']): boolean {
  const text = [step.intent ?? '', ...step.expectedEvidence.map(item => item.description)].join(' ')
  // Explicit test/build work still requires execution, even when the step
  // also reads files. Generic file inspection does not imply a test run.
  return EXECUTION_STEP_PATTERN.test(text)
    || (VERIFICATION_STEP_PATTERN.test(text) && !OBSERVATION_STEP_PATTERN.test(text))
}

function refCarriesVerification(ref: GateRef): boolean {
  if (ref.source !== 'tool_result' || (ref.outcome && ref.outcome !== 'ok'))
    return false
  if (ref.toolName !== undefined && !VERIFICATION_RECEIPT_TOOLS.has(ref.toolName))
    return false
  return VERIFICATION_RECEIPT_PATTERN.test(ref.summary)
}

function expectedEvidenceDescribesDiff(expected: PlanExpectedEvidence): boolean {
  return DIFF_STEP_PATTERN.test(expected.description)
}

function stepExpectsDiff(step: VerificationGateInput['step']): boolean {
  return [step.intent ?? '', ...step.expectedEvidence.map(item => item.description)]
    .some(text => DIFF_STEP_PATTERN.test(text))
}

function refCarriesDiffContent(ref: GateRef): boolean {
  if (ref.source !== 'tool_result' || (ref.outcome && ref.outcome !== 'ok'))
    return false
  if (ref.toolName !== undefined && !DIFF_RECEIPT_TOOLS.has(ref.toolName))
    return false
  return DIFF_CONTENT_PATTERN.test(ref.summary)
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
    // Prefer the execution receipt for test work. Otherwise prefer mutation
    // proof over a generic source match. Independent checks below still
    // require each promised behavior, even when one ref is shown here.
    const verification = stepExpectsVerification(input.step)
      ? stepRefs.find(ref => ref.source === expected.source && refCarriesVerification(ref))
      : undefined
    const match = verification ?? stepRefs.find(ref => ref.source === expected.source && refProvesMutation(ref))
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
    && !stepRefs.some(refProvesMutation)
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

  // Independent of mutation proof: a verification-flavored step owes a
  // receipt with verification semantics. Runs even for read-only steps, so a
  // "test and verify" step cannot complete from an unrelated probe.
  if (
    stepExpectsVerification(input.step)
    && stepCanAct(input.step)
    && satisfied.length > 0
    && !stepRefs.some(refCarriesVerification)
  ) {
    const index = satisfied.findIndex(({ expected }) => expected.source === 'tool_result')
    const [unverified] = satisfied.splice(index >= 0 ? index : 0, 1)
    if (unverified) {
      missing.push({
        expected: unverified.expected,
        reason: 'not_verified_outcome',
      })
    }
  }

  const intent = [input.step.intent ?? '', ...input.step.expectedEvidence.map(item => item.description)].join(' ')
  if (OBSERVATION_STEP_PATTERN.test(intent) && !stepExpectsDiff(input.step) && stepCanAct(input.step) && satisfied.length > 0) {
    // A write receipt describes the mutation, not the resulting file. A
    // pre-write read cannot prove the contents left by that mutation either.
    const explicitReadback = /\bread[- ]?back\b|读回|写入后|写后/i.test(intent)
    const mutationIndex = stepRefs.findLastIndex(ref => refProvesMutation(ref)
      && (explicitReadback || (ref.toolName !== undefined && MUTATING_TOOL_NAMES.has(ref.toolName))))
    const observed = stepRefs.some((ref, index) => index > mutationIndex
      && ref.source === 'tool_result'
      // An absent outcome means ok — the journal only carries the field on
      // failures, matching collectStepGateRefs and refProvesMutation.
      // Requiring the literal field here rejected every readback whose
      // receipt came from the plain tool-result path.
      && (ref.outcome ?? 'ok') === 'ok'
      && (ref.toolName === 'read' || ref.toolName === 'readRaw')
      && ref.summary.trim().length > 0)
    if (!observed) {
      const index = satisfied.findIndex(({ expected }) => expected.source === 'tool_result')
      if (index >= 0) {
        const [unread] = satisfied.splice(index, 1)
        missing.push({ expected: unread!.expected, reason: 'not_observed_content' })
      }
    }
  }

  // A diff-flavored evidence item is stricter than the generic verification
  // semantic check: `git log`, `git diff --stat`, and a successful probe do not
  // show changed content. Require an accepted tool result whose body contains
  // a unified-diff marker, so the gate follows what was read rather than which
  // command happened to succeed.
  if (stepExpectsDiff(input.step) && stepCanAct(input.step)) {
    for (const expected of input.step.expectedEvidence.filter(expectedEvidenceDescribesDiff)) {
      const satisfiedIndex = satisfied.findIndex(item => item.expected === expected)
      if (satisfiedIndex < 0 || expected.source !== 'tool_result')
        continue
      if (stepRefs.some(ref => refCarriesDiffContent(ref)))
        continue

      const [unread] = satisfied.splice(satisfiedIndex, 1)
      if (unread) {
        missing.push({
          expected: unread.expected,
          reason: 'not_diff_content',
        })
      }
    }
  }

  return {
    passed: missing.length === 0,
    stepId: input.step.id,
    satisfied,
    missing,
  }
}
