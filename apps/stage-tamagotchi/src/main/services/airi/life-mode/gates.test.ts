import type { LifeModeConfigContract } from '../../../../shared/eventa'

import { describe, expect, it } from 'vitest'

import { evaluateLifeTickGate, isInQuietHours } from './gates'

const BASE_CONFIG: LifeModeConfigContract = {
  mode: 'autonomous',
  intervalMinutes: 15,
  quietHoursStart: 0,
  quietHoursEnd: 0,
  dailyBudget: 5,
  cooldownMinutes: 10,
}

const HOUR = 60 * 60 * 1000

function state(overrides: Partial<{ now: number, lastTickAt?: number, budgetUsed: number, budgetDateKey: string }> = {}) {
  return {
    now: overrides.now ?? 0,
    lastTickAt: overrides.lastTickAt,
    budgetUsed: overrides.budgetUsed ?? 0,
    budgetDateKey: overrides.budgetDateKey ?? '',
  }
}

describe('evaluateLifeTickGate', () => {
  it('allows a tick when every gate passes', () => {
    expect(evaluateLifeTickGate(BASE_CONFIG, state())).toEqual({ pass: true })
  })

  it('blocks when the daily budget is exhausted, counting only today', () => {
    // Local-noon instants so the day key is stable in any timezone.
    const today = new Date(2026, 7, 29, 12).getTime()
    const gated = evaluateLifeTickGate(BASE_CONFIG, state({ now: today, budgetUsed: 5, budgetDateKey: '2026-08-29' }))
    expect(gated).toEqual({ pass: false, gate: 'budget' })

    // A counter from yesterday must not block today's tick.
    const passed = evaluateLifeTickGate(BASE_CONFIG, state({ now: today, budgetUsed: 5, budgetDateKey: '2026-08-28' }))
    expect(passed).toEqual({ pass: true })
  })

  it('treats a zero budget as unlimited', () => {
    expect(evaluateLifeTickGate({ ...BASE_CONFIG, dailyBudget: 0 }, state({ budgetUsed: 999 })).pass).toBe(true)
  })

  it('blocks inside quiet hours and passes outside them', () => {
    const nightConfig = { ...BASE_CONFIG, quietHoursStart: 23, quietHoursEnd: 6 }
    const atNight = evaluateLifeTickGate(nightConfig, state({ now: new Date(2026, 7, 29, 3).getTime() }))
    expect(atNight).toEqual({ pass: false, gate: 'quiet-hours' })

    const midDay = evaluateLifeTickGate(nightConfig, state({ now: new Date(2026, 7, 29, 12).getTime() }))
    expect(midDay).toEqual({ pass: true })
  })

  it('treats equal quiet-hour bounds as disabled', () => {
    expect(evaluateLifeTickGate(BASE_CONFIG, state({ now: 3 * HOUR })).pass).toBe(true)
  })

  it('blocks during the cooldown window', () => {
    const now = 10 * HOUR
    const gated = evaluateLifeTickGate(BASE_CONFIG, state({ now, lastTickAt: now - 5 * 60_000 }))
    expect(gated).toEqual({ pass: false, gate: 'cooldown' })

    const passed = evaluateLifeTickGate(BASE_CONFIG, state({ now, lastTickAt: now - 15 * 60_000 }))
    expect(passed).toEqual({ pass: true })
  })
})

describe('isInQuietHours', () => {
  it('handles windows that do not wrap midnight', () => {
    const at = (hour: number) => new Date(2026, 7, 29, hour).getTime()
    expect(isInQuietHours(at(3), 0, 6)).toBe(true)
    expect(isInQuietHours(at(12), 0, 6)).toBe(false)
  })

  it('handles windows that wrap midnight', () => {
    const at = (hour: number) => new Date(2026, 7, 29, hour).getTime()
    expect(isInQuietHours(at(23), 23, 6)).toBe(true)
    expect(isInQuietHours(at(1), 23, 6)).toBe(true)
    expect(isInQuietHours(at(12), 23, 6)).toBe(false)
  })
})
