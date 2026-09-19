import type { SnapshotEntry } from '../movement/snapshot'

import { describe, expect, it } from 'vitest'

import { evaluatePatch, isDamagingBlock, isHazardBlock, isPlantBlock, lowestRoofAboveGoal } from './landing-site'

function flatPatch(x: number, z: number, y: number, id = 'minecraft:stone'): SnapshotEntry[] {
  return [
    { x, y, z, id },
    { x: x + 1, y, z, id },
    { x, y, z: z + 1, id },
    { x: x + 1, y, z: z + 1, id },
  ]
}

/** Air cells around the patch so the columns are covered, not unknown. */
function airAround(x: number, z: number, topY: number, bottomY: number): SnapshotEntry[] {
  const entries: SnapshotEntry[] = []
  for (let dx = -2; dx <= 3; dx++) {
    for (let dz = -2; dz <= 3; dz++) {
      for (let y = bottomY; y <= topY + 2; y++)
        entries.push({ x: x + dx, y, z: z + dz, id: 'minecraft:air' })
    }
  }
  return entries
}

describe('evaluatePatch', () => {
  it('verifies a flat 2x2 support with clearance', () => {
    const entries = [...airAround(10, 0, 100, 90), ...flatPatch(10, 0, 98)]
    const site = evaluatePatch({ entries, x: 10, z: 0, from: { x: 0, y: 100, z: 0 }, topY: 100 })
    expect(site).toBeDefined()
    expect(site!.contactY).toBe(99)
    expect(site!.support).toEqual({ x: 10, y: 98, z: 0, width: 2, depth: 2 })
  })

  it('refuses a single block because a pillar is not a support area', () => {
    const entries = [...airAround(10, 0, 100, 90), { x: 10, y: 98, z: 0, id: 'minecraft:stone' }]
    expect(evaluatePatch({ entries, x: 10, z: 0, from: { x: 0, y: 100, z: 0 }, topY: 100 })).toBeUndefined()
  })

  it('refuses a column the read did not cover', () => {
    // No air entries: every column is unknown, which is not air.
    const entries = flatPatch(10, 0, 98)
    expect(evaluatePatch({ entries, x: 10, z: 0, from: { x: 0, y: 100, z: 0 }, topY: 100 })).toBeUndefined()
  })

  it('refuses a hazardous surface', () => {
    const entries = [...airAround(10, 0, 100, 90), ...flatPatch(10, 0, 98, 'minecraft:magma_block')]
    expect(evaluatePatch({ entries, x: 10, z: 0, from: { x: 0, y: 100, z: 0 }, topY: 100 })).toBeUndefined()
  })

  it('accepts a flower in the clearance and refuses a damaging plant there', () => {
    // ROOT CAUSE (user review 2026-09-18): a no-collision plant has no volume,
    // so it neither supports nor blocks the pose box — grass, flowers and
    // saplings in the clearance are transparent. A damaging plant (berry bush)
    // still makes the patch unusable.
    const flowerEntries = [
      ...airAround(10, 0, 100, 90),
      ...flatPatch(10, 0, 98),
      { x: 10, y: 99, z: 0, id: 'minecraft:dandelion' },
    ]
    const flowerSite = evaluatePatch({ entries: flowerEntries, x: 10, z: 0, from: { x: 0, y: 100, z: 0 }, topY: 100 })
    expect(flowerSite?.contactY).toBe(99)
    expect(flowerSite?.hazards).toEqual([])

    const bushEntries = [
      ...airAround(10, 0, 100, 90),
      ...flatPatch(10, 0, 98),
      { x: 10, y: 99, z: 0, id: 'minecraft:sweet_berry_bush' },
    ]
    expect(evaluatePatch({ entries: bushEntries, x: 10, z: 0, from: { x: 0, y: 100, z: 0 }, topY: 100 })).toBeUndefined()
  })

  it('refuses a patch whose columns differ by more than one block', () => {
    const entries = [
      ...airAround(10, 0, 100, 88),
      { x: 10, y: 98, z: 0, id: 'minecraft:stone' },
      { x: 11, y: 98, z: 0, id: 'minecraft:stone' },
      { x: 10, y: 96, z: 1, id: 'minecraft:stone' },
      { x: 11, y: 96, z: 1, id: 'minecraft:stone' },
    ]
    expect(evaluatePatch({ entries, x: 10, z: 0, from: { x: 0, y: 100, z: 0 }, topY: 100 })).toBeUndefined()
  })
})

describe('isHazardBlock', () => {
  it('flags fire, flowers and plants', () => {
    expect(isHazardBlock('minecraft:fire')).toBe(true)
    expect(isHazardBlock('minecraft:dandelion')).toBe(true)
    expect(isHazardBlock('minecraft:oak_sapling')).toBe(true)
    expect(isHazardBlock('minecraft:grass_block')).toBe(false)
  })
})

describe('lowestRoofAboveGoal', () => {
  const goal = { x: 0.5, y: 65, z: 0.5 }

  it('finds the lowest solid block above the goal head', () => {
    // E-02 canyon: the glass over the cave mouth is the roof the mover used to
    // land on while the goal platform sat 21 blocks below it.
    expect(lowestRoofAboveGoal([
      { x: 0, y: 86, z: 0, id: 'minecraft:glass' },
      { x: 0, y: 90, z: 0, id: 'minecraft:obsidian' },
    ], goal, 95)).toBe(86)
  })

  it('returns undefined for an open column', () => {
    expect(lowestRoofAboveGoal([
      { x: 0, y: 64, z: 0, id: 'minecraft:sea_lantern' },
    ], goal, 95)).toBeUndefined()
  })

  it('ignores blocks inside the goal own headroom and above the probe top', () => {
    // The support under the feet and a block clipping the head belong to the
    // goal, not the roof; a roof above the read top cannot be claimed.
    expect(lowestRoofAboveGoal([
      { x: 0, y: 64, z: 0, id: 'minecraft:sea_lantern' },
      { x: 0, y: 66, z: 0, id: 'minecraft:stone' },
    ], goal, 95)).toBeUndefined()
  })

  it('does not treat a no-collision plant above the goal as a roof', () => {
    expect(lowestRoofAboveGoal([
      { x: 0, y: 80, z: 0, id: 'minecraft:tall_grass' },
    ], goal, 95)).toBeUndefined()
  })
})

describe('plant transparency', () => {
  /** One full column of air down to a solid support, unknown-free. */
  function column(x: number, z: number, supportY: number, surfaceId = 'minecraft:stone', topY = 66): SnapshotEntry[] {
    const entries: SnapshotEntry[] = []
    for (let y = supportY + 1; y <= topY; y++)
      entries.push({ x, y, z, id: 'minecraft:air' })
    entries.push({ x, y: supportY, z, id: surfaceId })
    return entries
  }

  it('skips no-collision plants down to the solid support', () => {
    // A flower meadow is landable: grass, flowers and saplings are not the
    // support and not obstacles — the block under them is (user review
    // 2026-09-18: refusing plant columns would leave a plains biome without
    // a single verified site).
    const entries = [
      ...column(10, 0, 63),
      ...column(11, 0, 63),
      ...column(10, 1, 63),
      ...column(11, 1, 63),
    ]
    entries.push({ x: 10, y: 64, z: 0, id: 'minecraft:short_grass' })
    entries.push({ x: 11, y: 64, z: 0, id: 'minecraft:poppy' })
    entries.push({ x: 10, y: 64, z: 1, id: 'minecraft:oak_sapling' })
    const site = evaluatePatch({ entries, x: 10, z: 0, from: { x: 10, y: 99, z: 0 }, topY: 66 })
    expect(site?.contactY).toBe(64)
    expect(site?.surface).toBe('minecraft:stone')
    expect(site?.hazards).toEqual([])
  })

  it('still refuses a damaging plant column', () => {
    const entries = [
      ...column(10, 0, 63),
      ...column(11, 0, 63),
      ...column(10, 1, 63),
      ...column(11, 1, 63),
    ]
    entries.push({ x: 10, y: 64, z: 0, id: 'minecraft:sweet_berry_bush' })
    const site = evaluatePatch({ entries, x: 10, z: 0, from: { x: 10, y: 99, z: 0 }, topY: 66 })
    expect(site).toBeUndefined()
  })

  it('splits the damaging and plant predicates', () => {
    expect(isPlantBlock('minecraft:oak_sapling')).toBe(true)
    expect(isPlantBlock('minecraft:sweet_berry_bush')).toBe(true)
    expect(isDamagingBlock('minecraft:sweet_berry_bush')).toBe(true)
    expect(isDamagingBlock('minecraft:oak_sapling')).toBe(false)
    // The combined never-support predicate keeps its old truth values.
    expect(isHazardBlock('minecraft:oak_sapling')).toBe(true)
  })
})
