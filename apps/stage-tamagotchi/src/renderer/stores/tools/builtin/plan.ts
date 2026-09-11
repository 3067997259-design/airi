import type { PlanLane, PlanSpec } from '@proj-airi/core-agent'
import type { Tool } from '@xsai/shared-chat'

import type { CodingApprovalDecisionPayload, PlanApprovalAskPayload } from '../../../../shared/eventa'

import { defineInvoke } from '@moeru/eventa'
import { getElectronEventaContext } from '@proj-airi/electron-vueuse'
import { useChatSessionStore } from '@proj-airi/stage-ui/stores/chat/session-store'
import { useCodingToolsStore } from '@proj-airi/stage-ui/stores/coding'
import { hasOpenPlanSteps, usePlanStore } from '@proj-airi/stage-ui/stores/plans'
import { tool } from '@xsai/tool'
import { z } from 'zod'

import { planApprovalAsk } from '../../../../shared/eventa'

// -- LLM Tool: plan_update --
// Turns the plan runtime on: without this tool no production code path ever
// calls `plans.start`, so the evidence gate and plan cards stay dormant.
// Completion semantics (three tiers): hard evidence completes a step
// automatically; action "complete" lets the model finish a step without
// evidence at the cost of an amber "unverified" flag on the card;
// `human_approval` steps can only complete through a decided approval card —
// chat text never satisfies them.

const PLAN_LANES = ['coding', 'desktop', 'browser_dom', 'terminal', 'human', 'mcp', 'websocket', 'conversation'] as const satisfies readonly PlanLane[]

const stepSchema = z.object({
  id: z.string().describe('Stable step id, e.g. "step-1". Reference it later in plan_update focus.'),
  lane: z.enum(PLAN_LANES).describe('Which surface this step runs on. Use "coding" for workspace file tools and shell, "conversation" for pure reply steps.'),
  intent: z.string().describe('What this step does, one sentence.'),
  allowedTools: z.array(z.string()).describe('Tool names this step may use. Only results from these tools can prove the step\'s completion.'),
  expectedEvidence: z.array(z.object({
    source: z.enum(['tool_result', 'verification_gate', 'human_approval']),
    description: z.string().describe('What the evidence must show, e.g. "read output contains the new import".'),
  })).describe('Evidence the step ideally shows before completing. tool_result entries are satisfied by an actual allowed-tool result; steps finished without their evidence are flagged unverified on the plan card. Never declare human_approval evidence unless approvalRequired is true.'),
  riskLevel: z.enum(['low', 'medium', 'high']).describe('Static hint used for approval routing; high-risk steps expect human approval.'),
  approvalRequired: z.boolean().describe('Whether this step needs explicit user approval (an approval card) before it can complete.'),
})

const params = z.object({
  action: z.enum(['start', 'focus', 'complete', 'cancel']).describe('start: replace the plan with a new spec. focus: announce the step you are working on (raises the approval card for approval-required steps). complete: mark the focused-style step finished; without its declared evidence it is flagged unverified. cancel: abandon the plan.'),
  goal: z.string().optional().describe('action=start: the overall goal.'),
  horizon: z.enum(['session', 'long']).optional().describe('action=start: session for a bounded current task; long for a rolling goal. Defaults to session.'),
  steps: z.array(stepSchema).min(1).optional().describe('action=start: ordered steps; the first one becomes in_progress automatically.'),
  stepId: z.string().optional().describe('action=focus/complete: the step id.'),
  rationale: z.string().optional().describe('action=complete: one-line reason the step is done despite missing evidence.'),
})

interface PlanStepInput {
  id: string
  lane: PlanLane
  intent: string
  allowedTools: string[]
  expectedEvidence: Array<{ source: 'tool_result' | 'verification_gate' | 'human_approval', description: string }>
  riskLevel: 'low' | 'medium' | 'high'
  approvalRequired: boolean
}

/** Overridable so behavioral tests can fake the approval broadcast loop. */
type PlanApprovalInvoker = (payload: PlanApprovalAskPayload) => Promise<CodingApprovalDecisionPayload>
let planApprovalInvoker: PlanApprovalInvoker | undefined

/** Installs a test double for the plan approval broadcast; pass undefined to restore the electron invoke. */
export function installPlanApprovalInvoker(next: PlanApprovalInvoker | undefined): void {
  planApprovalInvoker = next
}

/** Overridable chat-session origin; tests install a fixed session id. */
type PlanSessionProvider = () => string | undefined
let planSessionProvider: PlanSessionProvider | undefined

/** Installs the chat-session source; pass undefined to restore the session store. */
export function installPlanSessionProvider(next: PlanSessionProvider | undefined): void {
  planSessionProvider = next
}

function currentPlanSession(explicitSessionId?: string): string | undefined {
  if (explicitSessionId)
    return explicitSessionId
  if (planSessionProvider)
    return planSessionProvider()
  return useChatSessionStore().activeSessionId
}

async function askPlanApproval(payload: PlanApprovalAskPayload): Promise<CodingApprovalDecisionPayload> {
  if (planApprovalInvoker)
    return planApprovalInvoker(payload)
  const invoke = defineInvoke(getElectronEventaContext(), planApprovalAsk)
  return invoke(payload)
}

/** Steps that expect human approval without declaring approvalRequired can never complete — reject them at start. */
function ghostApprovalSteps(steps: PlanStepInput[]): PlanStepInput[] {
  return steps.filter(step => !step.approvalRequired && step.expectedEvidence.some(evidence => evidence.source === 'human_approval'))
}

/**
 * The plan_update executor. Exported so behavioral tests can drive it without
 * going through the xsAI tool shell; the shell itself is covered by the
 * built-in registration test.
 */
export async function executePlanUpdate(input: {
  action: 'start' | 'focus' | 'complete' | 'cancel'
  goal?: string
  horizon?: 'session' | 'long'
  steps?: PlanStepInput[]
  stepId?: string
  rationale?: string
  /** Runtime-only session binding; never appears in the provider schema. */
  __airiSessionId?: string
}): Promise<string> {
  const planStore = usePlanStore()
  const currentSession = currentPlanSession(input.__airiSessionId)

  if (input.action === 'start') {
    if (!input.goal?.trim() || !input.steps?.length)
      return 'plan_update action "start" requires both goal and steps.'

    const ghosts = ghostApprovalSteps(input.steps)
    if (ghosts.length > 0) {
      return `Steps ${ghosts.map(step => `"${step.id}"`).join(', ')} expect human_approval evidence but approvalRequired is false — that combination can never complete. Set approvalRequired to true (an approval card is raised when you focus the step) or remove the human_approval evidence. Chat confirmations never satisfy the gate.`
    }

    const horizon = input.horizon ?? 'session'
    // A new plan retires the whole session lane behind it, whatever its own
    // horizon: every older session plan is replaced by definition, and its
    // open steps can no longer be reached by focus or complete. The steps are
    // skipped, not blocked — a skipped step is closed by decision and leaves
    // the completion gate, while a blocked one held every later Flow open
    // over work no one would run (ACC-20260909 FIX1 and its retest). Long
    // plans are NOT folded here: another live goal can run in parallel, and
    // skipping its steps would close work that belongs to it; the completion
    // gate's lane rule keeps non-standing long plans out instead.
    const replacedSessionPlans = planStore.scopedActivePlans(currentSession)
      .filter(plan => plan.spec.horizon === 'session' && hasOpenPlanSteps(plan))
    for (const replaced of replacedSessionPlans) {
      const openSteps = replaced.spec.steps.filter(step =>
        !replaced.state.completedSteps.includes(step.id)
        && !replaced.state.failedSteps.includes(step.id)
        && !replaced.state.skippedSteps.includes(step.id))
      for (const step of openSteps)
        await planStore.updateStep(replaced.id, step.id, 'skipped', 'superseded by a new plan')
    }

    const codingStore = horizon === 'long' ? useCodingToolsStore() : undefined
    // A long goal persists the workspace it is allowed to touch. The cached
    // renderer status can lag behind a host root switch, so creation must read
    // the host again before capturing that boundary.
    const codingStatus = horizon === 'long'
      ? await codingStore?.refreshStatus()
      : undefined
    const sessionStore = horizon === 'long' && !planSessionProvider ? useChatSessionStore() : undefined
    const characterId = sessionStore?.sessionMetas[currentSession ?? '']?.characterId
      ?? globalThis.localStorage?.getItem('airi-card-active-id')
      ?? 'default'
    const spec: PlanSpec = {
      goal: input.goal.trim(),
      horizon,
      ...(horizon === 'long'
        ? {
            scope: {
              userId: sessionStore?.index?.userId ?? 'local',
              characterId,
            },
            ...(codingStatus?.workspaceRoot ? { workspaceRoot: codingStatus.workspaceRoot } : {}),
          }
        : {}),
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
    const planId = await planStore.start(spec, undefined, { sessionId: currentSession })
    return `Plan ${planId} created with ${spec.steps.length} step(s). Focus: "${spec.steps[0].id}". Tool results only count as evidence for the focused step's allowed tools. Keep executing steps within this turn until blocked or finished.`
  }

  // The completion gate holds a Flow open on the newest plan of each lane,
  // and a newer long plan can sit in front of the standing session plan.
  // Resolving focus and complete against only the single newest scoped plan
  // made steps of the other lane unreachable ("Unknown stepId") while the
  // gate demanded exactly those steps (ACC-20260909 FIX1 retest). The target
  // is the newest steerable plan that owns the step id, falling back to the
  // newest scoped plan for the message surface.
  const scopedPlans = planStore.scopedActivePlans(currentSession)
  const plan = (input.stepId
    ? [...scopedPlans].reverse().find(candidate => candidate.spec.steps.some(step => step.id === input.stepId))
    : undefined)
  ?? scopedPlans.at(-1)

  if (input.action === 'focus') {
    if (!plan)
      return 'No active plan. Use action "start" first.'
    if (!input.stepId || !plan.spec.steps.some(step => step.id === input.stepId))
      return `Unknown stepId. Plan steps: ${plan.spec.steps.map(step => step.id).join(', ')}.`
    const step = await planStore.focusStep(plan.id, input.stepId)
    if (!step)
      return `Unknown stepId. Plan steps: ${plan.spec.steps.map(step => step.id).join(', ')}.`

    if (!step.approvalRequired)
      return `Focusing step "${input.stepId}".`

    // Blocking ask, mirroring bash approvals: the tool call resolves when the
    // user decides, so the same turn continues with the evidence recorded.
    const requestId = `plan-approval-${crypto.randomUUID()}`
    const decision = await askPlanApproval({
      requestId,
      planId: plan.id,
      stepId: input.stepId,
      subject: step.intent,
      reason: `Plan step "${input.stepId}" requires your approval before it can complete.`,
      riskLevel: step.riskLevel,
    })
    if (decision.decision === 'approved')
      return `Approval granted for "${input.stepId}" — the human_approval evidence is recorded. Continue with the next step.`
    return `Approval was not granted for "${input.stepId}" (${decision.decision}). The step stays blocked; adjust the plan or ask the user what to change.`
  }

  if (input.action === 'complete') {
    if (!plan)
      return 'No active plan in this session. Use action "start" first.'
    if (!input.stepId || !plan.spec.steps.some(step => step.id === input.stepId))
      return `Unknown stepId. Plan steps: ${plan.spec.steps.map(step => step.id).join(', ')}.`
    return await planStore.completeStep(plan.id, input.stepId, input.rationale)
  }

  if (!plan)
    return 'No active plan in this session to cancel.'
  if (plan.spec.horizon === 'long') {
    await planStore.cancelLongGoal(plan.id)
    return 'Plan cancelled.'
  }
  const stepId = plan.state.currentStepId ?? plan.spec.steps[0]?.id
  if (stepId)
    await planStore.updateStep(plan.id, stepId, 'failed', 'cancelled by the model')
  return 'Plan cancelled.'
}

const tools: Promise<Tool>[] = [
  tool({
    name: 'plan_update',
    description: 'Create or steer the plan for a multi-step task. Steps complete when their declared evidence exists in the journal (an allowed-tool result, a verification, or a decided approval card). action "complete" lets you finish a step without evidence, but you must state the reason and the step is flagged unverified — it will be named in the flow wrap-up; human_approval steps always require the approval card. allowedTools steers which tools count as evidence for a step; exploration tools (read/grep/list) are always allowed regardless of it. Keep plans small: one plan per task, one focused step at a time, and keep executing steps within the turn until blocked or finished.',
    execute: executePlanUpdate,
    parameters: params,
  }),
]

export const planTools = async () => Promise.all(tools)
