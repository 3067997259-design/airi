import { describe, expect, it } from 'vitest'

import { facingFromYaw, planPlacement, verifyPlacement, yawForFacing } from './placement'

const SUPPORT_BELOW = { down: { blockId: 'minecraft:stone' } }
const SUPPORT_ABOVE = { up: { blockId: 'minecraft:stone' } }

describe('precise placement', () => {
  it('plans a floor placement onto the block below', () => {
    const intent = planPlacement({
      target: { x: 4, y: 1, z: 4, blockId: 'minecraft:observer', properties: { facing: 'south' } },
      neighbors: SUPPORT_BELOW,
    })
    expect(intent).toMatchObject({
      itemId: 'minecraft:observer',
      support: { x: 4, y: 0, z: 4 },
      clickFace: 'up',
      yaw: 0,
      pitch: 90,
      sneak: false,
    })
  })

  it('faces a directional block away from the placement yaw', () => {
    const intent = planPlacement({
      target: { x: 0, y: 0, z: 0, blockId: 'minecraft:observer', properties: { facing: 'north' } },
      neighbors: SUPPORT_BELOW,
    })
    expect(intent).toMatchObject({ yaw: 180 })
  })

  it('clicks from above for a piston that must point down', () => {
    const intent = planPlacement({
      target: { x: 0, y: 0, z: 0, blockId: 'minecraft:piston', properties: { facing: 'down' } },
      neighbors: SUPPORT_ABOVE,
    })
    expect(intent).toMatchObject({ support: { x: 0, y: 1, z: 0 }, clickFace: 'down', pitch: -90 })
  })

  it('sneaks when placing an interactive block', () => {
    const intent = planPlacement({
      target: { x: 0, y: 0, z: 0, blockId: 'minecraft:chest' },
      neighbors: SUPPORT_BELOW,
    })
    expect(intent).toMatchObject({ sneak: true })
  })

  it('refuses a placement with no usable support', () => {
    const intent = planPlacement({ target: { x: 0, y: 0, z: 0, blockId: 'minecraft:stone' }, neighbors: {} })
    expect(intent).toEqual({ unavailable: true, reason: 'no_support' })
  })

  it('round-trips cardinal yaw', () => {
    expect(facingFromYaw(yawForFacing('east'))).toBe('east')
    expect(facingFromYaw(yawForFacing('north'))).toBe('north')
  })
})

describe('placement verification', () => {
  const expected = { blockId: 'minecraft:repeater', properties: { facing: 'north', delay: '2' } }

  it('accepts a matching state and a decreasing inventory', () => {
    const result = verifyPlacement(
      expected,
      { blockId: 'minecraft:repeater', properties: { facing: 'north', delay: '2', powered: 'false' } },
      { itemId: 'minecraft:repeater', before: 3, after: 2 },
    )
    expect(result.placed).toBe(true)
    expect(result.inventoryDelta).toBe(-1)
  })

  it('rejects a placement whose configured delay is wrong', () => {
    const result = verifyPlacement(
      expected,
      { blockId: 'minecraft:repeater', properties: { facing: 'north', delay: '3' } },
      { itemId: 'minecraft:repeater', before: 3, after: 2 },
    )
    expect(result.placed).toBe(false)
    expect(result.reasons).toContain('state_mismatch')
  })

  it('rejects a placement whose inventory did not decrease', () => {
    const result = verifyPlacement(
      expected,
      { blockId: 'minecraft:repeater', properties: { facing: 'north', delay: '2' } },
      { itemId: 'minecraft:repeater', before: 3, after: 3 },
    )
    expect(result.placed).toBe(false)
    expect(result.reasons).toContain('inventory_did_not_decrease')
  })

  it('reports an unobserved placement without a fake result', () => {
    const result = verifyPlacement(expected, undefined)
    expect(result).toEqual({ placed: false, stateMismatches: [], inventoryDelta: 0, reasons: ['not_observed'] })
  })
})
