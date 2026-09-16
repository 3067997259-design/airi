import type { JumpTask, MovementControlPort, MovementInput, MovementState } from './port'
import type { SnapshotEntry } from './snapshot'
import type { PathStep, Vec3 } from './types'

import { describe, expect, it, vi } from 'vitest'

import { classifyWalkMotion, failedRunStep, runWalkRun, walkRunLength } from './follow'
import { createSnapshot } from './snapshot'
import { DEFAULT_MOVEMENT_CONFIG } from './types'

function makeStep(from: Vec3, to: Vec3, extra: Partial<PathStep> = {}): PathStep {
  return { ...to, from, remainingPlaceables: 0, cost: 1, toBreak: [], toPlace: [], parkour: false, ...extra }
}

/** A flat stone floor at y = 0 with one step block at (1,1,0), exact shapes. */
function jumpWorld() {
  const entries: SnapshotEntry[] = []
  const box = { minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 }
  for (let x = -1; x <= 2; x++) {
    for (let z = -1; z <= 1; z++)
      entries.push({ x, y: 0, z, id: 'minecraft:stone', collision: [box] })
  }
  entries.push({ x: 1, y: 1, z: 0, id: 'minecraft:stone', collision: [box] })
  return createSnapshot(entries, { exactShapes: true })
}

const OPTIONS = {
  config: DEFAULT_MOVEMENT_CONFIG,
  sleep: async () => {},
  now: () => 0,
  tickMs: 150,
  stepTimeoutMs: 8000,
}

function controlPort(state: MovementState) {
  const look = vi.fn(async (_yaw: number, _pitch: number) => {})
  const setInput = vi.fn(async (_input: MovementInput) => {})
  const port = {
    getState: vi.fn(async () => state),
    getBlocksRegion: vi.fn(async () => []),
    getBlock: vi.fn(async () => ({ id: 'minecraft:stone', air: false })),
    getInventory: vi.fn(async () => []),
    look,
    setInput,
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
  return { port, look, setInput }
}

describe('walk motion classification', () => {
  it('counts consecutive level walk edges as one run', () => {
    expect(walkRunLength([
      makeStep({ x: 0, y: 1, z: 0 }, { x: 1, y: 1, z: 0 }),
      makeStep({ x: 1, y: 1, z: 0 }, { x: 2, y: 1, z: 0 }),
    ], 0)).toBe(2)
  })

  it('keeps a full-block ascent inside the run with a scripted jump', () => {
    expect(classifyWalkMotion(makeStep({ x: 0, y: 1, z: 0 }, { x: 1, y: 2, z: 0 }))).toBe('jump-up')
    expect(walkRunLength([
      makeStep({ x: 0, y: 1, z: 0 }, { x: 1, y: 2, z: 0 }),
      makeStep({ x: 1, y: 2, z: 0 }, { x: 2, y: 2, z: 0 }),
    ], 0)).toBe(2)
  })

  it('jumps at the edge of a one-block rise instead of stopping', async () => {
    // Facing +x (yaw -90) at the destination: the alignment gate lets the hop.
    const state: MovementState = { position: { x: 0.5, y: 1, z: 0.5 }, yaw: -90, inWater: false, onGround: true }
    const { port, setInput } = controlPort(state)
    await runWalkRun({
      port,
      cells: [{ x: 0.5, y: 1, z: 0.5 }, { x: 1.5, y: 2, z: 0.5 }],
      ...OPTIONS,
      shouldStop: () => setInput.mock.calls.length > 0,
    })
    expect(setInput.mock.calls[0]?.[0]).toMatchObject({ forward: true, jump: true })
  })

  // ROOT CAUSE (live diagonal-chain runs, two opposing failures):
  //
  // Holding the key across the whole hop made the auto-jump fire on the
  // landing tick, before the rotation for the next cell reached the game: the
  // bot re-hopped in the previous direction and landed in the gap beside the
  // chain. Releasing it for a whole poll on an airborne sample made the bot
  // land and walk into the step's face until it slid off. The key is therefore
  // pressed on a grounded sample and released in the air.
  it('presses the jump on touchdown and releases it while airborne', async () => {
    // Yaw -90 faces +x, the direction of the ascent cell, so the alignment
    // gate lets the climb hop.
    const states: MovementState[] = [
      { position: { x: 0.5, y: 1, z: 0.5 }, yaw: -90, inWater: false, onGround: true },
      { position: { x: 0.8, y: 1.4, z: 0.5 }, yaw: -90, inWater: false, onGround: false },
      { position: { x: 1.0, y: 1.8, z: 0.5 }, yaw: -90, inWater: false, onGround: false },
    ]
    let poll = 0
    const { port, setInput } = controlPort(states[0]!)
    port.getState.mockImplementation(async () => states[Math.min(poll++, states.length - 1)]!)
    await runWalkRun({
      port,
      cells: [{ x: 0.5, y: 1, z: 0.5 }, { x: 1.5, y: 2, z: 0.5 }],
      ...OPTIONS,
      shouldStop: () => setInput.mock.calls.length >= states.length,
    })
    expect(setInput.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(setInput.mock.calls[0]?.[0]).toMatchObject({ jump: true })
    expect(setInput.mock.calls[1]?.[0]).toMatchObject({ jump: false })
    expect(setInput.mock.calls[2]?.[0]).toMatchObject({ jump: false })
  })

  // ROOT CAUSE (live chain, stale-aim takeoff):
  //
  // The mod holds keys between host polls, so a jump key held across a bend
  // took off in the previous direction before the new rotation reached the
  // game tick. On a one-block-wide chain that walked her off the edge. A climb
  // must withhold the jump until the view points at the destination.
  it('withholds the jump until the view faces the ascent cell', async () => {
    const states: MovementState[] = [
      { position: { x: 0.5, y: 1, z: 0.5 }, yaw: 0, inWater: false, onGround: true },
      { position: { x: 0.5, y: 1, z: 0.5 }, yaw: -90, inWater: false, onGround: true },
    ]
    let poll = 0
    const { port, look, setInput } = controlPort(states[0]!)
    port.getState.mockImplementation(async () => states[Math.min(poll++, states.length - 1)]!)
    await runWalkRun({
      port,
      cells: [{ x: 0.5, y: 1, z: 0.5 }, { x: 1.5, y: 2, z: 0.5 }],
      ...OPTIONS,
      shouldStop: () => setInput.mock.calls.length >= states.length,
    })
    // The view snaps to the bearing and the walk brakes for that poll: pressing
    // forward still pointed away is what walked her off the block.
    expect(look.mock.calls[0]?.[0]).toBeCloseTo(-90)
    expect(setInput.mock.calls[0]?.[0]).toMatchObject({ forward: false, jump: false })
    expect(setInput.mock.calls[1]?.[0]).toMatchObject({ forward: true, jump: true })
  })

  // ROOT CAUSE (real-hill v4/v5):
  //
  // The cursor advanced on a horizontal pass alone, so a corner bump below a
  // step skipped that step and made the run chase cells several blocks up.
  // An ascent edge is now complete only at the destination's standing level.
  it('does not complete an ascent edge from below it', async () => {
    const state: MovementState = { position: { x: 1.2, y: 1, z: 0.5 }, yaw: 0, inWater: false, onGround: true }
    const { port, setInput } = controlPort(state)
    const result = await runWalkRun({
      port,
      cells: [{ x: 0.5, y: 1, z: 0.5 }, { x: 1.5, y: 2, z: 0.5 }],
      ...OPTIONS,
      shouldStop: () => setInput.mock.calls.length > 0,
    })
    expect(result.cursor).toBe(0)
  })

  // ROOT CAUSE (live hill "dead end"):
  //
  // The run hopped in place under a step whose rise was two blocks: no jump
  // can clear it, so every attempt fell back and the run spent the stuck window
  // plus the discrete retry timeout before the planner could route around it.
  // The user pointed at the spot and said it is walkable; the phantom rise was
  // the bug (plants classified as solid, fixed in block-view), and an edge that
  // genuinely rises above the jump height must now fail at once.
  it('fails an edge whose rise is above the jump height instead of hopping', async () => {
    const state: MovementState = { position: { x: 0.5, y: 1, z: 0.5 }, yaw: -90, inWater: false, onGround: true }
    const { port, setInput } = controlPort(state)
    const result = await runWalkRun({
      port,
      cells: [{ x: 0.5, y: 1, z: 0.5 }, { x: 1.5, y: 3, z: 0.5 }],
      ...OPTIONS,
      shouldStop: () => false,
    })
    // The cursor names the rejected edge, not the cell before it: the executor
    // retried an already completed edge when it read the old value.
    expect(result).toMatchObject({ status: 'blocked', cursor: 1 })
    expect(setInput).not.toHaveBeenCalled()
  })

  it('completes an ascent edge when standing on the destination', async () => {
    const state: MovementState = { position: { x: 1.5, y: 2, z: 0.5 }, yaw: 0, inWater: false, onGround: true }
    const { port } = controlPort(state)
    const result = await runWalkRun({
      port,
      cells: [{ x: 0.5, y: 1, z: 0.5 }, { x: 1.5, y: 2, z: 0.5 }],
      ...OPTIONS,
      shouldStop: () => false,
    })
    expect(result).toMatchObject({ status: 'arrived', cursor: 1 })
  })

  // Step 3: with a bridge that has the per-tick jump task, the run hands the
  // whole hop over instead of pressing keys from a 150 ms poll loop.
  it('hands a jump-up edge to the per-tick jump task and advances on landing', async () => {
    const world = jumpWorld()
    const states: MovementState[] = [
      { position: { x: 0.5, y: 1, z: 0.5 }, yaw: -90, inWater: false, onGround: true },
      { position: { x: 1.5, y: 2, z: 0.5 }, yaw: -90, inWater: false, onGround: true },
    ]
    let poll = 0
    const { port: base, setInput } = controlPort(states[0]!)
    base.getState.mockImplementation(async () => states[Math.min(poll++, states.length - 1)]!)
    const port: MovementControlPort = base
    const startJump = vi.fn(async (_task: JumpTask) => ({ state: 'running' as const, endReason: 'running', ticks: 0 }))
    const jumpStatus = vi.fn(async () => ({ state: 'done' as const, endReason: 'landed', ticks: 10, position: { x: 1.5, y: 2, z: 0.5 }, onGround: true, distance: 0 }))
    port.startJump = startJump
    port.jumpStatus = jumpStatus
    const result = await runWalkRun({
      port,
      cells: [{ x: 0.5, y: 1, z: 0.5 }, { x: 1.5, y: 2, z: 0.5 }],
      ...OPTIONS,
      world,
      shouldStop: () => false,
    })
    expect(result).toMatchObject({ status: 'arrived', cursor: 1 })
    expect(startJump).toHaveBeenCalledTimes(1)
    const task = startJump.mock.calls[0]![0]
    expect(task.edges).toHaveLength(1)
    expect(task.edges[0]!.target).toMatchObject({ x: 1.5, y: 2, z: 0.5 })
    expect(task.edges[0]!.direction).toMatchObject({ x: 1, z: 0 })
    // The host never pressed keys for this hop: the task owns the input.
    expect(setInput).not.toHaveBeenCalled()
  })

  it('fails the edge when the per-tick jump task fails', async () => {
    const world = jumpWorld()
    const state: MovementState = { position: { x: 0.5, y: 1, z: 0.5 }, yaw: -90, inWater: false, onGround: true }
    const { port: base, setInput } = controlPort(state)
    const port: MovementControlPort = base
    port.startJump = vi.fn(async (_task: JumpTask) => ({ state: 'running' as const, endReason: 'running', ticks: 0 }))
    port.jumpStatus = vi.fn(async () => ({ state: 'failed' as const, endReason: 'fell', ticks: 12 }))
    const result = await runWalkRun({
      port,
      cells: [{ x: 0.5, y: 1, z: 0.5 }, { x: 1.5, y: 2, z: 0.5 }],
      ...OPTIONS,
      world,
      shouldStop: () => false,
    })
    // Same as the rejection above: the failed edge carries the failure.
    expect(result).toMatchObject({ status: 'blocked', cursor: 1 })
    expect(setInput).not.toHaveBeenCalled()
  })

  // ROOT CAUSE (combo fixture, the final two-cell gap):
  //
  // The follower latched a jump only for ascents, so a level gap the planner's
  // parkour move had accepted never reached the jump task. The bot walked to
  // the bridge end, stalled, and the run ended `unreachable` with the far pad
  // three cells away.
  it('reaches the jump task for a level gap the planner accepted', async () => {
    const entries: SnapshotEntry[] = []
    const box = { minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 }
    // Two floor segments with a two-cell void between them: the source bridge
    // ends at cell 0 and the landing pad starts at cell 3.
    for (let x = -1; x <= 0; x++) {
      for (let z = -1; z <= 1; z++)
        entries.push({ x, y: 0, z, id: 'minecraft:stone', collision: [box] })
    }
    for (let x = 3; x <= 4; x++) {
      for (let z = -1; z <= 1; z++)
        entries.push({ x, y: 0, z, id: 'minecraft:stone', collision: [box] })
    }
    const world = createSnapshot(entries, { exactShapes: true })
    const state: MovementState = { position: { x: 0.5, y: 1, z: 0.5 }, yaw: -90, inWater: false, onGround: true }
    const { port: base, setInput } = controlPort(state)
    const port: MovementControlPort = base
    port.startJump = vi.fn(async (_task: JumpTask) => ({ state: 'running' as const, endReason: 'running', ticks: 0 }))
    port.jumpStatus = vi.fn(async () => ({ state: 'failed' as const, endReason: 'fell', ticks: 12 }))
    const result = await runWalkRun({
      port,
      cells: [{ x: 0.5, y: 1, z: 0.5 }, { x: 3.5, y: 1, z: 0.5 }],
      ...OPTIONS,
      world,
      shouldStop: () => false,
    })
    expect(port.startJump).toHaveBeenCalledTimes(1)
    const task = (port.startJump as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as JumpTask
    expect(task.edges[0]?.target).toMatchObject({ x: 3.5, y: 1, z: 0.5 })
    expect(task.edges[0]?.sprint).toBe(true)
    // The predictor refused this edge, so the run reports blocked for a replan
    // instead of walking into the gap or retrying the same hop.
    expect(result).toMatchObject({ status: 'blocked' })
    expect(setInput).not.toHaveBeenCalled()
  })

  it('distinguishes a half-block step-up from a full-block jump-up by support height', () => {
    const stepUp = makeStep({ x: 0, y: 1, z: 0 }, { x: 1, y: 1, z: 0 }, { fromSupportHeight: 1, supportHeight: 1.5 })
    const jumpUp = makeStep({ x: 0, y: 1, z: 0 }, { x: 1, y: 2, z: 0 }, { fromSupportHeight: 1, supportHeight: 2 })
    expect(classifyWalkMotion(stepUp)).toBe('step-up')
    expect(classifyWalkMotion(jumpUp)).toBe('jump-up')
  })

  it('classifies a descending edge as fall', () => {
    expect(classifyWalkMotion(makeStep({ x: 0, y: 5, z: 0 }, { x: 1, y: 4, z: 0 }))).toBe('fall')
  })

  it('ends the run at a break, place or use action', () => {
    const breakStep = makeStep({ x: 1, y: 1, z: 0 }, { x: 2, y: 1, z: 0 }, { toBreak: [{ x: 2, y: 1, z: 0 }] })
    const useStep = makeStep({ x: 3, y: 1, z: 0 }, { x: 4, y: 1, z: 0 }, { toPlace: [{ kind: 'use', x: 4, y: 1, z: 0 }] })
    expect(classifyWalkMotion(breakStep)).toBe('interaction')
    expect(classifyWalkMotion(useStep)).toBe('interaction')
    expect(walkRunLength([
      makeStep({ x: 0, y: 1, z: 0 }, { x: 1, y: 1, z: 0 }),
      breakStep,
    ], 0)).toBe(1)
  })

  it('ends the run at a parkour edge', () => {
    expect(classifyWalkMotion(makeStep({ x: 0, y: 1, z: 0 }, { x: 3, y: 1, z: 0 }, { parkour: true }))).toBe('parkour')
  })

  it('honors an explicit swim or climb motion', () => {
    expect(classifyWalkMotion(makeStep({ x: 0, y: 1, z: 0 }, { x: 1, y: 1, z: 0 }, { motion: 'swim' }))).toBe('swim')
    expect(classifyWalkMotion(makeStep({ x: 0, y: 1, z: 0 }, { x: 1, y: 2, z: 0 }, { motion: 'climb' }))).toBe('climb')
  })
})

describe('runWalkRun steering', () => {
  it('visits the first bend before steering across unchecked space', async () => {
    const { port, look, setInput } = controlPort({ position: { x: 0.5, y: 1, z: 0.5 }, yaw: 0, onGround: true, inWater: false })
    await runWalkRun({
      port,
      cells: [{ x: 1.5, y: 1, z: 0.5 }, { x: 1.5, y: 1, z: 1.5 }],
      ...OPTIONS,
      shouldStop: () => setInput.mock.calls.length > 0,
    })
    expect(look.mock.calls[0]?.[0]).toBeCloseTo(-90)
  })

  it('releases sprint before a diagonal-to-cardinal turn', async () => {
    const { port, setInput } = controlPort({ position: { x: 0.5, y: 1, z: 0.5 }, yaw: 0, onGround: true, inWater: false })
    await runWalkRun({
      port,
      cells: [
        { x: 1.5, y: 1, z: 1.5 },
        { x: 2.5, y: 1, z: 2.5 },
        { x: 3.5, y: 1, z: 2.5 },
        { x: 4.5, y: 1, z: 2.5 },
      ],
      ...OPTIONS,
      shouldStop: () => setInput.mock.calls.length > 0,
    })
    expect(setInput.mock.calls[0]?.[0].sprint).toBe(false)
  })

  it('keeps sprint on a straight run', async () => {
    const { port, setInput } = controlPort({ position: { x: 0.5, y: 1, z: 0.5 }, yaw: 0, onGround: true, inWater: false })
    await runWalkRun({
      port,
      cells: [{ x: 1.5, y: 1, z: 0.5 }, { x: 2.5, y: 1, z: 0.5 }, { x: 3.5, y: 1, z: 0.5 }],
      ...OPTIONS,
      shouldStop: () => setInput.mock.calls.length > 0,
    })
    expect(setInput.mock.calls[0]?.[0].sprint).toBe(true)
  })
})

describe('failed run step', () => {
  it('points at the edge out of the last passed cell, not the run start', () => {
    const steps = [
      makeStep({ x: 0, y: 1, z: 0 }, { x: 1, y: 1, z: 0 }),
      makeStep({ x: 1, y: 1, z: 0 }, { x: 2, y: 1, z: 0 }),
      makeStep({ x: 2, y: 1, z: 0 }, { x: 3, y: 1, z: 0 }),
    ]
    expect(failedRunStep(steps, 0, 0)).toBe(steps[0])
    expect(failedRunStep(steps, 0, 1)).toBe(steps[1])
    expect(failedRunStep(steps, 0, 2)).toBe(steps[2])
  })

  it('clamps a stuck final arrival to the last edge', () => {
    const steps = [makeStep({ x: 0, y: 1, z: 0 }, { x: 1, y: 1, z: 0 })]
    expect(failedRunStep(steps, 0, 5)).toBe(steps[0])
  })
})
