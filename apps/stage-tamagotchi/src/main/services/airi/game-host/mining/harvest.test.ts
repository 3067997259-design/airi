import type { HarvestEvaluation, MiningRequest, ToolCandidate } from './types'

import { describe, expect, it } from 'vitest'

import { estimateDurability, isCandidateUsable, isDigAuthorized, parseHarvestEvaluation, requiresUpgrade, selectTool } from './harvest'

function candidate(overrides: Partial<ToolCandidate> = {}): ToolCandidate {
  return {
    slot: 0,
    hotbar: false,
    itemId: 'minecraft:iron_pickaxe',
    count: 1,
    damage: 0,
    maxDamage: 250,
    enchantments: {},
    harvestEligible: true,
    destroySpeed: 6,
    estimatedTicks: 10,
    expectedDropMode: 'normal',
    ...overrides,
  }
}

function evaluation(overrides: Partial<HarvestEvaluation> = {}): HarvestEvaluation {
  return {
    blockStateId: 'minecraft:stone',
    x: 1,
    y: 64,
    z: 0,
    dimension: 'minecraft:overworld',
    candidates: [candidate()],
    harvestEligible: true,
    expectedDropMode: 'normal',
    estimatedTicks: 10,
    estimateQuality: 'exact',
    hazards: [],
    unmet: [],
    requiresTool: true,
    ...overrides,
  }
}

function request(overrides: Partial<MiningRequest> = {}): MiningRequest {
  return { pos: { x: 1, y: 64, z: 0 }, strategy: 'conserve', ...overrides }
}

describe('parseHarvestEvaluation', () => {
  it('normalizes the bridge record into typed candidates', () => {
    const parsed = parseHarvestEvaluation({
      blockStateId: 'minecraft:stone',
      x: 1,
      y: 64,
      z: 0,
      dimension: 'minecraft:overworld',
      requiresTool: true,
      harvestEligible: true,
      estimateQuality: 'approximate',
      hazards: ['fluids', 'bogus'],
      unmet: ['no_tool', 'bogus'],
      candidates: [{ slot: 3, hotbar: true, itemId: 'minecraft:stone_pickaxe', count: 1, damage: 5, maxDamage: 131, harvestEligible: true, destroySpeed: 4, estimatedTicks: 15 }],
    })
    expect(parsed).toMatchObject({
      blockStateId: 'minecraft:stone',
      dimension: 'minecraft:overworld',
      requiresTool: true,
      estimateQuality: 'approximate',
      hazards: ['fluids'],
      unmet: ['no_tool'],
    })
    expect(parsed?.candidates[0]).toMatchObject({
      slot: 3,
      hotbar: true,
      itemId: 'minecraft:stone_pickaxe',
      enchantments: {},
      harvestEligible: true,
      destroySpeed: 4,
      estimatedTicks: 15,
    })
  })

  it('returns undefined for an unusable record instead of a free block', () => {
    expect(parseHarvestEvaluation({})).toBeUndefined()
    expect(parseHarvestEvaluation({ blockStateId: 'minecraft:stone', x: 1, y: 2, z: 3 })).toBeUndefined()
    expect(parseHarvestEvaluation(null)).toBeUndefined()
  })
})

describe('selectTool by block material', () => {
  // Grouped scenario set: stone/ore/wood/crop. The tool requirement differs,
  // so the eligibility gate is exercised for each.
  it('picks a pickaxe for stone and refuses a bare hand', () => {
    const decision = selectTool(evaluation({ candidates: [candidate({ itemId: 'minecraft:stone_pickaxe', destroySpeed: 4, estimatedTicks: 12 })] }), request())
    expect(decision.ok).toBe(true)
    if (decision.ok)
      expect(decision.selection?.candidate.itemId).toBe('minecraft:stone_pickaxe')
  })

  it('rejects an ore when the only tool is below its tier', () => {
    const decision = selectTool(evaluation({
      blockStateId: 'minecraft:diamond_ore',
      candidates: [candidate({ itemId: 'minecraft:stone_pickaxe', harvestEligible: false, destroySpeed: 0 })],
    }), request())
    expect(decision).toMatchObject({ ok: false, rejection: { reason: 'tool_level_too_low' } })
  })

  it('rejects when no candidate is present at all', () => {
    const decision = selectTool(evaluation({ candidates: [], harvestEligible: false }), request())
    expect(decision).toMatchObject({ ok: false, rejection: { reason: 'no_tool' } })
  })

  it('allows an axe for wood and a bare hand for a crop that drops without one', () => {
    const axe = selectTool(evaluation({
      blockStateId: 'minecraft:oak_log',
      candidates: [candidate({ itemId: 'minecraft:iron_axe', harvestEligible: true, destroySpeed: 6 })],
    }), request())
    expect(axe.ok && axe.selection?.candidate.itemId).toBe('minecraft:iron_axe')

    const crop = selectTool(evaluation({
      blockStateId: 'minecraft:wheat',
      requiresTool: false,
      candidates: [],
      harvestEligible: true,
    }), request())
    // A crop drops without a tool; clearing it must not be rejected.
    expect(crop).toMatchObject({ ok: true, bareHand: true })
  })
})

describe('selectTool strategy', () => {
  it('uses the fastest eligible tool under the fastest strategy', () => {
    const decision = selectTool(evaluation({
      candidates: [
        candidate({ slot: 0, itemId: 'minecraft:wooden_pickaxe', destroySpeed: 2, estimatedTicks: 25 }),
        candidate({ slot: 1, itemId: 'minecraft:diamond_pickaxe', destroySpeed: 8, estimatedTicks: 6 }),
      ],
    }), request({ strategy: 'fastest' }))
    expect(decision.ok && decision.selection?.candidate.itemId).toBe('minecraft:diamond_pickaxe')
  })

  it('avoids an enchanted tool under conserve when a plain tool qualifies', () => {
    const decision = selectTool(evaluation({
      candidates: [
        candidate({ slot: 0, itemId: 'minecraft:diamond_pickaxe', destroySpeed: 8, estimatedTicks: 6, enchantments: { 'minecraft:fortune': 3 } }),
        candidate({ slot: 1, itemId: 'minecraft:stone_pickaxe', destroySpeed: 4, estimatedTicks: 14, maxDamage: 131 }),
      ],
    }), request({ strategy: 'conserve' }))
    expect(decision.ok && decision.selection?.candidate.itemId).toBe('minecraft:stone_pickaxe')
    expect(decision.ok && decision.selection?.strategy).toBe('conserve')
  })

  it('honors a specified tool and reports it missing when absent', () => {
    const present = selectTool(evaluation(), request({ strategy: 'specified', toolItemId: 'minecraft:iron_pickaxe' }))
    expect(present.ok && present.selection?.candidate.itemId).toBe('minecraft:iron_pickaxe')

    const absent = selectTool(evaluation(), request({ strategy: 'specified', toolItemId: 'minecraft:netherite_pickaxe' }))
    expect(absent).toMatchObject({ ok: false, rejection: { reason: 'no_tool' } })
  })

  it('reveals a specified tool that is present but below the tier', () => {
    const decision = selectTool(evaluation({
      candidates: [candidate({ itemId: 'minecraft:stone_pickaxe', harvestEligible: false, destroySpeed: 0 })],
    }), request({ strategy: 'specified', toolItemId: 'minecraft:stone_pickaxe' }))
    expect(decision).toMatchObject({ ok: false, rejection: { reason: 'tool_level_too_low' } })
  })

  it('never selects a tool the caller asked to keep', () => {
    const decision = selectTool(evaluation({
      candidates: [candidate({ slot: 0, itemId: 'minecraft:iron_pickaxe' })],
    }), request({ keep: ['minecraft:iron_pickaxe'] }))
    expect(decision).toMatchObject({ ok: false, rejection: { reason: 'no_tool' } })
  })

  it('rejects a tool whose estimate exceeds the tick budget', () => {
    const decision = selectTool(evaluation({
      candidates: [candidate({ estimatedTicks: 40 })],
    }), request({ maxTicks: 20 }))
    expect(decision).toMatchObject({ ok: false, rejection: { reason: 'tool_level_too_low' } })
  })

  it('finds a tool carried only in the main inventory', () => {
    const decision = selectTool(evaluation({
      candidates: [candidate({ slot: 21, hotbar: false, itemId: 'minecraft:iron_pickaxe' })],
    }), request())
    expect(decision.ok && decision.selection?.candidate.slot).toBe(21)
  })
})

describe('durability expectations', () => {
  it('treats unbreaking as an expectation and keeps the pessimistic bound', () => {
    const estimate = estimateDurability(candidate({ damage: 10, maxDamage: 131, enchantments: { 'minecraft:unbreaking': 3 } }), 40)
    expect(estimate.known).toBe(true)
    expect(estimate.remaining).toBe(121)
    expect(estimate.worstCaseBlocks).toBe(121)
    expect(estimate.expectedBlocks).toBe(121 * 4)
    expect(estimate.riskOfBreak).toBe(false)
  })

  it('flags a plan longer than the raw remaining durability as a break risk', () => {
    const estimate = estimateDurability(candidate({ damage: 129, maxDamage: 131, enchantments: { 'minecraft:unbreaking': 3 } }), 10)
    // Even though unbreaking raises the expectation, it can fail, so the plan
    // is a risk.
    expect(estimate.remaining).toBe(2)
    expect(estimate.riskOfBreak).toBe(true)
  })

  it('marks a tool without readable durability as unknown, never safe', () => {
    const estimate = estimateDurability(candidate({ damage: undefined, maxDamage: undefined }), 5)
    expect(estimate.known).toBe(false)
    expect(estimate.riskOfBreak).toBe(false)
  })
})

describe('environmental variation is grouped apart', () => {
  // Underwater, mining fatigue and attribute changes only move the estimate;
  // they must not change the eligibility classification.
  const variations: Array<[string, Partial<ToolCandidate>]> = [
    ['underwater', { estimatedTicks: 30, destroySpeed: 0.4 }],
    ['fatigue', { estimatedTicks: 60, destroySpeed: 0.2 }],
    ['attribute', { estimatedTicks: 18, destroySpeed: 5 }],
  ]
  for (const [label, overrides] of variations) {
    it(`keeps eligibility while the estimate changes (${label})`, () => {
      const decision = selectTool(evaluation({ candidates: [candidate({ itemId: 'minecraft:iron_pickaxe', ...overrides })] }), request())
      expect(decision.ok).toBe(true)
      if (decision.ok)
        expect(decision.selection?.candidate.harvestEligible).toBe(true)
    })
  }
})

describe('authorization helpers', () => {
  it('authorizes a dig only when a usable tool is available', () => {
    expect(isDigAuthorized(evaluation(), { strategy: 'conserve' })).toBe(true)
    expect(isDigAuthorized(evaluation({ unmet: ['unbreakable'] }), { strategy: 'conserve' })).toBe(false)
    expect(isDigAuthorized(evaluation({ candidates: [], harvestEligible: false }), { strategy: 'conserve' })).toBe(false)
  })

  it('reports an upgrade need for a missing or low-tier tool', () => {
    expect(requiresUpgrade(evaluation({ candidates: [], harvestEligible: false }), request())).toBe(true)
    expect(requiresUpgrade(evaluation(), request())).toBe(false)
  })

  it('accepts a candidate that does not require a tool', () => {
    expect(isCandidateUsable(candidate({ harvestEligible: false }), evaluation({ requiresTool: false }))).toBe(false)
  })
})
