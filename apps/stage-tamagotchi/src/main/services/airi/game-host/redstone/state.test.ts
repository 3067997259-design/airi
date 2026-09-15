import { describe, expect, it } from 'vitest'

import { compareRuntimeState, compareStaticConfiguration, verifyStructure } from './state'

describe('static vs runtime block state', () => {
  it('flags a repeater delay difference as a configuration mismatch', () => {
    const result = compareStaticConfiguration(
      { blockId: 'minecraft:repeater', properties: { facing: 'north', delay: '2' } },
      { blockId: 'minecraft:repeater', properties: { facing: 'north', delay: '3' } },
    )
    expect(result.matches).toBe(false)
    expect(result.mismatches).toEqual([{ property: 'delay', expected: '2', observed: '3' }])
  })

  it('does not fail a build whose repeater is already powered', () => {
    const result = compareStaticConfiguration(
      { blockId: 'minecraft:repeater', properties: { facing: 'north', delay: '2' } },
      { blockId: 'minecraft:repeater', properties: { facing: 'north', delay: '2', powered: 'true' } },
    )
    expect(result.matches).toBe(true)
    expect(compareRuntimeState({ blockId: 'minecraft:repeater', properties: { powered: 'true' } }).facts).toEqual([{ property: 'powered', observed: 'true' }])
  })

  it('treats a missing static property as a mismatch', () => {
    const result = compareStaticConfiguration(
      { blockId: 'minecraft:observer', properties: { facing: 'west' } },
      { blockId: 'minecraft:observer', properties: {} },
    )
    expect(result.matches).toBe(false)
    expect(result.mismatches).toEqual([{ property: 'facing', expected: 'west' }])
  })

  it('separates missing, wrong block and wrong configuration in a structure', () => {
    const expected = [
      { x: 0, y: 0, z: 0, blockId: 'minecraft:observer', properties: { facing: 'north' } },
      { x: 1, y: 0, z: 0, blockId: 'minecraft:hopper', properties: { facing: 'east' } },
      { x: 2, y: 0, z: 0, blockId: 'minecraft:chest' },
    ]
    const observed = new Map([
      ['0,0,0', { blockId: 'minecraft:observer', properties: { facing: 'south' } }],
      ['1,0,0', { blockId: 'minecraft:dropper', properties: { facing: 'east' } }],
    ])
    const result = verifyStructure(expected, observed)
    expect(result.matches).toBe(false)
    expect(result.checked).toBe(3)
    expect(result.mismatches.map(mismatch => mismatch.kind)).toEqual(['wrong_configuration', 'wrong_block', 'missing'])
  })
})
