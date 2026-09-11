import type { LifeModeConfigContract } from '../../../../shared/eventa'

import { describe, expect, it } from 'vitest'

import { evaluateLifeTickGate, isInQuietHours, resolveNextLifeHeartbeatAt } from './gates'

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
  it('blocks off mode before any other gate', () => {
    expect(evaluateLifeTickGate({ ...BASE_CONFIG, mode: 'off' }, state({ budgetUsed: 5 }))).toEqual({
      pass: false,
      gate: 'mode',
    })
  })

  it('passes respond mode without spending economic gates', () => {
    expect(evaluateLifeTickGate({ ...BASE_CONFIG, mode: 'respond' }, state({ budgetUsed: 5 }))).toEqual({ pass: true })
  })

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

  it('applies quiet hours before the budget gate', () => {
    const nightConfig = { ...BASE_CONFIG, quietHoursStart: 0, quietHoursEnd: 6 }
    const gated = evaluateLifeTickGate(nightConfig, state({
      now: new Date(2026, 7, 29, 3).getTime(),
      budgetUsed: BASE_CONFIG.dailyBudget,
      budgetDateKey: '2026-08-29',
    }))
    expect(gated).toEqual({ pass: false, gate: 'quiet-hours' })
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

describe('resolveNextLifeHeartbeatAt', () => {
  it('keeps a persisted future heartbeat across a restart', () => {
    const now = new Date(2026, 8, 4, 12).getTime()
    const persisted = now + 8 * 60_000

    expect(resolveNextLifeHeartbeatAt(BASE_CONFIG, {
      now,
      persistedNextHeartbeatAt: persisted,
      startupGraceMs: 30_000,
    })).toBe(persisted)
  })

  it('schedules one overdue heartbeat after the startup grace', () => {
    const now = new Date(2026, 8, 4, 12).getTime()

    expect(resolveNextLifeHeartbeatAt(BASE_CONFIG, {
      now,
      persistedNextHeartbeatAt: now - HOUR,
      startupGraceMs: 30_000,
    })).toBe(now + 30_000)
  })

  it('moves a heartbeat out of quiet hours', () => {
    const now = new Date(2026, 8, 4, 1).getTime()
    const config = { ...BASE_CONFIG, quietHoursStart: 0, quietHoursEnd: 23 }

    expect(resolveNextLifeHeartbeatAt(config, {
      now,
      persistedNextHeartbeatAt: now - HOUR,
      startupGraceMs: 30_000,
    })).toBe(new Date(2026, 8, 4, 23).getTime())
  })
})
