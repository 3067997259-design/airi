import type { JournalEvent, PlanEvidenceRef, PlanSpec, PlanState, PlanStepStatus, ToolEvidenceAuthor } from '@proj-airi/core-agent'

import { buildTurnProjection, projectStepGateStates } from '@proj-airi/core-agent'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

import { useJournalStore } from './journal'

export interface PlanView {
  id: string
  goal: string
  spec: PlanSpec
  state: PlanState
  status: PlanStepStatus
  updatedAt: number
}

const EMPTY_PLANS: PlanView[] = Object.freeze([]) as unknown as PlanView[]

function createPlanId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `plan-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

function eventMatchesPlan(event: JournalEvent, planId: string): boolean {
  return (event.type === 'plan/update' || event.type === 'tool/call' || event.type === 'tool/result')
    ? event.planId === planId
    : false
}

function latestPlanStatus(view: PlanView): PlanStepStatus {
  if (view.state.blockers.length > 0)
    return 'blocked'
  if (view.state.failedSteps.length > 0)
    return 'failed'
  if (view.state.completedSteps.length === view.spec.steps.length && view.spec.steps.length > 0)
    return 'completed'
  return view.state.currentStepId ? 'in_progress' : 'pending'
}

function stateFromJournal(plan: PlanView, events: readonly JournalEvent[]): PlanState {
  const planEvents = events.filter(event => eventMatchesPlan(event, plan.id))
  const gateSnapshot = projectStepGateStates(planEvents, plan.spec.steps)
  const completedSteps = plan.spec.steps.filter(step => gateSnapshot.steps[step.id]?.status === 'completed').map(step => step.id)
  const failedSteps = plan.spec.steps.filter(step => gateSnapshot.steps[step.id]?.status === 'failed').map(step => step.id)
  const blockers = plan.spec.steps
    .map(step => gateSnapshot.steps[step.id])
    .filter(state => state?.status === 'blocked' && state.reason)
    .map(state => state!.reason!)
  const currentStepId = plan.spec.steps.find((step) => {
    const status = gateSnapshot.steps[step.id]?.status
    return status === 'in_progress' || status === 'blocked'
  })?.id
  const evidenceRefs: PlanEvidenceRef[] = planEvents.flatMap((event) => {
    if (event.type !== 'tool/result' || !event.ok || !event.stepId)
      return []
    return [{
      stepId: event.stepId,
      source: 'tool_result' as const,
      summary: event.summary,
    }]
  })

  return {
    ...(currentStepId ? { currentStepId } : {}),
    completedSteps,
    failedSteps,
    skippedSteps: [],
    evidenceRefs,
    blockers,
  }
}

/**
 * Owns plan specifications while the journal owns plan activity.
 *
 * A plan update can announce completion, but the derived gate status only
 * marks a step complete after the required evidence exists.
 */
export const usePlanStore = defineStore('runtime-plans', () => {
  const journal = useJournalStore()
  const plans = ref<Array<{ id: string, spec: PlanSpec, createdAt: number }>>([])

  const planViews = computed<PlanView[]>(() => {
    if (plans.value.length === 0)
      return EMPTY_PLANS

    return plans.value.map((plan) => {
      const state = stateFromJournal({
        id: plan.id,
        goal: plan.spec.goal,
        spec: plan.spec,
        state: { completedSteps: [], failedSteps: [], skippedSteps: [], evidenceRefs: [], blockers: [] },
        status: 'pending',
        updatedAt: plan.createdAt,
      }, journal.events)
      const updatedAt = journal.events.reduce((latest, event) => eventMatchesPlan(event, plan.id) ? Math.max(latest, event.seq) : latest, plan.createdAt)
      const view = { id: plan.id, goal: plan.spec.goal, spec: plan.spec, state, status: 'pending' as PlanStepStatus, updatedAt }
      view.status = latestPlanStatus(view)
      return view
    })
  })
  const activePlans = computed(() => planViews.value.filter(plan => plan.status !== 'completed' && plan.status !== 'failed'))
  const activePlan = computed(() => activePlans.value.at(-1))

  function start(spec: PlanSpec, id = createPlanId()): string {
    if (plans.value.some(plan => plan.id === id))
      throw new Error(`Plan already exists: ${id}`)

    const createdAt = Date.now()
    plans.value = [...plans.value, { id, spec: structuredClone(spec), createdAt }]
    journal.ensureSession()
    const firstStep = spec.steps[0]
    if (firstStep) {
      journal.appendActive({
        type: 'plan/update',
        planId: id,
        stepId: firstStep.id,
        status: 'in_progress',
      })
    }
    return id
  }

  function updateStep(planId: string, stepId: string, status: Exclude<PlanStepStatus, 'completed'>, reason?: string) {
    if (!plans.value.some(plan => plan.id === planId))
      return
    journal.appendActive({
      type: 'plan/update',
      planId,
      stepId,
      status,
      ...(reason ? { reason } : {}),
    })
  }

  function recordToolResult(input: { planId: string, stepId: string, toolName: string, ok: boolean, summary: string, provenance?: ToolEvidenceAuthor }) {
    journal.appendActive({
      type: 'tool/result',
      planId: input.planId,
      stepId: input.stepId,
      toolName: input.toolName,
      ok: input.ok,
      summary: input.summary,
      ...(input.provenance ? { provenance: input.provenance } : {}),
    })
  }

  function promptProjection(): string {
    const plan = activePlan.value
    if (!plan)
      return ''
    return buildTurnProjection({ plan: plan.spec, state: plan.state }).text
  }

  function reset() {
    plans.value = []
  }

  return {
    plans,
    planViews,
    activePlans,
    activePlan,
    start,
    updateStep,
    recordToolResult,
    promptProjection,
    reset,
  }
}, {
  synced: {
    state: true,
  },
})
