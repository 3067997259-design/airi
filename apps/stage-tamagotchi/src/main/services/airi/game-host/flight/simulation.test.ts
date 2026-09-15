import { describe, expect, it } from 'vitest'

import { FLIGHT_PROFILE_1_21_1 } from './profile'
import { createTrajectoryRecorder, lookVector, ROCKET_BOOST_TICKS, simulateFlight, stepFlight, trajectoryToJsonl } from './simulation'

const LEVEL = { yaw: 0, pitch: 0 }
const SOUTH = { x: 0, y: 100, z: 0 }

/** A repeated constant input list; `.fill` avoids a redundant map callback. */
function levels(count: number): Array<{ yaw: number, pitch: number }> {
  return Array.from({ length: count }).fill(LEVEL) as Array<{ yaw: number, pitch: number }>
}

function idleState() {
  return { position: { ...SOUTH }, velocity: { x: 0, y: 0, z: 1 }, yaw: 0, pitch: 0, rocketTicksRemaining: 0, onGround: false, inWater: false }
}

describe('lookVector', () => {
  it('matches Entity#getLookAngle for level south', () => {
    const look = lookVector(0, 0)
    expect(look.x).toBeCloseTo(0, 9)
    expect(look.y).toBeCloseTo(0, 9)
    expect(look.z).toBeCloseTo(1, 9)
  })

  it('looks up for a negative pitch', () => {
    const look = lookVector(0, -90)
    expect(look.y).toBeCloseTo(1, 6)
  })
})

describe('stepFlight', () => {
  it('reproduces the vanilla glide terms for one level tick', () => {
    const next = stepFlight(FLIGHT_PROFILE_1_21_1, idleState(), LEVEL)
    // Hand-computed from the bytecode order:
    // gravity: 0.08 * (-1 + 0.75) = -0.02; dive: d = -0.02 * -0.1 = 0.002;
    // steady pull toward 1.002; drag * 0.99/0.98.
    expect(next.velocity.x).toBeCloseTo(0, 9)
    expect(next.velocity.y).toBeCloseTo(-0.02 * 0.98 + 0.002 * 0.98, 6)
    expect(next.velocity.z).toBeCloseTo((1 + 0.002 + (1 - (1 + 0.002)) * 0.1) * 0.99, 6)
    expect(next.position.y).toBeCloseTo(SOUTH.y + next.velocity.y, 9)
    expect(next.position.z).toBeCloseTo(SOUTH.z + next.velocity.z, 9)
  })

  it('converts a nose-down pitch into extra speed and a steeper sink', () => {
    const level = stepFlight(FLIGHT_PROFILE_1_21_1, idleState(), LEVEL)
    const down = stepFlight(FLIGHT_PROFILE_1_21_1, idleState(), { yaw: 0, pitch: 30 })
    expect(down.velocity.y).toBeLessThan(level.velocity.y)
    expect(down.velocity.z).toBeGreaterThan(level.velocity.z)
  })

  it('gains height while looking up', () => {
    const up = stepFlight(FLIGHT_PROFILE_1_21_1, idleState(), { yaw: 0, pitch: -30 })
    expect(up.velocity.y).toBeGreaterThan(0)
  })

  it('applies an attached firework boost toward the look target', () => {
    const boosted = stepFlight(FLIGHT_PROFILE_1_21_1, { ...idleState(), rocketTicksRemaining: 5 }, { yaw: 0, pitch: 0, useRocket: true, rocketAvailable: true })
    expect(boosted.rocketTicksRemaining).toBe(ROCKET_BOOST_TICKS - 1)
    // The boost pulls toward look * 1.5; one tick lands well above the glide's
    // steady ~1 block/tick.
    expect(boosted.velocity.z).toBeGreaterThan(1.3)
  })

  it('marks the ground when the world reports a blocked cell', () => {
    const next = stepFlight(FLIGHT_PROFILE_1_21_1, idleState(), LEVEL, { isBlocked: () => true })
    expect(next.onGround).toBe(true)
  })
})

describe('simulateFlight', () => {
  it('records one sample per requested tick', () => {
    const inputs = levels(20)
    const trajectory = simulateFlight(FLIGHT_PROFILE_1_21_1, idleState(), inputs, {}, { maxTicks: 20 })
    expect(trajectory.samples).toHaveLength(20)
    expect(trajectory.samples.at(-1)!.tick).toBe(20)
    expect(trajectory.endReason).toBe('max-ticks')
  })

  it('stops the curve on a swept collision before an endpoint passes through', () => {
    // The world blocks only a thin band; endpoints alone could miss it.
    const world = { isBlocked: (position: { z: number }) => position.z >= 3 && position.z <= 3.4 }
    const inputs = levels(40)
    const trajectory = simulateFlight(FLIGHT_PROFILE_1_21_1, idleState(), inputs, world, { maxTicks: 40 })
    expect(trajectory.endReason).toBe('blocked')
    expect(trajectory.collision!.z).toBeGreaterThanOrEqual(3)
    expect(trajectory.samples.length).toBeLessThan(40)
  })

  it('stops below the world floor', () => {
    const inputs = Array.from({ length: 400 }, () => ({ yaw: 0, pitch: 60 }))
    const trajectory = simulateFlight(FLIGHT_PROFILE_1_21_1, idleState(), inputs, { minY: 40 }, { maxTicks: 400 })
    expect(trajectory.endReason).toBe('below-world')
  })

  it('is deterministic across runs', () => {
    const inputs = Array.from({ length: 40 }, (_, index) => ({ yaw: index % 30, pitch: -10 }))
    const first = simulateFlight(FLIGHT_PROFILE_1_21_1, idleState(), inputs, {}, { maxTicks: 40 })
    const second = simulateFlight(FLIGHT_PROFILE_1_21_1, idleState(), inputs, {}, { maxTicks: 40 })
    expect(first.samples).toEqual(second.samples)
  })
})

describe('trajectory recording', () => {
  it('keeps only the newest samples in the ring buffer', () => {
    const recorder = createTrajectoryRecorder(2)
    for (let tick = 1; tick <= 3; tick++)
      recorder.push({ tick, position: { x: 0, y: 0, z: tick }, velocity: { x: 0, y: 0, z: 1 }, onGround: false, inWater: false, rocketTicksRemaining: 0, rocketFired: false })
    expect(recorder.snapshot().map(sample => sample.tick)).toEqual([2, 3])
  })

  it('serializes one JSON object per line', () => {
    const inputs = levels(3)
    const trajectory = simulateFlight(FLIGHT_PROFILE_1_21_1, idleState(), inputs, {}, { maxTicks: 3 })
    const lines = trajectoryToJsonl(trajectory).split('\n')
    expect(lines).toHaveLength(3)
    expect(JSON.parse(lines[0]!).tick).toBe(1)
  })
})
