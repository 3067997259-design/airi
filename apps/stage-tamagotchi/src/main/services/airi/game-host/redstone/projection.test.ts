import { describe, expect, it } from 'vitest'

import { createBlueprintRecord } from './blueprint'
import { assertPlacementOnly, buildProjectionPlan } from './projection'
import { planSiting } from './siting'

function blueprint() {
  return createBlueprintRecord({
    file: { fileName: 'pair.litematic', digest: 'digest' },
    subregions: [{
      name: 'pair',
      origin: { x: 0, y: 0, z: 0 },
      blocks: [
        { x: 0, y: 0, z: 0, blockId: 'minecraft:observer', properties: { facing: 'north' } },
        { x: 1, y: 0, z: 0, blockId: 'minecraft:piston', properties: { facing: 'up' } },
      ],
    }],
  })
}

const PLOT = {
  bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 7, y: 3, z: 7 } },
  floorY: 1,
  diggableDepth: 0,
}

describe('projection plan', () => {
  it('emits world placement data with the material list', () => {
    const siting = planSiting(blueprint(), PLOT)
    expect(siting.ok).toBe(true)
    if (!siting.ok)
      return
    const plan = buildProjectionPlan({
      identity: { projectionId: 'proj-1', taskId: 'task-1', blueprintContentDigest: 'digest', blueprintVersion: 1 },
      blueprint: blueprint(),
      placement: siting.placement,
    })
    expect(plan.mode).toBe('projection')
    expect(plan.blocks).toHaveLength(2)
    expect(plan.blocks[0]).toEqual({ x: 3, y: 1, z: 4, blockId: 'minecraft:observer', properties: { facing: 'north' } })
    expect(plan.materials.map(material => material.itemId)).toContain('minecraft:piston')
  })

  it('rejects a plan that is not placement-only data', () => {
    const forged = { mode: 'paste' } as unknown as Parameters<typeof assertPlacementOnly>[0]
    expect(() => assertPlacementOnly(forged)).toThrow(/not placement-only/)
  })
})
