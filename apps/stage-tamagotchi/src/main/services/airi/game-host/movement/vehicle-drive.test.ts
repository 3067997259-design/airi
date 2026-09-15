import { describe, expect, it } from 'vitest'

import {
  boatAngularVelocity,
  chooseDockPoint,
  chooseHorseMotion,
  estimateHorseJump,
  minecartBrakingDistance,
  minecartDismountSafe,
  observeMinecartLaunch,
  paddleTurnVerified,
  planBoatApproach,
} from './vehicle-drive'

describe('boat driving', () => {
  it('measures angular velocity from the hull yaw, not the camera', () => {
    expect(boatAngularVelocity(0, 90, 1000)).toBeCloseTo(90)
    expect(boatAngularVelocity(0, 90, 0)).toBe(0)
  })

  it('reports an unverified paddle turn when forward did not rotate the hull', () => {
    expect(paddleTurnVerified({ previousYaw: 0, currentYaw: 0, elapsedMs: 500, forwardHeld: true })).toBe(false)
    expect(paddleTurnVerified({ previousYaw: 0, currentYaw: 45, elapsedMs: 500, forwardHeld: true })).toBe(true)
  })

  it('reports unobserved when no yaw sample or no forward input exists', () => {
    expect(paddleTurnVerified({ elapsedMs: 500, forwardHeld: true })).toBe('unobserved')
    expect(paddleTurnVerified({ previousYaw: 0, currentYaw: 0, elapsedMs: 500, forwardHeld: false })).toBe('unobserved')
  })

  it('brakes before a bend and holds forward on a straight approach', () => {
    const straight = planBoatApproach({ position: { x: 0, y: 64, z: 0 }, yaw: 0, waypoint: { x: 0, y: 64, z: 10 }, goal: { x: 0, y: 64, z: 10 }, speed: 0 })
    expect(straight.forward).toBe(true)
    expect(straight.slow).toBe(false)

    const bend = planBoatApproach({ position: { x: 0, y: 64, z: 0 }, yaw: 0, waypoint: { x: 10, y: 64, z: 0 }, goal: { x: 10, y: 64, z: 0 }, speed: 0.3 })
    expect(bend.slow).toBe(true)
    expect(bend.forward).toBe(false)
  })

  it('picks a bank dismount point and returns undefined with no bank', () => {
    const dock = chooseDockPoint({
      goal: { x: 0, y: 64, z: 0 },
      waterCells: [{ x: 0, y: 63, z: 0 }],
      isLand: cell => cell.x === 1,
    })
    expect(dock).toEqual({ x: 1, y: 63, z: 0 })
    expect(chooseDockPoint({ goal: { x: 0, y: 64, z: 0 }, waterCells: [{ x: 0, y: 63, z: 0 }], isLand: () => false })).toBeUndefined()
  })
})

describe('horse jumping', () => {
  it('accepts a jump that clears the obstacle with enough run-up', () => {
    const estimate = estimateHorseJump({
      takeoff: { x: 0, y: 64, z: 0 },
      obstacleTop: 64.6,
      landing: { x: 0, y: 64, z: 3 },
      gap: 3,
      health: 20,
      maxHealth: 20,
      runUp: 2,
    })
    expect(estimate.feasible).toBe(true)
    expect(estimate.clearance).toBeGreaterThan(0)
  })

  it('refuses an obstacle taller than the jump and a too-far gap', () => {
    const tooHigh = estimateHorseJump({ takeoff: { x: 0, y: 64, z: 0 }, obstacleTop: 66, landing: { x: 0, y: 64, z: 2 }, gap: 2 })
    expect(tooHigh.feasible).toBe(false)
    expect(tooHigh.reason).toBe('too_high')

    const tooFar = estimateHorseJump({ takeoff: { x: 0, y: 64, z: 0 }, obstacleTop: 64.5, landing: { x: 0, y: 64, z: 8 }, gap: 8 })
    expect(tooFar.feasible).toBe(false)
    expect(tooFar.reason).toBe('too_far')
  })

  it('refuses a jump on low health or without run-up', () => {
    expect(estimateHorseJump({ takeoff: { x: 0, y: 64, z: 0 }, obstacleTop: 64.5, landing: { x: 0, y: 64, z: 2 }, health: 2, maxHealth: 20 }).reason).toBe('low_health')
    expect(estimateHorseJump({ takeoff: { x: 0, y: 64, z: 0 }, obstacleTop: 64.5, landing: { x: 0, y: 64, z: 3 }, gap: 3, runUp: 1 }).reason).toBe('no_run_up')
  })

  it('prefers a gentle detour over a risky jump', () => {
    expect(chooseHorseMotion({ jumpDistance: 3, detourDistance: 3.5, jumpFeasible: true })).toBe('detour')
    expect(chooseHorseMotion({ jumpDistance: 2, detourDistance: 6, jumpFeasible: true })).toBe('jump')
    expect(chooseHorseMotion({ jumpDistance: 1, detourDistance: 1, jumpFeasible: false })).toBe('detour')
  })
})

describe('minecart launch and braking', () => {
  it('reports launched when real speed appears', () => {
    expect(observeMinecartLaunch({ speedBefore: 0, speedAfter: 0.2, powered: true }).launched).toBe(true)
  })

  it('reports rail_not_powered without waiting when the rail is unpowered', () => {
    const result = observeMinecartLaunch({ speedBefore: 0, speedAfter: 0, powered: false })
    expect(result.launched).toBe(false)
    expect(result.reason).toBe('rail_not_powered')
  })

  it('reports launch_unavailable when a powered rail produced no speed', () => {
    const result = observeMinecartLaunch({ speedBefore: 0, speedAfter: 0, powered: true })
    expect(result.reason).toBe('launch_unavailable')
  })

  it('only allows dismount at low speed, off-rail or at a station', () => {
    expect(minecartDismountSafe({ speed: 0.3, onRail: true })).toBe(false)
    expect(minecartDismountSafe({ speed: 0.01, onRail: true })).toBe(true)
    expect(minecartDismountSafe({ speed: 0.5, onRail: false })).toBe(true)
    expect(minecartDismountSafe({ speed: 0.5, onRail: true, atStation: true })).toBe(true)
  })

  it('computes a finite braking distance', () => {
    expect(minecartBrakingDistance(0.4, 0.05)).toBeCloseTo(1.6)
    expect(minecartBrakingDistance(0.4, 0)).toBe(Number.POSITIVE_INFINITY)
  })
})
