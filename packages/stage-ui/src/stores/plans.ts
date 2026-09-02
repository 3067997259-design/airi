import type { JournalEvent, PlanEvidenceRef, PlanSpec, PlanState, PlanStepStatus, ToolEvidenceAuthor, ToolResultOutcome, ToolResultTier } from '@proj-airi/core-agent'

import type { PlanPersistenceRepository } from '../services/memory/local-memory'

import { errorMessageFrom } from '@moeru/std'
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
const EXPLORATION_TOOL_NAMES = Object.freeze(['read', 'grep', 'list'])

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

function normalizePlanSpec(spec: PlanSpec): PlanSpec {
  return {
    ...spec,
    steps: spec.steps.map(step => (step.allowedTools.some(tool => tool === 'edit' || tool === 'write' || tool === 'bash')
      ? {
          ...step,
          allowedTools: [...new Set([...step.allowedTools, ...EXPLORATION_TOOL_NAMES])],
        }
      : step)),
  }
}

function clonePlanState(state: PlanState): PlanState {
  return {
    ...(state.currentStepId ? { currentStepId: state.currentStepId } : {}),
    ...(state.paused !== undefined ? { paused: state.paused } : {}),
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
  if (event.type === 'plan/hint')
    return event.planId === planId

  if (event.type === 'approval/asked' || event.type === 'approval/decided')
    return event.planId === planId
  return (event.type === 'plan/update' || event.type === 'tool/call' || event.type === 'tool/result')
    ? event.planId === planId
    : false
}

function latestPlanStatus(view: PlanView): PlanStepStatus {
  if (view.state.paused)
    return 'paused'
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
  const startedStep = plan.spec.steps.find((step) => {
    const status = gateSnapshot.steps[step.id]?.status
    return status === 'in_progress' || status === 'blocked'
  })?.id
  // Focus advances by derivation, not by a write: once a step is resolved the
  // first unresolved step becomes current. Without this the plan lost its
  // focus the moment a step completed, and the projection stopped naming any
  // next step even though the plan had work left (HARNESS-PLAN §4.1).
  const nextUnresolvedStep = plan.spec.steps.find(step =>
    !completedSteps.includes(step.id)
    && !failedSteps.includes(step.id)
    && !plan.stateSnapshot.skippedSteps.includes(step.id))?.id
  const currentCandidate = startedStep ?? nextUnresolvedStep ?? plan.stateSnapshot.currentStepId
  const evidenceFromJournal: PlanEvidenceRef[] = planEvents.flatMap((event) => {
    if (event.type !== 'tool/result' || !event.ok || (event.outcome ?? 'ok') !== 'ok' || !event.stepId)
      return []
    return [{
      stepId: event.stepId,
      source: 'tool_result' as const,
      summary: event.summary,
    }]
  })

  return {
    ...(currentCandidate && !completedSteps.includes(currentCandidate) ? { currentStepId: currentCandidate } : {}),
    ...(plan.stateSnapshot.paused !== undefined ? { paused: plan.stateSnapshot.paused } : {}),
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
/** Attempts to open the plan database before the failure becomes visible. */
const PERSISTENCE_OPEN_ATTEMPTS = 3

/** Backoff between open attempts, in milliseconds. */
const PERSISTENCE_RETRY_BACKOFF_MS = Object.freeze([200, 600])

/**
 * Whether plans are being kept, as the plan card reports it.
 *
 * `unavailable` is a follower window, which owns no writes by design.
 * `failed` means work is running with nothing behind it — the state that used
 * to be a console warning and looked to the user like plans evaporating on
 * restart (HARNESS-PLAN §0.2 R4).
 */
export interface PlanPersistenceState {
  status: 'idle' | 'ready' | 'unavailable' | 'failed'
  error?: string
}

export const usePlanStore = defineStore('runtime-plans', () => {
  const journal = useJournalStore()
  const plans = ref<RuntimePlanRecord[]>([])
  const repository = shallowRef<PlanPersistenceRepository>()
  const initialized = shallowRef(false)
  const persistence = shallowRef<PlanPersistenceState>({ status: 'idle' })
  const terminalStatusEvents = new Map<string, 'completed' | 'failed'>()
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
  // A completed plan with unverified steps stays in the active set: the field
  // run showed plan completion arriving from unrelated receipts while real
  // verification had not run, and removal from the active set is what made
  // "No active plan" erase the model's own task state mid-turn
  // (FLOW-DIAGNOSIS P0-1). The card keeps its amber unverified rendering.
  const activePlans = computed(() => planViews.value.filter((plan) => {
    if (plan.status === 'failed')
      return false
    if (plan.status === 'completed')
      return (plan.state.unverifiedSteps ?? []).length > 0
    return true
  }))
  const activeSessionPlan = computed(() => activePlans.value.filter(plan => plan.spec.horizon === 'session' && !plan.state.paused).at(-1))
  const activeLongPlan = computed(() => activePlans.value.filter(plan => plan.spec.horizon === 'long' && !plan.state.paused).at(-1))
  const activePlan = computed(() => activeSessionPlan.value ?? activeLongPlan.value)

  /**
   * Active plans visible from one chat session: long goals are global,
   * session plans belong to the session that created them.
   */
  function scopedActivePlans(sessionId?: string) {
    return activePlans.value.filter(plan =>
      !plan.state.paused
      && (plan.spec.horizon === 'long'
        || !plan.sessionId
        || plan.sessionId === sessionId))
  }

  function scopedPausedPlans(sessionId?: string) {
    return activePlans.value.filter(plan =>
      plan.state.paused
      && (plan.spec.horizon === 'long'
        || !plan.sessionId
        || plan.sessionId === sessionId))
  }

  async function initialize(): Promise<void> {
    if (initialized.value)
      return
    if (initializationPromise)
      return initializationPromise

    initializationPromise = (async () => {
      const locationSearch = globalThis.location?.search
      if (locationSearch == null || resolveMemoryWriteAccess(locationSearch) === 'follower') {
        // A follower owns no writes; that is the design, not a fault.
        persistence.value = { status: 'unavailable' }
        initialized.value = true
        return
      }

      const [{ useDuckDb }, { createDuckDbMemoryRepository }] = await Promise.all([
        import('../composables/use-duck-db'),
        import('../services/memory/local-memory'),
      ])
      // OPFS allows a single writer, so a leftover window or a reloading
      // worker can hold the handle for a moment. Retrying with a short backoff
      // turns that transient conflict into a slow start instead of a session
      // that silently keeps no plans at all (HARNESS-PLAN §4.3).
      let lastError: unknown
      for (let attempt = 0; attempt < PERSISTENCE_OPEN_ATTEMPTS && !repository.value; attempt++) {
        try {
          const database = useDuckDb()
          await database.getDb()
          if (database.db.value)
            repository.value = createDuckDbMemoryRepository(database.db.value)
          else
            lastError = new Error('Plan persistence database did not initialize')
        }
        catch (error) {
          lastError = error
        }

        if (!repository.value && attempt < PERSISTENCE_OPEN_ATTEMPTS - 1)
          await new Promise(resolve => setTimeout(resolve, PERSISTENCE_RETRY_BACKOFF_MS[attempt] ?? 0))
      }

      if (!repository.value)
        throw lastError instanceof Error ? lastError : new Error('Plan persistence database did not initialize')

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
      persistence.value = { status: 'ready' }
      initialized.value = true
    })()
      .catch((error) => {
        // Left un-initialized on purpose: the next persist retries, and the
        // chip tells the user that plans are not being kept meanwhile.
        persistence.value = { status: 'failed', error: errorMessageFrom(error) ?? 'unknown error' }
      })
      .finally(() => {
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
    try {
      await repository.value.savePlan({
        id: planId,
        spec: clonePlanSpec(view.spec),
        state: stateSnapshot,
        status: view.status,
        ...(record.sessionId ? { sessionId: record.sessionId } : {}),
        createdAt: record.createdAt,
        updatedAt,
      })
      if (persistence.value.status !== 'ready')
        persistence.value = { status: 'ready' }
    }
    catch (error) {
      // The plan keeps running in memory; the chip says it will not survive a
      // restart. Swallowing this was how "my plan evaporated" happened with no
      // warning anywhere the user could see.
      persistence.value = { status: 'failed', error: errorMessageFrom(error) ?? 'unknown error' }
    }
  }

  /** Re-opens the plan database after a failed start, for the card's chip. */
  async function retryPersistence(): Promise<PlanPersistenceState> {
    initialized.value = false
    repository.value = undefined
    persistence.value = { status: 'idle' }
    await initialize()
    return persistence.value
  }

  async function start(spec: PlanSpec, requestedId?: string, options?: { sessionId?: string }): Promise<string> {
    await initialize()
    const normalizedSpec = normalizePlanSpec(spec)
    const rolling = normalizedSpec.horizon === 'long' ? activeLongPlan.value : undefined
    const id = requestedId ?? rolling?.id ?? createPlanId()
    terminalStatusEvents.delete(id)
    const existingIndex = plans.value.findIndex(plan => plan.id === id)
    if (existingIndex >= 0 && rolling?.id !== id)
      throw new Error(`Plan already exists: ${id}`)

    const now = Date.now()
    if (existingIndex >= 0) {
      const previous = plans.value[existingIndex]!
      const previousState = planViews.value.find(plan => plan.id === id)?.state ?? previous.stateSnapshot
      plans.value = plans.value.map((plan, index) => index === existingIndex
        ? { ...plan, spec: clonePlanSpec(normalizedSpec), stateSnapshot: clonePlanState(previousState), updatedAt: now }
        : plan)
    }
    else {
      plans.value = [...plans.value, {
        id,
        spec: clonePlanSpec(normalizedSpec),
        stateSnapshot: emptyPlanState(),
        ...(options?.sessionId ? { sessionId: options.sessionId } : {}),
        createdAt: now,
        updatedAt: now,
      }]
    }

    journal.ensureSession()
    const firstStep = normalizedSpec.steps[0]
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

  /** Records a derived terminal plan status once, so status transitions stay auditable. */
  async function recordTerminalStatus(planId: string): Promise<void> {
    const view = planViews.value.find(candidate => candidate.id === planId)
    const status = view?.status === 'completed' || view?.status === 'failed' ? view.status : undefined
    if (!status) {
      terminalStatusEvents.delete(planId)
      return
    }
    if (terminalStatusEvents.get(planId) === status)
      return

    terminalStatusEvents.set(planId, status)
    journal.appendActive({
      type: 'plan/update',
      planId,
      status,
      reason: `plan reached terminal status: ${status}`,
    })
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
    await recordTerminalStatus(planId)
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
    await recordTerminalStatus(planId)
    return `Step "${stepId}" marked complete (unverified — the declared evidence was not satisfied in the journal). The plan card flags it amber.`
  }

  async function recordToolResult(input: { planId: string, stepId: string, toolName: string, ok: boolean, summary: string, outcome?: ToolResultOutcome, tier?: ToolResultTier, provenance?: ToolEvidenceAuthor }): Promise<void> {
    journal.appendActive({
      type: 'tool/result',
      planId: input.planId,
      stepId: input.stepId,
      toolName: input.toolName,
      ok: input.ok,
      ...(input.outcome ? { outcome: input.outcome } : {}),
      ...(input.tier ? { tier: input.tier } : {}),
      summary: input.summary,
      ...(input.provenance ? { provenance: input.provenance } : {}),
    })
    await persistPlan(input.planId)
    await recordTerminalStatus(input.planId)
  }

  async function setPaused(planId: string, paused: boolean): Promise<void> {
    const record = plans.value.find(plan => plan.id === planId)
    if (!record)
      return
    plans.value = plans.value.map(plan => plan.id === planId
      ? { ...plan, stateSnapshot: { ...clonePlanState(plan.stateSnapshot), paused }, updatedAt: Date.now() }
      : plan)
    const stepId = record.stateSnapshot.currentStepId ?? record.spec.steps[0]?.id
    journal.appendActive({
      type: 'plan/update',
      planId,
      ...(stepId ? { stepId } : {}),
      status: paused ? 'paused' : 'in_progress',
      reason: paused ? 'paused by the user' : 'resumed by the user',
    })
    await persistPlan(planId)
  }

  async function pausePlan(planId: string): Promise<void> {
    await setPaused(planId, true)
  }

  async function resumePlan(planId: string): Promise<void> {
    await setPaused(planId, false)
  }

  async function softDeletePlan(planId: string): Promise<void> {
    await initialize()
    if (!plans.value.some(plan => plan.id === planId))
      return
    await repository.value?.softDeletePlan(planId)
    plans.value = plans.value.filter(plan => plan.id !== planId)
    terminalStatusEvents.delete(planId)
  }

  function promptProjection(planId?: string): string {
    const plan = planId
      ? planViews.value.find(candidate => candidate.id === planId)
      : activePlan.value
    if (!plan)
      return ''

    const recentHints = journal.events.flatMap((event) => {
      if (event.type !== 'plan/hint' || event.planId !== plan.id)
        return []
      return [{ toolName: event.toolName, allowedTools: event.allowedTools }]
    })
    return buildTurnProjection({
      plan: plan.spec,
      state: plan.state,
      ...(recentHints.length > 0 ? { recentHints } : {}),
    }).text
  }

  function reset() {
    plans.value = []
    repository.value = undefined
    initialized.value = false
    initializationPromise = undefined
    persistence.value = { status: 'idle' }
    terminalStatusEvents.clear()
  }

  return {
    plans,
    planViews,
    persistence,
    retryPersistence,
    activePlans,
    activeSessionPlan,
    activeLongPlan,
    activePlan,
    scopedActivePlans,
    scopedPausedPlans,
    initialize,
    persistPlan,
    start,
    updateStep,
    focusStep,
    completeStep,
    recordToolResult,
    recordTerminalStatus,
    pausePlan,
    resumePlan,
    softDeletePlan,
    promptProjection,
    reset,
  }
}, {
  synced: {
    actions: ['initialize', 'persistPlan', 'retryPersistence', 'start', 'updateStep', 'focusStep', 'completeStep', 'recordToolResult', 'recordTerminalStatus', 'pausePlan', 'resumePlan', 'softDeletePlan'],
    state: true,
  },
})
