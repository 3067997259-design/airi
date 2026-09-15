import type { JournalEvent, TaskRun, TaskRunActivity, TaskRunStatus } from './types'

/**
 * Prefix of task ids synthesized for journals written before task stamps
 * existed. Runtime ids never contain a colon, so the two id spaces cannot
 * collide and a legacy run can never be resumed under a minted identity.
 */
const LEGACY_TASK_ID_PREFIX = 'legacy:'

const TITLE_MAX_LENGTH = 80
const TASK_ACTIVITY_LIMIT = 40
const ACTIVITY_TEXT_LIMIT = 200

function truncateTitle(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  return collapsed.length > TITLE_MAX_LENGTH ? `${collapsed.slice(0, TITLE_MAX_LENGTH - 1)}…` : collapsed
}

function truncateActivityText(text: string, limit = ACTIVITY_TEXT_LIMIT): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  return collapsed.length > limit ? `${collapsed.slice(0, limit - 1)}…` : collapsed
}

function serializeArguments(args: unknown): string {
  if (typeof args === 'string')
    return truncateActivityText(args, 80)

  const serialized = JSON.stringify(args)
  return truncateActivityText(serialized ?? String(args), 80)
}

const FLOW_END_STATUSES: Record<string, TaskRunStatus> = {
  'done': 'completed',
  'blocked': 'blocked',
  'interrupted': 'interrupted',
  'budget': 'budget',
  'no-progress': 'no-progress',
}

interface DraftTaskRun extends TaskRun {
  /** Question requestIds already answered; answers arrive after the question. */
  answeredRequests: Set<string>
  /** Open question requestIds in arrival order, for the pending question text. */
  openQuestions: Map<string, string>
}

function eventTimestamp(event: JournalEvent): number {
  return 'timestamp' in event && typeof event.timestamp === 'number' ? event.timestamp : 0
}

function taskForStamp(drafts: Map<string, DraftTaskRun>, taskId: string, event: JournalEvent): DraftTaskRun | undefined {
  const existing = drafts.get(taskId)
  if (existing)
    return existing

  // A stamp without a flow/start can only come from a truncated replay, so
  // the task is opened best-effort at the first attributed event.
  const created: DraftTaskRun = {
    taskId,
    sessionId: '',
    planIds: [],
    title: 'Task',
    status: 'running',
    startedAt: eventTimestamp(event),
    updatedAt: eventTimestamp(event),
    activity: [],
    answeredRequests: new Set(),
    openQuestions: new Map(),
  }
  drafts.set(taskId, created)
  return created
}

function resolveTitle(events: JournalEvent[], flowStartIndex: number, triggerDetail?: string): string {
  // The chat store writes flow/start before the command's user/message. Search
  // the open flow window first, then use the preceding message for tool- or
  // legacy-triggered flows that have no new user text.
  for (let index = flowStartIndex + 1; index < events.length; index++) {
    const event = events[index]!
    if (event.type === 'flow/start' || event.type === 'flow/end')
      break
    if (event.type === 'user/message' && event.text.trim())
      return truncateTitle(event.text)
  }
  for (let index = flowStartIndex - 1; index >= 0; index--) {
    const event = events[index]!
    if (event.type === 'user/message' && event.text.trim()) {
      return truncateTitle(event.text)
    }
  }
  if (triggerDetail?.trim())
    return truncateTitle(triggerDetail)
  return 'Task'
}

/**
 * Derives the task runs of one session's journal.
 *
 * Tasks are attributed strictly by stamps: `flow/start` opens a task with the
 * runtime-minted `taskId`, and later events join the task whose stamp they
 * carry — never by scanning time windows. Steering text and plan activity
 * without a stamp update nothing. Journals written before stamps existed get
 * one display-only projection per flow id, marked `legacy`.
 *
 * @example
 * deriveTaskRuns([
 *   { type: 'flow/start', seq: 1, flowId: 'f1', taskId: 't1', trigger: 'command', timestamp: 10 },
 *   { type: 'flow/end', seq: 2, flowId: 'f1', taskId: 't1', reason: 'done', iterations: 3, timestamp: 20 },
 * ])
 * // => [{ taskId: 't1', flowId: 'f1', status: 'completed', ... }]
 */
export function deriveTaskRuns(events: JournalEvent[]): TaskRun[] {
  const drafts = new Map<string, DraftTaskRun>()
  const legacyDrafts = new Map<string, DraftTaskRun>()
  const activeFlowTasks = new Map<string, DraftTaskRun>()
  const header = events.find((event): event is Extract<JournalEvent, { type: 'session/header' }> => event.type === 'session/header')
  const sessionId = header?.sessionId ?? ''

  const touch = (draft: DraftTaskRun, event: JournalEvent): void => {
    draft.updatedAt = Math.max(draft.updatedAt, eventTimestamp(event))
  }

  events.forEach((event, index) => {
    if (event.type === 'flow/start') {
      if (event.taskId) {
        // One session runs one flow at a time. A new start while an older
        // stamped task of this session is still "running" means that run's
        // flow/end never reached the journal — a persistence gap killed the
        // app mid-flow (ACC-20260909). Close the orphan at the replacement
        // point instead of leaving a row whose stop control has no flow to
        // stop.
        for (const draft of drafts.values()) {
          if (draft.taskId !== event.taskId && draft.status === 'running') {
            draft.status = 'interrupted'
            draft.endDetail = 'its flow/end was never journaled; a newer flow started in this session'
          }
        }
        const draft = taskForStamp(drafts, event.taskId, event)
        if (!draft)
          return
        draft.sessionId = sessionId
        draft.flowId = event.flowId
        draft.startedAt = event.timestamp
        draft.updatedAt = event.timestamp
        draft.title = resolveTitle(events, index, event.triggerDetail)
        draft.status = 'running'
        activeFlowTasks.set(event.flowId, draft)
      }
      else {
        // Legacy flow: a display-only projection keyed by the flow id, never
        // resumed. Its window events that carry only a flow id still update it.
        const taskId = `${LEGACY_TASK_ID_PREFIX}${event.flowId}`
        let draft = legacyDrafts.get(taskId)
        if (!draft) {
          draft = {
            taskId,
            sessionId,
            flowId: event.flowId,
            planIds: [],
            title: resolveTitle(events, index, event.triggerDetail),
            status: 'running',
            startedAt: event.timestamp,
            updatedAt: event.timestamp,
            activity: [],
            legacy: true,
            answeredRequests: new Set(),
            openQuestions: new Map(),
          }
          legacyDrafts.set(taskId, draft)
        }
        activeFlowTasks.set(event.flowId, draft)
      }
      return
    }

    const stampTask = (): DraftTaskRun | undefined => {
      if (!('taskId' in event) || !event.taskId)
        return undefined
      const draft = taskForStamp(drafts, event.taskId, event)
      if (draft)
        touch(draft, event)
      return draft
    }
    const legacyTask = (): DraftTaskRun | undefined => {
      if (!('flowId' in event) || !event.flowId)
        return undefined
      if ('taskId' in event && event.taskId)
        return undefined
      const draft = legacyDrafts.get(`${LEGACY_TASK_ID_PREFIX}${event.flowId}`)
      if (draft)
        touch(draft, event)
      return draft
    }

    const activeTask = (): DraftTaskRun | undefined => {
      if (activeFlowTasks.size !== 1)
        return undefined
      return activeFlowTasks.values().next().value as DraftTaskRun | undefined
    }

    const appendActivity = (draft: DraftTaskRun, activity: TaskRunActivity): void => {
      draft.activity.push(activity)
      if (draft.activity.length > TASK_ACTIVITY_LIMIT)
        draft.activity.shift()
    }

    switch (event.type) {
      case 'flow/step': {
        const draft = stampTask() ?? legacyTask()
        if (draft)
          draft.currentIteration = event.iteration
        break
      }
      case 'flow/end': {
        const draft = stampTask() ?? legacyTask()
        if (draft) {
          draft.status = FLOW_END_STATUSES[event.reason] ?? 'interrupted'
          draft.endDetail = event.detail
        }
        activeFlowTasks.delete(event.flowId)
        break
      }
      case 'user/steering': {
        // Steering belongs to the task it interrupted but must never open one.
        const draft = stampTask() ?? legacyTask()
        if (draft) {
          appendActivity(draft, {
            kind: 'steering',
            seq: event.seq,
            text: truncateActivityText(event.text, 160),
          })
        }
        break
      }
      case 'plan/update': {
        if (!event.taskId)
          break
        const draft = stampTask()
        if (!draft)
          break
        if (event.planId && !draft.planIds.includes(event.planId))
          draft.planIds.push(event.planId)
        if (event.stepId)
          draft.currentStepId = event.stepId
        appendActivity(draft, {
          kind: 'plan-update',
          seq: event.seq,
          ...(event.planId ? { planId: event.planId } : {}),
          ...(event.stepId ? { stepId: event.stepId } : {}),
          ...(event.status ? { status: event.status } : {}),
          ...(event.unverified ? { unverified: true } : {}),
        })
        break
      }
      case 'tool/call': {
        const draft = stampTask()
        if (!draft)
          break
        if (event.planId && !draft.planIds.includes(event.planId))
          draft.planIds.push(event.planId)
        appendActivity(draft, {
          kind: 'tool-call',
          seq: event.seq,
          toolName: event.toolName,
          args: serializeArguments(event.args),
        })
        break
      }
      case 'tool/result': {
        const draft = stampTask()
        if (!draft)
          break
        if (event.planId && !draft.planIds.includes(event.planId))
          draft.planIds.push(event.planId)
        // A revoked receipt is an invalid receipt, not a task failure; it
        // still appears as an activity row so the withdrawal stays visible.
        if (event.type === 'tool/result' && event.outcome !== 'revoked' && (!event.ok || event.outcome === 'failed' || event.outcome === 'timeout'))
          draft.lastFailure = `${event.toolName}: ${String(event.summary).slice(0, 200)}`
        appendActivity(draft, {
          kind: 'tool-result',
          seq: event.seq,
          toolName: event.toolName,
          ok: event.ok,
          ...(event.outcome ? { outcome: event.outcome } : {}),
          summary: truncateActivityText(event.summary, 120),
        })
        break
      }
      case 'user/asked': {
        if (!event.taskId)
          break
        const draft = stampTask()
        if (!draft)
          break
        draft.openQuestions.set(event.requestId, event.question)
        draft.pendingQuestion = event.question.slice(0, 200)
        break
      }
      case 'user/answered': {
        if (!event.taskId)
          break
        const draft = stampTask()
        if (!draft)
          break
        draft.answeredRequests.add(event.requestId)
        if (draft.openQuestions.delete(event.requestId) && draft.openQuestions.size === 0)
          draft.pendingQuestion = undefined
        break
      }
      case 'assistant/chunk': {
        const draft = activeTask()
        if (draft) {
          appendActivity(draft, {
            kind: 'narration',
            seq: event.seq,
            text: truncateActivityText(event.text),
          })
        }
        break
      }
      case 'flow/completion-review': {
        const draft = stampTask()
        if (draft) {
          appendActivity(draft, {
            kind: 'completion-review',
            seq: event.seq,
            layer: event.layer,
            verdict: event.verdict,
            ...(event.blockers?.length ? { blockers: [truncateActivityText(event.blockers[0]!, 200)] } : {}),
          })
        }
        break
      }
      default:
        break
    }
  })

  const finalize = (draft: DraftTaskRun): TaskRun => {
    return {
      taskId: draft.taskId,
      ...(draft.sessionId ? { sessionId: draft.sessionId } : { sessionId: '' }),
      ...(draft.flowId ? { flowId: draft.flowId } : {}),
      planIds: draft.planIds,
      title: draft.title,
      status: draft.status === 'running' && draft.openQuestions.size > 0 ? 'waiting-user' : draft.status,
      startedAt: draft.startedAt,
      updatedAt: draft.updatedAt,
      activity: draft.activity,
      ...(draft.currentIteration !== undefined ? { currentIteration: draft.currentIteration } : {}),
      ...(draft.currentStepId ? { currentStepId: draft.currentStepId } : {}),
      ...(draft.pendingQuestion ? { pendingQuestion: draft.pendingQuestion } : {}),
      ...(draft.lastFailure ? { lastFailure: draft.lastFailure } : {}),
      ...(draft.endDetail ? { endDetail: draft.endDetail } : {}),
      ...(draft.legacy ? { legacy: true } : {}),
    }
  }

  const ordered = [...drafts.values(), ...legacyDrafts.values()]
  return ordered.map(finalize)
}

/**
 * Returns the task id of the session's currently open flow, for writers that
 * must stamp events as they happen (plan updates, tool results). A flow that
 * has ended, and a legacy flow/start without a stamp, attribute nothing.
 *
 * @example
 * openTaskId([{ type: 'flow/start', seq: 1, flowId: 'f1', taskId: 't1', trigger: 'tool', timestamp: 1 }])
 * // => 't1'
 */
export function openTaskId(events: JournalEvent[]): string | undefined {
  const startIndex = events.findLastIndex(event => event.type === 'flow/start')
  if (startIndex < 0)
    return undefined
  const start = events[startIndex] as Extract<JournalEvent, { type: 'flow/start' }>
  if (!start.taskId)
    return undefined
  const stillOpen = !events.slice(startIndex + 1).some(event => event.type === 'flow/end')
  return stillOpen ? start.taskId : undefined
}
