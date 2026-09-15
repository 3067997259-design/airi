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

  it('marks gravity blocks and keeps bedrock unbreakable', () => {
    expect(classifyBlock({ id: 'minecraft:sand', x: 1, y: 64, z: 1 })).toMatchObject({ canFall: true, physical: true })
    expect(classifyBlock({ id: 'minecraft:bedrock', x: 1, y: 64, z: 1 }).hardness).toBe(-1)
  })

  it('honors a hardness reported by the world read', () => {
    expect(classifyBlock({ id: 'minecraft:stone', x: 1, y: 64, z: 1, hardness: 7 }).hardness).toBe(7)
  })
})
