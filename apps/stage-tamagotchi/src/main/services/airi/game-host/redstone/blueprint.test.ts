import { describe, expect, it } from 'vitest'

import { blueprintBounds, BlueprintValidationError, createBlueprintRecord, materialRequirementsOf, stableDigest, transformBlueprintBlocks } from './blueprint'

function sampleBlueprint() {
  return createBlueprintRecord({
    file: { fileName: 'sugarcane.litematic', sizeBytes: 2048, digest: 'raw-file-digest' },
    relativeOrigin: { x: 0, y: 0, z: 0 },
    subregions: [
      {
        name: 'machine',
        origin: { x: 0, y: 0, z: 0 },
        blocks: [
          { x: 0, y: 0, z: 0, blockId: 'minecraft:observer', properties: { facing: 'north' } },
          { x: 0, y: 0, z: 1, blockId: 'minecraft:redstone_wire' },
          { x: 0, y: 1, z: 0, blockId: 'minecraft:water' },
          { x: 1, y: 0, z: 0, blockId: 'minecraft:piston', properties: { facing: 'up' } },
          { x: 2, y: 0, z: 0, blockId: 'minecraft:hopper', properties: { axis: 'x' } },
        ],
      },
      {
        name: 'storage',
        origin: { x: 2, y: -1, z: 0 },
        blocks: [
          { x: 0, y: 0, z: 0, blockId: 'minecraft:chest' },
        ],
      },
    ],
    accessPoints: [
      { name: 'chest', kind: 'chest', x: 2, y: -1, z: 0, outward: 'north' },
    ],
  })
}

describe('blueprint record', () => {
  it('hashes the same content regardless of subregion block order', () => {
    const first = sampleBlueprint()
    const reordered = createBlueprintRecord({
      file: { fileName: 'copy.litematic', digest: 'other' },
      relativeOrigin: { x: 0, y: 0, z: 0 },
      subregions: [
        {
          name: 'machine',
          origin: { x: 0, y: 0, z: 0 },
          blocks: [
            { x: 0, y: 1, z: 0, blockId: 'minecraft:water' },
            { x: 0, y: 0, z: 1, blockId: 'minecraft:redstone_wire' },
            { x: 0, y: 0, z: 0, blockId: 'minecraft:observer', properties: { facing: 'north' } },
            { x: 2, y: 0, z: 0, blockId: 'minecraft:hopper', properties: { axis: 'x' } },
            { x: 1, y: 0, z: 0, blockId: 'minecraft:piston', properties: { facing: 'up' } },
          ],
        },
        {
          name: 'storage',
          origin: { x: 2, y: -1, z: 0 },
          blocks: [{ x: 0, y: 0, z: 0, blockId: 'minecraft:chest' }],
        },
      ],
      accessPoints: [{ name: 'chest', kind: 'chest', x: 2, y: -1, z: 0, outward: 'north' }],
    })
    expect(reordered.contentDigest).toBe(first.contentDigest)
  })

  it('rejects two subregions that place a block at the same cell', () => {
    expect(() => createBlueprintRecord({
      file: { fileName: 'broken.litematic', digest: 'x' },
      subregions: [
        { name: 'a', origin: { x: 0, y: 0, z: 0 }, blocks: [{ x: 0, y: 0, z: 0, blockId: 'minecraft:stone' }] },
        { name: 'b', origin: { x: 1, y: 0, z: 0 }, blocks: [{ x: -1, y: 0, z: 0, blockId: 'minecraft:stone' }] },
      ],
    })).toThrow(BlueprintValidationError)
  })

  it('rejects a blueprint with no blocks', () => {
    expect(() => createBlueprintRecord({
      file: { fileName: 'empty.litematic', digest: 'x' },
      subregions: [{ name: 'a', origin: { x: 0, y: 0, z: 0 }, blocks: [] }],
    })).toThrow(BlueprintValidationError)
  })

  it('derives the bounding box from block positions, not the origin', () => {
    const bounds = blueprintBounds(sampleBlueprint())
    expect(bounds).toEqual({ min: { x: 0, y: -1, z: 0 }, max: { x: 2, y: 1, z: 1 } })
  })

  it('maps redstone dust and water to their real build items', () => {
    const materials = materialRequirementsOf(sampleBlueprint())
    const redstone = materials.find(material => material.itemId === 'minecraft:redstone')
    const water = materials.find(material => material.itemId === 'minecraft:water_bucket')
    expect(redstone).toEqual({ itemId: 'minecraft:redstone', count: 1, reusable: false })
    expect(water).toEqual({ itemId: 'minecraft:water_bucket', count: 1, reusable: true })
  })

  it('rotates directional static properties with the structure', () => {
    const rotated = transformBlueprintBlocks(sampleBlueprint(), 90)
    const observer = rotated.find(block => block.blockId === 'minecraft:observer')
    const hopper = rotated.find(block => block.blockId === 'minecraft:hopper')
    expect(observer?.properties?.facing).toBe('west')
    expect(hopper?.properties?.axis).toBe('z')
  })

  it('keeps a stable index digest', () => {
    expect(stableDigest({ b: 1, a: 2 })).toBe(stableDigest({ a: 2, b: 1 }))
  })
})
