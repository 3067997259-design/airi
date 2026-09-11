import type { JournalEvent, JournalEventInput, LongGoalRunRecord, LongGoalState, LongGoalTransitionInput, PlanEvidenceRef, PlanSpec, PlanState, PlanStepStatus, ToolEvidenceAuthor, ToolResultOutcome, ToolResultTier } from '@proj-airi/core-agent'

import type { PlanPersistenceRepository } from '../services/memory/local-memory'

import { errorMessageFrom } from '@moeru/std'
import { applyLongGoalTransition, buildTurnProjection, createLongGoalState, openTaskId, projectStepGateStates } from '@proj-airi/core-agent'
import { defineStore } from 'pinia'
import { computed, ref, shallowRef, toRaw } from 'vue'

import { syncLongGoalSchedule, unscheduleLongGoal } from '../services/long-goal-scheduler'
import { resolveMemoryWriteAccess } from '../services/memory/write-access'
import { waitForRestore } from '../services/restore-gate'
import { useJournalStore } from './journal'

export interface PlanView {
  id: string
  goal: string
  spec: PlanSpec
  state: PlanState
  status: PlanStepStatus
  /** Chat session that owns this plan's journal evidence and scheduled work. */
  sessionId?: string
  updatedAt: number
}

/** Identifies the Flow that must stop before a revised long goal can run. */
export interface LongGoalRevisionEvent {
  planId: string
  run: LongGoalRunRecord
  constraintVersion: number
  reason: string
}

/** Whether a plan can still hold open work: not paused and not terminal-failed. */
function holdsOpenWork(plan: PlanView): boolean {
  return !plan.state.paused && plan.status !== 'failed' && plan.status !== 'cancelled'
}

/**
 * Selects the plans a Flow completion gate must evaluate: the newest plan of
 * each lane, never the pile behind it.
 *
 * The session lane has one standing plan — the newest session plan bound to
 * the flow's session. Every older session plan is superseded by definition:
 * starting a newer plan in the lane already replaced it, and the model can no
 * longer reach its steps. Letting the pile into the conjunction held every
 * later Flow open over steps nothing would ever run (ACC-20260909 FIX1
 * retest: twelve plans across two days, thirty-one blockers per rejection).
 *
 * The long lane is one rolling goal lane per flow: the newest long plan the
 * flow touched, or — when the flow touched no long plan — the newest long
 * plan bound to the flow's session. A newer goal the flow never touched
 * cannot hold it open, and an abandoned predecessor cannot either.
 */
export function selectFlowCompletionPlans(
  plans: readonly PlanView[],
  input: { sessionId: string, touchedPlanIds: ReadonlySet<string> },
): PlanView[] {
  const standingSessionId = [...plans].reverse().find(plan => plan.spec.horizon === 'session' && plan.sessionId === input.sessionId && holdsOpenWork(plan))?.id

  const longCandidates = plans.filter(plan =>
    plan.spec.horizon === 'long'
    && holdsOpenWork(plan)
    && (input.touchedPlanIds.has(plan.id) || plan.sessionId === input.sessionId))
  const longLaneId = [...longCandidates].reverse().find(plan => input.touchedPlanIds.has(plan.id))?.id
    ?? [...longCandidates].reverse().find(plan => plan.sessionId === input.sessionId)?.id

  return plans.filter(plan => plan.id === standingSessionId || plan.id === longLaneId)
}

/**
 * Where one plan belongs on the chat surface.
 *
 * Chat used to render every plan the store held, so long goals from other
 * conversations and finished goals accumulated in the timeline until the
 * composer was pushed out of view (ACC-20260911 cross-session pile-up). The
 * lane decides the surface, not the lifecycle:
 *
 * - `current`: live work of the conversation this window shows.
 * - `other-session`: live long goals owned by another conversation; browsed
 *   from the plan center with its source session named instead of
 *   impersonating this one.
 * - `unattributed`: live work with no session binding (legacy rows and
 *   scope-less goals); shown in its own lane so the surface never fakes an
 *   owner.
 * - `archived`: terminal records. They leave the timeline but stay
 *   inspectable in the plan center, because completing a plan moves evidence,
 *   it does not delete it. A completed plan whose steps lack verification
 *   keeps its amber unverified marks on the card; the plan center counts
 *   those separately so the flag is not buried. Session plans superseded by a
 *   newer plan in the same lane are archived too (see
 *   {@link planSurfaceLanes}).
 */
export type PlanSurfaceLane = 'current' | 'other-session' | 'unattributed' | 'archived'

/** Classifies one plan for the chat surfaces of a session. */
export function planSurfaceLane(plan: PlanView, sessionId?: string): PlanSurfaceLane {
  if (plan.status === 'failed' || plan.status === 'cancelled' || plan.status === 'completed')
    return 'archived'
  if (!plan.sessionId)
    return 'unattributed'
  if (plan.sessionId === sessionId)
    return 'current'
  return 'other-session'
}

/**
 * Classifies every plan of one chat window, applying lane supersession.
 *
 * The session lane holds one standing plan per conversation: starting a newer
 * session plan replaces the older ones, and the completion gate plus the
 * evidence channel never target them again (see
 * {@link selectFlowCompletionPlans}). Rendering the whole pile as live work
 * recreated the accumulation defect in the session lane, so every older
 * session plan of the same conversation archives for display while its record
 * stays inspectable in the plan center.
 *
 * Order follows the store: records load oldest-first and new plans append, so
 * the last occurrence of a session lane is the standing plan.
 */
export function planSurfaceLanes(plans: readonly PlanView[], sessionId?: string): ReadonlyMap<string, PlanSurfaceLane> {
  const standingBySession = new Map<string, string>()
  for (const plan of plans) {
    if (plan.spec.horizon === 'session' && plan.sessionId)
      standingBySession.set(plan.sessionId, plan.id)
  }

  const lanes = new Map<string, PlanSurfaceLane>()
  for (const plan of plans) {
    const lane = planSurfaceLane(plan, sessionId)
    const superseded = lane === 'current'
      && plan.spec.horizon === 'session'
      && !!plan.sessionId
      && standingBySession.get(plan.sessionId) !== plan.id
    lanes.set(plan.id, superseded ? 'archived' : lane)
  }
  return lanes
}

/** Whether a plan still has steps that can run or collect evidence. */
export function hasOpenPlanSteps(plan: PlanView): boolean {
  return plan.spec.steps.some(step =>
    !plan.state.completedSteps.includes(step.id)
    && !plan.state.failedSteps.includes(step.id)
    && !plan.state.skippedSteps.includes(step.id))
}

/**
 * Resolves the plan a Flow turn uses for evidence stamping and projection.
 *
 * A dead binding must not blind the evidence channel: when the bound plan is
 * unknown or has no open steps left, receipts would go out unstamped and the
 * completion gate could never pass (ACC-20260909 FIX1). The fallback is the
 * newest scoped plan that can still collect evidence, mirroring
 * `scopedActivePlans` scoping.
 */
export function resolveFlowEvidencePlan(
  plans: readonly PlanView[],
  input: { sessionId?: string, boundPlanId?: string },
): PlanView | undefined {
  if (input.boundPlanId) {
    const bound = plans.find(plan => plan.id === input.boundPlanId)
    if (bound && hasOpenPlanSteps(bound))
      return bound
  }
  const scoped = plans.filter(plan =>
    !plan.state.paused
    && plan.status !== 'failed'
    && plan.status !== 'cancelled'
    && (plan.spec.horizon === 'long' || !plan.sessionId || plan.sessionId === input.sessionId))
  return [...scoped].reverse().find(plan => hasOpenPlanSteps(plan))
}

/**
 * Finds the long-horizon plan that owns a Flow run by durable run identity.
 *
 * A resumed Flow carries no `planId`, so the host authorizer resolves ownership
 * from `activeRun` or `lastRun`. `lastRun` matters because a constraint revision
 * clears `activeRun` while a provider response from the old run may still be
 * delivering tool calls; matching only `activeRun` would allow that mutation.
 */
export function findLongPlanOwningRun(
  plans: readonly PlanView[],
  run: { sessionId: string, flowId: string, taskId: string },
): PlanView | undefined {
  return plans.find((plan) => {
    if (plan.spec.horizon !== 'long')
      return false
    const goal = plan.state.longGoal
    return [goal?.activeRun, goal?.lastRun].some(candidate =>
      !!candidate
      && candidate.sessionId === run.sessionId
      && candidate.flowId === run.flowId
      && candidate.taskId === run.taskId)
  })
}

type LongGoalRevisionHandler = (event: LongGoalRevisionEvent) => void

let longGoalRevisionHandler: LongGoalRevisionHandler | undefined

/**
 * Installs the runtime bridge that interrupts a Flow before its long-goal
 * constraints are replaced.
 *
 * The returned disposer only clears this registration when it still owns the
 * slot. This keeps a later store instance from being removed by an older
 * renderer cleanup.
 */
export function installLongGoalRevisionHandler(handler: LongGoalRevisionHandler | undefined): () => void {
  longGoalRevisionHandler = handler
  return () => {
    if (longGoalRevisionHandler === handler)
      longGoalRevisionHandler = undefined
  }
}

interface RuntimePlanRecord {
  id: string
  spec: PlanSpec
  stateSnapshot: PlanState
  /** Chat session that owns this plan's journal evidence and scheduled work. */
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
    ...(spec.scope ? { scope: { ...spec.scope } } : {}),
    ...(spec.workspaceRoot ? { workspaceRoot: spec.workspaceRoot } : {}),
    steps: spec.steps.map(step => ({
      ...step,
      allowedTools: [...step.allowedTools],
      expectedEvidence: step.expectedEvidence.map(evidence => ({ ...evidence })),
    })),
  }
}

function cloneLongGoalState(state: LongGoalState): LongGoalState {
  return {
    ...state,
    ...(state.lastEnvironment ? { lastEnvironment: { ...state.lastEnvironment, toolNames: [...state.lastEnvironment.toolNames] } } : {}),
    ...(state.pendingQuestion ? { pendingQuestion: { ...state.pendingQuestion, ...(state.pendingQuestion.choices ? { choices: [...state.pendingQuestion.choices] } : {}) } } : {}),
    ...(state.activeRun ? { activeRun: { ...state.activeRun } } : {}),
    ...(state.lastRun ? { lastRun: { ...state.lastRun } } : {}),
    ...(state.lastTransition ? { lastTransition: { ...state.lastTransition } } : {}),
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
    ...(state.longGoal ? { longGoal: cloneLongGoalState(state.longGoal) } : {}),
  }
}

function planJournalEvents(journal: ReturnType<typeof useJournalStore>, plan: Pick<RuntimePlanRecord, 'sessionId'>): readonly JournalEvent[] {
  if (!plan.sessionId)
    return journal.events

  // `events` is touched so a write or hydration in any session invalidates the
  // projection. The session snapshot itself does not switch the window's
  // active journal projection.
  void journal.events
  return journal.snapshotSession(plan.sessionId)
}

function keepPlanStateForSpec(state: PlanState, spec: PlanSpec): PlanState {
  const stepIds = new Set(spec.steps.map(step => step.id))
  const next = clonePlanState(state)

  next.completedSteps = next.completedSteps.filter(stepId => stepIds.has(stepId))
  next.failedSteps = next.failedSteps.filter(stepId => stepIds.has(stepId))
  next.skippedSteps = next.skippedSteps.filter(stepId => stepIds.has(stepId))
  next.evidenceRefs = next.evidenceRefs.filter(evidence => stepIds.has(evidence.stepId))
  if (next.unverifiedSteps)
    next.unverifiedSteps = next.unverifiedSteps.filter(stepId => stepIds.has(stepId))
  if (next.currentStepId && !stepIds.has(next.currentStepId))
    delete next.currentStepId

  return next
}

function createPlanId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `plan-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

function eventMatchesPlan(event: JournalEvent, planId: string): boolean {
  if (event.type === 'plan/hint')
    return event.planId === planId

  if (event.type === 'approval/asked' || event.type === 'approval/decided')
    return event.planId === planId
  if (event.type === 'goal/update')
    return event.goalId === planId
  return (event.type === 'plan/update' || event.type === 'tool/call' || event.type === 'tool/result')
    ? event.planId === planId
    : false
}

function latestPlanStatus(view: PlanView): PlanStepStatus {
  switch (view.state.longGoal?.lifecycle) {
    case 'paused':
      return 'paused'
    case 'completed':
      return 'completed'
    case 'cancelled':
      return 'cancelled'
    case 'failed':
      return 'failed'
    case 'waiting-condition':
    case 'waiting-user':
      return 'blocked'
  }
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
  const initialState = keepPlanStateForSpec(plan.stateSnapshot, plan.spec)
  if (plan.spec.horizon === 'long' && !initialState.longGoal)
    initialState.longGoal = createLongGoalState(plan.createdAt, true)
  if (planEvents.length === 0)
    return initialState

  const gateSnapshot = projectStepGateStates(planEvents, plan.spec.steps)
  const completedFromJournal = plan.spec.steps.filter(step => gateSnapshot.steps[step.id]?.status === 'completed').map(step => step.id)
  const failedFromJournal = plan.spec.steps.filter(step => gateSnapshot.steps[step.id]?.status === 'failed').map(step => step.id)
  // Supersession closes steps by decision; the journal, not only the restart
  // snapshot, must carry that closure into skippedSteps so the focus
  // derivation and the evidence candidates stop pointing at dead steps.
  const skippedFromJournal = plan.spec.steps.filter(step => gateSnapshot.steps[step.id]?.status === 'skipped').map(step => step.id)
  const approvalBlockedSteps = new Set(plan.spec.steps
    .filter(step => gateSnapshot.steps[step.id]?.status === 'blocked' && gateSnapshot.steps[step.id]?.reason?.startsWith('approval '))
    .map(step => step.id))
  const failedGateSteps = new Set(failedFromJournal)
  // Model-declared completions (plan_update action "complete") land here
  // without gate evidence; they count as finished but stay flagged as
  // unverified so the plan card can render them amber. Approval-blocked and
  // failed steps stay open: a declaration cannot override a pending decision
  // or a recorded failure in the user-visible projection.
  const modelCompletedFromJournal = [...new Set(planEvents.flatMap((event) => {
    if (event.type !== 'plan/update' || event.status !== 'completed' || !event.stepId || !plan.spec.steps.some(step => step.id === event.stepId))
      return []
    if (approvalBlockedSteps.has(event.stepId) || failedGateSteps.has(event.stepId))
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
    && !plan.stateSnapshot.skippedSteps.includes(step.id)
    && !skippedFromJournal.includes(step.id))?.id
  // A snapshot focus on a since-skipped step is a stale pointer, not a plan:
  // restoring it would report a fully-superseded plan as in progress.
  const snapshotCurrentStepId = plan.stateSnapshot.currentStepId && !skippedFromJournal.includes(plan.stateSnapshot.currentStepId)
    ? plan.stateSnapshot.currentStepId
    : undefined
  const currentCandidate = startedStep ?? nextUnresolvedStep ?? snapshotCurrentStepId
  const evidenceFromJournal: PlanEvidenceRef[] = planEvents.flatMap((event) => {
    if (event.type !== 'tool/result' || !event.ok || (event.outcome ?? 'ok') !== 'ok' || !event.stepId || !plan.spec.steps.some(step => step.id === event.stepId))
      return []
    return [{
      stepId: event.stepId,
      source: 'tool_result' as const,
      summary: event.summary,
    }]
  })

  let longGoal = initialState.longGoal
  for (const event of planEvents) {
    if (event.type !== 'goal/update' || !longGoal)
      continue
    // The snapshot already folds every transition persisted with it. A
    // millisecond tie between consecutive transitions (pause and a
    // waiting-user update in the same tick) used to slip an already-consumed
    // event past the old `<` guard, applying it on top of the snapshot and
    // throwing on an impossible transition.
    if (longGoal.lastTransition) {
      if (event.timestamp < longGoal.lastTransition.timestamp)
        continue
      if (event.timestamp === longGoal.lastTransition.timestamp
        && (event.lifecycle !== longGoal.lastTransition.lifecycle || event.reason !== longGoal.lastTransition.reason)) {
        continue
      }
    }
    longGoal = applyLongGoalTransition(longGoal, {
      lifecycle: event.lifecycle,
      reason: event.reason,
      source: event.source,
      timestamp: event.timestamp,
      constraintVersion: event.constraintVersion,
      revision: event.revision,
      nextReviewAt: event.nextReviewAt,
      waitReason: event.waitReason,
      pendingQuestion: event.pendingQuestion,
      run: event.run,
      environment: event.environment,
    })
  }

  return {
    ...(currentCandidate && !completedSteps.includes(currentCandidate) ? { currentStepId: currentCandidate } : {}),
    ...(longGoal ? { paused: longGoal.lifecycle === 'paused' } : plan.stateSnapshot.paused !== undefined ? { paused: plan.stateSnapshot.paused } : {}),
    completedSteps,
    failedSteps,
    skippedSteps: uniqueStrings(plan.stateSnapshot.skippedSteps, skippedFromJournal),
    evidenceRefs: uniqueEvidence(plan.stateSnapshot.evidenceRefs, evidenceFromJournal),
    blockers,
    unverifiedSteps,
    ...(plan.stateSnapshot.lastReplanReason ? { lastReplanReason: plan.stateSnapshot.lastReplanReason } : {}),
    ...(longGoal ? { longGoal } : {}),
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

  /**
   * Task stamp for events this store writes.
   *
   * Attribution happens at write time: when a flow is open in this session,
   * its plan updates and tool receipts belong to that task, and the open
   * task's id comes from the journal instead of being guessed from timing
   * (TASK-RUN-AND-UI-PLAN A).
   */
  function taskStamp(sessionId?: string): { taskId: string } | Record<never, never> {
    const taskId = openTaskId(sessionId ? journal.snapshotSession(sessionId) : journal.events)
    return taskId ? { taskId } : {}
  }

  function planSessionId(planId: string): string | undefined {
    return plans.value.find(plan => plan.id === planId)?.sessionId
  }

  function appendPlanEvent(planId: string, event: JournalEventInput): JournalEvent {
    const sessionId = planSessionId(planId)
    return sessionId ? journal.append(sessionId, event) : journal.appendActive(event)
  }

  const planViews = computed<PlanView[]>(() => {
    if (plans.value.length === 0)
      return EMPTY_PLANS

    return plans.value.map((plan) => {
      const state = stateFromJournal(plan, planJournalEvents(journal, plan))
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
    if (plan.status === 'failed' || plan.status === 'cancelled')
      return false
    if (plan.status === 'completed')
      return (plan.state.unverifiedSteps ?? []).length > 0
    return true
  }))
  const activeSessionPlan = computed(() => activePlans.value.filter(plan => plan.spec.horizon === 'session' && !plan.state.paused).at(-1))
  const activeLongPlan = computed(() => activePlans.value.filter(plan => plan.spec.horizon === 'long' && !plan.state.paused).at(-1))
  const activePlan = computed(() => activeSessionPlan.value ?? activeLongPlan.value)

  /**
   * Active plans visible from one chat session. Long goals remain visible in
   * every window, while their journal evidence is still read from the owning
   * session.
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
    await waitForRestore()
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

  async function start(spec: PlanSpec, requestedId?: string, options?: { sessionId?: string, scope?: PlanSpec['scope'], workspaceRoot?: string }): Promise<string> {
    await initialize()
    const normalizedSpec = normalizePlanSpec({
      ...spec,
      ...(options?.scope ? { scope: { ...options.scope } } : {}),
      ...(options?.workspaceRoot ? { workspaceRoot: options.workspaceRoot } : {}),
    })
    const rolling = normalizedSpec.horizon === 'long' ? activeLongPlan.value : undefined
    const id = requestedId ?? rolling?.id ?? createPlanId()
    terminalStatusEvents.delete(id)
    const existingIndex = plans.value.findIndex(plan => plan.id === id)
    if (existingIndex >= 0 && rolling?.id !== id)
      throw new Error(`Plan already exists: ${id}`)

    const now = Date.now()
    let revisedLongGoal: LongGoalState | undefined
    if (existingIndex >= 0) {
      const previous = plans.value[existingIndex]!
      const previousState = planViews.value.find(plan => plan.id === id)?.state ?? previous.stateSnapshot
      if (normalizedSpec.horizon === 'long') {
        const currentLongGoal = previousState.longGoal ?? createLongGoalState(previous.createdAt, true)
        revisedLongGoal = applyLongGoalTransition(currentLongGoal, {
          lifecycle: 'executable',
          reason: 'long-goal constraints revised',
          source: 'user',
          timestamp: now,
          revision: true,
          nextReviewAt: now,
        })
        const activeRun = currentLongGoal.activeRun
        if (activeRun && (currentLongGoal.lifecycle === 'running' || currentLongGoal.lifecycle === 'waiting-user')) {
          longGoalRevisionHandler?.({
            planId: id,
            run: { ...activeRun },
            constraintVersion: revisedLongGoal.constraintVersion,
            reason: revisedLongGoal.lastTransition?.reason ?? 'long-goal constraints revised',
          })
        }
      }
      const nextState = keepPlanStateForSpec(previousState, normalizedSpec)
      plans.value = plans.value.map((plan, index) => index === existingIndex
        ? {
            ...plan,
            spec: clonePlanSpec(normalizedSpec),
            stateSnapshot: {
              ...nextState,
              ...(revisedLongGoal ? { longGoal: revisedLongGoal, paused: false } : {}),
            },
            ...(options?.sessionId ? { sessionId: options.sessionId } : {}),
            updatedAt: now,
          }
        : plan)
    }
    else {
      const initialState = emptyPlanState()
      if (normalizedSpec.horizon === 'long')
        initialState.longGoal = createLongGoalState(now, !normalizedSpec.scope || !normalizedSpec.workspaceRoot)
      plans.value = [...plans.value, {
        id,
        spec: clonePlanSpec(normalizedSpec),
        stateSnapshot: initialState,
        ...(options?.sessionId ? { sessionId: options.sessionId } : {}),
        createdAt: now,
        updatedAt: now,
      }]
    }

    if (options?.sessionId) {
      // Replay before the first append so plan events continue the persisted
      // seqs instead of reusing them (2026-09-10 #18).
      await journal.hydrate(options.sessionId)
      journal.ensureSession(options.sessionId)
    }
    else {
      journal.ensureSession()
    }
    const firstStep = normalizedSpec.steps[0]
    if (firstStep) {
      appendPlanEvent(id, {
        type: 'plan/update',
        planId: id,
        stepId: firstStep.id,
        status: 'in_progress',
        ...taskStamp(options?.sessionId),
      })
    }
    if (revisedLongGoal) {
      appendPlanEvent(id, {
        type: 'goal/update',
        goalId: id,
        lifecycle: revisedLongGoal.lifecycle,
        reason: revisedLongGoal.lastTransition?.reason ?? 'long-goal constraints revised',
        source: revisedLongGoal.lastTransition?.source ?? 'user',
        constraintVersion: revisedLongGoal.constraintVersion,
        timestamp: now,
        revision: true,
        nextReviewAt: revisedLongGoal.nextReviewAt,
      })
    }
    await persistPlan(id)
    const created = planViews.value.find(plan => plan.id === id)
    if (created?.state.longGoal)
      await syncLongGoalSchedule({ goalId: id, ...created.state.longGoal })
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
    appendPlanEvent(planId, {
      type: 'plan/update',
      planId,
      status,
      reason: `plan reached terminal status: ${status}`,
      ...taskStamp(planSessionId(planId)),
    })
  }

  async function updateStep(planId: string, stepId: string, status: Exclude<PlanStepStatus, 'completed'>, reason?: string): Promise<void> {
    const record = plans.value.find(plan => plan.id === planId)
    if (!record)
      return
    appendPlanEvent(planId, {
      type: 'plan/update',
      planId,
      stepId,
      status,
      ...(reason ? { reason } : {}),
      ...taskStamp(record.sessionId),
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

    appendPlanEvent(planId, {
      type: 'plan/update',
      planId,
      stepId,
      status: 'completed',
      unverified: true,
      ...(rationale ? { reason: rationale } : {}),
      ...taskStamp(plan.sessionId),
    })
    await persistPlan(planId)
    await recordTerminalStatus(planId)
    return `Step "${stepId}" marked complete (unverified — the declared evidence was not satisfied in the journal). The plan card flags it amber.`
  }

  async function recordToolResult(input: { planId: string, stepId: string, toolName: string, ok: boolean, summary: string, outcome?: ToolResultOutcome, tier?: ToolResultTier, provenance?: ToolEvidenceAuthor }): Promise<void> {
    const sessionId = planSessionId(input.planId)
    appendPlanEvent(input.planId, {
      type: 'tool/result',
      planId: input.planId,
      stepId: input.stepId,
      toolName: input.toolName,
      ok: input.ok,
      ...(input.outcome ? { outcome: input.outcome } : {}),
      ...(input.tier ? { tier: input.tier } : {}),
      summary: input.summary,
      ...(input.provenance ? { provenance: input.provenance } : {}),
      ...taskStamp(sessionId),
    })
    await persistPlan(input.planId)
    await recordTerminalStatus(input.planId)
  }

  async function setPaused(planId: string, paused: boolean): Promise<void> {
    const record = plans.value.find(plan => plan.id === planId)
    if (!record)
      return
    if (record.spec.horizon === 'long') {
      const timestamp = Date.now()
      await transitionLongGoal(planId, {
        lifecycle: paused ? 'paused' : 'executable',
        reason: paused ? 'paused by the user' : 'resumed by the user',
        source: 'user',
        timestamp,
        ...(paused ? {} : { nextReviewAt: timestamp }),
      })
      return
    }
    plans.value = plans.value.map(plan => plan.id === planId
      ? { ...plan, stateSnapshot: { ...clonePlanState(plan.stateSnapshot), paused }, updatedAt: Date.now() }
      : plan)
    const stepId = record.stateSnapshot.currentStepId ?? record.spec.steps[0]?.id
    appendPlanEvent(planId, {
      type: 'plan/update',
      planId,
      ...(stepId ? { stepId } : {}),
      status: paused ? 'paused' : 'in_progress',
      reason: paused ? 'paused by the user' : 'resumed by the user',
      ...taskStamp(record.sessionId),
    })
    await persistPlan(planId)
  }

  async function pausePlan(planId: string): Promise<void> {
    await setPaused(planId, true)
  }

  async function resumePlan(planId: string): Promise<void> {
    await setPaused(planId, false)
  }

  /** Applies one durable long-goal lifecycle transition and persists its snapshot. */
  async function transitionLongGoal(planId: string, input: LongGoalTransitionInput): Promise<LongGoalState | undefined> {
    const record = plans.value.find(plan => plan.id === planId)
    if (!record || record.spec.horizon !== 'long')
      return undefined
    // Goal transitions append `goal/update` to the plan session before any
    // flow exists. Replay first: appending at seq 0 into a session whose file
    // already has history made the host drop every event (2026-09-10 #18).
    if (record.sessionId)
      await journal.hydrate(record.sessionId)

    const view = planViews.value.find(plan => plan.id === planId)
    const current = view?.state.longGoal ?? createLongGoalState(record.createdAt, true)
    if (input.run?.endedAt !== undefined
      && (!current.activeRun || current.activeRun.taskId !== input.run.taskId || current.activeRun.flowId !== input.run.flowId)) {
      return cloneLongGoalState(current)
    }
    const next = applyLongGoalTransition(current, input)
    const nextSnapshot = clonePlanState(record.stateSnapshot)
    nextSnapshot.longGoal = cloneLongGoalState(next)
    nextSnapshot.paused = next.lifecycle === 'paused'
    plans.value = plans.value.map(plan => plan.id === planId
      ? { ...plan, stateSnapshot: nextSnapshot, updatedAt: input.timestamp }
      : plan)

    appendPlanEvent(planId, {
      type: 'goal/update',
      goalId: planId,
      lifecycle: next.lifecycle,
      reason: input.reason,
      source: input.source,
      constraintVersion: next.constraintVersion,
      timestamp: input.timestamp,
      ...(input.revision ? { revision: true } : {}),
      ...(input.run?.taskId ? { taskId: input.run.taskId } : {}),
      ...(input.run?.flowId ? { flowId: input.run.flowId } : {}),
      ...(next.nextReviewAt !== undefined ? { nextReviewAt: next.nextReviewAt } : {}),
      ...(next.waitReason ? { waitReason: next.waitReason } : {}),
      ...(next.pendingQuestion ? { pendingQuestion: { ...next.pendingQuestion } } : {}),
      ...(next.lastEnvironment ? { environment: { ...next.lastEnvironment, toolNames: [...next.lastEnvironment.toolNames] } } : {}),
      ...(input.run ? { run: { ...input.run } } : {}),
    })
    await persistPlan(planId)
    await syncLongGoalSchedule({ goalId: planId, ...next })
    return cloneLongGoalState(next)
  }

  async function cancelLongGoal(planId: string, reason = 'cancelled by the user'): Promise<void> {
    await transitionLongGoal(planId, {
      lifecycle: 'cancelled',
      reason,
      source: 'user',
      timestamp: Date.now(),
    })
  }

  /**
   * Deterministic long-goal revision for a `/goal` send that arrives while a
   * Flow runs.
   *
   * A running Flow consumes queued sends as steering text, so the revision
   * that `plan_update start` would perform (rolling-id rewrite with a
   * constraint-version bump) never happens: the goal plan keeps its obsolete
   * steps and the completion conjunction holds them open while the model
   * improvises a session plan for the revised work (ACC-20260910 REV). This
   * applies the same revision transition `start()` applies — version bump,
   * revision event, interruption of an active run — and lets the steering
   * text still carry the new requirements to the model. Completed or
   * cancelled goals are not revised; the model creates a fresh goal instead.
   */
  async function reviseLongGoalConstraints(sessionId: string | undefined): Promise<boolean> {
    const target = scopedActivePlans(sessionId).filter(plan => plan.spec.horizon === 'long').at(-1)
    const lifecycle = target?.state.longGoal?.lifecycle
    if (!target || lifecycle === 'completed' || lifecycle === 'cancelled')
      return false

    const activeRun = target.state.longGoal?.activeRun
    const now = Date.now()
    const next = await transitionLongGoal(target.id, {
      lifecycle: 'executable',
      reason: 'long-goal constraints revised',
      source: 'user',
      timestamp: now,
      revision: true,
      nextReviewAt: now,
    })
    if (next && activeRun && (lifecycle === 'running' || lifecycle === 'waiting-user')) {
      longGoalRevisionHandler?.({
        planId: target.id,
        run: { ...activeRun },
        constraintVersion: next.constraintVersion,
        reason: 'long-goal constraints revised',
      })
    }
    return !!next
  }

  async function softDeletePlan(planId: string): Promise<void> {
    await initialize()
    const record = plans.value.find(plan => plan.id === planId)
    if (!record)
      return
    await repository.value?.softDeletePlan(planId)
    if (record.spec.horizon === 'long')
      await unscheduleLongGoal(planId)
    plans.value = plans.value.filter(plan => plan.id !== planId)
    terminalStatusEvents.delete(planId)
  }

  function promptProjection(planId?: string): string {
    const plan = planId
      ? planViews.value.find(candidate => candidate.id === planId)
      : activePlan.value
    if (!plan)
      return ''

    const recentHints = planJournalEvents(journal, plan).flatMap((event) => {
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
    longPlans: computed(() => planViews.value.filter(plan => plan.spec.horizon === 'long')),
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
    transitionLongGoal,
    cancelLongGoal,
    reviseLongGoalConstraints,
    softDeletePlan,
    promptProjection,
    reset,
  }
}, {
  synced: {
    actions: ['initialize', 'persistPlan', 'retryPersistence', 'start', 'updateStep', 'focusStep', 'completeStep', 'recordToolResult', 'recordTerminalStatus', 'pausePlan', 'resumePlan', 'transitionLongGoal', 'cancelLongGoal', 'reviseLongGoalConstraints', 'softDeletePlan'],
    state: true,
  },
})
