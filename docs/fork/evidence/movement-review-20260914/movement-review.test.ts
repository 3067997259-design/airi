import type { MovementControlPort, MovementState } from '../../../../apps/stage-tamagotchi/src/main/services/airi/game-host/movement/port'
import type { SnapshotEntry } from '../../../../apps/stage-tamagotchi/src/main/services/airi/game-host/movement/snapshot'
import type { Vec3 } from '../../../../apps/stage-tamagotchi/src/main/services/airi/game-host/movement/types'

import { describe, expect, it, vi } from 'vitest'

import { runElytraMove } from '../../../../apps/stage-tamagotchi/src/main/services/airi/game-host/movement/elytra'
import { runTerrainMove } from '../../../../apps/stage-tamagotchi/src/main/services/airi/game-host/movement/executor'
import { Movements } from '../../../../apps/stage-tamagotchi/src/main/services/airi/game-host/movement/movements'
import { planPath } from '../../../../apps/stage-tamagotchi/src/main/services/airi/game-host/movement/planner'
import { createSnapshot } from '../../../../apps/stage-tamagotchi/src/main/services/airi/game-host/movement/snapshot'
import { DEFAULT_MOVEMENT_CONFIG } from '../../../../apps/stage-tamagotchi/src/main/services/airi/game-host/movement/types'

// These review fixtures exercise public planning and control boundaries.
// Scripted observations do not simulate Minecraft collision or flight physics.
// Expected-failure cases assert the desired behavior against the reviewed code.

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

function state(position: Vec3, flying = false): MovementState {
  return {
    position,
    yaw: 0,
    onGround: !flying,
    inWater: false,
    fallFlying: flying,
    motion: { x: 0, y: 0, z: 1 },
    health: 20,
  }
}

function scriptedPort(states: MovementState[], blocks: SnapshotEntry[] = []) {
  let observation = 0
  return {
    getState: vi.fn(async () => states[Math.min(observation++, states.length - 1)]!),
    getBlocksRegion: vi.fn(async (from: Vec3, to: Vec3) => blocks.filter(block =>
      block.x >= from.x && block.x <= to.x
      && block.y >= from.y && block.y <= to.y
      && block.z >= from.z && block.z <= to.z,
    )),
    getBlock: vi.fn(async () => ({ id: 'minecraft:air', air: true })),
    getInventory: vi.fn(async () => [{ slot: 0, id: 'minecraft:firework_rocket', count: 20, hotbar: true }]),
    getEquipment: vi.fn(async () => ({ chest: { id: 'minecraft:elytra', damage: 0, maxDamage: 432 } })),
    look: vi.fn(async (_yaw: number, _pitch: number) => {}),
    setInput: vi.fn(async () => {}),
    stopMovement: vi.fn(async () => {}),
    jumpOnce: vi.fn(async () => {}),
    breakBlock: vi.fn(async () => {}),
    placeBlock: vi.fn(async () => {}),
    useBlock: vi.fn(async () => {}),
    useItem: vi.fn(async () => {}),
    selectHotbar: vi.fn(async () => {}),
    swapSlots: vi.fn(async () => {}),
    dismount: vi.fn(async () => {}),
    getRiding: vi.fn(async () => undefined),
    boardNearestVehicle: vi.fn(async () => ({ boarded: false })),
    useEntity: vi.fn(async () => {}),
  } satisfies MovementControlPort
}

describe('2026-09-14 movement review', () => {
  it('finds equal-cost diagonal paths in all four quadrants on flat ground', () => {
    const costs: number[] = []
    for (const [x, z] of [[6, 6], [6, -6], [-6, 6], [-6, -6]]) {
      const result = planPath({
        source: createSnapshot(flatWorld()),
        start: { x: 0, y: 1, z: 0 },
        goal: { x: x!, y: 1, z: z! },
        config: { ...DEFAULT_MOVEMENT_CONFIG, allowParkour: false },
        onMissingBlock: 'stub',
      })
      expect(result.ok).toBe(true)
      if (!result.ok)
        throw new Error(result.reason)
      expect(result.steps).toHaveLength(6)
      costs.push(result.cost)
    }
    for (const cost of costs)
      expect(cost).toBeCloseTo(6 * Math.SQRT2)
  })

  it.fails('keeps the shared snapshot unchanged when considering a placed step', () => {
    // ROOT CAUSE:
    // getMoveJumpUp changes blockC.height on the object returned by the shared
    // snapshot. Later successors read this hypothetical height as world state.
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

  it.fails('aims a flat eastward step at its walkable center', async () => {
    // ROOT CAUSE:
    // Integer graph coordinates become world-space steering targets without
    // the center projection used by the upstream path executor.
    const port = scriptedPort([state({ x: 0.5, y: 1, z: 0.5 })], flatWorld())
    let time = 0
    await runTerrainMove({
      port,
      goal: { x: 4, y: 1, z: 0 },
      config: { ...DEFAULT_MOVEMENT_CONFIG, allowParkour: false },
      shouldStop: () => port.look.mock.calls.length > 0,
      deps: { now: () => time, sleep: async (ms) => { time += ms } },
    })
    expect(port.look.mock.calls[0]?.[0]).toBeCloseTo(-90)
  })

  it.fails('keeps the block budget unchanged when opening a door', () => {
    // ROOT CAUSE:
    // getMoveForward subtracts all toPlace entries, including a use action.
    // Zero blocks become -1, which later bypasses the === 0 placement guard.
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
    const doorStep = neighbors.find(node => node.x === 1 && node.y === 1 && node.z === 0)
    expect(doorStep?.toPlace[0]?.kind).toBe('use')
    expect(doorStep?.remainingPlaceables).toBe(0)
  })

  it.fails('uses a reachable goal region for fractional move targets', () => {
    // ROOT CAUSE:
    // planPath compares exact coordinate keys; direct move_to forwards a
    // fractional target although every generated graph node is an integer.
    const result = planPath({
      source: createSnapshot(flatWorld()),
      start: { x: 0, y: 1, z: 0 },
      goal: { x: 4.5, y: 1, z: 0.5 },
      config: { ...DEFAULT_MOVEMENT_CONFIG, allowParkour: false },
      onMissingBlock: 'stub',
    })
    expect(result.ok).toBe(true)
  })

  it.fails('ignores terrain well outside a diagonal flight corridor', async () => {
    // ROOT CAUSE:
    // The diagonal scan reads its enclosing rectangle, then tests only the
    // forward projection. A block far to the side still forces a climb.
    const goal = { x: 200, y: 64, z: 200 }
    const port = scriptedPort([
      state({ x: 0, y: 100, z: 0 }, true),
      state(goal),
    ], [{ x: 6, y: 100, z: 32, id: 'minecraft:stone' }])
    let time = 0
    await runElytraMove({
      port,
      goal,
      deps: { now: () => time, sleep: async (ms) => { time += ms } },
    })
    expect(port.look.mock.calls[1]?.[1]).toBe(0)
  })

  it.fails('keeps cancellation as the reason after approach has started', async () => {
    // ROOT CAUSE:
    // shouldStop only changes the reason when landing is false. A stop during
    // the existing approach continues the goal landing and returns reached.
    const goal = { x: 60, y: 64, z: 0 }
    const port = scriptedPort([
      state({ x: 0, y: 85, z: 0 }, true),
      state({ x: 40, y: 75, z: 0 }, true),
      state(goal),
    ])
    let time = 0
    const result = await runElytraMove({
      port,
      goal,
      shouldStop: () => time > 0,
      deps: { now: () => time, sleep: async (ms) => { time += ms } },
    })
    expect(result.status).toBe('cancelled')
  })

  it.fails('clears takeoff input when a state read fails before deployment', async () => {
    // ROOT CAUSE:
    // The cleanup finally block begins after takeoff and deployment. A failed
    // takeoff observation exits while forward and sprint remain requested.
    const port = scriptedPort([state({ x: 0, y: 100, z: 0 })])
    port.getState.mockReset()
    port.getState.mockResolvedValueOnce(state({ x: 0, y: 100, z: 0 }))
    port.getState.mockRejectedValueOnce(new Error('takeoff read unavailable'))
    await expect(runElytraMove({
      port,
      goal: { x: 100, y: 64, z: 0 },
      deps: { sleep: async () => {} },
    })).rejects.toThrow('takeoff read unavailable')
    expect(port.setInput).toHaveBeenCalled()
    expect(port.stopMovement).toHaveBeenCalled()
  })
})
