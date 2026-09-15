import type { MovementControlPort, MovementState } from '../../../../apps/stage-tamagotchi/src/main/services/airi/game-host/movement/port'
import type { PathStep, Vec3 } from '../../../../apps/stage-tamagotchi/src/main/services/airi/game-host/movement/types'

import { describe, expect, it, vi } from 'vitest'

import { runWalkRun, walkRunLength } from '../../../../apps/stage-tamagotchi/src/main/services/airi/game-host/movement/follow'
import { createMcpMovementPort } from '../../../../apps/stage-tamagotchi/src/main/services/airi/game-host/movement/host-port'
import { DEFAULT_MOVEMENT_CONFIG } from '../../../../apps/stage-tamagotchi/src/main/services/airi/game-host/movement/types'

// These fixtures inspect requested controls and state contracts, not game
// physics. Expected failures describe defects in the reviewed worktree.

function step(from: Vec3, to: Vec3): PathStep {
  return { ...to, from, remainingPlaceables: 0, cost: 1, toBreak: [], toPlace: [], parkour: false }
}

function controlPort(position: Vec3) {
  const observation: MovementState = { position, yaw: 0, onGround: true, inWater: false }
  return {
    getState: vi.fn(async () => observation),
    getBlocksRegion: vi.fn(async () => []),
    getBlock: vi.fn(async () => ({ id: 'minecraft:stone', air: false })),
    getInventory: vi.fn(async () => []),
    look: vi.fn(async (_yaw: number, _pitch: number) => {}),
    setInput: vi.fn(async (_input: Parameters<MovementControlPort['setInput']>[0]) => {}),
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

describe('capability deepening: movement boundaries', () => {
  it('retains a continuous run of level walk steps', () => {
    expect(walkRunLength([
      step({ x: 0, y: 1, z: 0 }, { x: 1, y: 1, z: 0 }),
      step({ x: 1, y: 1, z: 0 }, { x: 2, y: 1, z: 0 }),
    ], 0)).toBe(2)
  })

  it('keeps a full-block ascent in the run with a scripted jump', () => {
    // ROOT CAUSE:
    // The classifier checked actions and parkour but not the height change, so
    // a full-block ascent entered the run controller, which only jumps in
    // water. The classifier now marks the ascent `jump-up` and the run
    // controller jumps at the edge, so the ascent stays in a continuous run
    // without being walked into as if it were flat. A drop, break/place/use
    // and parkour still end the run.
    expect(walkRunLength([
      step({ x: 0, y: 1, z: 0 }, { x: 1, y: 2, z: 0 }),
      step({ x: 1, y: 2, z: 0 }, { x: 2, y: 2, z: 0 }),
    ], 0)).toBe(2)
  })

  it('visits the first bend before steering across unchecked space', async () => {
    // ROOT CAUSE:
    // targetIndex started at cursor + 1, even when the first point had not been
    // reached and the next point was outside the lookahead distance. The
    // lookahead now starts at the first unreached node, so the first bearing is
    // aimed at before the bend is crossed.
    const port = controlPort({ x: 0.5, y: 1, z: 0.5 })
    await runWalkRun({
      port,
      cells: [{ x: 1.5, y: 1, z: 0.5 }, { x: 1.5, y: 1, z: 1.5 }],
      config: DEFAULT_MOVEMENT_CONFIG,
      shouldStop: () => port.setInput.mock.calls.length > 0,
      sleep: async () => {},
      now: () => 0,
      tickMs: 150,
      stepTimeoutMs: 8000,
    })
    expect(port.look.mock.calls[0]?.[0]).toBeCloseTo(-90)
  })

  it('releases sprint before a diagonal-to-cardinal turn', async () => {
    // ROOT CAUSE:
    // Math.sign direction vectors have different lengths for diagonal and
    // cardinal edges, and their unnormalized dot product hid a 45-degree turn.
    // Normalized directions detect the bend and release the sprint early.
    const port = controlPort({ x: 0.5, y: 1, z: 0.5 })
    await runWalkRun({
      port,
      cells: [
        { x: 1.5, y: 1, z: 1.5 },
        { x: 2.5, y: 1, z: 2.5 },
        { x: 3.5, y: 1, z: 2.5 },
        { x: 4.5, y: 1, z: 2.5 },
      ],
      config: DEFAULT_MOVEMENT_CONFIG,
      shouldStop: () => port.setInput.mock.calls.length > 0,
      sleep: async () => {},
      now: () => 0,
      tickMs: 150,
      stepTimeoutMs: 8000,
    })
    expect(port.setInput.mock.calls[0]?.[0].sprint).toBe(false)
  })

  it('rejects an unreadable player state instead of inventing a landing', async () => {
    // ROOT CAUSE:
    // Missing get_self data became position zero, onGround true and
    // fallFlying false, so a flight loop could treat a read failure as
    // touchdown. CD-0 D4 makes getState reject an unreadable state instead.
    const port = createMcpMovementPort(async () => undefined)
    await expect(port.getState()).rejects.toThrow()
  })
})
