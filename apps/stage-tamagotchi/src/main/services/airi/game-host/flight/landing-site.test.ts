import type { SnapshotEntry } from '../movement/snapshot'

import { describe, expect, it } from 'vitest'

import { evaluatePatch, isHazardBlock } from './landing-site'

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

  it('refuses a flower in the clearance', () => {
    const entries = [
      ...airAround(10, 0, 100, 90),
      ...flatPatch(10, 0, 98),
      { x: 10, y: 99, z: 0, id: 'minecraft:dandelion' },
    ]
    expect(evaluatePatch({ entries, x: 10, z: 0, from: { x: 0, y: 100, z: 0 }, topY: 100 })).toBeUndefined()
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
    expect(isHazardBlock('minecraft:stone')).toBe(false)
    expect(isHazardBlock('minecraft:grass_block')).toBe(false)
  })
})
