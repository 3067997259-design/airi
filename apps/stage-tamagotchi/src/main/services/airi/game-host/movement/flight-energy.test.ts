import { describe, expect, it } from 'vitest'

import { CRUISE_DROP_PER_BLOCK, CRUISE_HEIGHT_MARGIN, CRUISE_MARGIN_EXTRA_MAX, energyMarginForAge, planCruiseThrust, routeDetourRatio } from './flight-energy'

describe('planCruiseThrust', () => {
  it('glides when the height covers the remaining distance', () => {
    // 120 blocks of gap need 31.2 blocks of height; 40 is a comfortable surplus,
    // so the old "climbing or out of band" thresholds must not spend here.
    const plan = planCruiseThrust({ gap: 120, height: 40, speed: 0.9, closingRatePerSecond: 3, fireworks: 20, reserve: 2 })
    expect(plan).toEqual({
      thrust: false,
      reason: 'economy',
      requiredHeight: 120 * CRUISE_DROP_PER_BLOCK,
      surplusHeight: 40 - 120 * CRUISE_DROP_PER_BLOCK,
      spendable: 18,
    })
  })

  it('burns for height when the glide would come up short', () => {
    const plan = planCruiseThrust({ gap: 200, height: 30, speed: 1.1, closingRatePerSecond: 5, fireworks: 20, reserve: 2 })
    expect(plan.thrust).toBe(true)
    expect(plan.reason).toBe('required_height')
    expect(plan.surplusHeight).toBeLessThan(CRUISE_HEIGHT_MARGIN)
  })

  it('burns for speed when the wing drops below the glide floor', () => {
    const plan = planCruiseThrust({ gap: 20, height: 60, speed: 0.2, closingRatePerSecond: 4, fireworks: 20, reserve: 2 })
    expect(plan.reason).toBe('glide_floor')
  })

  it('burns to close when the chase is not closing', () => {
    const plan = planCruiseThrust({ gap: 20, height: 60, speed: 1.2, closingRatePerSecond: -0.4, fireworks: 20, reserve: 2 })
    expect(plan.reason).toBe('not_closing')
  })

  it('treats a missing closing rate as unmeasured, not as not-closing', () => {
    // Design D4/D7: without a fresh sample there is no closure fact, and a band
    // violation is the only usable evidence that the target got away.
    const blind = planCruiseThrust({ gap: 20, height: 60, speed: 1.2, fireworks: 20, reserve: 2 })
    expect(blind).toMatchObject({ thrust: false, reason: 'economy' })
    const banded = planCruiseThrust({ gap: 20, height: 60, speed: 1.2, behindBand: true, fireworks: 20, reserve: 2 })
    expect(banded.reason).toBe('not_closing')
  })

  it('never spends the landing reserve on progress', () => {
    const plan = planCruiseThrust({ gap: 200, height: 0, speed: 0.1, closingRatePerSecond: -1, fireworks: 2, reserve: 2 })
    expect(plan).toEqual({
      thrust: false,
      reason: 'economy',
      requiredHeight: 52,
      surplusHeight: -52,
      spendable: 0,
    })
  })

  it('keeps the height case ahead of the other two, so the reason names the first need', () => {
    const plan = planCruiseThrust({ gap: 200, height: 0, speed: 0, closingRatePerSecond: -2, fireworks: 20, reserve: 2 })
    expect(plan.reason).toBe('required_height')
  })
})

describe('energyMarginForAge', () => {
  it('keeps the base margin for a fresh sample and widens it with age', () => {
    expect(energyMarginForAge(0)).toBe(CRUISE_HEIGHT_MARGIN)
    expect(energyMarginForAge(undefined)).toBe(CRUISE_HEIGHT_MARGIN)
    expect(energyMarginForAge(2_000)).toBe(CRUISE_HEIGHT_MARGIN + 3)
    expect(energyMarginForAge(60_000)).toBe(CRUISE_HEIGHT_MARGIN + CRUISE_MARGIN_EXTRA_MAX)
  })
})

describe('routeDetourRatio', () => {
  it('reports 1 when the route aim sits on the straight line', () => {
    const ratio = routeDetourRatio({ self: { x: 0, y: 100, z: 0 }, aim: { x: 50, y: 100, z: 0 }, goal: { x: 100, y: 100, z: 0 } })
    expect(ratio).toBeCloseTo(1, 6)
  })

  it('grows when the route swings aside, and stops at the ceiling', () => {
    const dogleg = routeDetourRatio({ self: { x: 0, y: 100, z: 0 }, aim: { x: 50, y: 100, z: 50 }, goal: { x: 100, y: 100, z: 0 } })
    expect(dogleg).toBeGreaterThan(1.3)
    const absurd = routeDetourRatio({ self: { x: 0, y: 100, z: 0 }, aim: { x: 0, y: 100, z: 900 }, goal: { x: 1, y: 100, z: 0 } })
    expect(absurd).toBe(2.5)
  })

  it('stays at 1 when the goal is closer than a block, where the ratio has no meaning', () => {
    expect(routeDetourRatio({ self: { x: 0, y: 100, z: 0 }, aim: { x: 0, y: 100, z: 0 }, goal: { x: 0.5, y: 100, z: 0 } })).toBe(1)
  })
})
