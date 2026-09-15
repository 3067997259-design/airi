import { describe, expect, it } from 'vitest'

import {
  FLIGHT_CLIMB_FACTOR,
  FLIGHT_DIVE_FACTOR,
  FLIGHT_GRAVITY,
  FLIGHT_HORIZONTAL_DRAG,
  FLIGHT_LIFT_FACTOR,
  FLIGHT_PROFILE_1_21_1,
  FLIGHT_PROFILE_VERSION,
  FLIGHT_ROCKET_PULL,
  FLIGHT_ROCKET_TARGET_SPEED,
  FLIGHT_VERTICAL_DRAG,
  resolveFlightProfile,
} from './profile'

describe('flight profile constants', () => {
  it('binds the 1.21.1 vanilla values', () => {
    expect(FLIGHT_PROFILE_VERSION).toBe('1.21.1')
    expect(FLIGHT_GRAVITY).toBe(0.08)
    expect(FLIGHT_LIFT_FACTOR).toBe(0.75)
    expect(FLIGHT_DIVE_FACTOR).toBe(-0.1)
    expect(FLIGHT_CLIMB_FACTOR).toBe(0.04)
    expect(FLIGHT_HORIZONTAL_DRAG).toBe(0.99)
    expect(FLIGHT_VERTICAL_DRAG).toBe(0.98)
    expect(FLIGHT_ROCKET_TARGET_SPEED).toBe(1.5)
    expect(FLIGHT_ROCKET_PULL).toBe(0.5)
  })

  it('names the source class and method', () => {
    expect(FLIGHT_PROFILE_1_21_1.source).toContain('LivingEntity#travel')
    expect(FLIGHT_PROFILE_1_21_1.source).toContain('FireworkRocketEntity#tick')
  })
})

describe('resolveFlightProfile', () => {
  it('resolves the vanilla 1.21.1 profile', () => {
    const resolution = resolveFlightProfile('1.21.1', [])
    expect(resolution.ok).toBe(true)
    expect(resolution.ok && resolution.profile.modifiers).toEqual([])
  })

  it('refuses an unknown version instead of guessing physics', () => {
    const resolution = resolveFlightProfile('1.20.1', [])
    expect(resolution).toEqual({ ok: false, reason: 'unsupported_flight_profile', requested: '1.20.1' })
  })

  it('refuses an unknown movement-affecting mod', () => {
    const resolution = resolveFlightProfile('1.21.1', ['some-elytra-tweaks'])
    expect(resolution.ok).toBe(false)
  })
})
