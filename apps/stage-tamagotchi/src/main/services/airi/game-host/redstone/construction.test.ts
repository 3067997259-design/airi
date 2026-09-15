import type { Vec3 } from './geometry'
import type { ProjectionBlock, ProjectionPlan } from './projection'

import { describe, expect, it } from 'vitest'

import { nextExecutableSteps, planConstruction } from './construction'
import { boundsOfPoints, vecKey } from './geometry'

function plan(blocks: ProjectionBlock[]): ProjectionPlan {
  const points = blocks.map(block => ({ x: block.x, y: block.y, z: block.z }))
  return {
    identity: { projectionId: 'p', taskId: 't', blueprintContentDigest: 'd', blueprintVersion: 1 },
    mode: 'projection',
    orientation: 0,
    anchor: { x: 0, y: 0, z: 0 },
    bounds: boundsOfPoints(points) ?? { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } },
    blocks,
    materials: [],
  }
}

const MACHINE = plan([
  { x: 0, y: 0, z: 0, blockId: 'minecraft:stone' },
  { x: 0, y: 1, z: 0, blockId: 'minecraft:stone' },
  { x: 1, y: 0, z: 0, blockId: 'minecraft:chest' },
  { x: 2, y: 0, z: 0, blockId: 'minecraft:water' },
  { x: 3, y: 0, z: 0, blockId: 'minecraft:redstone_wire' },
  { x: 4, y: 0, z: 0, blockId: 'minecraft:glass' },
])

const OUTER_LAYER: Vec3[] = [{ x: 4, y: 0, z: 0 }]

describe('construction ordering', () => {
  it('places foundation, components and water before the enclosure and wiring', () => {
    const construction = planConstruction(MACHINE, { outerLayer: OUTER_LAYER })
    const stageOrder = construction.stages.map(stage => stage.id)
    expect(stageOrder).toEqual(['foundation', 'components', 'water', 'enclosure', 'wiring'])
    expect(construction.stages.at(-1)?.boundary).toContain('trigger')
  })

  it('keeps lower blocks before the blocks resting on them', () => {
    const construction = planConstruction(MACHINE, { outerLayer: OUTER_LAYER })
    const foundation = construction.stages.find(stage => stage.id === 'foundation')
    const positions = foundation?.steps.map(step => step.position.y)
    expect(positions).toEqual([0, 1])
  })

  it('does not schedule a block before its projected support exists', () => {
    const upper = vecKey({ x: 0, y: 1, z: 0 })
    const lower = vecKey({ x: 0, y: 0, z: 0 })
    const construction = planConstruction(MACHINE, { outerLayer: OUTER_LAYER })
    const blocked = nextExecutableSteps(construction, new Set([vecKey({ x: 1, y: 0, z: 0 })]), 10).map(step => vecKey(step.position))
    expect(blocked).not.toContain(upper)
    const allowed = nextExecutableSteps(construction, new Set([lower, vecKey({ x: 1, y: 0, z: 0 }), vecKey({ x: 2, y: 0, z: 0 })]), 10).map(step => vecKey(step.position))
    expect(allowed).toContain(upper)
  })
})
