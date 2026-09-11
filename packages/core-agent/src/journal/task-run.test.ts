import type { JournalEvent } from './types'

import { describe, expect, it } from 'vitest'

import { deriveTaskRuns, openTaskId } from './task-run'

const header: JournalEvent = { type: 'session/header', seq: 0, sessionId: 's1', createdAt: 1, delegationDepth: 0 }

function stampedFlowEvents(): JournalEvent[] {
  return [
    header,
    { type: 'user/message', seq: 1, text: 'Fix the flaky login test', timestamp: 10 },
    { type: 'flow/start', seq: 2, flowId: 'f1', taskId: 't1', trigger: 'tool', triggerDetail: 'bash', timestamp: 20 },
    { type: 'flow/step', seq: 3, flowId: 'f1', taskId: 't1', iteration: 1, reason: 'continue' },
    { type: 'assistant/chunk', seq: 4, text: 'I will inspect the test first.' },
    { type: 'tool/call', seq: 5, toolName: 'edit', args: {}, taskId: 't1', planId: 'p1' },
    { type: 'tool/result', seq: 6, toolName: 'edit', ok: true, outcome: 'ok', summary: 'applied', taskId: 't1', planId: 'p1' },
    { type: 'plan/update', seq: 7, planId: 'p1', stepId: 'step-1', status: 'completed', taskId: 't1' },
    { type: 'flow/step', seq: 8, flowId: 'f1', taskId: 't1', iteration: 2, reason: 'continue' },
    { type: 'tool/result', seq: 9, toolName: 'bash', ok: false, outcome: 'failed', summary: 'exit 1', taskId: 't1' },
    { type: 'flow/end', seq: 10, flowId: 'f1', taskId: 't1', reason: 'done', iterations: 2, timestamp: 90, detail: 'verified by test run' },
  ]
}

describe('deriveTaskRuns', () => {
  it('derives one task per flow with a stable identity across all iterations', () => {
    const tasks = deriveTaskRuns(stampedFlowEvents())
    expect(tasks).toHaveLength(1)
    const task = tasks[0]!
    expect(task.taskId).toBe('t1')
    expect(task.flowId).toBe('f1')
    expect(task.sessionId).toBe('s1')
    expect(task.status).toBe('completed')
    expect(task.currentIteration).toBe(2)
    expect(task.planIds).toEqual(['p1'])
    expect(task.currentStepId).toBe('step-1')
    expect(task.lastFailure).toBe('bash: exit 1')
    expect(task.endDetail).toBe('verified by test run')
    expect(task.activity.map(activity => activity.kind)).toEqual([
      'narration',
      'tool-call',
      'tool-result',
      'plan-update',
      'tool-result',
    ])
    expect(task.activity[0]).toMatchObject({ kind: 'narration', text: 'I will inspect the test first.' })
    expect(task.legacy).toBeUndefined()
  })

  it('titles the task from the nearest user message, not the trigger detail', () => {
    const tasks = deriveTaskRuns(stampedFlowEvents())
    expect(tasks[0]!.title).toBe('Fix the flaky login test')
  })

  it('uses the command message that follows flow start as the task title', () => {
    // ROOT CAUSE:
    //
    // The chat store writes flow/start before it writes the command's user/message.
    // Looking only before flow/start selects the previous turn's text.
    //
    // We fixed this by checking the first user message after flow/start before
    // falling back to the preceding message or the trigger detail.
    const tasks = deriveTaskRuns([
      header,
      { type: 'user/message', seq: 1, text: 'Previous provider probe', timestamp: 5 },
      { type: 'flow/start', seq: 2, flowId: 'f1', taskId: 't1', trigger: 'command', triggerDetail: 'read', timestamp: 6 },
      { type: 'user/message', seq: 3, text: 'Read the project guide', timestamp: 7 },
    ])
    expect(tasks[0]!.title).toBe('Read the project guide')
  })

  it('falls back through trigger detail to a placeholder title', () => {
    const tasks = deriveTaskRuns([
      header,
      { type: 'flow/start', seq: 1, flowId: 'f1', taskId: 't1', trigger: 'tool', triggerDetail: 'write', timestamp: 5 },
      { type: 'flow/end', seq: 2, flowId: 'f1', taskId: 't1', reason: 'blocked', iterations: 1, timestamp: 8 },
    ])
    expect(tasks[0]!.title).toBe('write')
    expect(tasks[0]!.status).toBe('blocked')

    const withoutDetail = deriveTaskRuns([
      header,
      { type: 'flow/start', seq: 1, flowId: 'f2', taskId: 't2', trigger: 'tool', timestamp: 5 },
    ])
    expect(withoutDetail[0]!.title).toBe('Task')
    expect(withoutDetail[0]!.status).toBe('running')
  })

  it('never lets steering open a task', () => {
    const tasks = deriveTaskRuns([
      header,
      { type: 'flow/start', seq: 1, flowId: 'f1', taskId: 't1', trigger: 'tool', timestamp: 5 },
      { type: 'user/steering', seq: 2, text: 'also update the docs', flowId: 'f1', taskId: 't1', timestamp: 6 },
      { type: 'user/steering', seq: 3, text: 'unattributed steering', flowId: 'f1', timestamp: 7 },
    ])
    expect(tasks).toHaveLength(1)
    expect(tasks[0]!.taskId).toBe('t1')
  })

  it('marks an open user question as waiting-user and clears it on answer', () => {
    const withQuestionEvents: JournalEvent[] = [
      header,
      { type: 'flow/start', seq: 1, flowId: 'f1', taskId: 't1', trigger: 'tool', timestamp: 5 },
      { type: 'user/asked', seq: 2, requestId: 'q1', question: 'Which branch?', source: 'user_ask', taskId: 't1' },
    ]
    const withQuestion = deriveTaskRuns(withQuestionEvents)
    expect(withQuestion[0]!.status).toBe('waiting-user')
    expect(withQuestion[0]!.pendingQuestion).toBe('Which branch?')

    const answeredEvents: JournalEvent[] = [
      header,
      { type: 'flow/start', seq: 1, flowId: 'f1', taskId: 't1', trigger: 'tool', timestamp: 5 },
      { type: 'user/asked', seq: 2, requestId: 'q1', question: 'Which branch?', source: 'user_ask', taskId: 't1' },
      { type: 'user/answered', seq: 3, requestId: 'q1', answer: 'main', channel: 'text', source: 'user_ask', taskId: 't1' },
    ]
    const answered = deriveTaskRuns(answeredEvents)
    expect(answered[0]!.status).toBe('running')
    expect(answered[0]!.pendingQuestion).toBeUndefined()
  })

  it('closes a still-running task when a newer flow starts in the same session', () => {
    // ROOT CAUSE:
    //
    // ACC-20260909: the journal mirror went silent for twenty minutes while
    // the app kept running, and the flow stopped in that window never wrote
    // its flow/end. The task row stayed "running" forever with a stop button
    // that no longer had a flow to stop. One session runs one flow at a
    // time, so a newer flow/start proves the older run ended; the projection
    // closes it as interrupted instead of leaving a ghost row behind.
    const tasks = deriveTaskRuns([
      header,
      { type: 'user/message', seq: 1, text: 'First goal', timestamp: 10 },
      { type: 'flow/start', seq: 2, flowId: 'f1', taskId: 't1', trigger: 'command', timestamp: 20 },
      { type: 'flow/step', seq: 3, flowId: 'f1', taskId: 't1', iteration: 10, reason: 'continue' },
      { type: 'user/message', seq: 4, text: 'Second goal', timestamp: 30 },
      { type: 'flow/start', seq: 5, flowId: 'f2', taskId: 't2', trigger: 'command', timestamp: 40 },
      { type: 'flow/end', seq: 6, flowId: 'f2', taskId: 't2', reason: 'done', iterations: 2, timestamp: 50 },
    ])
    const ghost = tasks.find(task => task.taskId === 't1')
    expect(ghost?.status).toBe('interrupted')
    expect(ghost?.currentIteration).toBe(10)
    expect(ghost?.endDetail).toContain('flow/end')
    expect(tasks.find(task => task.taskId === 't2')?.status).toBe('completed')
  })

  it('maps every terminal flow reason to its own status', () => {
    const reasons = ['done', 'blocked', 'interrupted', 'budget', 'no-progress'] as const
    const statuses = reasons.map((reason) => {
      const events: JournalEvent[] = [
        header,
        { type: 'flow/start', seq: 1, flowId: 'f1', taskId: 't1', trigger: 'tool', timestamp: 5 },
        { type: 'flow/end', seq: 2, flowId: 'f1', taskId: 't1', reason, iterations: 1, timestamp: 8 },
      ]
      const [task] = deriveTaskRuns(events)
      return task!.status
    })
    expect(statuses).toEqual(['completed', 'blocked', 'interrupted', 'budget', 'no-progress'])
  })

  it('projects legacy flows without task stamps as one non-resumable run per flow id', () => {
    const tasks = deriveTaskRuns([
      header,
      { type: 'user/message', seq: 1, text: 'Old task', timestamp: 5 },
      { type: 'flow/start', seq: 2, flowId: 'f-old', trigger: 'tool', timestamp: 6 },
      { type: 'flow/step', seq: 3, flowId: 'f-old', iteration: 3, reason: 'continue' },
      { type: 'flow/end', seq: 4, flowId: 'f-old', reason: 'budget', iterations: 3, timestamp: 40 },
      { type: 'flow/start', seq: 5, flowId: 'f-old-2', trigger: 'tool', timestamp: 50 },
    ])
    expect(tasks).toHaveLength(2)
    expect(tasks[0]).toMatchObject({
      taskId: 'legacy:f-old',
      flowId: 'f-old',
      legacy: true,
      status: 'budget',
      currentIteration: 3,
      title: 'Old task',
    })
    expect(tasks[1]!.legacy).toBe(true)
  })

  it('ignores unattributed plan activity', () => {
    const tasks = deriveTaskRuns([
      header,
      { type: 'plan/update', seq: 1, planId: 'p9', stepId: 'step-1', status: 'in_progress' },
    ])
    expect(tasks).toHaveLength(0)
  })

  it('keeps activity bounded and isolates each task window', () => {
    const firstTaskResults = Array.from({ length: 45 }, (_, index): JournalEvent => ({
      type: 'tool/result',
      seq: index + 3,
      toolName: 'read',
      ok: true,
      outcome: 'ok',
      summary: `first-${index}`,
      taskId: 't1',
    }))
    const tasks = deriveTaskRuns([
      header,
      { type: 'flow/start', seq: 1, flowId: 'f1', taskId: 't1', trigger: 'tool', timestamp: 1 },
      { type: 'tool/call', seq: 2, toolName: 'read', args: { path: 'first' }, taskId: 't1' },
      ...firstTaskResults,
      { type: 'flow/end', seq: 48, flowId: 'f1', taskId: 't1', reason: 'done', iterations: 1, timestamp: 48 },
      { type: 'flow/start', seq: 49, flowId: 'f2', taskId: 't2', trigger: 'tool', timestamp: 49 },
      { type: 'tool/result', seq: 50, toolName: 'read', ok: true, outcome: 'ok', summary: 'second', taskId: 't2' },
    ])

    const firstTask = tasks.find(task => task.taskId === 't1')!
    const secondTask = tasks.find(task => task.taskId === 't2')!
    expect(firstTask.activity).toHaveLength(40)
    expect(firstTask.activity.at(-1)).toMatchObject({ kind: 'tool-result', summary: 'first-44' })
    expect(firstTask.activity.some(activity => 'summary' in activity && activity.summary === 'second')).toBe(false)
    expect(secondTask.activity).toMatchObject([{ kind: 'tool-result', summary: 'second' }])
  })
})

describe('openTaskId', () => {
  it('returns the open flow task id for write-time attribution', () => {
    const events: JournalEvent[] = [
      header,
      { type: 'flow/start', seq: 1, flowId: 'f1', taskId: 't1', trigger: 'tool', timestamp: 5 },
      { type: 'flow/step', seq: 2, flowId: 'f1', taskId: 't1', iteration: 1, reason: 'continue' },
    ]
    expect(openTaskId(events)).toBe('t1')
  })

  it('attributes nothing once the flow has ended', () => {
    const events: JournalEvent[] = [
      header,
      { type: 'flow/start', seq: 1, flowId: 'f1', taskId: 't1', trigger: 'tool', timestamp: 5 },
      { type: 'flow/end', seq: 2, flowId: 'f1', taskId: 't1', reason: 'done', iterations: 1, timestamp: 8 },
    ]
    expect(openTaskId(events)).toBeUndefined()
  })

  it('attributes nothing for a legacy flow/start without a stamp', () => {
    expect(openTaskId([
      header,
      { type: 'flow/start', seq: 1, flowId: 'f-old', trigger: 'tool', timestamp: 5 },
    ])).toBeUndefined()
  })
})
