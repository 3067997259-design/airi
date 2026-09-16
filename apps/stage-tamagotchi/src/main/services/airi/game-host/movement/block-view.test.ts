import { describe, expect, it } from 'vitest'

import { classifyBlock, normalizeBlockId } from './block-view'

describe('normalizeBlockId', () => {
  it('strips the namespace and lowercases', () => {
    expect(normalizeBlockId('minecraft:Oak_Log')).toBe('oak_log')
    expect(normalizeBlockId('water')).toBe('water')
  })
})

describe('classifyBlock', () => {
  it('treats air as safe replaceable space', () => {
    const block = classifyBlock({ id: 'minecraft:air', x: 1, y: 64, z: 1 })
    expect(block).toMatchObject({ physical: false, safe: true, replaceable: true, liquid: false, height: 64 })
  })

  it('treats water as swimmable liquid and lava as avoided', () => {
    expect(classifyBlock({ id: 'minecraft:water', x: 1, y: 64, z: 1 })).toMatchObject({ safe: true, liquid: true, replaceable: true })
    expect(classifyBlock({ id: 'minecraft:lava', x: 1, y: 64, z: 1 })).toMatchObject({ safe: false, liquid: true })
  })

  it('treats an unknown block as a solid obstacle', () => {
    expect(classifyBlock({ id: 'minecraft:custom_widget', x: 1, y: 64, z: 1 })).toMatchObject({ physical: true, safe: false, replaceable: false })
  })

  it('reads door open state and keeps unopened doors as obstacles', () => {
    const closed = classifyBlock({ id: 'minecraft:oak_door', x: 1, y: 64, z: 1, properties: { open: 'false' } })
    expect(closed).toMatchObject({ physical: true, safe: false, openable: true, open: false })
    const open = classifyBlock({ id: 'minecraft:oak_door', x: 1, y: 64, z: 1, properties: { open: 'true' } })
    expect(open).toMatchObject({ physical: false, safe: true, openable: true, open: true })
  })

  it('makes slabs walkable at half height and carpets at a tenth', () => {
    expect(classifyBlock({ id: 'minecraft:stone_slab', x: 1, y: 64, z: 1 })).toMatchObject({ physical: false, safe: true, height: 64.5 })
    expect(classifyBlock({ id: 'minecraft:white_carpet', x: 1, y: 64, z: 1 })).toMatchObject({ physical: false, safe: true, height: 64.1 })
  })

  // A bed's collision is 0.5625 high, below the vanilla step height, so a walk
  // may cross it. Treating it as a full obstacle made the planner detour (or
  // fail) instead of stepping over it.
  it('treats a bed as a walkable partial step', () => {
    const bed = classifyBlock({ id: 'minecraft:red_bed', x: 1, y: 64, z: 1 })
    expect(bed).toMatchObject({ physical: false, safe: true })
    expect(bed.height).toBeCloseTo(64.5625, 4)
  })

  // ROOT CAUSE (live hill run at (53,98,-66)):
  //
  // Unknown ids defaulted to full obstacles, so a short_grass tuft raised the
  // walk surface by one block. The planner then built a step whose source cell
  // was a phantom, ordered a 2-block jump from the real feet level, and the bot
  // hopped under the tuft until the run gave up. The region read sends the real
  // collision shapes; an empty list means the block does not collide.
  it('trusts an empty collision list over the id fallback', () => {
    const grass = classifyBlock({ id: 'minecraft:short_grass', x: 53, y: 98, z: -66, collision: [] })
    expect(grass).toMatchObject({ physical: false, safe: true, replaceable: true, height: 98 })
    // Without shapes the plant list still keeps the same cell passable.
    expect(classifyBlock({ id: 'minecraft:short_grass', x: 53, y: 98, z: -66 }))
      .toMatchObject({ physical: false, safe: true, height: 98 })
    // An unknown id with no shapes stays the conservative obstacle.
    expect(classifyBlock({ id: 'minecraft:mystery_panel', x: 0, y: 64, z: 0 }))
      .toMatchObject({ physical: true, safe: false })
  })

  it('keeps a non-empty shape list on the conservative path', () => {
    const topSlab = classifyBlock({
      id: 'minecraft:mystery_panel',
      x: 0,
      y: 64,
      z: 0,
      collision: [{ minX: 0, minY: 0.5, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 }],
    })
    expect(topSlab).toMatchObject({ physical: true, safe: false })
  })

  // ROOT CAUSE (pressure-plate corridor fixture):
  //
  // A pressure plate collides with a 1/16 lip and its collision list is not
  // empty, so the "empty shapes mean passable" rule did not apply and no id
  // class matched: the plate became a full one-block obstacle. The route graph
  // then either detoured around it or ordered a phantom one-block jump, which
  // the takeoff prediction refused because it sees the real 1/16 lip
  // (|restY - targetY| = 0.94 > 0.35), and the run stalled at the plate.
  it('treats a pressure plate as a walkable thin top', () => {
    const plate = classifyBlock({
      id: 'minecraft:oak_pressure_plate',
      x: 4,
      y: 64,
      z: 4,
      collision: [{ minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 0.0625, maxZ: 1 }],
    })
    expect(plate).toMatchObject({ physical: false, safe: true })
    expect(plate.height).toBeCloseTo(64.0625, 4)
  })

  it('uses the shape height for an unlisted thin step over the id fallback', () => {
    const step = classifyBlock({
      id: 'minecraft:mystery_panel',
      x: 4,
      y: 64,
      z: 4,
      collision: [{ minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 0.5625, maxZ: 1 }],
    })
    expect(step).toMatchObject({ physical: false, safe: true })
    expect(step.height).toBeCloseTo(64.5625, 4)
  })

  it('keeps a shape taller than the step height on the conservative path', () => {
    const panel = classifyBlock({
      id: 'minecraft:mystery_panel',
      x: 4,
      y: 64,
      z: 4,
      collision: [{ minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 0.75, maxZ: 1 }],
    })
    expect(panel).toMatchObject({ physical: true, safe: false })
  })

  it('marks gravity blocks and keeps bedrock unbreakable', () => {
    expect(classifyBlock({ id: 'minecraft:sand', x: 1, y: 64, z: 1 })).toMatchObject({ canFall: true, physical: true })
    expect(classifyBlock({ id: 'minecraft:bedrock', x: 1, y: 64, z: 1 }).hardness).toBe(-1)
  })

  it('honors a hardness reported by the world read', () => {
    expect(classifyBlock({ id: 'minecraft:stone', x: 1, y: 64, z: 1, hardness: 7 }).hardness).toBe(7)
  })
})
