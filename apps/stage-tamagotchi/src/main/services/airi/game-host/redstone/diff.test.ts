import { describe, expect, it } from 'vitest'

import { createBlueprintRecord } from './blueprint'
import { applyChanges, buildLayeredBlueprint, createBlueprintDiff, worldToBlueprintPosition } from './diff'

function blueprint() {
  return createBlueprintRecord({
    file: { fileName: 'line.litematic', digest: 'raw' },
    subregions: [{
      name: 'line',
      origin: { x: 0, y: 0, z: 0 },
      blocks: [
        { x: 0, y: 0, z: 0, blockId: 'minecraft:redstone_wire' },
        { x: 1, y: 0, z: 0, blockId: 'minecraft:stone' },
      ],
    }],
  })
}

describe('blueprint diffs', () => {
  it('replaces a block and leaves the original record untouched', () => {
    const original = blueprint()
    const repaired = applyChanges(original, [{ position: { x: 0, y: 0, z: 0 }, from: 'minecraft:redstone_wire', to: 'minecraft:repeater', toProperties: { delay: '1' } }], 2)
    expect(repaired.version).toBe(2)
    expect(repaired.subregions[0].blocks.find(block => block.x === 0)?.blockId).toBe('minecraft:repeater')
    expect(original.subregions[0].blocks[0].blockId).toBe('minecraft:redstone_wire')
    expect(repaired.contentDigest).not.toBe(original.contentDigest)
  })

  it('removes a block when the new state is air', () => {
    const repaired = applyChanges(blueprint(), [{ position: { x: 1, y: 0, z: 0 }, from: 'minecraft:stone', to: 'minecraft:air' }], 2)
    expect(repaired.subregions[0].blocks.some(block => block.x === 1)).toBe(false)
  })

  it('inserts a block at a position that had none', () => {
    const repaired = applyChanges(blueprint(), [{ position: { x: 5, y: 0, z: 0 }, from: 'minecraft:air', to: 'minecraft:repeater' }], 2)
    expect(repaired.subregions[0].blocks.some(block => block.x === 5 && block.blockId === 'minecraft:repeater')).toBe(true)
  })

  it('layers only accepted diffs and keeps the original', () => {
    const original = blueprint()
    const accepted = createBlueprintDiff({
      version: 2,
      baseContentDigest: original.contentDigest,
      changes: [{ position: { x: 0, y: 0, z: 0 }, from: 'minecraft:redstone_wire', to: 'minecraft:repeater' }],
      reason: 'restore the far signal',
      appliesTo: { contentDigest: original.contentDigest, version: 1 },
      retestResult: 'passed',
    })
    const rejected = createBlueprintDiff({
      version: 2,
      baseContentDigest: original.contentDigest,
      changes: [{ position: { x: 1, y: 0, z: 0 }, from: 'minecraft:stone', to: 'minecraft:gold_block' }],
      reason: 'not needed',
      appliesTo: { contentDigest: original.contentDigest, version: 1 },
      retestResult: 'failed',
    })
    const goal = buildLayeredBlueprint(original, [accepted, rejected])
    expect(goal.subregions[0].blocks.find(block => block.x === 0)?.blockId).toBe('minecraft:repeater')
    expect(goal.subregions[0].blocks.find(block => block.x === 1)?.blockId).toBe('minecraft:stone')
    expect(goal.version).toBe(2)
  })

  it('returns the original when no diff is accepted', () => {
    const original = blueprint()
    expect(buildLayeredBlueprint(original, [])).toBe(original)
  })

  it('converts a world repair position back to the blueprint frame', () => {
    expect(worldToBlueprintPosition({ x: 5, y: 1, z: -3 }, { x: 5, y: 1, z: 0 }, 90)).toEqual({ x: 3, y: 0, z: 0 })
  })
})
