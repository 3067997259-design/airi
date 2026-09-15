import type { MovementControlPort, MovementInput, MovementState } from './port'
import type { PathStep, Vec3 } from './types'

import { describe, expect, it, vi } from 'vitest'

import { classifyWalkMotion, failedRunStep, runWalkRun, walkRunLength } from './follow'
import { DEFAULT_MOVEMENT_CONFIG } from './types'

function makeStep(from: Vec3, to: Vec3, extra: Partial<PathStep> = {}): PathStep {
  return { ...to, from, remainingPlaceables: 0, cost: 1, toBreak: [], toPlace: [], parkour: false, ...extra }
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
    const state: MovementState = { position: { x: 0.5, y: 1, z: 0.5 }, yaw: 0, inWater: false, onGround: true }
    const { port, setInput } = controlPort(state)
    await runWalkRun({
      port,
      cells: [{ x: 0.5, y: 1, z: 0.5 }, { x: 1.5, y: 2, z: 0.5 }],
      ...OPTIONS,
      shouldStop: () => setInput.mock.calls.length > 0,
    })
    expect(setInput.mock.calls[0]?.[0]).toMatchObject({ forward: true, jump: true })
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
