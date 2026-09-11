/**
 * Flow completion authority (FLOW-AUTONOMY batch C).
 *
 * A `flow_update done` declaration is a claim, not a fact. The claim is
 * checked at the turn boundary in two layers, and only there — never during
 * the working loop:
 *
 * - L1, {@link evaluateFlowCompletion}: the mechanical conjunction over plan
 *   step states. Every step must be completed by the verification gate or
 *   explicitly closed by the model through `plan_update complete` (recorded
 *   as unverified).
 * - L3, {@link parseFlowReviewVerdict}: the host-supplied reviewer reads a
 *   bounded journal slice (her claims vs. the tool receipts) and passes or
 *   bounces the declaration. Parsing is defensive: a reviewer that rejects
 *   without citing a receipt is treated as an abstain, so a weak reviewer
 *   cannot stall the loop forever.
 *
 * A flow with no plan activity passes L1 vacuously; L3 alone then judges it.
 * This is what lets genuinely analysis-shaped flows complete — the previous
 * "must have mutated something" gate made read-only investigations unable to
 * finish honestly.
 */

import type { PlanSpec, PlanState } from '../authority/contract'

export interface FlowCompletionStepInput {
  planId: string
  stepId: string
  /** Step intent, quoted in blocker messages the model reads. */
  title?: string
  /** The verification gate completed this step in the journal. */
  gateCompleted: boolean
  /**
   * The model explicitly closed this step through `plan_update` action
   * "complete". It counts as finished but is reported as unverified so the
   * wrap-up can state it plainly.
   */
  declaredComplete: boolean
  /** The step is stuck waiting on an approval card decision. */
  approvalBlocked?: boolean
  status?: 'pending' | 'in_progress' | 'blocked' | 'failed'
}

export interface FlowCompletionBlocker {
  planId: string
  stepId: string
  title?: string
  reason: string
}

export interface FlowCompletionVerdict {
  pass: boolean
  blockers: FlowCompletionBlocker[]
  /** Steps closed by declaration instead of evidence; an honest wrap-up names them. */
  unverifiedClosed: FlowCompletionBlocker[]
}

export interface FlowReviewVerdict {
  verdict: 'pass' | 'bounce' | 'abstain'
  feedback?: string
}

/**
 * Evaluates the L1 completion conjunction over normalized plan step states.
 *
 * @example
 * evaluateFlowCompletion([
 *   { planId: 'p1', stepId: 's1', gateCompleted: true, declaredComplete: false },
 *   { planId: 'p1', stepId: 's2', gateCompleted: false, declaredComplete: true },
 * ])
 * // => { pass: true, blockers: [], unverifiedClosed: [{ planId: 'p1', stepId: 's2', reason: 'closed by declaration without evidence' }] }
 */
export function evaluateFlowCompletion(steps: readonly FlowCompletionStepInput[]): FlowCompletionVerdict {
  const blockers: FlowCompletionBlocker[] = []
  const unverifiedClosed: FlowCompletionBlocker[] = []

  for (const step of steps) {
    const title = step.title === undefined ? {} : { title: step.title }
    // A declaration cannot override a pending approval or a recorded failure.
    // Those states require a new decision or a new execution attempt before a
    // flow may cross its completion boundary.
    if (step.approvalBlocked || step.status === 'failed') {
      blockers.push({
        planId: step.planId,
        stepId: step.stepId,
        ...title,
        reason: step.approvalBlocked ? 'waiting for the approval card decision' : 'step failed',
      })
      continue
    }

    if (step.gateCompleted)
      continue

    if (step.declaredComplete) {
      unverifiedClosed.push({ planId: step.planId, stepId: step.stepId, ...title, reason: 'closed by declaration without evidence' })
      continue
    }

    const reason = step.status === 'blocked'
      ? 'step is blocked'
      : step.status === 'in_progress'
        ? 'step is still in progress'
        : 'step has not started'
    blockers.push({ planId: step.planId, stepId: step.stepId, ...title, reason })
  }

  return { pass: blockers.length === 0, blockers, unverifiedClosed }
}

/**
 * Normalizes one plan's steps into the conjunction inputs of
 * {@link evaluateFlowCompletion}.
 *
 * Skipped steps are left out entirely: supersession closes them by decision,
 * they can never collect evidence again, and reading them would hold every
 * later done declaration open over work no one will run
 * (ACC-20260909 FIX1). A focused step reports `blocked` only while its plan
 * records blockers; otherwise it reports `in_progress`.
 *
 * @example
 * flowCompletionStepInputs({
 *   id: 'p1',
 *   spec: { goal: 'g', horizon: 'session', steps: [{ id: 's1', ... }] },
 *   state: { completedSteps: [], failedSteps: [], skippedSteps: ['s1'], evidenceRefs: [], blockers: [] },
 * })
 * // => []
 */
export function flowCompletionStepInputs(plan: { id: string, spec: PlanSpec, state: PlanState }): FlowCompletionStepInput[] {
  return plan.spec.steps
    .filter(step => !plan.state.skippedSteps.includes(step.id))
    .map((step) => {
      const declared = (plan.state.unverifiedSteps ?? []).includes(step.id)
      const completed = plan.state.completedSteps.includes(step.id)
      const status = plan.state.failedSteps.includes(step.id)
        ? 'failed' as const
        : plan.state.currentStepId === step.id
          ? (plan.state.blockers.length > 0 ? 'blocked' as const : 'in_progress' as const)
          : 'pending' as const
      return {
        planId: plan.id,
        stepId: step.id,
        title: step.intent,
        gateCompleted: completed && !declared,
        declaredComplete: declared,
        status,
      }
    })
}

/** Receipts a bounce may cite: the sequence reference or any work-tool name. */
const REVIEW_RECEIPT_TOOLS = ['write', 'edit', 'bash', 'read', 'grep', 'list', 'code_mode', 'job_output', 'job_kill', 'test', 'build', 'exit', 'result', 'receipt']

/** A bounce must cite a receipt: a tool name as a whole word, or a seq reference. */
const REVIEW_RECEIPT_CITATION = new RegExp(
  `seq\\s*#?\\d+|(?<![a-z])(?:${REVIEW_RECEIPT_TOOLS.join('|')})(?![a-z])`,
  'i',
)

/**
 * Parses the completion reviewer's answer.
 *
 * Accepts a JSON object (`{ "verdict": "pass" | "bounce" | "abstain", "feedback": ... }`)
 * or a leading prose verdict followed by a colon or dash. A bounce whose feedback cites no concrete receipt is
 * downgraded to an abstain — a rejection the model could act on must point at
 * the evidence that fails to hold. Unparseable answers abstain too.
 *
 * @example
 * parseFlowReviewVerdict('{"verdict":"bounce","feedback":"bash seq 12 probe never ran the tests"}')
 * // => { verdict: 'bounce', feedback: 'bash seq 12 probe never ran the tests' }
 * parseFlowReviewVerdict('looks bad')
 * // => { verdict: 'abstain' }
 */
export function parseFlowReviewVerdict(raw: string | undefined): FlowReviewVerdict {
  const text = (raw ?? '').trim()
  if (!text)
    return { verdict: 'abstain' }

  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as { verdict?: unknown, feedback?: unknown }
      const feedback = typeof parsed.feedback === 'string' && parsed.feedback.trim() ? parsed.feedback.trim() : undefined
      if (parsed.verdict === 'pass')
        return { verdict: 'pass', ...(feedback ? { feedback } : {}) }
      if (parsed.verdict === 'bounce') {
        if (feedback && REVIEW_RECEIPT_CITATION.test(feedback))
          return { verdict: 'bounce', feedback }
        return { verdict: 'abstain' }
      }
      // The structured verdict owns the decision. Feedback may quote passing
      // tests while the reviewer abstains or returns an unsupported verdict.
      return { verdict: 'abstain' }
    }
    catch {
      // A malformed structured response supplies no trustworthy verdict.
      return { verdict: 'abstain' }
    }
  }

  if (/^(?:pass|approve)(?:\s*[:—-]|\s*$)/i.test(text))
    return { verdict: 'pass' }
  if (/^(?:bounce|reject)(?:\s*[:—-]|\s*$)/i.test(text)) {
    if (REVIEW_RECEIPT_CITATION.test(text))
      return { verdict: 'bounce', feedback: text.slice(0, 500) }
    return { verdict: 'abstain' }
  }
  return { verdict: 'abstain' }
}
