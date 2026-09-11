import { describe, expect, it } from 'vitest'

import {
  applyLongGoalTransition,
  compareLongGoalEnvironment,
  createLongGoalState,
  describeLongGoalEnvironmentChanges,
  normalizeLongGoalEnvironment,
} from './contract'

describe('long-goal authority contract', () => {
  it('creates an executable goal with an immediate review time', () => {
    expect(createLongGoalState(1000)).toMatchObject({
      lifecycle: 'executable',
      constraintVersion: 1,
      nextReviewAt: 1000,
    })
  })

  it('requires a run record while a goal is running', () => {
    expect(() => applyLongGoalTransition(createLongGoalState(1000), {
      lifecycle: 'running',
      reason: 'claim scheduled run',
      source: 'scheduler',
      timestamp: 2000,
    })).toThrow('requires a task and flow record')
  })

  it('records a completed run and keeps its constraint version', () => {
    const running = applyLongGoalTransition(createLongGoalState(1000), {
      lifecycle: 'running',
      reason: 'claim scheduled run',
      source: 'scheduler',
      timestamp: 2000,
      run: { taskId: 'task-1', flowId: 'flow-1', sessionId: 'session-1', startedAt: 2000 },
    })
    const waiting = applyLongGoalTransition(running, {
      lifecycle: 'waiting-condition',
      reason: 'run ended before all steps were verified',
      source: 'flow',
      timestamp: 3000,
      nextReviewAt: 4000,
      waitReason: 'more evidence is needed',
      run: { taskId: 'task-1', flowId: 'flow-1', sessionId: 'session-1', startedAt: 2000, endedAt: 3000, outcome: 'blocked' },
    })

    expect(waiting).toMatchObject({
      lifecycle: 'waiting-condition',
      constraintVersion: 1,
      nextReviewAt: 4000,
      lastRun: { taskId: 'task-1', outcome: 'blocked' },
    })
    expect(waiting.activeRun).toBeUndefined()
  })

  it('requires a pending question while waiting for the user', () => {
    expect(() => applyLongGoalTransition(createLongGoalState(1000), {
      lifecycle: 'waiting-user',
      reason: 'need a choice',
      source: 'flow',
      timestamp: 2000,
    })).toThrow('requires a pending question')
  })

  it('makes terminal goals revisable only through an executable revision', () => {
    const completed = applyLongGoalTransition(createLongGoalState(1000), {
      lifecycle: 'completed',
      reason: 'all steps verified',
      source: 'flow',
      timestamp: 2000,
    })

    expect(() => applyLongGoalTransition(completed, {
      lifecycle: 'waiting-condition',
      reason: 'retry later',
      source: 'scheduler',
      timestamp: 3000,
    })).toThrow('without a revision')

    const revised = applyLongGoalTransition(completed, {
      lifecycle: 'executable',
      reason: 'user revised the goal',
      source: 'user',
      timestamp: 3000,
      revision: true,
      nextReviewAt: 3000,
    })
    expect(revised).toMatchObject({ lifecycle: 'executable', constraintVersion: 2, nextReviewAt: 3000 })
  })

  it('keeps the interrupted run identity when a revision clears activeRun', () => {
    // ROOT CAUSE:
    //
    // A constraint revision moved the goal off `running`, which deleted
    // `activeRun`. `lastRun` was only kept when the run record already carried
    // `endedAt`, so an interrupted run lost its task and flow identity. The host
    // authorizer could then no longer tell that a late mutation belonged to the
    // superseded run and allowed it.
    const running = applyLongGoalTransition(createLongGoalState(1000), {
      lifecycle: 'running',
      reason: 'claim scheduled run',
      source: 'scheduler',
      timestamp: 2000,
      run: { taskId: 'task-1', flowId: 'flow-1', sessionId: 'session-1', startedAt: 2000 },
    })
    const revised = applyLongGoalTransition(running, {
      lifecycle: 'executable',
      reason: 'user revised the goal',
      source: 'user',
      timestamp: 3000,
      revision: true,
      nextReviewAt: 3000,
    })

    expect(revised.activeRun).toBeUndefined()
    expect(revised.constraintVersion).toBe(2)
    expect(revised.lastRun).toMatchObject({ taskId: 'task-1', flowId: 'flow-1', sessionId: 'session-1' })
  })

  it('treats an exact replay as an idempotent transition', () => {
    const input = {
      lifecycle: 'paused' as const,
      reason: 'user paused the goal',
      source: 'user' as const,
      timestamp: 2000,
    }
    const paused = applyLongGoalTransition(createLongGoalState(1000), input)

    expect(applyLongGoalTransition(paused, input)).toBe(paused)
    expect(() => applyLongGoalTransition(paused, {
      lifecycle: 'waiting-condition',
      reason: 'retry while paused',
      source: 'scheduler',
      timestamp: 3000,
      nextReviewAt: 4000,
    })).toThrow('cannot transition')
  })

  it('normalizes and compares the environment that a run observed', () => {
    const previous = normalizeLongGoalEnvironment({
      providerId: ' provider-a ',
      modelId: 'model-a',
      workspaceRoot: 'D:/workspace',
      toolNames: ['read', 'list', 'read'],
    })
    const current = normalizeLongGoalEnvironment({
      providerId: 'provider-b',
      modelId: 'model-a',
      workspaceRoot: 'D:/other-workspace',
      toolNames: ['read'],
    })

    expect(previous.toolNames).toEqual(['list', 'read'])
    expect(compareLongGoalEnvironment(previous, current)).toEqual(['provider', 'workspace', 'tools'])
    expect(describeLongGoalEnvironmentChanges(['provider', 'tools'])).toBe('provider, available tools')
  })

  it('persists the accepted environment across a waiting transition', () => {
    const environment = {
      providerId: 'provider-a',
      modelId: 'model-a',
      workspaceRoot: 'D:/workspace',
      toolNames: ['list', 'read'],
    }
    const running = applyLongGoalTransition(createLongGoalState(1000), {
      lifecycle: 'running',
      reason: 'start one bounded run',
      source: 'scheduler',
      timestamp: 2000,
      environment,
      run: { taskId: 'task-1', flowId: 'flow-1', sessionId: 'session-1', startedAt: 2000 },
    })
    const waiting = applyLongGoalTransition(running, {
      lifecycle: 'waiting-condition',
      reason: 'provider unavailable after run',
      source: 'flow',
      timestamp: 3000,
      nextReviewAt: 4000,
      waitReason: 'provider unavailable after run',
      run: { taskId: 'task-1', flowId: 'flow-1', sessionId: 'session-1', startedAt: 2000, endedAt: 3000, outcome: 'failed' },
    })

    expect(waiting.lastEnvironment).toEqual(environment)
  })
})
