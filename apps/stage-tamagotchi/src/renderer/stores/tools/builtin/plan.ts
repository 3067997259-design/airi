import type { PlanLane, PlanSpec } from '@proj-airi/core-agent'
import type { Tool } from '@xsai/shared-chat'

import { usePlanStore } from '@proj-airi/stage-ui/stores/plans'
import { tool } from '@xsai/tool'
import { z } from 'zod'

// -- LLM Tool: plan_update --
// Turns the plan runtime on: without this tool no production code path ever
// calls `plans.start`, so the evidence gate and plan cards stay dormant. The
// tool is steering only — it can create, focus, or cancel a plan, but it can
// never mark a step complete; completion is decided by journal evidence
// (WORKSPACE-DESIGN §3).

const PLAN_LANES = ['coding', 'desktop', 'browser_dom', 'terminal', 'human', 'mcp', 'websocket', 'conversation'] as const satisfies readonly PlanLane[]

const stepSchema = z.object({
  id: z.string().describe('Stable step id, e.g. "step-1". Reference it later in plan_update focus.'),
  lane: z.enum(PLAN_LANES).describe('Which surface this step runs on. Use "coding" for workspace file tools and shell, "conversation" for pure reply steps.'),
  intent: z.string().describe('What this step does, one sentence.'),
  allowedTools: z.array(z.string()).describe('Tool names this step may use. Only results from these tools can prove the step\'s completion.'),
  expectedEvidence: z.array(z.object({
    source: z.enum(['tool_result', 'verification_gate', 'human_approval']),
    description: z.string().describe('What the evidence must show, e.g. "read output contains the new import".'),
  })).describe('Evidence required before the step counts as complete. tool_result entries are satisfied by an actual allowed-tool result; your own claims never satisfy the gate.'),
  riskLevel: z.enum(['low', 'medium', 'high']).describe('Static hint used for approval routing; high-risk steps expect human approval.'),
  approvalRequired: z.boolean().describe('Whether this step needs explicit user approval before running.'),
})

const params = z.object({
  action: z.enum(['start', 'focus', 'cancel']).describe('start: replace the plan with a new spec. focus: announce the step you are working on. cancel: abandon the plan.'),
  goal: z.string().optional().describe('action=start: the overall goal.'),
  horizon: z.enum(['session', 'long']).optional().describe('action=start: session for a bounded current task; long for a rolling goal. Defaults to session.'),
  steps: z.array(stepSchema).min(1).optional().describe('action=start: ordered steps; the first one becomes in_progress automatically.'),
  stepId: z.string().optional().describe('action=focus: the step id to focus.'),
})

/**
 * The plan_update executor. Exported so behavioral tests can drive it without
 * going through the xsAI tool shell; the shell itself is covered by the
 * built-in registration test.
 */
export async function executePlanUpdate(input: {
  action: 'start' | 'focus' | 'cancel'
  goal?: string
  horizon?: 'session' | 'long'
  steps?: Array<{
    id: string
    lane: PlanLane
    intent: string
    allowedTools: string[]
    expectedEvidence: Array<{ source: 'tool_result' | 'verification_gate' | 'human_approval', description: string }>
    riskLevel: 'low' | 'medium' | 'high'
    approvalRequired: boolean
  }>
  stepId?: string
}): Promise<string> {
  const planStore = usePlanStore()

  if (input.action === 'start') {
    if (!input.goal?.trim() || !input.steps?.length)
      return 'plan_update action "start" requires both goal and steps.'

    const horizon = input.horizon ?? 'session'
    // Session plans supersede only the current session plan. A long goal is
    // a separate rolling lane and keeps its stable id across replans.
    const previous = horizon === 'session' ? planStore.activeSessionPlan : undefined
    if (previous) {
      const previousStepId = previous.state.currentStepId ?? previous.spec.steps[0]?.id
      if (previousStepId)
        await planStore.updateStep(previous.id, previousStepId, 'blocked', 'superseded by a new plan')
    }

    const spec: PlanSpec = {
      goal: input.goal.trim(),
      horizon,
      steps: input.steps.map(step => ({
        id: step.id,
        lane: step.lane,
        intent: step.intent,
        allowedTools: [...step.allowedTools],
        expectedEvidence: step.expectedEvidence.map(evidence => ({ ...evidence })),
        riskLevel: step.riskLevel,
        approvalRequired: step.approvalRequired,
      })),
    }
    const planId = await planStore.start(spec)
    return `Plan ${planId} created with ${spec.steps.length} step(s). Focus: "${spec.steps[0].id}". Tool results only count as evidence for the focused step's allowed tools.`
  }

  if (input.action === 'focus') {
    const plan = planStore.activeSessionPlan ?? planStore.activeLongPlan
    if (!plan)
      return 'No active plan. Use action "start" first.'
    if (!input.stepId || !plan.spec.steps.some(step => step.id === input.stepId))
      return `Unknown stepId. Plan steps: ${plan.spec.steps.map(step => step.id).join(', ')}.`
    await planStore.updateStep(plan.id, input.stepId, 'in_progress')
    return `Focusing step "${input.stepId}".`
  }

  const plan = planStore.activeSessionPlan ?? planStore.activeLongPlan
  if (!plan)
    return 'No active plan to cancel.'
  const stepId = plan.state.currentStepId ?? plan.spec.steps[0]?.id
  if (stepId)
    await planStore.updateStep(plan.id, stepId, 'failed', 'cancelled by the model')
  return 'Plan cancelled.'
}

const tools: Promise<Tool>[] = [
  tool({
    name: 'plan_update',
    description: 'Create or steer the plan for a multi-step task. Steps complete only when their expected evidence exists in the journal (an allowed-tool result, a verification, or a human approval) — never because you claim completion. Keep plans small: one plan per task, one focused step at a time.',
    execute: executePlanUpdate,
    parameters: params,
  }),
]

export const planTools = async () => Promise.all(tools)
