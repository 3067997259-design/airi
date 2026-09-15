import { describe, expect, it } from 'vitest'

import {
  classifyCraftDelta,
  classifyCraftObservation,
  craftExpectation,
  DEFAULT_EXPLORATION_BUDGET,
  finishExploration,
  knowledgeMatchesTarget,
  planExploration,
  recordStep,
  shouldReuse,
  startExploration,
  stepAllowed,
  stopExploration,
  summarizeExploration,
} from './explore'

const TARGET = { itemId: 'farmersdelight:flint_knife', modId: 'farmersdelight' }

describe('exploration plan', () => {
  it('orders sources reuse → jar → web → craft → record', () => {
    const plan = planExploration(TARGET, { allowWeb: true, craftable: true })
    expect(plan.map(step => step.kind)).toEqual(['reuse-check', 'jar', 'web', 'craft', 'record'])
  })

  it('drops optional steps when unavailable', () => {
    const plan = planExploration(TARGET, { allowWeb: false, craftable: false, jarReadable: false })
    expect(plan.map(step => step.kind)).toEqual(['reuse-check', 'record'])
  })
})

describe('exploration budget', () => {
  it('blocks on step count and on wall clock', () => {
    const state = startExploration(TARGET, { maxSteps: 1, maxDurationMs: 1000, maxCraftAttempts: 2 }, {}, 0)
    expect(stepAllowed(state, 0)).toEqual({ allowed: true })
    const after = recordStep(state, 'reuse-check', 'done', 0)
    expect(stepAllowed(after, 0)).toEqual({ allowed: false, reason: 'budget-steps' })

    const slow = startExploration(TARGET, { maxSteps: 5, maxDurationMs: 1000, maxCraftAttempts: 2 }, {}, 0)
    expect(stepAllowed(slow, 1001)).toEqual({ allowed: false, reason: 'budget-time' })
  })

  it('does not charge skipped no-op steps against the budget', () => {
    const state = startExploration(TARGET, { maxSteps: 1, maxDurationMs: 1000, maxCraftAttempts: 2 }, {}, 0)
    const skipped = recordStep(state, 'web', 'skipped', 0, 'no web sources provided')
    expect(stepAllowed(skipped, 0)).toEqual({ allowed: true })
  })

  it('records steps in order and flips planned → running', () => {
    const state = recordStep(recordStep(startExploration(TARGET), 'reuse-check', 'done', 1), 'jar', 'done', 2)
    expect(state.phase).toBe('running')
    expect(state.steps.map(step => `${step.kind}:${step.status}`)).toEqual(['reuse-check:done', 'jar:done'])
  })
})

describe('exploration terminals', () => {
  it('distinguishes user stops from errors and marks the final tier', () => {
    const running = recordStep(startExploration(TARGET), 'reuse-check', 'done')
    expect(stopExploration(running, 'user').phase).toBe('stopped')
    expect(stopExploration(running, 'user').stopReason).toBe('user')
    expect(stopExploration(running, 'error').phase).toBe('failed')
    expect(finishExploration(running, 'verified').tier).toBe('verified')
    expect(summarizeExploration(finishExploration(running, 'candidate'))).toContain('tier=candidate')
  })
})

describe('reuse decision', () => {
  it('reuses only fresh verified/candidate knowledge', () => {
    expect(shouldReuse([{ tier: 'verified', fresh: true }])).toBe(true)
    expect(shouldReuse([{ tier: 'candidate', fresh: true }])).toBe(true)
    expect(shouldReuse([{ tier: 'lead', fresh: true }])).toBe(false)
    expect(shouldReuse([{ tier: 'verified', fresh: false }])).toBe(false)
    expect(shouldReuse([])).toBe(false)
  })

  it('matches only facts that name the target recipe', () => {
    expect(knowledgeMatchesTarget({ originId: 'mc2:farmersdelight:flint_knife', content: '' }, TARGET)).toBe(true)
    expect(knowledgeMatchesTarget({ originId: 'mc2:web:abc', content: '网页线索 …（Flint Knife）…' }, TARGET)).toBe(true)
    expect(knowledgeMatchesTarget({ originId: 'mc2:web:abc', content: '网页线索 farmersdelight:flint_knife 配方' }, TARGET)).toBe(true)
    // A semantically near knife must not satisfy the target.
    expect(knowledgeMatchesTarget({ originId: 'mc2:farmersdelight:diamond_knife', content: 'farmersdelight:diamond_knife：…' }, TARGET)).toBe(false)
    expect(knowledgeMatchesTarget({ originId: 'mc2:web:abc', content: '网页线索 …（Diamond Knife）…' }, TARGET)).toBe(false)
    // Materials that merely mention the target id do not make the fact about it.
    expect(knowledgeMatchesTarget({ originId: 'mc2:web:abc', content: 'farmersdelight:barbecue_stick：材料 st=minecraft:stick；状态：候选。' }, TARGET)).toBe(false)
  })
})

describe('craft classification', () => {
  const expectation = {
    result: { id: 'farmersdelight:flint_knife', count: 1 },
    materials: [{ id: 'minecraft:flint', count: 1 }, { id: 'minecraft:stick', count: 1 }],
  }

  it('verifies an exact inventory delta', () => {
    const before = [{ id: 'minecraft:flint', count: 4 }, { id: 'minecraft:stick', count: 4 }]
    const after = [{ id: 'farmersdelight:flint_knife', count: 1 }, { id: 'minecraft:flint', count: 3 }, { id: 'minecraft:stick', count: 3 }]
    expect(classifyCraftObservation(before, after, expectation)).toBe('verified')
  })

  it('fails a contradicting delta and never verifies missing readings', () => {
    expect(classifyCraftObservation(
      [{ id: 'minecraft:flint', count: 4 }],
      [{ id: 'minecraft:flint', count: 4 }],
      expectation,
    )).toBe('failed')
    expect(classifyCraftObservation([], [], expectation)).toBe('inconclusive')
  })

  it('classifies a measured delta from a receipt', () => {
    expect(classifyCraftDelta({ 'farmersdelight:flint_knife': 1, 'minecraft:flint': -1, 'minecraft:stick': -1, 'minecraft:sand': 1 }, expectation)).toBe('verified')
    expect(classifyCraftDelta({ 'farmersdelight:flint_knife': 1, 'minecraft:flint': -1 }, expectation)).toBe('failed')
    expect(classifyCraftDelta({}, expectation)).toBe('failed')
  })
})

describe('craft expectation', () => {
  it('counts shaped pattern symbols and keeps tags out of the concrete delta', () => {
    const result = craftExpectation({
      type: 'minecraft:crafting_shaped',
      result: { id: 'farmersdelight:flint_knife', count: 1 },
      pattern: ['m', 's'],
      keys: { m: { item: 'minecraft:flint' }, s: { tag: 'minecraft:sticks' } },
    })
    expect(result.expectation?.materials).toEqual([{ id: 'minecraft:flint', count: 1 }])
    expect(result.tagMaterials).toEqual(['minecraft:sticks'])
  })

  it('counts shapeless ingredients and reports unsupported shapes', () => {
    const dough = craftExpectation({
      type: 'minecraft:crafting_shapeless',
      result: { id: 'farmersdelight:wheat_dough', count: 1 },
      ingredients: [{ item: 'minecraft:wheat' }, { item: 'minecraft:water_bucket' }],
    })
    expect(dough.expectation?.materials).toEqual([{ id: 'minecraft:wheat', count: 1 }, { id: 'minecraft:water_bucket', count: 1 }])
    expect(craftExpectation({ type: 'create:crushing' }).unsupported).toContain('no result')
    expect(craftExpectation({ type: 'create:crushing', result: { id: 'x', count: 1 } }).unsupported).toContain('unsupported recipe type')
  })
})

describe('default budget', () => {
  it('is bounded and positive', () => {
    expect(DEFAULT_EXPLORATION_BUDGET.maxSteps).toBeGreaterThan(0)
    expect(DEFAULT_EXPLORATION_BUDGET.maxDurationMs).toBeGreaterThan(0)
    expect(DEFAULT_EXPLORATION_BUDGET.maxCraftAttempts).toBeGreaterThan(0)
  })
})
