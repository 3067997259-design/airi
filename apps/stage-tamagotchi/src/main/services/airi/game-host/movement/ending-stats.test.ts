import { describe, expect, it } from 'vitest'

import { endingStatsOf, SETTLE_TICKS } from './ending-stats'

/**
 * Ending accounting regressions (ab-23 repair plan, batch A4/A5).
 *
 * The ab-23 facts: the full arm dropped 20 -> 13.36 at t26086 while still
 * airborne and unowned, then regenerated to 16.36; the segmented arm dropped
 * 20 -> 19.31 at t26427. Regeneration must not erase the event, and the
 * settled-vs-airborne verdict must come from stable native ticks.
 */

function sample(tick: number, health: number, onGround: boolean, vy: number) {
  return { tick, health, onGround, inWater: false, vx: 0, vy, vz: 0 }
}

describe('endingStatsOf', () => {
  it('counts the ab-23 full-arm drop even though regeneration raised the final hp', () => {
    // Extract: ab-23 samples, t26080-26100, full arm.
    const samples = [
      sample(26080, 20, false, -0.16),
      sample(26085, 20, false, -0.16),
      sample(26086, 13.36, false, -0.16),
      sample(26090, 13.36, false, -0.16),
      sample(26100, 15.36, true, -0.08),
    ]
    const stats = endingStatsOf(samples)
    expect(stats.endingObservedDamage).toBeCloseTo(6.64, 5)
    expect(stats.firstDamageTick).toBe(26086)
    expect(stats.endingMinHealth).toBeCloseTo(13.36, 5)
    expect(stats.endingHealthDropFromStart).toBeCloseTo(6.64, 5)
  })

  it('counts the ab-23 segmented-arm brush', () => {
    const stats = endingStatsOf([
      sample(26420, 20, false, -0.05),
      sample(26427, 19.31, false, -0.05),
      sample(26430, 19.31, false, -0.05),
    ])
    expect(stats.endingObservedDamage).toBeCloseTo(0.69, 5)
    expect(stats.firstDamageTick).toBe(26427)
  })

  it('requires a stable run of native ticks before any settled verdict', () => {
    const stableGround = Array.from({ length: SETTLE_TICKS }, (_, index) => sample(30000 + index, 20, true, -0.08))
    const stats = endingStatsOf(stableGround)
    expect(stats.stableSettled).toBe(true)
    expect(stats.settledGround).toBe(true)
    expect(stats.settledWater).toBe(false)
    expect(stats.unresolvedAirborne).toBe(false)
    expect(stats.damageFreeObserved).toBe(true)
  })

  it('rejects a settled verdict when the stable run is broken by a gap', () => {
    const samples = Array.from({ length: SETTLE_TICKS }, (_, index) => sample(30000 + index, 20, true, -0.08))
    samples.splice(10, 1)
    const stats = endingStatsOf(samples)
    expect(stats.missingTickRanges).toEqual([{ from: 30010, to: 30010 }])
    expect(stats.stableTicks).toBeLessThan(SETTLE_TICKS)
    expect(stats.damageFreeObserved).toBe(false)
  })

  it('treats a missing velocity as unknown, not as a stopped aircraft', () => {
    const samples = Array.from({ length: SETTLE_TICKS }, (_, index) => sample(30000 + index, 20, true, -0.08))
    const last = samples[SETTLE_TICKS - 1]!
    samples[SETTLE_TICKS - 1] = { tick: last.tick, health: last.health, onGround: true, inWater: false } as typeof last
    const stats = endingStatsOf(samples)
    expect(stats.stableTicks).toBe(0)
    expect(stats.stableSettled).toBe(false)
    expect(stats.fullyObserved).toBe(false)
  })

  it('keeps water settlement a separate outcome from ground settlement', () => {
    const samples = Array.from({ length: SETTLE_TICKS }, (_, index) => ({
      tick: 40000 + index,
      health: 20,
      onGround: false,
      inWater: true,
      vx: 0.1,
      vy: 0,
      vz: 0.1,
    }))
    const stats = endingStatsOf(samples)
    expect(stats.settledWater).toBe(true)
    expect(stats.settledGround).toBe(false)
    expect(stats.damageFreeObserved).toBe(true)
  })

  it('reports an airborne ending as unresolved rather than settled', () => {
    const stats = endingStatsOf([
      sample(50000, 20, false, -0.5),
      sample(50001, 20, false, -0.5),
    ])
    expect(stats.unresolvedAirborne).toBe(true)
    expect(stats.stableSettled).toBe(false)
    expect(stats.damageFreeObserved).toBe(false)
  })

  it('counts duplicate native ticks without letting them extend a stable run', () => {
    const samples = Array.from({ length: SETTLE_TICKS }, (_, index) => sample(60000 + index, 20, true, -0.08))
    samples.push(sample(60019, 20, true, -0.08))
    const stats = endingStatsOf(samples)
    expect(stats.duplicateTicks).toBe(1)
    expect(stats.stableSettled).toBe(true)
    expect(stats.damageFreeObserved).toBe(false)
  })
})
