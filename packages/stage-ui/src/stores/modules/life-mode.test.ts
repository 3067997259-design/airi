import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useChatSessionStore } from '../chat/session-store'
import { useJournalStore } from '../journal'
import { usePlanStore } from '../plans'
import { advanceLongGoalStallState, buildStimulusBrief, useLifeModeStore } from './life-mode'

const chat = vi.hoisted(() => ({
  sending: false,
  send: vi.fn(),
}))
const session = vi.hoisted(() => ({ activeSessionId: 'session-1' }))

vi.mock('../chat', () => ({
  useChatStore: () => chat,
}))

vi.mock('../chat/session-store', () => ({
  useChatSessionStore: () => session,
}))

vi.mock('../modules/memory', () => ({
  useMemoryStore: () => ({ currentMood: undefined }),
}))

beforeEach(() => {
  setActivePinia(createPinia())
  chat.sending = false
  chat.send.mockReset().mockResolvedValue({ sessionId: 'session-1', messages: [] })
  session.activeSessionId = 'session-1'
})

describe('buildStimulusBrief', () => {
  it('assembles mood, spotlight, and recent facts into a structured brief', () => {
    const brief = buildStimulusBrief({
      mood: { valence: 0.6, arousal: 0.2 },
      spotlight: 'plan step "step-1" completed',
      recentEvents: ['read ok: 12 lines', 'appearance changed: HairFront → 1'],
    })

    expect(brief).toContain('[Stimulus brief')
    expect(brief).toContain('Mood: warm')
    expect(brief).toContain('Spotlight: plan step "step-1" completed')
    expect(brief).toContain('Recent activity: read ok: 12 lines | appearance changed: HairFront → 1')
  })

  it('labels cool moods and omits optional sections', () => {
    const brief = buildStimulusBrief({
      mood: { valence: -0.7, arousal: 0.8 },
      recentEvents: [],
    })
    expect(brief).toContain('Mood: cool')
    expect(brief).not.toContain('Spotlight:')
    expect(brief).not.toContain('Recent activity:')
  })

  it('caps the fact list to five entries', () => {
    const brief = buildStimulusBrief({
      recentEvents: Array.from({ length: 8 }, (_, i) => `fact-${i}`),
    })
    expect(brief).toContain('fact-0 | fact-1 | fact-2 | fact-3 | fact-4')
    expect(brief).not.toContain('fact-5')
  })
})

describe('advanceLongGoalStallState', () => {
  it('schedules a blocker report after three unchanged task ticks', () => {
    let state = { stalledTicks: 0, reportBlocker: false }
    for (let tick = 0; tick < 3; tick++) {
      state = advanceLongGoalStallState({
        previous: state,
        progressKey: 'goal-1:step-1',
        progressed: false,
      })
    }

    expect(state).toEqual({
      progressKey: 'goal-1:step-1',
      stalledTicks: 3,
      reportBlocker: true,
    })
  })

  it('clears the stall counter when verified plan state advances', () => {
    const state = advanceLongGoalStallState({
      previous: { progressKey: 'goal-1:step-1', stalledTicks: 2, reportBlocker: false },
      progressKey: 'goal-1:step-1',
      progressed: true,
    })

    expect(state).toEqual({
      progressKey: 'goal-1:step-1',
      stalledTicks: 0,
      reportBlocker: false,
    })
  })
})

describe('life-mode long-term goal ticks', () => {
  it('mounts only the current step tools and plan_update in a hidden task round', async () => {
    const sessionStore = useChatSessionStore()
    sessionStore.activeSessionId = 'session-1'
    const planStore = usePlanStore()
    await planStore.start({
      goal: 'Maintain the workspace',
      horizon: 'long',
      steps: [{
        id: 'inspect',
        lane: 'coding',
        intent: 'Inspect the workspace',
        allowedTools: ['list', 'read'],
        expectedEvidence: [{ source: 'tool_result', description: 'workspace evidence' }],
        riskLevel: 'low',
        approvalRequired: false,
      }],
    }, 'goal-1')
    const lifeStore = useLifeModeStore()
    lifeStore.config.mode = 'autonomous'

    await lifeStore.onLifeTick({ tickId: 'tick-1', reason: 'heartbeat', timestamp: 1 })

    expect(chat.send).toHaveBeenCalledWith(expect.objectContaining({
      source: 'self-initiative',
      selfInitiativeMode: 'task',
      planId: 'goal-1',
      tools: [{ name: 'list' }, { name: 'read' }, { name: 'plan_update' }],
    }))
    expect(useJournalStore().events).toContainEqual(expect.objectContaining({
      type: 'life/tick',
      tickId: 'tick-1',
    }))
  })

  it('uses the existing social consideration round when no long-term goal is active', async () => {
    useChatSessionStore().activeSessionId = 'session-1'
    const lifeStore = useLifeModeStore()
    lifeStore.config.mode = 'autonomous'

    await lifeStore.onLifeTick({ tickId: 'tick-social', reason: 'heartbeat', timestamp: 1 })

    expect(chat.send).toHaveBeenCalledWith(expect.objectContaining({
      source: 'self-initiative',
      tools: [{ name: 'self_speak' }, { name: 'self_note' }],
    }))
    expect(chat.send.mock.calls[0]?.[0]).not.toHaveProperty('planId')
  })

  it('turns the fourth unchanged goal tick into a self_speak blocker report', async () => {
    useChatSessionStore().activeSessionId = 'session-1'
    await usePlanStore().start({
      goal: 'Maintain the workspace',
      horizon: 'long',
      steps: [{
        id: 'inspect',
        lane: 'coding',
        intent: 'Inspect the workspace',
        allowedTools: ['list'],
        expectedEvidence: [{ source: 'tool_result', description: 'workspace evidence' }],
        riskLevel: 'low',
        approvalRequired: false,
      }],
    }, 'goal-1')
    const lifeStore = useLifeModeStore()
    lifeStore.config.mode = 'autonomous'

    for (let tick = 1; tick <= 4; tick++)
      await lifeStore.onLifeTick({ tickId: `tick-${tick}`, reason: 'heartbeat', timestamp: tick })

    expect(chat.send).toHaveBeenCalledTimes(4)
    expect(chat.send.mock.calls[3]?.[0]).toEqual(expect.objectContaining({
      source: 'self-initiative',
      selfInitiativeMode: 'blocker',
      tools: [{ name: 'self_speak' }],
    }))
    expect(chat.send.mock.calls[3]?.[0]).not.toHaveProperty('planId')
  })
})
