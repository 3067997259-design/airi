/**
 * Plan runtime (WORKSPACE-DESIGN §2 / §3, WIRING-BACKLOG §3).
 *
 * A headless, testable fold over plan-step events: tool whitelist
 * enforcement, evidence collection with resolved provenance, verification
 * gate evaluation, and the step state machine. The model can never declare
 * completion — only the gate can; a step whose tool is outside the
 * whitelist is structurally rejected before execution.
 */
import type { PlanExpectedEvidence, PlanLane, PlanRiskLevel } from '../authority/contract'
import type { GateRef, VerificationGateVerdict } from '../authority/gate'
import type { ToolEvidenceAuthor } from '../authority/provenance'

import { evaluateVerificationGate } from '../authority/gate'
import { resolveEvidenceAuthority } from '../authority/provenance'

export interface PlanRuntimeStepInput {
  id: string
  lane: PlanLane
  intent: string
  allowedTools: string[]
  expectedEvidence: PlanExpectedEvidence[]
  riskLevel: PlanRiskLevel
  approvalRequired: boolean
}

export interface PlanRuntimeSpec {
  goal: string
  steps: PlanRuntimeStepInput[]
}

export type PlanRuntimeEvent
  = | { type: 'start-step', stepId: string, toolName: string }
    | { type: 'tool-result', stepId: string, toolName: string, ok: boolean, summary: string, author?: ToolEvidenceAuthor }
    | { type: 'approval-decided', stepId: string, decision: 'approved' | 'rejected' }

export type PlanRuntimeStatus = 'pending' | 'in_progress' | 'completed' | 'blocked' | 'failed'

export interface PlanRuntimeStepState {
  status: PlanRuntimeStatus
  verdict?: VerificationGateVerdict
  reason?: string
}

export interface PlanRuntimeSnapshot {
  goal: string
  steps: Record<string, PlanRuntimeStepState>
  completedStepCount: number
  failedStepCount: number
  blockedStepCount: number
}

/** Whether the step's active tool is inside its declared whitelist. */
export function canUseTool(step: PlanRuntimeStepInput, toolName: string): boolean {
  return step.allowedTools.includes(toolName)
}

/**
 * Folds plan events into step states. Each event is processed in order:
 * `start-step` outside the whitelist blocks the step; tool results and
 * approvals become gate refs; the gate alone decides completed vs blocked.
 */
interface StepAccumulator {
  step: PlanRuntimeStepInput
  refs: GateRef[]
  started: boolean
  blockedReason?: string
}

export function projectPlanRuntime(spec: PlanRuntimeSpec, events: readonly PlanRuntimeEvent[]): PlanRuntimeSnapshot {
  const steps = new Map<string, StepAccumulator>(spec.steps.map(step => [step.id, { step, refs: [], started: false }]))

  for (const event of events) {
    const entry = steps.get(event.stepId)
    if (!entry)
      continue

    if (event.type === 'start-step') {
      if (!canUseTool(entry.step, event.toolName)) {
        entry.blockedReason = `tool "${event.toolName}" is not allowed for this step`
        continue
      }
      entry.started = true
      entry.refs = entry.refs.filter(ref => ref.source !== 'runtime_trace')
    }
    else if (event.type === 'tool-result') {
      if (!entry.started)
        entry.started = true
      entry.refs.push({
        stepId: event.stepId,
        source: 'tool_result',
        summary: event.summary,
        provenance: resolveEvidenceAuthority({ source: 'tool_result' }, event.author ?? 'unreviewed_self_authored'),
      })
    }
    else if (event.type === 'approval-decided' && event.decision === 'approved') {
      entry.refs.push({
        stepId: event.stepId,
        source: 'human_approval',
        summary: 'human approval recorded for step',
        provenance: resolveEvidenceAuthority({ source: 'human_approval' }),
      })
    }
  }

  const result: Record<string, PlanRuntimeStepState> = {}
  let completedStepCount = 0
  const failedStepCount = 0
  let blockedStepCount = 0

  for (const [stepId, entry] of steps) {
    const verdict = evaluateVerificationGate({ step: entry.step, refs: entry.refs })
    let state: PlanRuntimeStepState

    if (entry.blockedReason) {
      state = { status: 'blocked', verdict, reason: entry.blockedReason }
      blockedStepCount++
    }
    else if (!entry.started) {
      state = { status: 'pending' }
    }
    else if (verdict.passed) {
      state = { status: 'completed', verdict }
      completedStepCount++
    }
    else {
      const missing = verdict.missing[0]
      state = {
        status: entry.step.approvalRequired ? 'blocked' : 'blocked',
        verdict,
        reason: missing ? `missing ${missing.expected.source} evidence: ${missing.reason}` : 'gate not satisfied',
      }
      blockedStepCount++
    }
    result[stepId] = state
  }

  return {
    goal: spec.goal,
    steps: result,
    completedStepCount,
    failedStepCount,
    blockedStepCount,
  }
}
