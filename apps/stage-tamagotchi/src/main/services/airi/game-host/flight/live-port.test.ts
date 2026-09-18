import type { MovementControlPort } from '../movement/port'

import { describe, expect, it } from 'vitest'

import { fireworkStateSince, planLiveFlightControl } from './live-port'
import { FLIGHT_PROFILE_1_21_1, resolveFlightPlannerSwitch } from './profile'

describe('resolveFlightPlannerSwitch', () => {
  it('keeps the heuristics while the planner is off or unconfigured', () => {
    expect(resolveFlightPlannerSwitch(undefined, '1.21.1')).toBeUndefined()
    expect(resolveFlightPlannerSwitch({ planner: 'off' }, '1.21.1')).toBeUndefined()
  })

  it('resolves the switch for a supported version', () => {
    const sw = resolveFlightPlannerSwitch({ planner: 'on' }, '1.21.1')
    expect(sw?.enabled).toBe(true)
    expect(sw?.calibrated).toBe(false)
    expect(sw?.profile.id).toBe(FLIGHT_PROFILE_1_21_1.id)
    expect(resolveFlightPlannerSwitch({ planner: 'on', calibrated: true }, '1.21.1')?.calibrated).toBe(true)
  })

  it('stays off when the version has no profile instead of guessing physics', () => {
    expect(resolveFlightPlannerSwitch({ planner: 'on' }, '1.20.1')).toBeUndefined()
  })
})

describe('fireworkStateSince', () => {
  it('reports no boost before the first rocket', () => {
    expect(fireworkStateSince(undefined, 10_000)).toEqual({ active: false, ticksRemaining: 0 })
  })

  it('models the boost window from the last spent rocket', () => {
    expect(fireworkStateSince(10_000, 10_050)).toEqual({ active: true, ticksRemaining: 9 })
    expect(fireworkStateSince(10_000, 10_500)).toEqual({ active: false, ticksRemaining: 0 })
  })
})

describe('planLiveFlightControl', () => {
  const planner = { enabled: true, profile: FLIGHT_PROFILE_1_21_1, calibrated: false }

  function stateOf(position: { x: number, y: number, z: number }) {
    return {
      position,
      yaw: 0,
      inWater: false,
      onGround: false,
      motion: { x: 0.8, y: -0.05, z: 0 },
      fallFlying: true,
      health: 20,
    }
  }

  function fakePort(entries: () => Array<{ x: number, y: number, z: number }>): MovementControlPort & { reads: number } {
    return {
      reads: 0,
      async getState() {
        throw new Error('unexpected in this test')
      },
      async getBlocksRegion() {
        this.reads++
        return entries().map(({ x, y, z }) => ({ x, y, z, id: 'minecraft:air' }))
      },
    } as unknown as MovementControlPort & { reads: number }
  }

  it('returns a control when the swept cells are read and passable', async () => {
    const around: Array<{ x: number, y: number, z: number }> = []
    for (let x = -20; x <= 20; x++) {
      for (let y = 70; y <= 95; y++) {
        for (let z = -20; z <= 20; z++)
          around.push({ x, y, z })
      }
    }
    const port = fakePort(() => around)
    const control = await planLiveFlightControl({
      planner,
      port,
      state: stateOf({ x: 0, y: 82, z: 0 }),
      poll: 1,
      fireworks: 16,
      health: 20,
      goal: { x: 120, y: 80, z: 0 },
      lastRocketAt: undefined,
      now: () => 0,
    })
    expect(control).toBeDefined()
    expect(port.reads).toBe(1)
  })

  it('falls back when the read covers none of the swept cells', async () => {
    const port = fakePort(() => [])
    const control = await planLiveFlightControl({
      planner,
      port,
      state: stateOf({ x: 0, y: 82, z: 0 }),
      poll: 1,
      fireworks: 16,
      health: 20,
      goal: { x: 120, y: 80, z: 0 },
      lastRocketAt: undefined,
      now: () => 0,
    })
    // Every swept cell is unknown, so no candidate is safe; the caller keeps
    // its heuristic branch for this poll.
    expect(control).toBeUndefined()
  })

  it('falls back when the region read itself fails', async () => {
    const port: MovementControlPort = {
      async getState() {
        throw new Error('unexpected')
      },
      async getBlocksRegion() {
        throw new Error('bridge unavailable')
      },
    }
    const control = await planLiveFlightControl({
      planner,
      port,
      state: stateOf({ x: 0, y: 82, z: 0 }),
      poll: 1,
      fireworks: 16,
      health: 20,
      goal: { x: 120, y: 80, z: 0 },
      lastRocketAt: undefined,
      now: () => 0,
    })
    expect(control).toBeUndefined()
  })
})
