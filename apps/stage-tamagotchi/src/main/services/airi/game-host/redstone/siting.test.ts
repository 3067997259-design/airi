import type { BlueprintRecord } from './blueprint'

import { describe, expect, it } from 'vitest'

import { createBlueprintRecord } from './blueprint'
import { planSiting } from './siting'

function slab(width: number, depth: number, extra: Partial<{ digDepth: number, accessPoints: BlueprintRecord['accessPoints'], origin: { x: number, y: number, z: number } }> = {}): BlueprintRecord {
  const blocks = []
  for (let x = 0; x < width; x++) {
    for (let z = 0; z < depth; z++)
      blocks.push({ x, y: 0, z, blockId: 'minecraft:stone' })
  }
  return createBlueprintRecord({
    file: { fileName: 'slab.litematic', digest: 'digest' },
    ...(extra.origin ? { relativeOrigin: extra.origin } : {}),
    subregions: [{ name: 'slab', origin: extra.origin ?? { x: 0, y: 0, z: 0 }, blocks }],
    ...(extra.digDepth !== undefined ? { digDepth: extra.digDepth } : {}),
    ...(extra.accessPoints ? { accessPoints: extra.accessPoints } : {}),
  })
}

const PLOT = {
  bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 15, y: 5, z: 15 } },
  floorY: 1,
  diggableDepth: 0,
}

describe('plot siting', () => {
  it('centers an even structure on the plot with zero deviation', () => {
    const result = planSiting(slab(4, 4), PLOT)
    expect(result.ok).toBe(true)
    if (!result.ok)
      return
    expect(result.placement.anchor).toEqual({ x: 6, y: 1, z: 6 })
    expect(result.placement.bounds).toEqual({ min: { x: 6, y: 1, z: 6 }, max: { x: 9, y: 1, z: 9 } })
    expect(result.placement.deviation).toEqual({ x: 0, y: 0, z: 0 })
  })

  it('records the half-block deviation when parity prevents exact centering', () => {
    const result = planSiting(slab(3, 3), PLOT)
    expect(result.ok).toBe(true)
    if (!result.ok)
      return
    expect(result.placement.anchor).toEqual({ x: 7, y: 1, z: 7 })
    expect(result.placement.deviation).toEqual({ x: 0.5, y: 0, z: 0.5 })
  })

  it('keeps a blueprint whose origin is not the lower-left corner inside the plot', () => {
    const blueprint = slab(3, 3, { origin: { x: -5, y: 0, z: -5 } })
    const result = planSiting(blueprint, PLOT)
    expect(result.ok).toBe(true)
    if (!result.ok)
      return
    const size = { x: result.placement.bounds.max.x - result.placement.bounds.min.x + 1, z: result.placement.bounds.max.z - result.placement.bounds.min.z + 1 }
    expect(size).toEqual({ x: 3, z: 3 })
  })

  it('reports a concrete footprint conflict instead of truncating the blueprint', () => {
    const result = planSiting(slab(4, 4), { ...PLOT, bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 5, z: 1 } } })
    expect(result.ok).toBe(false)
    if (result.ok)
      return
    expect(result.conflicts.every(conflict => conflict.kind === 'footprint_out_of_bounds')).toBe(true)
  })

  it('rejects a blueprint that needs more diggable depth than the plot allows', () => {
    const result = planSiting(slab(2, 2, { digDepth: 2 }), PLOT)
    expect(result.ok).toBe(false)
    if (result.ok)
      return
    expect(result.conflicts.some(conflict => conflict.kind === 'insufficient_diggable_depth')).toBe(true)
  })

  it('rejects an access point whose standing cell is outside the plot', () => {
    const blueprint = slab(4, 4, { accessPoints: [{ name: 'chest', kind: 'chest', x: 0, y: 0, z: 0, outward: 'north' }] })
    const result = planSiting(blueprint, { ...PLOT, bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 3, y: 5, z: 3 } } })
    expect(result.ok).toBe(false)
    if (result.ok)
      return
    expect(result.conflicts.some(conflict => conflict.kind === 'access_unreachable')).toBe(true)
  })

  it('rejects a placement without the required maintenance space', () => {
    const result = planSiting(slab(4, 4), PLOT, { maintenance: { north: 8 } })
    expect(result.ok).toBe(false)
    if (result.ok)
      return
    expect(result.conflicts.every(conflict => conflict.kind === 'maintenance_space_missing')).toBe(true)
  })

  it('falls through to the first orientation that satisfies the plot', () => {
    const plot = { bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 2, y: 3, z: 5 } }, floorY: 0, diggableDepth: 0 }
    const result = planSiting(slab(4, 2), plot, { orientations: [0, 90] })
    expect(result.ok).toBe(true)
    if (!result.ok)
      return
    expect(result.placement.orientation).toBe(90)
  })

  it('reports no_orientation when no candidate is offered', () => {
    const result = planSiting(slab(2, 2), PLOT, { orientations: [] })
    expect(result.ok).toBe(false)
    if (result.ok)
      return
    expect(result.conflicts.some(conflict => conflict.kind === 'no_orientation')).toBe(true)
  })
})
