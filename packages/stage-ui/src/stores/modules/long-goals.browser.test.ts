import { createPinia, disposePinia } from 'pinia'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from 'vue'
import { createI18n } from 'vue-i18n'

import { chatSessionsRepo } from '../../database/repos/chat-sessions.repo'
import { installLongGoalSchedulerPort } from '../../services/long-goal-scheduler'
import { completeRestoreGate, releaseRestoreEffectHold } from '../../services/restore-gate'
import { useChatStore } from '../chat'
import { useChatSessionStore } from '../chat/session-store'
import { installCodingHostClient, useCodingToolsStore } from '../coding'
import { installJournalPersistence, useJournalStore } from '../journal'
import { usePlanStore } from '../plans'
import { useConsciousnessStore } from './consciousness'
import { longGoalCompletionReason, useLongGoalSchedulerStore } from './long-goals'

// Database IO is the only substituted boundary. Chat, plans, Vue and Pinia
// retain their real startup and command behavior in this isolated browser.
vi.mock('../../composables/use-duck-db', () => ({
  useDuckDb: () => ({ db: { value: { execute: async () => [] } }, getDb: async () => undefined }),
}))

const cleanup: Array<() => void> = []
const originalUrl = location.href

afterEach(async () => {
  cleanup.splice(0).reverse().forEach(dispose => dispose())
  installLongGoalSchedulerPort(undefined)
  installJournalPersistence(undefined)
  completeRestoreGate()
  await chatSessionsRepo.clear('local')
  localStorage.clear()
  history.replaceState(null, '', originalUrl)
})

function mountOwners() {
  const url = new URL(location.href)
  url.searchParams.set('synced-leader', 'true')
  history.replaceState(null, '', url)
  const pinia = createPinia()
  const app = createApp({
    setup() {
      useChatStore()
      return () => null
    },
  })
  app.use(pinia)
  app.use(createI18n({ legacy: false, locale: 'en', messages: { en: {} }, missingWarn: false, fallbackWarn: false }))
  app.mount(document.createElement('div'))
  cleanup.push(() => disposePinia(pinia), () => app.unmount())
  return pinia
}

describe('longGoalCompletionReason', () => {
  it('names declared-but-unverified steps on the completed goal', () => {
    expect(longGoalCompletionReason([])).toBe('Flow completed the goal steps; evidence remains visible in the plan record.')
    expect(longGoalCompletionReason(['step-1'])).toContain('closed without verification: step-1')
  })
})

describe('long-goal startup and resume', () => {
  it('installs one listener after adoption, including concurrent initialization', async () => {
    completeRestoreGate(true)
    const pinia = mountOwners()
    const dispose = vi.fn()
    const onWake = vi.fn(() => dispose)
    let leader = false
    installLongGoalSchedulerPort({
      schedule: async () => {},
      unschedule: async () => {},
      claim: async () => ({ claimed: false }),
      release: async () => {},
      isWakeConsumer: () => leader,
      onWake,
    })
    const scheduler = useLongGoalSchedulerStore(pinia)
    cleanup.push(() => scheduler.reset())
    expect(await scheduler.initialize()).toBe(false)
    releaseRestoreEffectHold()
    expect(await scheduler.initialize()).toBe(false)
    expect(onWake).not.toHaveBeenCalled()
    leader = true
    expect(await Promise.all([scheduler.initialize(), scheduler.initialize()])).toEqual([true, true])
    expect(await scheduler.initialize()).toBe(true)
    expect(onWake).toHaveBeenCalledTimes(1)
    scheduler.reset()
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it('schedules goals that waited through the restore hold once adoption releases it', async () => {
    // ROOT CAUSE:
    //
    // ACC-20260910 R04: a restored profile boots with the effect hold active,
    // so `initialize` returns before `syncAllSchedules` runs. Adoption is
    // clicked in a follower window; when the leader never receives the release
    // signal, the main-process schedule stays empty and no wake is ever
    // emitted. Releasing the hold must re-run initialization and mirror every
    // persisted review time into the schedule.
    completeRestoreGate(true)
    const pinia = mountOwners()
    const sessions = useChatSessionStore(pinia)
    const sessionId = await sessions.createSession('default', { setActive: true })
    const chat = useChatStore(pinia)
    const plans = usePlanStore(pinia)
    const nextReviewAt = Date.now() - 60_000
    const goalId = await plans.start({
      goal: 'Resume after adoption',
      horizon: 'long',
      steps: [{ id: 'read', lane: 'coding', intent: 'Read notes', allowedTools: ['read'], expectedEvidence: [{ source: 'tool_result', description: 'file contents' }], riskLevel: 'low', approvalRequired: false }],
    }, 'adopted-goal', { sessionId, scope: chat.memoryScope, workspaceRoot: 'goal-workspace' })
    await plans.transitionLongGoal(goalId, {
      lifecycle: 'waiting-condition',
      reason: 'Flow ended with interrupted.',
      source: 'flow',
      timestamp: nextReviewAt - 1000,
      nextReviewAt,
      waitReason: 'Flow ended with interrupted.',
    })

    const schedule = vi.fn(async () => {})
    installLongGoalSchedulerPort({
      schedule,
      unschedule: async () => {},
      claim: async () => ({ claimed: false }),
      release: async () => {},
      isWakeConsumer: () => true,
      onWake: () => () => {},
    })
    const scheduler = useLongGoalSchedulerStore(pinia)
    cleanup.push(() => scheduler.reset())

    expect(await scheduler.initialize()).toBe(false)
    expect(schedule).not.toHaveBeenCalled()

    releaseRestoreEffectHold()
    expect(await scheduler.initialize()).toBe(true)
    expect(schedule).toHaveBeenCalledWith({ goalId, nextReviewAt })
  })

  it('replays a persisted session before the first flow append', async () => {
    // ROOT CAUSE (ACC-20260911 #18):
    //
    // A flow started in an adopted profile journaled into a session that had
    // never been replayed, so it began at seq 0 and the host skipped every
    // append as a duplicate of the restored file. The whole run stayed in
    // memory. The send entry points now replay the session first.
    completeRestoreGate()
    const pinia = mountOwners()
    const sessions = useChatSessionStore(pinia)
    const sessionId = await sessions.createSession('default', { setActive: true })
    const journal = useJournalStore(pinia)
    installJournalPersistence({
      append: async () => {},
      read: async () => ({
        lines: [
          JSON.stringify({ type: 'session/header', seq: 0, sessionId, createdAt: 1, delegationDepth: 0 }),
          JSON.stringify({ type: 'user/message', seq: 1, text: 'restored', timestamp: 1 }),
          JSON.stringify({ type: 'user/message', seq: 2, text: 'restored again', timestamp: 2 }),
        ],
        lastSeq: 2,
        truncated: false,
        gaps: [],
        corruptLines: 0,
        duplicateLines: 0,
      }),
    })
    const chat = useChatStore(pinia)

    await chat.startFlow(sessionId)

    const start = journal.snapshotSession(sessionId).find(event => event.type === 'flow/start')
    expect(start?.seq).toBe(3)
  })

  it('names a damaged goal scope instead of a plain mismatch', async () => {
    // ROOT CAUSE (#17): a goal created with a mistyped character id kept a
    // broken scope and every wake reported "outside the goal scope", which
    // points at the current user instead of the damaged plan.
    completeRestoreGate()
    const pinia = mountOwners()
    const sessions = useChatSessionStore(pinia)
    const sessionId = await sessions.createSession('default', { setActive: true })
    const plans = usePlanStore(pinia)
    const goalId = await plans.start({
      goal: 'Repair the damaged scope',
      horizon: 'long',
      steps: [{ id: 'read', lane: 'coding', intent: 'Read notes', allowedTools: ['read'], expectedEvidence: [{ source: 'tool_result', description: 'file contents' }], riskLevel: 'low', approvalRequired: false }],
    }, 'damaged-scope-goal', { sessionId, scope: { userId: 'local', characterId: 'default' }, workspaceRoot: 'goal-workspace' })
    plans.plans = plans.plans.map(plan => plan.id === goalId
      ? { ...plan, spec: { ...plan.spec, scope: { userId: 'local', characterId: {} as never } } }
      : plan)
    const scheduler = useLongGoalSchedulerStore(pinia)
    cleanup.push(() => scheduler.reset())

    expect(await scheduler.runNow(goalId)).toBe(false)
    expect(plans.longPlans[0]?.state.longGoal?.waitReason).toContain('goal scope is invalid')
  })

  it('l06 resumes through the schedule without starting an ordinary chat turn', async () => {
    const pinia = mountOwners()
    const sessions = useChatSessionStore(pinia)
    const sessionId = await sessions.createSession('default', { setActive: true })
    const chat = useChatStore(pinia)
    const plans = usePlanStore(pinia)
    const schedule = vi.fn(async () => {})
    installLongGoalSchedulerPort({
      schedule,
      unschedule: async () => {},
      claim: async () => ({ claimed: false }),
      release: async () => {},
    })
    const goalId = await plans.start({
      goal: 'Inspect the isolated workspace',
      horizon: 'long',
      steps: [{ id: 'read', lane: 'coding', intent: 'Read notes', allowedTools: ['read'], expectedEvidence: [{ source: 'tool_result', description: 'file contents' }], riskLevel: 'low', approvalRequired: false }],
    }, 'resume-goal', { sessionId, scope: chat.memoryScope, workspaceRoot: 'isolated-workspace' })
    await plans.pausePlan(goalId)
    schedule.mockClear()
    // No provider is configured. The old fallthrough attempted a model turn
    // and failed, although the scheduler already owned the resumed goal.
    const result = await chat.send({ sessionId, text: '继续' })
    expect(result.messages).toHaveLength(1)
    expect(result.messages[0]?.content).toBe('stage.chat.long-goal-resumed')
    expect(plans.longPlans[0]?.state.longGoal?.lifecycle).toBe('executable')
    expect(schedule).toHaveBeenCalledTimes(1)
    expect(Object.values(chat.flowStates)).toHaveLength(0)
    expect(chat.sending).toBe(false)
  })

  it('runs a scheduled goal in its origin session, not the leader selection', async () => {
    completeRestoreGate()
    const pinia = mountOwners()
    const sessions = useChatSessionStore(pinia)
    const originSessionId = await sessions.createSession('default', { setActive: true })
    const leaderSelectionId = await sessions.createSession('default', { setActive: false })
    sessions.activeSessionId = leaderSelectionId

    const consciousness = useConsciousnessStore(pinia)
    consciousness.activeProvider = 'mock-provider'
    consciousness.activeModel = 'mock-model'
    installCodingHostClient({
      listDir: async () => ({ entries: [] }),
      readFile: async () => ({ content: '' }),
      listTools: async () => ({
        workspaceRoot: 'goal-workspace',
        tools: [
          { name: 'read', description: 'Read files', available: true },
          { name: 'list', description: 'List files', available: true },
        ],
      }),
      runCommand: async () => ({ tier: 'read-only', status: 'ok', stdout: '', stderr: '' }),
      runProgram: async () => ({ ok: true, logs: [], traces: [] }),
      setApprovalMode: async () => {},
      setWorkspaceRoot: async ({ root }) => ({ status: 'switched', workspaceRoot: root }),
    })

    const chat = useChatStore(pinia)
    const plans = usePlanStore(pinia)
    const scheduler = useLongGoalSchedulerStore(pinia)
    const send = vi.spyOn(chat, 'send').mockResolvedValue({ messages: [], sessionId: originSessionId })
    const startFlow = vi.spyOn(chat, 'startFlow').mockResolvedValue({
      flowId: 'origin-flow',
      taskId: 'origin-task',
      sessionId: originSessionId,
      status: 'running',
      trigger: 'declared',
      startedAt: Date.now(),
      iteration: 0,
      totalToolCalls: 0,
      stalledTurns: 0,
    })
    let wake: ((payload: { goalId: string, wakeId: string, reason: 'schedule' | 'retry' | 'startup', timestamp: number }) => void) | undefined
    installLongGoalSchedulerPort({
      schedule: async () => {},
      unschedule: async () => {},
      claim: async () => ({ claimed: true, leaseId: 'lease-1' }),
      release: async () => {},
      isWakeConsumer: () => true,
      onWake: (listener) => {
        wake = listener
        return () => {}
      },
    })

    const goalId = await plans.start({
      goal: 'Inspect the origin workspace',
      horizon: 'long',
      scope: chat.memoryScope,
      workspaceRoot: 'goal-workspace',
      steps: [{ id: 'read', lane: 'coding', intent: 'Read notes', allowedTools: ['read'], expectedEvidence: [{ source: 'tool_result', description: 'file contents' }], riskLevel: 'low', approvalRequired: false }],
    }, 'origin-goal', { sessionId: originSessionId })
    expect(await scheduler.initialize()).toBe(true)

    wake?.({ goalId, wakeId: 'wake-1', reason: 'schedule', timestamp: Date.now() })
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce())

    expect(startFlow).toHaveBeenCalledWith(originSessionId, 'declared', expect.any(String))
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: originSessionId,
      planId: goalId,
    }))
    expect(plans.longPlans[0]?.sessionId).toBe(originSessionId)
    expect(plans.longPlans[0]?.state.longGoal?.lastRun?.sessionId).toBe(originSessionId)
    expect(send.mock.calls[0]?.[0]).not.toEqual(expect.objectContaining({ sessionId: leaderSelectionId }))
  })

  it('refreshes the host workspace before a scheduled wake', async () => {
    completeRestoreGate()
    const pinia = mountOwners()
    const sessions = useChatSessionStore(pinia)
    const sessionId = await sessions.createSession('default', { setActive: true })
    const chat = useChatStore(pinia)
    const plans = usePlanStore(pinia)
    const consciousness = useConsciousnessStore(pinia)
    consciousness.activeProvider = 'mock-provider'
    consciousness.activeModel = 'mock-model'

    let workspaceRoot = 'goal-workspace'
    installCodingHostClient({
      listDir: async () => ({ entries: [] }),
      readFile: async () => ({ content: '' }),
      listTools: async () => ({
        workspaceRoot,
        tools: [
          { name: 'read', description: 'Read files', available: true },
          { name: 'list', description: 'List files', available: true },
        ],
      }),
      runCommand: async () => ({ tier: 'read-only', status: 'ok', stdout: '', stderr: '' }),
      runProgram: async () => ({ ok: true, logs: [], traces: [] }),
      setApprovalMode: async () => {},
      setWorkspaceRoot: async ({ root }) => ({ status: 'switched', workspaceRoot: root }),
    })
    await useCodingToolsStore().refreshStatus()
    workspaceRoot = 'changed-workspace'

    const send = vi.spyOn(chat, 'send').mockResolvedValue({ messages: [], sessionId })
    const startFlow = vi.spyOn(chat, 'startFlow').mockResolvedValue({
      flowId: 'stale-root-flow',
      taskId: 'stale-root-task',
      sessionId,
      status: 'running',
      trigger: 'declared',
      startedAt: Date.now(),
      iteration: 0,
      totalToolCalls: 0,
      stalledTurns: 0,
    })
    let wake: ((payload: { goalId: string, wakeId: string, reason: 'schedule' | 'retry' | 'startup', timestamp: number }) => void) | undefined
    installLongGoalSchedulerPort({
      schedule: async () => {},
      unschedule: async () => {},
      claim: async () => ({ claimed: true, leaseId: 'lease-stale-root' }),
      release: async () => {},
      isWakeConsumer: () => true,
      onWake: (listener) => {
        wake = listener
        return () => {}
      },
    })

    const goalId = await plans.start({
      goal: 'Do not run on a stale workspace root',
      horizon: 'long',
      scope: chat.memoryScope,
      workspaceRoot: 'goal-workspace',
      steps: [{ id: 'read', lane: 'coding', intent: 'Read notes', allowedTools: ['read'], expectedEvidence: [{ source: 'tool_result', description: 'file contents' }], riskLevel: 'low', approvalRequired: false }],
    }, 'stale-root-goal', { sessionId })
    const scheduler = useLongGoalSchedulerStore(pinia)
    cleanup.push(() => scheduler.reset())
    expect(await scheduler.initialize()).toBe(true)

    wake?.({ goalId, wakeId: 'stale-root-wake', reason: 'schedule', timestamp: Date.now() })
    await vi.waitFor(() => expect(plans.longPlans[0]?.state.longGoal?.lifecycle).toBe('waiting-condition'))

    expect(startFlow).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
    expect(plans.longPlans[0]?.state.longGoal?.waitReason).toContain('workspace root')
  })

  it('interrupts the live Flow before revising its long-goal constraints', async () => {
    completeRestoreGate()
    const pinia = mountOwners()
    const sessions = useChatSessionStore(pinia)
    const sessionId = await sessions.createSession('default', { setActive: true })
    const chat = useChatStore(pinia)
    const plans = usePlanStore(pinia)
    const goalId = await plans.start({
      goal: 'Keep the old constraints from writing after a revision',
      horizon: 'long',
      scope: { userId: 'local', characterId: 'default' },
      workspaceRoot: 'goal-workspace',
      steps: [{ id: 'write', lane: 'coding', intent: 'Write the marker', allowedTools: ['write'], expectedEvidence: [{ source: 'tool_result', description: 'marker written' }], riskLevel: 'low', approvalRequired: false }],
    }, 'revision-live-goal', { sessionId })
    const flow = await chat.startFlow(sessionId, 'declared', 'old constraints')
    await plans.transitionLongGoal(goalId, {
      lifecycle: 'running',
      reason: 'scheduler claimed the run',
      source: 'scheduler',
      timestamp: 100,
      run: { taskId: flow.taskId, flowId: flow.flowId, sessionId, startedAt: 100 },
    })

    await plans.start({
      goal: 'Use the revised constraints',
      horizon: 'long',
      scope: { userId: 'local', characterId: 'default' },
      workspaceRoot: 'goal-workspace',
      steps: [{ id: 'write', lane: 'coding', intent: 'Write the revised marker', allowedTools: ['write'], expectedEvidence: [{ source: 'tool_result', description: 'revised marker written' }], riskLevel: 'low', approvalRequired: false }],
    })

    expect(chat.flowStates[sessionId]).toMatchObject({
      flowId: flow.flowId,
      taskId: flow.taskId,
      status: 'ended',
      endReason: 'interrupted',
    })
    expect(plans.longPlans[0]?.state.longGoal).toMatchObject({ lifecycle: 'executable', constraintVersion: 2 })
  })

  it('rebinds a persisted running goal after restart and settles its journal end', async () => {
    completeRestoreGate()
    const pinia = mountOwners()
    const sessions = useChatSessionStore(pinia)
    const sessionId = await sessions.createSession('default', { setActive: true })
    const chat = useChatStore(pinia)
    const plans = usePlanStore(pinia)
    const journal = useJournalStore(pinia)
    const consciousness = useConsciousnessStore(pinia)
    consciousness.activeProvider = 'mock-provider'
    consciousness.activeModel = 'mock-model'
    installCodingHostClient({
      listDir: async () => ({ entries: [] }),
      readFile: async () => ({ content: '' }),
      listTools: async () => ({
        workspaceRoot: 'goal-workspace',
        tools: [
          { name: 'read', description: 'Read files', available: true },
          { name: 'list', description: 'List files', available: true },
        ],
      }),
      runCommand: async () => ({ tier: 'read-only', status: 'ok', stdout: '', stderr: '' }),
      runProgram: async () => ({ ok: true, logs: [], traces: [] }),
      setApprovalMode: async () => {},
      setWorkspaceRoot: async ({ root }) => ({ status: 'switched', workspaceRoot: root }),
    })

    const goalId = await plans.start({
      goal: 'Recover the interrupted workspace run',
      horizon: 'long',
      scope: chat.memoryScope,
      workspaceRoot: 'goal-workspace',
      steps: [{ id: 'read', lane: 'coding', intent: 'Read notes', allowedTools: ['read'], expectedEvidence: [{ source: 'tool_result', description: 'file contents' }], riskLevel: 'low', approvalRequired: false }],
    }, 'recovery-goal', { sessionId })
    const run = { taskId: 'recovery-task', flowId: 'recovery-flow', sessionId, startedAt: 1000 }
    await plans.transitionLongGoal(goalId, {
      lifecycle: 'running',
      reason: 'scheduler claimed one bounded Flow run',
      source: 'scheduler',
      timestamp: 1000,
      run,
      environment: { providerId: 'mock-provider', modelId: 'mock-model', workspaceRoot: 'goal-workspace', toolNames: ['list', 'read'] },
    })
    journal.append(sessionId, {
      type: 'flow/start',
      flowId: run.flowId,
      taskId: run.taskId,
      trigger: 'declared',
      timestamp: run.startedAt,
    })

    const resume = vi.spyOn(chat, 'resumeFlowAfterRestart').mockImplementation(async (targetSessionId) => {
      journal.append(targetSessionId, {
        type: 'flow/end',
        flowId: run.flowId,
        taskId: run.taskId,
        reason: 'blocked',
        iterations: 1,
        timestamp: 2000,
        detail: 'recovered run stopped for the next scheduled review',
      })
      return true
    })
    installLongGoalSchedulerPort({
      schedule: async () => {},
      unschedule: async () => {},
      claim: async () => ({ claimed: false }),
      release: async () => {},
      isWakeConsumer: () => true,
      onWake: () => () => {},
    })

    const scheduler = useLongGoalSchedulerStore(pinia)
    cleanup.push(() => scheduler.reset())
    expect(await scheduler.initialize()).toBe(true)

    await vi.waitFor(() => expect(resume).toHaveBeenCalledWith(sessionId))
    await vi.waitFor(() => expect(plans.longPlans[0]?.state.longGoal).toMatchObject({
      lifecycle: 'waiting-condition',
      lastRun: { taskId: run.taskId, flowId: run.flowId, outcome: 'blocked' },
    }))
    await vi.waitFor(() => expect(scheduler.runningGoalId).toBeUndefined())
  })

  it('defers a busy wake without claiming a lease, then backs off in steps', async () => {
    // ROOT CAUSE (ACC-20260909):
    //
    // Two live goals alternately claimed wakes and deferred each other at a
    // fixed five-minute cadence, writing a waiting-condition goal/update on
    // every deferral. A goal blocked only by the busy slot now keeps its
    // main-process retry schedule instead of burning a lease: one journal
    // transition on entry, schedule-only extensions afterwards, on a
    // backoff ladder.
    completeRestoreGate()
    const pinia = mountOwners()
    const sessions = useChatSessionStore(pinia)
    const sessionId = await sessions.createSession('default', { setActive: true })
    const chat = useChatStore(pinia)
    const plans = usePlanStore(pinia)
    const journal = useJournalStore(pinia)
    const claim = vi.fn(async () => ({ claimed: true, leaseId: 'lease' }))
    const schedule = vi.fn(async (_input: { goalId: string, nextReviewAt: number }) => {})
    let wake: ((payload: { goalId: string, wakeId: string, reason: 'schedule' | 'retry' | 'startup', timestamp: number }) => void) | undefined
    installLongGoalSchedulerPort({
      schedule,
      unschedule: async () => {},
      claim,
      release: async () => {},
      isWakeConsumer: () => true,
      onWake: (listener) => {
        wake = listener
        return () => {}
      },
    })

    const goalId = await plans.start({
      goal: 'Wait behind the running goal',
      horizon: 'long',
      scope: { userId: 'local', characterId: 'default' },
      workspaceRoot: 'goal-workspace',
      steps: [{ id: 'read', lane: 'coding', intent: 'Read notes', allowedTools: ['read'], expectedEvidence: [{ source: 'tool_result', description: 'file contents' }], riskLevel: 'low', approvalRequired: false }],
    }, 'busy-goal', { sessionId })
    const scheduler = useLongGoalSchedulerStore(pinia)
    cleanup.push(() => scheduler.reset())
    expect(await scheduler.initialize()).toBe(true)
    schedule.mockClear()

    await chat.startFlow(sessionId, 'command')

    const firstAt = Date.now()
    wake?.({ goalId, wakeId: 'w1', reason: 'schedule', timestamp: firstAt })
    await vi.waitFor(() => expect(schedule).toHaveBeenCalledTimes(1))
    expect(claim).not.toHaveBeenCalled()
    expect(journal.snapshotSession(sessionId).filter(event => event.type === 'goal/update' && event.lifecycle === 'waiting-condition')).toHaveLength(1)
    const [firstWrite] = schedule.mock.calls[0]!
    expect(firstWrite.nextReviewAt - firstAt).toBeGreaterThanOrEqual(5 * 60_000)

    const secondAt = Date.now()
    wake?.({ goalId, wakeId: 'w2', reason: 'retry', timestamp: secondAt })
    await vi.waitFor(() => expect(schedule).toHaveBeenCalledTimes(2))
    expect(claim).not.toHaveBeenCalled()
    expect(journal.snapshotSession(sessionId).filter(event => event.type === 'goal/update' && event.lifecycle === 'waiting-condition')).toHaveLength(1)
    const [secondWrite] = schedule.mock.calls[1]!
    expect(secondWrite.nextReviewAt - secondAt).toBeGreaterThanOrEqual(10 * 60_000)
  })

  it('stops queuing and asks the user after hours on the busy slot', async () => {
    completeRestoreGate()
    const pinia = mountOwners()
    const sessions = useChatSessionStore(pinia)
    const sessionId = await sessions.createSession('default', { setActive: true })
    const chat = useChatStore(pinia)
    const plans = usePlanStore(pinia)
    const claim = vi.fn(async () => ({ claimed: true, leaseId: 'lease' }))
    let wake: ((payload: { goalId: string, wakeId: string, reason: 'schedule' | 'retry' | 'startup', timestamp: number }) => void) | undefined
    installLongGoalSchedulerPort({
      schedule: async () => {},
      unschedule: async () => {},
      claim,
      release: async () => {},
      isWakeConsumer: () => true,
      onWake: (listener) => {
        wake = listener
        return () => {}
      },
    })

    const goalId = await plans.start({
      goal: 'Queue behind the running goal for hours',
      horizon: 'long',
      scope: { userId: 'local', characterId: 'default' },
      workspaceRoot: 'goal-workspace',
      steps: [{ id: 'read', lane: 'coding', intent: 'Read notes', allowedTools: ['read'], expectedEvidence: [{ source: 'tool_result', description: 'file contents' }], riskLevel: 'low', approvalRequired: false }],
    }, 'hours-goal', { sessionId })
    const scheduler = useLongGoalSchedulerStore(pinia)
    cleanup.push(() => scheduler.reset())
    expect(await scheduler.initialize()).toBe(true)

    await chat.startFlow(sessionId, 'command')

    wake?.({ goalId, wakeId: 'w1', reason: 'schedule', timestamp: Date.now() })
    await vi.waitFor(() => expect(plans.longPlans[0]?.state.longGoal?.lifecycle).toBe('waiting-condition'))

    // Three hours pass on the busy slot: the goal must stop thrashing and
    // surface the decision instead of queueing forever.
    vi.useFakeTimers()
    try {
      vi.setSystemTime(Date.now() + 3 * 60 * 60_000)
      wake?.({ goalId, wakeId: 'w2', reason: 'retry', timestamp: Date.now() })
      await vi.waitFor(() => expect(plans.longPlans[0]?.state.longGoal?.lifecycle).toBe('waiting-user'))
      expect(plans.longPlans[0]?.state.longGoal?.pendingQuestion?.question).toContain('single Flow slot')
      expect(claim).not.toHaveBeenCalled()
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('answers the queue-depth question: keep waiting, pause, or cancel', async () => {
    // R4: the raised question must be actionable from the goal card, or the
    // goal queues forever behind a message nothing can clear.
    completeRestoreGate()
    const pinia = mountOwners()
    const sessions = useChatSessionStore(pinia)
    const sessionId = await sessions.createSession('default', { setActive: true })
    const plans = usePlanStore(pinia)
    installLongGoalSchedulerPort({
      schedule: async () => {},
      unschedule: async () => {},
      claim: async () => ({ claimed: false }),
      release: async () => {},
    })
    const goalId = await plans.start({
      goal: 'Answer the queue question',
      horizon: 'long',
      scope: { userId: 'local', characterId: 'default' },
      workspaceRoot: 'goal-workspace',
      steps: [{ id: 'read', lane: 'coding', intent: 'Read notes', allowedTools: ['read'], expectedEvidence: [{ source: 'tool_result', description: 'file contents' }], riskLevel: 'low', approvalRequired: false }],
    }, 'answer-goal', { sessionId })
    const scheduler = useLongGoalSchedulerStore(pinia)
    cleanup.push(() => scheduler.reset())
    await plans.transitionLongGoal(goalId, {
      lifecycle: 'waiting-user',
      reason: 'this goal kept waiting for the Flow slot',
      source: 'scheduler',
      timestamp: Date.now(),
      pendingQuestion: {
        requestId: 'q1',
        question: 'Keep it queued, pause it, or cancel it from this card.',
        choices: ['keep waiting', 'pause', 'cancel'],
        askedAt: Date.now(),
      },
    })

    await scheduler.answerPendingQuestion(goalId, 'keep-waiting')
    expect(plans.longPlans[0]?.state.longGoal?.lifecycle).toBe('waiting-condition')
    expect(plans.longPlans[0]?.state.longGoal?.pendingQuestion).toBeUndefined()

    await plans.transitionLongGoal(goalId, {
      lifecycle: 'waiting-user',
      reason: 'still queued',
      source: 'scheduler',
      timestamp: Date.now(),
      pendingQuestion: { requestId: 'q2', question: 'Keep it queued, pause it, or cancel it from this card.', askedAt: Date.now() },
    })
    await scheduler.answerPendingQuestion(goalId, 'pause')
    expect(plans.longPlans[0]?.state.longGoal?.lifecycle).toBe('paused')

    await plans.resumePlan(goalId)
    await plans.transitionLongGoal(goalId, {
      lifecycle: 'waiting-user',
      reason: 'still queued again',
      source: 'scheduler',
      timestamp: Date.now(),
      pendingQuestion: { requestId: 'q3', question: 'Keep it queued, pause it, or cancel it from this card.', askedAt: Date.now() },
    })
    await scheduler.answerPendingQuestion(goalId, 'cancel')
    expect(plans.longPlans[0]?.state.longGoal?.lifecycle).toBe('cancelled')
  })

  it('serializes wake dispatch: a second goal waits for the running one', async () => {
    completeRestoreGate()
    const pinia = mountOwners()
    const sessions = useChatSessionStore(pinia)
    const sessionId = await sessions.createSession('default', { setActive: true })
    const chat = useChatStore(pinia)
    const plans = usePlanStore(pinia)
    const consciousness = useConsciousnessStore(pinia)
    consciousness.activeProvider = 'mock-provider'
    consciousness.activeModel = 'mock-model'
    installCodingHostClient({
      listDir: async () => ({ entries: [] }),
      readFile: async () => ({ content: '' }),
      listTools: async () => ({
        workspaceRoot: 'goal-workspace',
        tools: [
          { name: 'read', description: 'Read files', available: true },
          { name: 'list', description: 'List files', available: true },
        ],
      }),
      runCommand: async () => ({ tier: 'read-only', status: 'ok', stdout: '', stderr: '' }),
      runProgram: async () => ({ ok: true, logs: [], traces: [] }),
      setApprovalMode: async () => {},
      setWorkspaceRoot: async ({ root }) => ({ status: 'switched', workspaceRoot: root }),
    })

    const claim = vi.fn(async ({ goalId }: { goalId: string }) => ({ claimed: true, leaseId: `lease-${goalId}` }))
    const release = vi.fn(async () => {})
    let wake: ((payload: { goalId: string, wakeId: string, reason: 'schedule' | 'retry' | 'startup', timestamp: number }) => void) | undefined
    installLongGoalSchedulerPort({
      schedule: async () => {},
      unschedule: async () => {},
      claim,
      release,
      isWakeConsumer: () => true,
      onWake: (listener) => {
        wake = listener
        return () => {}
      },
    })

    const firstGoalId = await plans.start({
      goal: 'Hold the slot',
      horizon: 'long',
      scope: { userId: 'local', characterId: 'default' },
      workspaceRoot: 'goal-workspace',
      steps: [{ id: 'read', lane: 'coding', intent: 'Read notes', allowedTools: ['read'], expectedEvidence: [{ source: 'tool_result', description: 'file contents' }], riskLevel: 'low', approvalRequired: false }],
    }, 'slot-goal-a', { sessionId })
    const secondGoalId = await plans.start({
      goal: 'Wait for the slot',
      horizon: 'long',
      scope: { userId: 'local', characterId: 'default' },
      workspaceRoot: 'goal-workspace',
      steps: [{ id: 'read', lane: 'coding', intent: 'Read notes', allowedTools: ['read'], expectedEvidence: [{ source: 'tool_result', description: 'file contents' }], riskLevel: 'low', approvalRequired: false }],
    }, 'slot-goal-b', { sessionId })

    // The first goal's run stays in flight; the real startFlow marks the
    // session flow running, which the second goal's pre-claim check sees.
    let releaseRun: (() => void) = () => {}
    const runGate = new Promise<{ messages: never[], sessionId: string }>((resolve) => {
      releaseRun = () => resolve({ messages: [], sessionId })
    })
    vi.spyOn(chat, 'send').mockImplementation((payload: { planId?: string, sessionId: string }) =>
      payload.planId === firstGoalId
        ? runGate as never
        : Promise.resolve({ messages: [], sessionId }))

    const scheduler = useLongGoalSchedulerStore(pinia)
    cleanup.push(() => scheduler.reset())
    expect(await scheduler.initialize()).toBe(true)

    wake?.({ goalId: firstGoalId, wakeId: 'a1', reason: 'schedule', timestamp: Date.now() })
    await vi.waitFor(() => expect(claim).toHaveBeenCalledTimes(1))

    // The second wake queues behind the in-flight run: no lease is burned
    // while the slot is held.
    wake?.({ goalId: secondGoalId, wakeId: 'b1', reason: 'schedule', timestamp: Date.now() })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(claim).toHaveBeenCalledTimes(1)

    releaseRun()
    await chat.endFlow(sessionId, 'interrupted', 'test teardown')
    await new Promise(resolve => setTimeout(resolve, 50))

    wake?.({ goalId: secondGoalId, wakeId: 'b2', reason: 'retry', timestamp: Date.now() })
    await vi.waitFor(() => expect(claim).toHaveBeenCalledTimes(2))
    expect(claim.mock.calls.map(call => call[0]?.goalId)).toEqual([firstGoalId, secondGoalId])
  })
})
