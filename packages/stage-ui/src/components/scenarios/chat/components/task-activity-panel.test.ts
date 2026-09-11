import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const panelSource = readFileSync(fileURLToPath(new URL('./task-activity-panel.vue', import.meta.url)), 'utf8')
const historySource = readFileSync(fileURLToPath(new URL('./history.vue', import.meta.url)), 'utf8')
const assistantSource = readFileSync(fileURLToPath(new URL('./assistant-item.vue', import.meta.url)), 'utf8')

describe('task activity panel contract', () => {
  it('renders the bounded activity carried by the task projection', () => {
    // TASK-RUN-AND-UI-PLAN B: the leader publishes bounded activity rows with
    // the task snapshot, so a follower does not need the leader's journal.
    expect(panelSource).toContain('props.task.activity.slice(-ACTIVITY_LIMIT)')
    expect(panelSource).not.toContain('useJournalStore')
  })

  it('stays bounded and offers collapse, stop, and status summary', () => {
    expect(panelSource).toContain('ACTIVITY_LIMIT = 40')
    expect(panelSource).toContain('<details')
    expect(panelSource).toContain('(e: \'stop\'): void')
    expect(panelSource).toContain('data-testid="chat-task-activity-stop"')
    expect(panelSource).toContain('t(\'stage.task-activity.steering\')')
    expect(panelSource).toContain('task.pendingQuestion')
    expect(panelSource).toContain('task.lastFailure')
  })
})

describe('chat timeline task entry contract', () => {
  it('takes task runs as the single task entry and pins live tasks to the end', () => {
    expect(historySource).toContain('taskRuns?: readonly TaskRun[]')
    expect(historySource).toContain('kind: \'task-activity\'')
    expect(historySource).toContain('ENDED_TASK_SUMMARY_LIMIT = 3')
    expect(historySource).toContain('TIMELINE_TASK_STATUSES')
    expect(historySource).toContain('(e: \'stopTask\'): void')
    expect(historySource).toContain('event.key !== \'Escape\'')
    expect(historySource).toContain('target.closest(\'input, textarea, [contenteditable="true"]\')')
    // The legacy flow card no longer participates in the timeline.
    expect(historySource).not.toContain('ChatFlowTimelineCard')
    expect(historySource).not.toContain('kind: \'flow\'')
  })

  it('hides tool slices of flow-iteration bubbles so tools render once per projection', () => {
    expect(historySource).toContain(':hide-tool-slices="hideToolSlices(item.message)"')
    expect(historySource).toContain('!!(message as UIStreamingAssistantMessage).flowIteration')
    expect(assistantSource).toContain('hideToolSlices?: boolean')
    expect(assistantSource).toContain('slice.type !== \'tool-call\' && slice.type !== \'tool-call-result\'')
  })
})
