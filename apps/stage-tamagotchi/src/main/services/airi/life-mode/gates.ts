/**
 * Cheap cost gates for the life-mode heartbeat (LIFE-PLAN §三).
 *
 * Pure and Electron-free so every gate is unit-testable: quiet hours,
 * per-day budget, and cooldown run here — before any consideration round
 * can spend model tokens. `busy` (active stream) and stimulus availability
 * are renderer-side gates because only the renderer knows them.
 */
import type { LifeModeConfigContract } from '../../../../shared/eventa'

export type LifeTickGate = 'mode' | 'quiet-hours' | 'budget' | 'cooldown'

export interface LifeTickGateState {
  now: number
  lastTickAt?: number
  /** Budget consumed for `budgetDateKey`. */
  budgetUsed: number
  /** YYYY-MM-DD local-day key the budget counter belongs to. */
  budgetDateKey: string
}

export interface LifeTickGateResult {
  pass: boolean
  gate?: LifeTickGate
}

export function localDayKeyForNow(now: number): string {
  const date = new Date(now)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * Evaluates the cheap gate chain in order: quiet hours -> budget -> cooldown.
 * A failed gate stops the chain; the returned `gate` names it. Callers decide
 * the mode: `off` never reaches here (the service stays silent), `respond`
 * emits every tick unconditionally (journal-only, no model tokens), and only
 * `autonomous` runs this economic gate chain.
 *
 * @example
 * evaluateLifeTickGate({ mode: 'autonomous', ... }, { now: 0, budgetUsed: 0, budgetDateKey: 'x' })
 * // => { pass: true }
 */
export function evaluateLifeTickGate(
  config: LifeModeConfigContract,
  state: LifeTickGateState,
): LifeTickGateResult {
  const today = localDayKeyForNow(state.now)
  const budgetUsed = state.budgetDateKey === today ? state.budgetUsed : 0
  if (config.dailyBudget > 0 && budgetUsed >= config.dailyBudget)
    return { pass: false, gate: 'budget' }

  if (config.quietHoursStart !== config.quietHoursEnd && isInQuietHours(state.now, config.quietHoursStart, config.quietHoursEnd))
    return { pass: false, gate: 'quiet-hours' }

  if (config.cooldownMinutes > 0 && state.lastTickAt != null) {
    const elapsedMinutes = (state.now - state.lastTickAt) / 60_000
    if (elapsedMinutes < config.cooldownMinutes)
      return { pass: false, gate: 'cooldown' }
  }

  return { pass: true }
}

export function isInQuietHours(now: number, start: number, end: number): boolean {
  const hours = new Date(now).getHours() + new Date(now).getMinutes() / 60
  // Half-open window; a window spanning midnight wraps.
  if (start < end)
    return hours >= start && hours < end
  return hours >= start || hours < end
}
