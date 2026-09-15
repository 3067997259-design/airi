import { describe, expect, it } from 'vitest'

import { planToolUpgrade } from './upgrade'

const FULL_BUDGET = { maxCrafts: 12, maxMissingPrerequisites: 4 }

describe('planToolUpgrade', () => {
  it('plans the wood pickaxe chain from logs, ending with the target', () => {
    const plan = planToolUpgrade({ 'minecraft:oak_log': 2 }, 'minecraft:wooden_pickaxe', FULL_BUDGET)
    expect(plan.craftable).toBe(true)
    expect(plan.missing).toEqual([])
    expect(plan.steps.at(-1)?.itemId).toBe('minecraft:wooden_pickaxe')
    expect(plan.steps.some(step => step.itemId === 'minecraft:stick')).toBe(true)
  })

  it('plans the iron pickaxe chain including a furnace smelt step', () => {
    const plan = planToolUpgrade(
      { 'minecraft:raw_iron': 3, 'minecraft:coal': 3, 'minecraft:oak_log': 1 },
      'minecraft:iron_pickaxe',
      {
        maxCrafts: 12,
        maxMissingPrerequisites: 4,
        allowedStations: ['inventory', 'crafting_table', 'furnace'],
        fuel: { 'minecraft:coal': 3 },
      },
    )
    expect(plan.craftable).toBe(true)
    const smelt = plan.steps.find(step => step.kind === 'smelt')
    expect(smelt).toMatchObject({ itemId: 'minecraft:iron_ingot', station: 'furnace', fuel: { itemId: 'minecraft:coal', count: 3 } })
    expect(plan.steps.at(-1)?.itemId).toBe('minecraft:iron_pickaxe')
  })

  it('does not recurse without bound: a deep missing prerequisite stops', () => {
    const plan = planToolUpgrade({}, 'minecraft:wooden_pickaxe', { maxCrafts: 12, maxMissingPrerequisites: 0 })
    expect(plan.craftable).toBe(false)
    expect(plan.reason).toBe('missing-prerequisite-depth')
    expect(plan.missing.some(entry => entry.itemId === 'minecraft:oak_planks')).toBe(true)
  })

  it('stops at the craft budget and reports what is missing', () => {
    const plan = planToolUpgrade({ 'minecraft:oak_log': 2 }, 'minecraft:wooden_pickaxe', { maxCrafts: 1, maxMissingPrerequisites: 4 })
    expect(plan.craftable).toBe(false)
    // One step is kept so the caller can still see the partial plan.
    expect(plan.steps).toHaveLength(1)
  })

  it('reserves kept materials before planning', () => {
    const plan = planToolUpgrade({ 'minecraft:oak_log': 2 }, 'minecraft:wooden_pickaxe', {
      ...FULL_BUDGET,
      keep: [{ itemId: 'minecraft:oak_log', count: 2 }],
    })
    expect(plan.craftable).toBe(false)
    expect(plan.missing.some(entry => entry.itemId === 'minecraft:oak_log')).toBe(true)
  })

  it('refuses a recipe whose station the caller disallowed', () => {
    const plan = planToolUpgrade({ 'minecraft:oak_log': 2 }, 'minecraft:wooden_pickaxe', {
      ...FULL_BUDGET,
      allowedStations: ['inventory'],
    })
    expect(plan.craftable).toBe(false)
  })

  it('reports an already-held target as craftable without steps', () => {
    const plan = planToolUpgrade({ 'minecraft:stone_pickaxe': 1 }, 'minecraft:stone_pickaxe', FULL_BUDGET)
    expect(plan).toMatchObject({ craftable: true, steps: [], reason: 'already-held' })
  })

  it('does not require the target tool inside its own recipe', () => {
    const plan = planToolUpgrade({ 'minecraft:oak_log': 2 }, 'minecraft:wooden_pickaxe', FULL_BUDGET)
    expect(plan.steps.every(step => step.itemId !== 'minecraft:wooden_pickaxe' || step.kind === 'craft')).toBe(true)
    expect(plan.steps.some(step => step.ingredients.some(ingredient => ingredient.itemId === 'minecraft:wooden_pickaxe'))).toBe(false)
  })
})
