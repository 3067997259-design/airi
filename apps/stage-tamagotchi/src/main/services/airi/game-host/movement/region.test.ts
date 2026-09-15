import type { MovementControlPort, MovementInput, MovementState } from './port'
import type { SnapshotEntry } from './snapshot'
import type { Vec3 } from './types'

import { describe, expect, it } from 'vitest'

import { movementRegionBounds, readMovementRegion } from './region'

describe('movementRegionBounds', () => {
  it('inflates around the start and goal', () => {
    const bounds = movementRegionBounds({ x: 0, y: 64, z: 0 }, { x: 4, y: 66, z: 2 }, 8)
    expect(bounds).toEqual({
      // The default lower margin is 5: the deepest allowed drop (4) plus the
      // support block below the landing node.
      min: { x: -8, y: 59, z: -8 },
      max: { x: 12, y: 72, z: 10 },
    })
  })

  it('reaches the support block below the deepest drop', () => {
    const bounds = movementRegionBounds({ x: 0, y: 64, z: 0 }, { x: 0, y: 64, z: 0 }, 8, 4 + 1)
    expect(bounds.min.y).toBe(64 - 5)
  })

  it('clamps to the build limits', () => {
    const low = movementRegionBounds({ x: 0, y: -200, z: 0 }, { x: 0, y: -200, z: 0 })
    expect(low.min.y).toBe(-64)
    const high = movementRegionBounds({ x: 0, y: 400, z: 0 }, { x: 0, y: 400, z: 0 })
    expect(high.max.y).toBe(320)
  })
})

function fakePort(): { port: MovementControlPort, calls: number, maxCallVolume: number } {
  const state = { calls: 0, maxCallVolume: 0 }
  const port: MovementControlPort = {
    async getState(): Promise<MovementState> {
      return { position: { x: 0, y: 64, z: 0 }, yaw: 0, inWater: false, onGround: true }
    },
    async getBlocksRegion(from: Vec3, to: Vec3): Promise<SnapshotEntry[]> {
      state.calls++
      state.maxCallVolume = Math.max(state.maxCallVolume, (to.x - from.x + 1) * (to.y - from.y + 1) * (to.z - from.z + 1))
      const entries: SnapshotEntry[] = []
      for (let x = from.x; x <= to.x; x++) {
        for (let y = from.y; y <= to.y; y++) {
          for (let z = from.z; z <= to.z; z++)
            entries.push({ x, y, z, id: 'minecraft:stone' })
        }
      }
      return entries
    },
    async look(): Promise<void> {},
    async setInput(_input: MovementInput): Promise<void> {},
    async stopMovement(): Promise<void> {},
    async jumpOnce(): Promise<void> {},
    async getBlock() { return undefined },
    async getInventory() { return [] },
    async breakBlock(): Promise<void> {},
    async placeBlock(): Promise<void> {},
    async useBlock(): Promise<void> {},
    async useItem(): Promise<void> {},
    async selectHotbar(): Promise<void> {},
    async swapSlots(): Promise<void> {},
    async dismount(): Promise<void> {},
    async getRiding() { return undefined },
    async boardNearestVehicle() { return { boarded: false } },
    async useEntity(): Promise<void> {},
  }
  return {
    port,
    get calls() { return state.calls },
    get maxCallVolume() { return state.maxCallVolume },
  }
}

describe('readMovementRegion', () => {
  it('splits a large cuboid into calls under the MCP cap', async () => {
    const fake = fakePort()
    const bounds = { min: { x: 0, y: 60, z: 0 }, max: { x: 99, y: 69, z: 99 } }
    const entries = await readMovementRegion(fake.port, bounds)

    expect(fake.calls).toBeGreaterThan(1)
    expect(fake.maxCallVolume).toBeLessThanOrEqual(30_000)
    expect(entries).toHaveLength(100 * 10 * 100)
  })
})
