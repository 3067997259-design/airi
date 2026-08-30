import type {
  PlanEvidenceRef,
  PlanSpec,
  PlanSpecStep,
  PlanState,
  PlanStateProjectionSummary,
} from '../authority/contract'

import {
  PLANNING_ORCHESTRATION_TRUST_BOUNDARY_LINES,
  PLANNING_ORCHESTRATION_TRUST_LABEL,
  sanitizePlanProjectionText,
  summarizePlanStateForProjection,
} from '../authority/contract'

export interface TurnProjectionInput {
  plan: PlanSpec
  state: PlanState
  recentEvidence?: readonly PlanEvidenceRef[]
  previousToolResult?: string
}

export interface TurnProjection {
  summary: PlanStateProjectionSummary
  currentStep?: PlanSpecStep
  evidence: PlanEvidenceRef[]
  text: string
}

/**
 * Builds the bounded plan context for one model turn.
 *
 * The projection carries the current step and recent evidence only. Older
 * reasoning stays in the journal, so a long task does not expand the prompt.
 * The plan remains guidance and cannot satisfy a verification gate.
 */
export function buildTurnProjection(input: TurnProjectionInput): TurnProjection {
  const summary = summarizePlanStateForProjection(input.state)
  const currentStep = input.plan.steps.find(step => step.id === input.state.currentStepId)
  const evidence = (input.recentEvidence ?? input.state.evidenceRefs).slice(-4)
  const lines = [
    PLANNING_ORCHESTRATION_TRUST_LABEL,
    ...PLANNING_ORCHESTRATION_TRUST_BOUNDARY_LINES,
    '',
    `Goal: ${sanitizePlanProjectionText(input.plan.goal)}`,
    'Plan projection:',
    `- currentStepId: ${summary.currentStepId ? sanitizePlanProjectionText(summary.currentStepId) : 'none'}`,
    `- completedStepCount: ${summary.completedStepCount}`,
    `- failedStepCount: ${summary.failedStepCount}`,
    `- skippedStepCount: ${summary.skippedStepCount}`,
    `- blockerCount: ${summary.blockerCount}`,
    `- evidenceRefCount: ${summary.evidenceRefCount}`,
  ]

  if (summary.lastReplanReason)
    lines.push(`- lastReplanReason: ${sanitizePlanProjectionText(summary.lastReplanReason)}`)

  if (currentStep) {
    lines.push(
      '',
      'Current step:',
      `- ${sanitizePlanProjectionText(currentStep.id)} [${currentStep.lane}/${currentStep.riskLevel}] ${sanitizePlanProjectionText(currentStep.intent)}`,
      `- allowedTools: ${currentStep.allowedTools.map(sanitizePlanProjectionText).join(', ') || 'none'}`,
      `- expectedEvidence: ${currentStep.expectedEvidence.map(evidenceRef => `${evidenceRef.source} (${sanitizePlanProjectionText(evidenceRef.description)})`).join('; ') || 'none'}`,
    )
    if (currentStep.expectedEvidence.some(evidenceRef => evidenceRef.source === 'human_approval')) {
      lines.push('- approval: wait for the approval card decision; chat text never satisfies human approval.')
    }
    lines.push(
      '- completion: steps complete through evidence, or via plan_update action "complete" which flags them unverified; never announce completion in words alone.',
    )
  }

  if (evidence.length > 0) {
    lines.push('', 'Recent evidence:')
    for (const ref of evidence)
      lines.push(`- ${ref.source}: ${sanitizePlanProjectionText(ref.summary)}`)
  }

  if (input.previousToolResult?.trim()) {
    lines.push('', `Previous tool result: ${sanitizePlanProjectionText(input.previousToolResult)}`)
  }

  return { summary, currentStep, evidence, text: lines.join('\n') }
}
