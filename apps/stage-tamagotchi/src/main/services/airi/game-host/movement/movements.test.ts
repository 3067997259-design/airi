import type { SnapshotEntry } from './snapshot'

import { describe, expect, it } from 'vitest'

import { Movements } from './movements'
import { createSnapshot } from './snapshot'
import { DEFAULT_MOVEMENT_CONFIG } from './types'

function flatWorld(): SnapshotEntry[] {
  const entries: SnapshotEntry[] = []
  for (let x = -16; x <= 16; x++) {
    for (let y = -10; y <= 8; y++) {
      for (let z = -16; z <= 16; z++)
        entries.push({ x, y, z, id: y <= 0 ? 'minecraft:stone' : 'minecraft:air' })
    }
  }
  return entries
}

describe('movements', () => {
  // ROOT CAUSE:
  //
  // `getMoveJumpUp` wrote the hypothetical placed block's top back into the
  // shared snapshot (`blockC.height += 1`). Later successors of the same search
  // then read an assumed height as world state, which made plans depend on
  // candidate order (review R2).
  it('keeps the shared snapshot unchanged when considering a placed step', () => {
    const snapshot = createSnapshot(flatWorld())
    const before = snapshot.getBlock(1, 1, 0)!.height
    const movements = new Movements(snapshot, DEFAULT_MOVEMENT_CONFIG)
    movements.getNeighbors({
      x: 0,
      y: 1,
      z: 0,
      remainingPlaceables: 8,
      cost: 0,
      toBreak: [],
      toPlace: [],
      parkour: false,
    })
    expect(snapshot.getBlock(1, 1, 0)!.height).toBe(before)
  })

  // ROOT CAUSE:
  //
  // Door `use` actions were pushed into the same array as placements and the
  // budget subtracted the whole array length. Zero blocks became -1 and the
  // later `=== 0` guards could not reject a negative budget (review R3).
  it('keeps the block budget unchanged when opening a door', () => {
    const snapshot = createSnapshot([
      ...flatWorld(),
      { x: 1, y: 1, z: 0, id: 'minecraft:oak_door', properties: { open: 'false' } },
      { x: 1, y: 2, z: 0, id: 'minecraft:oak_door', properties: { open: 'false' } },
    ])
    const movements = new Movements(snapshot, DEFAULT_MOVEMENT_CONFIG)
    const neighbors = movements.getNeighbors({
      x: 0,
      y: 1,
      z: 0,
      remainingPlaceables: 0,
      cost: 0,
      toBreak: [],
      toPlace: [],
      parkour: false,
    })
    const door = neighbors.find(node => node.x === 1 && node.y === 1 && node.z === 0)
    expect(door).toBeDefined()
    expect(door!.remainingPlaceables).toBe(0)
    expect(door!.toPlace).toEqual([{ kind: 'use', x: 1, y: 1, z: 0 }])
  })

  it('freezes the block view so candidate writes fail loudly instead of leaking', () => {
    const snapshot = createSnapshot(flatWorld())
    const air = snapshot.getBlock(1, 1, 0)!
    expect(Object.isFrozen(air)).toBe(true)
    expect(() => {
      (air as { height: number }).height += 1
    }).toThrow()
  })
})
