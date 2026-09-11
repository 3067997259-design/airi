import type { FlowEndReason, LongGoalEnvironmentSnapshot, LongGoalPendingQuestion, LongGoalRunOutcome, LongGoalRunRecord } from '@proj-airi/core-agent'

import type { LongGoalWakePayload } from '../../services/long-goal-scheduler'
import type { PlanView } from '../plans'

import { errorMessageFrom } from '@moeru/std'
import { compareLongGoalEnvironment, describeLongGoalEnvironmentChanges, normalizeLongGoalEnvironment } from '@proj-airi/core-agent'
import { defineStore } from 'pinia'
import { ref, watch } from 'vue'

import {
  claimLongGoalWake,
  isLongGoalWakeConsumer,
  onLongGoalWake,
  releaseLongGoalRun,
  syncLongGoalSchedule,
  unscheduleLongGoal,
} from '../../services/long-goal-scheduler'
import { areRestoreEffectsHeld, waitForRestore } from '../../services/restore-gate'
import { useChatStore } from '../chat'
import { useChatSessionStore } from '../chat/session-store'
import { useCodingToolsStore } from '../coding'
import { useJournalStore } from '../journal'
import { usePlanStore } from '../plans'
import { useAiriCardStore } from './airi-card'
import { useConsciousnessStore } from './consciousness'

const DEFAULT_REVIEW_DELAY_MS = 15 * 60_000
const BUSY_REVIEW_DELAY_MS = 5 * 60_000
const FAILURE_REVIEW_DELAY_MS = 10 * 60_000
/** Busy backoff ladder: each deferral while another goal holds the slot waits longer, capped. */
const BUSY_BACKOFF_LADDER_MS: readonly number[] = Object.freeze([5, 10, 20, 30].map(minutes => minutes * 60_000))
/** A goal queued this long for the slot stops thrashing and asks the user instead. */
const BUSY_ASK_AFTER_MS = 2 * 60 * 60_000
const BUSY_START_REASON = 'Another chat Flow is active.'
const BUSY_WAIT_REASON = 'Waiting for another goal that holds the single Flow slot.'

interface StartCheck {
  ok: boolean
  reason?: string
  sessionId?: string
  environment?: LongGoalEnvironmentSnapshot
}

function isTerminalGoal(plan: PlanView): boolean {
  const lifecycle = plan.state.longGoal?.lifecycle
  return lifecycle === 'completed' || lifecycle === 'cancelled' || lifecycle === 'failed'
}

/**
 * Builds the reason recorded when a run settles the goal as completed.
 *
 * A step closed by `plan_update complete` has no mechanical evidence. The goal
 * still completes, because that declaration is the intended escape hatch for
 * steps the gate cannot verify; naming those steps in the reason keeps the
 * unverified part on the goal record instead of only in the flow/end detail.
 *
 * @example
 * longGoalCompletionReason([])
 * // => 'Flow completed the goal steps; evidence remains visible in the plan record.'
 * longGoalCompletionReason(['step-1'])
 * // => 'Flow completed the goal steps; closed without verification: step-1.'
 */
export function longGoalCompletionReason(unverifiedSteps: readonly string[]): string {
  return unverifiedSteps.length > 0
    ? `Flow completed the goal steps; closed without verification: ${unverifiedSteps.join(', ')}.`
    : 'Flow completed the goal steps; evidence remains visible in the plan record.'
}

/** Coordinates durable goal state with one leader-owned Flow at a time. */
export const useLongGoalSchedulerStore = defineStore('long-goal-scheduler', () => {
  const planStore = usePlanStore()
  const chatSession = useChatSessionStore()
  const chat = useChatStore()
  const coding = useCodingToolsStore()
  const consciousness = useConsciousnessStore()
  const journal = useJournalStore()
  const card = useAiriCardStore()
  const initialized = ref(false)
  const runningGoalId = ref<string>()
  const lastWake = ref<LongGoalWakePayload>()
  const processingGoalIds = new Set<string>()
  // Wake dispatch is one serialized lane (run-to-completion): a wake that
  // arrives while a run holds the Flow slot waits behind it instead of
  // racing the start conditions.
  let wakeDispatch: Promise<void> = Promise.resolve()
  /** First deferral timestamp per goal while the Flow slot is busy. */
  const busySince = new Map<string, number>()
  /** Consecutive busy deferrals per goal; drives the backoff ladder. */
  const busyDeferrals = new Map<string, number>()
  let disposeWake: (() => void) | undefined
  let disposeJournalWatch: (() => void) | undefined

  function currentPlan(goalId: string): PlanView | undefined {
    return planStore.longPlans.find(plan => plan.id === goalId)
  }

  function activeFlowExists(): boolean {
    return Object.values(chat.flowStates).some(flow => flow.status === 'running')
  }

  function goalSessionId(plan: PlanView): string | undefined {
    return plan.sessionId ?? chatSession.activeSessionId
  }

  async function checkStartConditions(plan: PlanView, options: { acceptEnvironmentChange?: boolean } = {}): Promise<StartCheck> {
    const scope = plan.spec.scope
    // A scope that is missing or not a pair of non-empty strings is damaged
    // state, not a mismatch: name it so the user recreates the goal instead of
    // reading "outside the goal scope" (ACC-20260911 #17).
    if (!scope
      || typeof scope.userId !== 'string' || scope.userId.trim().length === 0
      || typeof scope.characterId !== 'string' || scope.characterId.trim().length === 0) {
      return {
        ok: false,
        reason: plan.spec.scope
          ? 'The goal scope is invalid. Recreate the goal with a valid user and character.'
          : 'The goal has no user and character execution scope.',
      }
    }

    const userId = chatSession.index?.userId ?? 'local'
    const characterId = card.activeCardId || 'default'
    if (scope.userId !== userId || scope.characterId !== characterId)
      return { ok: false, reason: 'The current user or character is outside the goal scope.' }

    const sessionId = goalSessionId(plan)
    if (!sessionId)
      return { ok: false, reason: 'No active chat session is available for this goal.' }

    const sessionMeta = chatSession.sessionMetas[sessionId]
    if (!sessionMeta || sessionMeta.userId !== userId || sessionMeta.characterId !== characterId)
      return { ok: false, reason: 'The goal session is not available in the current user and character scope.' }

    if (activeFlowExists() || chat.sending)
      return { ok: false, reason: BUSY_START_REASON }

    if (!consciousness.activeProvider || !consciousness.activeModel)
      return { ok: false, reason: 'No provider and model are configured.' }

    // A workspace-root broadcast updates the cache asynchronously. A wake
    // can arrive in that gap, so the start gate must read the host again
    // instead of trusting the last renderer snapshot.
    const status = await coding.refreshStatus()
    if (!status)
      return { ok: false, reason: 'Coding tools are not available in this renderer.' }
    if (!plan.spec.workspaceRoot)
      return { ok: false, reason: 'The goal has no isolated workspace root.' }
    if (status.workspaceRoot !== plan.spec.workspaceRoot)
      return { ok: false, reason: 'The current workspace root does not match the goal scope.' }
    if (!status.tools.some(tool => tool.available && (tool.name === 'read' || tool.name === 'list')))
      return { ok: false, reason: 'No workspace inspection tool is available.' }

    const environment = normalizeLongGoalEnvironment({
      providerId: consciousness.activeProvider,
      modelId: consciousness.activeModel,
      workspaceRoot: status.workspaceRoot,
      toolNames: status.tools.filter(tool => tool.available).map(tool => tool.name),
    })
    // The first accepted run records the environment. Before that there is
    // nothing to compare against, so a never-started goal always starts: the
    // workspace-root equality check above still guards the run, and inventing
    // a baseline at creation would block goals created while the environment
    // (provider, model, tools) was already unusual. This is a design choice,
    // not an oversight (ACC-20260911 #15).
    const previous = plan.state.longGoal?.lastEnvironment
    if (previous && !options.acceptEnvironmentChange) {
      const changed = compareLongGoalEnvironment(previous, environment)
      if (changed.length > 0) {
        return {
          ok: false,
          reason: `The goal environment changed (${describeLongGoalEnvironmentChanges(changed)}). Review the current environment before the next run.`,
          environment,
        }
      }
    }

    return { ok: true, sessionId, environment }
  }

  function pendingInteraction(plan: PlanView, run: LongGoalRunRecord): LongGoalPendingQuestion | undefined {
    const sessionEvents = journal.snapshotSession(run.sessionId)
    const startSeq = sessionEvents.findLast(event => event.type === 'flow/start' && event.flowId === run.flowId)?.seq ?? 0
    const events = sessionEvents.filter(event => event.seq > startSeq)
    const pending: LongGoalPendingQuestion[] = []

    for (const event of events) {
      if (event.type === 'user/asked' && event.taskId === run.taskId) {
        const answered = events.some(candidate => candidate.type === 'user/answered' && candidate.requestId === event.requestId && candidate.seq > event.seq)
        if (!answered)
          pending.push({ requestId: event.requestId, question: event.question, ...(event.choices ? { choices: [...event.choices] } : {}), askedAt: Date.now() })
      }
      if (event.type === 'approval/asked' && event.planId === plan.id) {
        const decided = events.some(candidate => candidate.type === 'approval/decided' && candidate.requestId === event.requestId && candidate.seq > event.seq)
        if (!decided) {
          pending.push({
            requestId: event.requestId,
            question: event.subject ? `${event.reason}: ${event.subject}` : event.reason,
            choices: ['approve', 'reject'],
            askedAt: Date.now(),
          })
        }
      }
    }

    return pending.at(-1)
  }

  async function waitForCondition(plan: PlanView, reason: string, delayMs = DEFAULT_REVIEW_DELAY_MS): Promise<void> {
    const timestamp = Date.now()
    try {
      await planStore.transitionLongGoal(plan.id, {
        lifecycle: 'waiting-condition',
        reason,
        source: 'scheduler',
        timestamp,
        nextReviewAt: timestamp + delayMs,
        waitReason: reason,
      })
    }
    catch (error) {
      console.warn('[LongGoal] Failed to record a waiting condition:', errorMessageFrom(error) ?? error)
    }
  }

  async function recordPendingInteraction(plan: PlanView, run: LongGoalRunRecord, question: LongGoalPendingQuestion): Promise<void> {
    const lifecycle = plan.state.longGoal?.lifecycle
    if (lifecycle !== 'running' || plan.state.longGoal?.activeRun?.taskId !== run.taskId)
      return
    await planStore.transitionLongGoal(plan.id, {
      lifecycle: 'waiting-user',
      reason: 'the work Flow is waiting for user input',
      source: 'flow',
      timestamp: Date.now(),
      pendingQuestion: question,
    })
  }

  async function observePendingInteraction(): Promise<void> {
    const goalId = runningGoalId.value
    if (!goalId)
      return
    const plan = currentPlan(goalId)
    const run = plan?.state.longGoal?.activeRun
    if (!plan || !run)
      return
    const question = pendingInteraction(plan, run)
    if (question)
      await recordPendingInteraction(plan, run, question)
  }

  function runStillOwnsGoal(plan: PlanView, run: LongGoalRunRecord): boolean {
    const state = plan.state.longGoal
    return (state?.lifecycle === 'running' || state?.lifecycle === 'waiting-user')
      && state.activeRun?.taskId === run.taskId
      && state.activeRun.flowId === run.flowId
  }

  function flowOutcome(endReason: 'done' | 'blocked' | 'interrupted' | 'budget' | 'no-progress' | undefined): LongGoalRunOutcome {
    if (endReason === 'done')
      return 'completed'
    if (endReason === 'blocked')
      return 'blocked'
    if (endReason === 'budget')
      return 'budget'
    if (endReason === 'no-progress')
      return 'no-progress'
    return 'cancelled'
  }

  /** Returns the terminal reason for the run, including a journal-only end after a restart. */
  function flowEndReasonForRun(run: LongGoalRunRecord): FlowEndReason | undefined {
    const liveFlow = chat.flowStates[run.sessionId]
    if (liveFlow?.flowId === run.flowId && liveFlow.taskId === run.taskId && liveFlow.status === 'ended' && liveFlow.endReason)
      return liveFlow.endReason

    const journalEnd = journal.snapshotSession(run.sessionId).findLast(event =>
      event.type === 'flow/end'
      && event.flowId === run.flowId
      && event.taskId === run.taskId,
    )
    return journalEnd?.type === 'flow/end' ? journalEnd.reason : undefined
  }

  async function finishRun(plan: PlanView, run: LongGoalRunRecord, fallbackEndReason?: FlowEndReason): Promise<void> {
    const latest = currentPlan(plan.id)
    if (!latest || !runStillOwnsGoal(latest, run))
      return

    const pending = pendingInteraction(latest, run)
    if (pending) {
      await recordPendingInteraction(latest, run, pending)
      return
    }

    const endReason = flowEndReasonForRun(run) ?? fallbackEndReason
    if (!endReason)
      return

    const endedAt = Date.now()
    const outcome = flowOutcome(endReason)
    const endedRun: LongGoalRunRecord = { ...run, endedAt, outcome }
    const completed = endReason === 'done' && latest.status === 'completed'
    if (completed) {
      // A declared step has no mechanical evidence. The goal still completes —
      // the declaration mechanism exists for steps the gate cannot verify — but
      // the transition reason names those steps so the goal record itself
      // carries what the flow/end detail already reports.
      const unverified = latest.state.unverifiedSteps ?? []
      await planStore.transitionLongGoal(latest.id, {
        lifecycle: 'completed',
        reason: longGoalCompletionReason(unverified),
        source: 'flow',
        timestamp: endedAt,
        run: endedRun,
      })
      return
    }

    const reason = endReason === 'done'
      ? 'Flow ended before all goal steps were verified.'
      : `Flow ended with ${endReason}.`
    await planStore.transitionLongGoal(latest.id, {
      lifecycle: 'waiting-condition',
      reason,
      source: 'flow',
      timestamp: endedAt,
      nextReviewAt: endedAt + (endReason === 'budget' ? FAILURE_REVIEW_DELAY_MS : DEFAULT_REVIEW_DELAY_MS),
      waitReason: reason,
      run: endedRun,
    })
  }

  async function observeRunningGoal(): Promise<void> {
    const goalId = runningGoalId.value
    if (!goalId)
      return

    const plan = currentPlan(goalId)
    const run = plan?.state.longGoal?.activeRun
    if (!plan || !run)
      return

    const endReason = flowEndReasonForRun(run)
    if (!endReason) {
      await observePendingInteraction()
      return
    }

    await finishRun(plan, run)
    const latest = currentPlan(goalId)
    if (!latest?.state.longGoal?.activeRun && runningGoalId.value === goalId)
      runningGoalId.value = undefined
  }

  async function recoverRunningGoals(): Promise<void> {
    const plan = planStore.longPlans.find(candidate => candidate.state.longGoal?.lifecycle === 'running' && candidate.state.longGoal.activeRun)
    const run = plan?.state.longGoal?.activeRun
    if (!plan || !run)
      return

    // The main-process schedule deliberately omits running goals. The durable
    // plan snapshot and flow journal are the recovery source after a renderer
    // crash; bind the run back to this leader before attempting the resume.
    runningGoalId.value = plan.id
    await journal.hydrate(run.sessionId)

    const liveFlow = chat.flowStates[run.sessionId]
    if (liveFlow?.status === 'running' && (liveFlow.flowId !== run.flowId || liveFlow.taskId !== run.taskId)) {
      const reason = 'another Flow is active while the long-goal run is recovering'
      const timestamp = Date.now()
      await planStore.transitionLongGoal(plan.id, {
        lifecycle: 'waiting-condition',
        reason,
        source: 'system',
        timestamp,
        nextReviewAt: timestamp + BUSY_REVIEW_DELAY_MS,
        waitReason: reason,
        run: { ...run, endedAt: timestamp, outcome: 'failed' },
      })
      runningGoalId.value = undefined
      return
    }

    const resumed = liveFlow?.status === 'running' && liveFlow.flowId === run.flowId && liveFlow.taskId === run.taskId
      ? true
      : await chat.resumeFlowAfterRestart(run.sessionId)
    if (!resumed && !flowEndReasonForRun(run)) {
      const reason = 'the persisted long-goal Flow could not be resumed on startup'
      const timestamp = Date.now()
      await planStore.transitionLongGoal(plan.id, {
        lifecycle: 'waiting-condition',
        reason,
        source: 'system',
        timestamp,
        nextReviewAt: timestamp + FAILURE_REVIEW_DELAY_MS,
        waitReason: reason,
        run: { ...run, endedAt: timestamp, outcome: 'failed' },
      })
      runningGoalId.value = undefined
      return
    }

    await observeRunningGoal()
  }

  /**
   * Defers a goal whose only blocker is the single Flow slot.
   *
   * The first deferral records one waiting-condition transition (visible on
   * the goal card); every later one only extends the main-process schedule,
   * so two live goals no longer rewrite journal state at each other's
   * cadence. The backoff ladder caps the retry storm, and a goal queued past
   * BUSY_ASK_AFTER_MS stops thrashing entirely: it asks the user whether to
   * keep queuing, pause, or cancel.
   */
  async function deferWhileBusy(plan: PlanView): Promise<void> {
    const timestamp = Date.now()
    busySince.set(plan.id, busySince.get(plan.id) ?? timestamp)
    const deferrals = (busyDeferrals.get(plan.id) ?? 0) + 1
    busyDeferrals.set(plan.id, deferrals)

    if (timestamp - busySince.get(plan.id)! >= BUSY_ASK_AFTER_MS) {
      busyDeferrals.delete(plan.id)
      busySince.delete(plan.id)
      await planStore.transitionLongGoal(plan.id, {
        lifecycle: 'waiting-user',
        reason: 'this goal kept waiting for the Flow slot',
        source: 'scheduler',
        timestamp,
        pendingQuestion: {
          requestId: `goal-slot-${plan.id}-${timestamp}`,
          question: `This goal queued for over ${Math.round(BUSY_ASK_AFTER_MS / 3_600_000)} hours while other goals used the single Flow slot. Keep it queued, pause it, or cancel it from this card.`,
          choices: ['keep waiting', 'pause', 'cancel'],
          askedAt: timestamp,
        },
      })
      return
    }

    const backoffMs = BUSY_BACKOFF_LADDER_MS[Math.min(deferrals - 1, BUSY_BACKOFF_LADDER_MS.length - 1)]!
    const state = plan.state.longGoal
    if (state?.lifecycle === 'waiting-condition' && state.waitReason === BUSY_WAIT_REASON)
      await syncLongGoalSchedule({ goalId: plan.id, lifecycle: 'waiting-condition', nextReviewAt: timestamp + backoffMs })
    else
      await waitForCondition(plan, BUSY_WAIT_REASON, backoffMs)
  }

  function handleWake(payload: LongGoalWakePayload): void {
    wakeDispatch = wakeDispatch.then(() => processWake(payload)).catch((error) => {
      console.warn('[LongGoal] Wake dispatch failed.', error)
    })
  }

  async function processWake(payload: LongGoalWakePayload): Promise<void> {
    if (areRestoreEffectsHeld())
      return
    if (!isLongGoalWakeConsumer() || processingGoalIds.has(payload.goalId))
      return

    processingGoalIds.add(payload.goalId)
    lastWake.value = { ...payload }
    try {
      const plan = currentPlan(payload.goalId)
      const lifecycle = plan?.state.longGoal?.lifecycle
      if (!plan || !plan.state.longGoal) {
        await unscheduleLongGoal(payload.goalId)
        return
      }
      if (isTerminalGoal(plan) || (lifecycle !== 'executable' && lifecycle !== 'waiting-condition')) {
        await unscheduleLongGoal(payload.goalId)
        return
      }

      // Check before claim: a goal blocked only by the busy slot keeps its
      // main-process retry schedule instead of burning a lease and rewriting
      // its lifecycle every few minutes. This is what two live goals used to
      // ping-pong on (ACC-20260909: goal/update deferrals all evening).
      if (activeFlowExists() || chat.sending) {
        await deferWhileBusy(plan)
        return
      }

      const claim = await claimLongGoalWake({ goalId: payload.goalId, wakeId: payload.wakeId })
      if (!claim?.claimed || !claim.leaseId)
        return

      try {
        const check = await checkStartConditions(plan)
        if (!check.ok || !check.sessionId) {
          // A run may have claimed the slot between the pre-check and here.
          if (check.reason === BUSY_START_REASON)
            await deferWhileBusy(plan)
          else
            await waitForCondition(plan, check.reason ?? 'The goal cannot start yet.', DEFAULT_REVIEW_DELAY_MS)
          return
        }

        busyDeferrals.delete(plan.id)
        busySince.delete(plan.id)

        const sessionId = check.sessionId

        const flow = await chat.startFlow(sessionId, 'declared', `scheduled long-goal run for ${plan.goal}`)
        const run: LongGoalRunRecord = {
          taskId: flow.taskId,
          flowId: flow.flowId,
          sessionId,
          startedAt: flow.startedAt,
        }
        await planStore.transitionLongGoal(plan.id, {
          lifecycle: 'running',
          reason: 'scheduler claimed one bounded Flow run',
          source: 'scheduler',
          timestamp: Date.now(),
          run,
          environment: check.environment,
        })
        runningGoalId.value = plan.id
        await chat.send({
          sessionId,
          text: 'Continue one bounded work iteration for the current long-term goal. Inspect the workspace, take only the next safe action, record evidence, and stop when the iteration is complete.',
          source: 'self-initiative',
          selfInitiativeMode: 'task',
          planId: plan.id,
          profile: 'work',
          delivery: 'next-turn',
          maxSteps: 50,
        })
        // A normal scheduler send resolves only after the Flow has ended. The
        // fallback keeps the owner conservative when a remote state snapshot
        // arrives one tick late: settle as interrupted and schedule a review,
        // never as a successful completion.
        await finishRun(plan, run, 'interrupted')
      }
      finally {
        if (claim.leaseId)
          await releaseLongGoalRun({ goalId: payload.goalId, leaseId: claim.leaseId })
        if (runningGoalId.value === payload.goalId)
          runningGoalId.value = undefined
      }
    }
    catch (error) {
      const plan = currentPlan(payload.goalId)
      const run = plan?.state.longGoal?.activeRun
      if (plan && run && runStillOwnsGoal(plan, run)) {
        const timestamp = Date.now()
        const reason = `Long-goal work could not complete: ${errorMessageFrom(error) ?? 'unknown error'}.`
        await planStore.transitionLongGoal(plan.id, {
          lifecycle: 'waiting-condition',
          reason,
          source: 'system',
          timestamp,
          nextReviewAt: timestamp + FAILURE_REVIEW_DELAY_MS,
          waitReason: reason,
          run: { ...run, endedAt: timestamp, outcome: 'failed' },
        })
      }
      else if (plan) {
        await waitForCondition(plan, `Long-goal work failed before a run was recorded: ${errorMessageFrom(error) ?? 'unknown error'}.`, FAILURE_REVIEW_DELAY_MS)
      }
    }
    finally {
      processingGoalIds.delete(payload.goalId)
    }
  }

  async function syncAllSchedules(): Promise<void> {
    await planStore.initialize()
    // Plan persistence owns the schedule mirror. This call exists for boot,
    // when persisted goals must be registered before the first wake arrives.
    for (const plan of planStore.longPlans) {
      const state = plan.state.longGoal
      if (!state)
        continue
      await syncLongGoalSchedule({ goalId: plan.id, ...state })
    }
  }

  /** Rechecks one goal immediately after explicit user takeover. */
  async function runNow(goalId: string): Promise<boolean> {
    const plan = currentPlan(goalId)
    const state = plan?.state.longGoal
    if (!plan || !state)
      return false

    if (state.activeRun && chat.flowStates[state.activeRun.sessionId]?.status === 'running')
      await chat.endFlow(state.activeRun.sessionId, 'interrupted', 'user took over the goal')

    const check = await checkStartConditions(plan, { acceptEnvironmentChange: true })
    if (!check.ok) {
      await waitForCondition(plan, check.reason ?? 'The goal cannot start yet.')
      return false
    }

    const timestamp = Date.now()
    await planStore.transitionLongGoal(goalId, {
      lifecycle: 'executable',
      reason: 'user requested a fresh goal run after reviewing its state',
      source: 'user',
      timestamp,
      nextReviewAt: timestamp,
      environment: check.environment,
      ...(isTerminalGoal(plan) ? { revision: true } : {}),
    })
    return true
  }

  /**
   * Answers the queue-depth question a goal raised after hours on the busy
   * slot.
   *
   * `keep-waiting` returns it to the waiting lane (the main-process schedule
   * resumes from the next wake); `pause` and `cancel` end its queuing. The
   * goal card renders these as buttons so the raised question is actionable
   * instead of decoration.
   */
  async function answerPendingQuestion(goalId: string, choice: 'keep-waiting' | 'pause' | 'cancel'): Promise<void> {
    const plan = currentPlan(goalId)
    if (!plan || plan.state.longGoal?.lifecycle !== 'waiting-user')
      return

    const timestamp = Date.now()
    if (choice === 'cancel') {
      await planStore.cancelLongGoal(goalId, 'cancelled from the goal card after waiting for the Flow slot')
      return
    }
    if (choice === 'pause') {
      await planStore.pausePlan(goalId)
      return
    }
    // Keep waiting: back to the waiting lane with a fresh review window.
    await planStore.transitionLongGoal(goalId, {
      lifecycle: 'waiting-condition',
      reason: 'the user kept this goal queued for the Flow slot',
      source: 'user',
      timestamp,
      nextReviewAt: timestamp + BUSY_REVIEW_DELAY_MS,
      waitReason: BUSY_WAIT_REASON,
    })
  }

  async function initialize(): Promise<boolean> {
    await waitForRestore()
    if (areRestoreEffectsHeld())
      return false
    if (!isLongGoalWakeConsumer())
      return false
    if (initialized.value)
      return true

    await planStore.initialize()
    // Concurrent boot and adoption can both wait for plan hydration. Only
    // the first continuation installs listeners and mirrors schedules.
    if (initialized.value)
      return true
    if (areRestoreEffectsHeld())
      return false
    disposeWake?.()
    disposeWake = onLongGoalWake(payload => void handleWake(payload))
    disposeJournalWatch?.()
    disposeJournalWatch = watch(
      () => [
        journal.events.length,
        ...Object.values(chat.flowStates)
          .map(flow => `${flow.sessionId}:${flow.flowId}:${flow.taskId}:${flow.status}:${flow.endReason ?? ''}`)
          .sort(),
      ],
      () => void observeRunningGoal().catch(error => console.warn('[LongGoal] Run observation failed.', error)),
    )
    initialized.value = true
    await syncAllSchedules()
    await recoverRunningGoals()
    return true
  }

  function reset(): void {
    disposeWake?.()
    disposeJournalWatch?.()
    disposeWake = undefined
    disposeJournalWatch = undefined
    initialized.value = false
    runningGoalId.value = undefined
    lastWake.value = undefined
    processingGoalIds.clear()
    busySince.clear()
    busyDeferrals.clear()
    wakeDispatch = Promise.resolve()
  }

  return {
    initialized,
    runningGoalId,
    lastWake,
    initialize,
    syncAllSchedules,
    runNow,
    answerPendingQuestion,
    reset,
  }
})
