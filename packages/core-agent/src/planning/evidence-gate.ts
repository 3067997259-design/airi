import type { PlanExpectedEvidence, PlanRiskLevel } from '../authority/contract'
import type { GateRef, VerificationGateVerdict } from '../authority/gate'
import type { ToolEvidenceAuthor } from '../authority/provenance'
/**
 * Evidence gate runtime (CODING-HARNESS-DESIGN §4 第四期 core loop).
 *
 * Closes the loop the fork is built on: journal `tool/result` events become
 * `PlanEvidenceRef`s with resolved provenance, the verification gate
 * evaluates each plan step mechanically, and the derived step status is a
 * pure projection of the journal — nothing here trusts model claims.
 *
 * The desktop wiring (approval cards, step execution loop) consumes this
 * runtime later (WORKSPACE-DESIGN / WIRING-BACKLOG); everything below runs
 * headless against journal fixtures.
 */
import type { JournalEvent } from '../journal/types'

import { evaluateVerificationGate } from '../authority/gate'
import { resolveEvidenceAuthority } from '../authority/provenance'

export interface StepGateSpec {
  id: string
  riskLevel: PlanRiskLevel
  approvalRequired: boolean
  expectedEvidence: PlanExpectedEvidence[]
}

export type StepGateStatus = 'pending' | 'in_progress' | 'completed' | 'blocked' | 'failed'

export interface StepGateState {
  status: StepGateStatus
  verdict?: VerificationGateVerdict
  /** Reason a blocked step is stuck, for the review/approval card. */
  reason?: string
}

export interface EvidenceGateSnapshot {
  steps: Record<string, StepGateState>
}

/**
 * Converts journal events into gate refs for one step: `tool/result` events
 * bound to the step (provenance resolved via the author bucket) plus
 * `approval/decided` pairs for `human_approval` evidence.
 */
export function collectStepGateRefs(events: readonly JournalEvent[], stepId: string): GateRef[] {
  const refs: GateRef[] = []
  const approvals = new Map<string, {
    asked: Extract<JournalEvent, { type: 'approval/asked' }>
    decision?: Extract<JournalEvent, { type: 'approval/decided' }>['decision']
  }>()

  for (const event of events) {
    if (event.type === 'tool/result' && event.stepId === stepId && event.ok) {
      const evidenceAuthor = event.provenance as ToolEvidenceAuthor | undefined
      const provenance = resolveEvidenceAuthority({ source: 'tool_result' }, evidenceAuthor ?? 'unreviewed_self_authored')
      refs.push({
        stepId,
        source: 'tool_result',
        summary: event.summary,
        provenance,
      })
    }
    else if (event.type === 'approval/asked' && !approvals.has(event.requestId)) {
      approvals.set(event.requestId, { asked: event })
    }
    else if (event.type === 'approval/decided') {
      const approval = approvals.get(event.requestId)
      if (approval)
        approval.decision = event.decision
    }
  }

  for (const [requestId, approval] of approvals) {
    if (approval.asked.stepId !== stepId || approval.decision !== 'allowed-once')
      continue

    refs.push({
      stepId,
      source: 'human_approval',
      summary: `approval ${requestId} allowed by ${approval.asked.reason}`,
      provenance: resolveEvidenceAuthority({ source: 'human_approval' }),
    })
  }

  return refs
}

/** Evaluates the verification gate for one step over the journal. */
export function verdictForStep(events: readonly JournalEvent[], step: StepGateSpec): VerificationGateVerdict {
  return evaluateVerificationGate({
    step,
    refs: collectStepGateRefs(events, step.id),
  })
}

/**
 * Projects step states from the journal. A step with no activity stays
 * `pending`; `plan/update` moves it to `in_progress`; the gate verdict
 * decides `completed` vs `blocked` (missing evidence) / `failed`
 * (announced evidence contradicted). `plan/update.completed` announced by
 * the model is ignored — only the gate can complete a step.
 */
export function projectStepGateStates(events: readonly JournalEvent[], steps: readonly StepGateSpec[]): EvidenceGateSnapshot {
  const result: Record<string, StepGateState> = {}

  for (const step of steps) {
    const latestPlan = latestPlanUpdateFor(events, step.id)
    if (!latestPlan && !hasAnyActivity(events, step.id)) {
      result[step.id] = { status: 'pending' }
      continue
    }

    const verdict = verdictForStep(events, step)
    if (verdict.passed) {
      result[step.id] = { status: 'completed', verdict }
      continue
    }

    if (step.approvalRequired && !hasAnyHumanApproval(events, step.id)) {
      result[step.id] = {
        status: 'blocked',
        verdict,
        reason: `approval required: ${step.id}`,
      }
      continue
    }

    const missingItem = verdict.missing[0]
    const stuckReason = missingItem
      ? `missing ${missingItem.expected.source} evidence: ${missingItem.reason}`
      : 'gate not satisfied'
    result[step.id] = {
      status: latestPlan?.status === 'failed' || latestToolResultFailed(events, step.id) ? 'failed' : 'blocked',
      verdict,
      reason: stuckReason,
    }
  }

  return { steps: result }
}

function latestPlanUpdateFor(events: readonly JournalEvent[], stepId: string): Extract<JournalEvent, { type: 'plan/update' }> | undefined {
  let latest: Extract<JournalEvent, { type: 'plan/update' }> | undefined
  for (const event of events) {
    if (event.type === 'plan/update' && event.stepId === stepId)
      latest = event
  }
  return latest
}

function hasAnyActivity(events: readonly JournalEvent[], stepId: string): boolean {
  return events.some(event =>
    (event.type === 'tool/result' && event.stepId === stepId)
    || (event.type === 'plan/update' && event.stepId === stepId)
    || (event.type === 'approval/asked' && event.stepId === stepId))
}

function hasAnyHumanApproval(events: readonly JournalEvent[], stepId: string): boolean {
  return collectStepGateRefs(events, stepId).some(ref => ref.source === 'human_approval')
}

function latestToolResultFailed(events: readonly JournalEvent[], stepId: string): boolean {
  let latest: Extract<JournalEvent, { type: 'tool/result' }> | undefined
  for (const event of events) {
    if (event.type === 'tool/result' && event.stepId === stepId)
      latest = event
  }
  return latest?.ok === false
}
