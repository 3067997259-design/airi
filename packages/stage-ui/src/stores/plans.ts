import type { JournalEvent, PlanEvidenceRef, PlanSpec, PlanState, PlanStepStatus, ToolEvidenceAuthor } from '@proj-airi/core-agent'

import type { PlanPersistenceRepository } from '../services/memory/local-memory'

import { buildTurnProjection, projectStepGateStates } from '@proj-airi/core-agent'
import { defineStore } from 'pinia'
import { computed, ref, shallowRef, toRaw } from 'vue'

import { resolveMemoryWriteAccess } from '../services/memory/write-access'
import { useJournalStore } from './journal'

export interface PlanView {
  id: string
  goal: string
  spec: PlanSpec
  state: PlanState
  status: PlanStepStatus
  /** Origin chat session of a session-horizon plan; long goals are global. */
  sessionId?: string
  updatedAt: number
}

interface RuntimePlanRecord {
  id: string
  spec: PlanSpec
  stateSnapshot: PlanState
  /** Origin chat session of a session-horizon plan; long goals are global. */
  sessionId?: string
  createdAt: number
  updatedAt: number
}

const EMPTY_PLANS: PlanView[] = Object.freeze([]) as unknown as PlanView[]

function emptyPlanState(): PlanState {
  return {
    completedSteps: [],
    failedSteps: [],
    skippedSteps: [],
    evidenceRefs: [],
    blockers: [],
    unverifiedSteps: [],
  }
}

function clonePlanSpec(spec: PlanSpec): PlanSpec {
  return {
    goal: spec.goal,
    horizon: spec.horizon,
    ...(spec.deadline !== undefined ? { deadline: spec.deadline } : {}),
    steps: spec.steps.map(step => ({
      ...step,
      allowedTools: [...step.allowedTools],
      expectedEvidence: step.expectedEvidence.map(evidence => ({ ...evidence })),
    })),
  }
}

function clonePlanState(state: PlanState): PlanState {
  return {
    ...(state.currentStepId ? { currentStepId: state.currentStepId } : {}),
    completedSteps: [...state.completedSteps],
    failedSteps: [...state.failedSteps],
    skippedSteps: [...state.skippedSteps],
    evidenceRefs: state.evidenceRefs.map(evidence => ({ ...evidence })),
    blockers: [...state.blockers],
    ...(state.unverifiedSteps ? { unverifiedSteps: [...state.unverifiedSteps] } : {}),
    ...(state.lastReplanReason ? { lastReplanReason: state.lastReplanReason } : {}),
  }
}

function createPlanId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `plan-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

function eventMatchesPlan(event: JournalEvent, planId: string): boolean {
  if (event.type === 'approval/asked' || event.type === 'approval/decided')
    return event.planId === planId
  return (event.type === 'plan/update' || event.type === 'tool/call' || event.type === 'tool/result')
    ? event.planId === planId
    : false
}

function latestPlanStatus(view: PlanView): PlanStepStatus {
  if (view.state.blockers.length > 0)
    return 'blocked'
  if (view.state.failedSteps.length > 0)
    return 'failed'
  if (view.spec.steps.length > 0 && view.spec.steps.every(step => view.state.completedSteps.includes(step.id)))
    return 'completed'
  return view.state.currentStepId ? 'in_progress' : 'pending'
}

function uniqueStrings(...groups: readonly string[][]): string[] {
  return [...new Set(groups.flat())]
}

function uniqueEvidence(...groups: readonly PlanEvidenceRef[][]): PlanEvidenceRef[] {
  const seen = new Set<string>()
  return groups.flat().filter((evidence) => {
    const key = `${evidence.stepId}:${evidence.source}:${evidence.summary}`
    if (seen.has(key))
      return false
    seen.add(key)
    return true
  })
}

/** Rebuilds current activity from the journal and falls back to the persisted restart snapshot. */
function stateFromJournal(plan: RuntimePlanRecord, events: readonly JournalEvent[]): PlanState {
  const planEvents = events.filter(event => eventMatchesPlan(event, plan.id))
  if (planEvents.length === 0)
    return clonePlanState(plan.stateSnapshot)

  const gateSnapshot = projectStepGateStates(planEvents, plan.spec.steps)
  const completedFromJournal = plan.spec.steps.filter(step => gateSnapshot.steps[step.id]?.status === 'completed').map(step => step.id)
  const failedFromJournal = plan.spec.steps.filter(step => gateSnapshot.steps[step.id]?.status === 'failed').map(step => step.id)
  // Model-declared completions (plan_update action "complete") land here
  // without gate evidence; they count as finished but stay flagged as
  // unverified so the plan card can render them amber.
  const modelCompletedFromJournal = [...new Set(planEvents.flatMap((event) => {
    if (event.type !== 'plan/update' || event.status !== 'completed' || !event.stepId)
      return []
    return [event.stepId]
  }))]
  const completedSteps = uniqueStrings(plan.stateSnapshot.completedSteps, completedFromJournal, modelCompletedFromJournal)
  const unverifiedSteps = [...new Set([...(plan.stateSnapshot.unverifiedSteps ?? []), ...modelCompletedFromJournal])]
    .filter(stepId => !completedFromJournal.includes(stepId))
  const failedSteps = uniqueStrings(plan.stateSnapshot.failedSteps, failedFromJournal)
    .filter(stepId => !completedSteps.includes(stepId))
  const blockers = plan.spec.steps
    .map(step => ({ stepId: step.id, state: gateSnapshot.steps[step.id] }))
    .filter(({ stepId, state }) => state?.status === 'blocked' && state.reason && !completedSteps.includes(stepId))
    .map(({ state }) => state!.reason!)
  const currentFromJournal = plan.spec.steps.find((step) => {
    const status = gateSnapshot.steps[step.id]?.status
    return status === 'in_progress' || status === 'blocked'
  })?.id
  const currentCandidate = currentFromJournal ?? plan.stateSnapshot.currentStepId
  const evidenceFromJournal: PlanEvidenceRef[] = planEvents.flatMap((event) => {
    if (event.type !== 'tool/result' || !event.ok || !event.stepId)
      return []
    return [{
      stepId: event.stepId,
      source: 'tool_result' as const,
      summary: event.summary,
    }]
  })

  return {
    ...(currentCandidate && !completedSteps.includes(currentCandidate) ? { currentStepId: currentCandidate } : {}),
    completedSteps,
    failedSteps,
    skippedSteps: [...plan.stateSnapshot.skippedSteps],
    evidenceRefs: uniqueEvidence(plan.stateSnapshot.evidenceRefs, evidenceFromJournal),
    blockers,
    unverifiedSteps,
    ...(plan.stateSnapshot.lastReplanReason ? { lastReplanReason: plan.stateSnapshot.lastReplanReason } : {}),
  }
}

/**
 * Owns plan specifications and restart snapshots while the journal owns
 * current-session activity. Only the synchronized leader opens DuckDB.
 */
export const usePlanStore = defineStore('runtime-plans', () => {
  const journal = useJournalStore()
  const plans = ref<RuntimePlanRecord[]>([])
  const repository = shallowRef<PlanPersistenceRepository>()
  const initialized = shallowRef(false)
  let initializationPromise: Promise<void> | undefined

  const planViews = computed<PlanView[]>(() => {
    if (plans.value.length === 0)
      return EMPTY_PLANS

    return plans.value.map((plan) => {
      const state = stateFromJournal(plan, journal.events)
      const view = {
        id: plan.id,
        goal: plan.spec.goal,
        spec: plan.spec,
        state,
        status: 'pending' as PlanStepStatus,
        ...(plan.sessionId ? { sessionId: plan.sessionId } : {}),
        updatedAt: plan.updatedAt,
      }
      view.status = latestPlanStatus(view)
      return view
    })
  })
  const activePlans = computed(() => planViews.value.filter(plan => plan.status !== 'completed' && plan.status !== 'failed'))
  const activeSessionPlan = computed(() => activePlans.value.filter(plan => plan.spec.horizon === 'session').at(-1))
  const activeLongPlan = computed(() => activePlans.value.filter(plan => plan.spec.horizon === 'long').at(-1))
  const activePlan = computed(() => activeSessionPlan.value ?? activeLongPlan.value)

  /**
   * Active plans visible from one chat session: long goals are global,
   * session plans belong to the session that created them.
   */
  function scopedActivePlans(sessionId?: string) {
    return activePlans.value.filter(plan =>
      plan.spec.horizon === 'long'
      || !plan.sessionId
      || plan.sessionId === sessionId)
  }

  async function initialize(): Promise<void> {
    if (initialized.value)
      return
    if (initializationPromise)
      return initializationPromise

    initializationPromise = (async () => {
      const locationSearch = globalThis.location?.search
      if (locationSearch == null || resolveMemoryWriteAccess(locationSearch) === 'follower') {
        initialized.value = true
        return
      }

      const [{ useDuckDb }, { createDuckDbMemoryRepository }] = await Promise.all([
        import('../composables/use-duck-db'),
        import('../services/memory/local-memory'),
      ])
      const database = useDuckDb()
      await database.getDb()
      if (!database.db.value)
        throw new Error('Plan persistence database did not initialize')
      repository.value = createDuckDbMemoryRepository(database.db.value)
      const persisted = await repository.value.loadPlans()
      const merged = new Map(persisted.map(plan => [plan.id, {
        id: plan.id,
        spec: clonePlanSpec(plan.spec),
        stateSnapshot: clonePlanState(plan.state),
        ...(plan.sessionId ? { sessionId: plan.sessionId } : {}),
        createdAt: plan.createdAt,
        updatedAt: plan.updatedAt,
      } satisfies RuntimePlanRecord]))
      for (const local of plans.value) {
        const stored = merged.get(local.id)
        if (!stored || local.updatedAt >= stored.updatedAt)
          merged.set(local.id, local)
      }
      plans.value = [...merged.values()].sort((left, right) => left.updatedAt - right.updatedAt)
      initialized.value = true
    })().finally(() => {
      initializationPromise = undefined
    })
    return initializationPromise
  }

  async function persistPlan(planId: string): Promise<void> {
    await initialize()
    if (!repository.value)
      return
    const record = plans.value.find(plan => plan.id === planId)
    const view = planViews.value.find(plan => plan.id === planId)
    if (!record || !view)
      return

    const updatedAt = Date.now()
    const stateSnapshot = clonePlanState(view.state)
    plans.value = plans.value.map(plan => plan.id === planId
      ? { ...plan, stateSnapshot, updatedAt }
      : plan)
    await repository.value.savePlan({
      id: planId,
      spec: clonePlanSpec(view.spec),
      state: stateSnapshot,
      status: view.status,
      ...(record.sessionId ? { sessionId: record.sessionId } : {}),
      createdAt: record.createdAt,
      updatedAt,
    })
  }

  async function start(spec: PlanSpec, requestedId?: string, options?: { sessionId?: string }): Promise<string> {
    await initialize()
    const rolling = spec.horizon === 'long' ? activeLongPlan.value : undefined
    const id = requestedId ?? rolling?.id ?? createPlanId()
    const existingIndex = plans.value.findIndex(plan => plan.id === id)
    if (existingIndex >= 0 && rolling?.id !== id)
      throw new Error(`Plan already exists: ${id}`)

    const now = Date.now()
    if (existingIndex >= 0) {
      const previous = plans.value[existingIndex]!
      const previousState = planViews.value.find(plan => plan.id === id)?.state ?? previous.stateSnapshot
      plans.value = plans.value.map((plan, index) => index === existingIndex
        ? { ...plan, spec: clonePlanSpec(spec), stateSnapshot: clonePlanState(previousState), updatedAt: now }
        : plan)
    }
    else {
      plans.value = [...plans.value, {
        id,
        spec: clonePlanSpec(spec),
        stateSnapshot: emptyPlanState(),
        ...(options?.sessionId ? { sessionId: options.sessionId } : {}),
        createdAt: now,
        updatedAt: now,
      }]
    }

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
    await persistPlan(id)
    return id
  }

  async function updateStep(planId: string, stepId: string, status: Exclude<PlanStepStatus, 'completed'>, reason?: string): Promise<void> {
    if (!plans.value.some(plan => plan.id === planId))
      return
    journal.appendActive({
      type: 'plan/update',
      planId,
      stepId,
      status,
      ...(reason ? { reason } : {}),
    })
    await persistPlan(planId)
  }

  /** Focuses a step and returns it, so the caller can raise the approval card for `approvalRequired` steps. */
  async function focusStep(planId: string, stepId: string) {
    const plan = plans.value.find(candidate => candidate.id === planId)
    const step = plan?.spec.steps.find(candidate => candidate.id === stepId)
    if (!step)
      return undefined
    await updateStep(planId, stepId, 'in_progress')
    // The step element is a reactive proxy, and pinia-plugin-synced
    // structuredClones every synchronized action result — a proxy throws
    // "could not be cloned". Return a plain snapshot with what the caller
    // (plan_update focus → approval card) actually needs.
    const raw = toRaw(step)
    return {
      id: raw.id,
      intent: raw.intent,
      allowedTools: [...raw.allowedTools],
      riskLevel: raw.riskLevel,
      approvalRequired: raw.approvalRequired,
    }
  }

  /**
   * Model-declared completion (plan_update action "complete"). Steps whose
   * declared evidence is not in the journal still complete, flagged as
   * unverified — except `human_approval` steps, which can only complete
   * through a decided approval card and are refused here.
   */
  async function completeStep(planId: string, stepId: string, rationale?: string): Promise<string> {
    const plan = plans.value.find(candidate => candidate.id === planId)
    const step = plan?.spec.steps.find(candidate => candidate.id === stepId)
    if (!plan || !step)
      return `Unknown step "${stepId}".`

    const view = planViews.value.find(candidate => candidate.id === planId)
    if (view?.state.completedSteps.includes(stepId))
      return `Step "${stepId}" is already complete.`

    if (step.expectedEvidence.some(evidence => evidence.source === 'human_approval')) {
      return `Step "${stepId}" expects human approval — it completes only after the approval card is decided. Chat text does not count as approval.`
    }

    journal.appendActive({
      type: 'plan/update',
      planId,
      stepId,
      status: 'completed',
      unverified: true,
      ...(rationale ? { reason: rationale } : {}),
    })
    await persistPlan(planId)
    return `Step "${stepId}" marked complete (unverified — the declared evidence was not satisfied in the journal). The plan card flags it amber.`
  }

  async function recordToolResult(input: { planId: string, stepId: string, toolName: string, ok: boolean, summary: string, provenance?: ToolEvidenceAuthor }): Promise<void> {
    journal.appendActive({
      type: 'tool/result',
      planId: input.planId,
      stepId: input.stepId,
      toolName: input.toolName,
      ok: input.ok,
      summary: input.summary,
      ...(input.provenance ? { provenance: input.provenance } : {}),
    })
    await persistPlan(input.planId)
  }

  async function softDeletePlan(planId: string): Promise<void> {
    await initialize()
    if (!plans.value.some(plan => plan.id === planId))
      return
    await repository.value?.softDeletePlan(planId)
    plans.value = plans.value.filter(plan => plan.id !== planId)
  }

  function promptProjection(planId?: string): string {
    const plan = planId
      ? planViews.value.find(candidate => candidate.id === planId)
      : activePlan.value
    if (!plan)
      return ''
    return buildTurnProjection({ plan: plan.spec, state: plan.state }).text
  }

  function reset() {
    plans.value = []
    repository.value = undefined
    initialized.value = false
    initializationPromise = undefined
  }

  return {
    plans,
    planViews,
    activePlans,
    activeSessionPlan,
    activeLongPlan,
    activePlan,
    scopedActivePlans,
    initialize,
    persistPlan,
    start,
    updateStep,
    focusStep,
    completeStep,
    recordToolResult,
    softDeletePlan,
    promptProjection,
    reset,
  }
}, {
  synced: {
    actions: ['initialize', 'persistPlan', 'start', 'updateStep', 'focusStep', 'completeStep', 'recordToolResult', 'softDeletePlan'],
    state: true,
  },
})
