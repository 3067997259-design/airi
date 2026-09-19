/**
 * Escort estimators, gating and the live strategy (LR-1 wiring, escort design D2/D4/D5).
 *
 * Pure policy math for the escort strategy: the optimistic feasibility gate
 * decides whether a chase may even start, and the closure-window evaluator
 * decides while flying whether the chase is converging. Both are deliberately
 * lower-bound/upper-bound honest: the gate only refuses, never promises a
 * catch-up, and the evaluator only declares "not converging" after two full
 * non-closing windows (design D4).
 *
 * {@link createEscortPolicy} is the consumer the live drivers hold: the host
 * feeds it one target observation before a takeoff, the air driver feeds it one
 * distance sample per poll. One policy belongs to one follow command, because
 * its closure history is only meaningful across that command's own samples.
 * The detour factor comes from the corridor's measured route bend when the
 * driver has one (LR-4); a suggestion's delivery is the driver's job (LR-2), and
 * the policy only counts what actually left the application.
 */
import type { TargetObservation } from './target-observation'
import type { Vec3 } from './types'

import { ROCKET_BOOST_TICKS } from '../flight/simulation'

/** One target observation the estimators consume (design D2 input). */
export interface EscortTargetSample {
  position: { x: number, y: number, z: number }
  /** Horizontal velocity, blocks per second. */
  speed: number
  /** Horizontal heading unit vector; present when the target is moving. */
  direction?: { x: number, z: number }
}

/** Self facts the gate consumes. */
export interface EscortSelfState {
  position: { x: number, y: number, z: number }
  /** Rockets in the inventory right now. */
  fireworks: number
  /** Rockets kept for the nearest verified landing; never spent on progress. */
  reserve: number
  /** True when the elytra is wearable for an attempted launch. */
  canFly: boolean
}

/** Ceiling on a measured detour ratio, so one odd aim point cannot inflate the estimate. */
export const DETOUR_RATIO_MAX = 2.5

/** D2 estimate inputs a caller may override (escort design D2). */
export interface EscortGateConfig {
  detourFactor: number
  safetyMargin: number
  boostedSpeedPerTick: number
  rocketBoostTicks: number
}

/** Default escort gating parameters (first-round engineering values). */
export const DEFAULT_ESCORT_GATE: EscortGateConfig = {
  /** Terrain detour multiplier applied to the straight-line gap (design D2). */
  detourFactor: 1.3,
  /** Extra supply margin on top of the optimistic requirement. */
  safetyMargin: 0.25,
  /** Sustained boosted cruise speed, blocks per tick (`rocketTargetSpeed`). */
  boostedSpeedPerTick: 1.5,
  /**
   * Boost lifetime per rocket in ticks.
   *
   * NOTICE:
   * Why 35 and not 10: the E-01 calibration (2026-09-18) measured the boost
   * platform at 35 ticks for a rocket with `flight_duration: 2`, and the flight
   * simulation was corrected to match (`ROCKET_BOOST_TICKS`). The gate kept the
   * old 10, which made the optimistic estimate need 3.5x more rockets than the
   * calibrated profile actually spends — a feasibility gate that refuses chases
   * the glider can fly.
   * Source: docs/fork/evidence/e01-flight-calibration-20260918/e01-residuals.md
   * Removal condition: when the gate reads the window from the resolved flight
   * profile instead of a constant.
   */
  rocketBoostTicks: ROCKET_BOOST_TICKS,
}

export type EscortGateOutcome
  = | {
    ok: true
    /** Optimistic rockets the chase could need (a lower bound, not a promise). */
    optimisticRockets: number
    /** Optimistic ticks to close the gap, assuming full boost the whole way. */
    optimisticCatchTicks: number
  }
  | { ok: false, reason: 'cannot_catch_up' | 'cannot_fly' | 'no_supply', requiredRockets?: number }

/**
 * Optimistic feasibility gate (escort design D2).
 *
 * Estimates the chase under the most favourable assumptions — the target keeps
 * its current speed, the glider sustains full boost the whole way, the terrain
 * detour is only the configured factor — and refuses when even that overruns
 * the spendable supply (`fireworks - reserve`, widened by the safety margin).
 * An optimistic pass is permission to try, never a promise to catch up; the
 * closure evaluator below owns the honest in-flight verdict.
 *
 * @example
 * escortGate({ target: { position: P, speed: 5 }, self: { position: Q, fireworks: 20, reserve: 2, canFly: true } }).ok
 * // => true
 */
export function escortGate(input: {
  target: EscortTargetSample
  self: EscortSelfState
  config?: Partial<EscortGateConfig>
}): EscortGateOutcome {
  const config = { ...DEFAULT_ESCORT_GATE, ...input.config }
  if (!input.self.canFly)
    return { ok: false, reason: 'cannot_fly' }
  const spendable = input.self.fireworks - input.self.reserve
  if (spendable <= 0)
    return { ok: false, reason: 'no_supply' }

  const dx = input.target.position.x - input.self.position.x
  const dz = input.target.position.z - input.self.position.z
  const gap = Math.hypot(dx, dz) * config.detourFactor

  // Closing speed under the optimistic model: full boost toward the target
  // while the target keeps its current heading. A target fleeing along the
  // self-to-target axis narrows the closure by its speed; one approaching
  // only makes it easier.
  const selfSpeed = config.boostedSpeedPerTick * 20
  const gapLength = Math.hypot(dx, dz) || 1
  const away = input.target.direction
    ? (input.target.direction.x * dx + input.target.direction.z * dz) / gapLength
    : 0
  const closing = selfSpeed - away * input.target.speed
  if (closing <= 0)
    return { ok: false, reason: 'cannot_catch_up' }

  const catchSeconds = gap / closing
  const optimisticCatchTicks = Math.ceil(catchSeconds * 20)
  const optimisticRockets = Math.ceil(optimisticCatchTicks / config.rocketBoostTicks)
  const required = Math.ceil(optimisticRockets * (1 + config.safetyMargin))
  if (spendable < required)
    return { ok: false, reason: 'cannot_catch_up', requiredRockets: required }
  return { ok: true, optimisticRockets, optimisticCatchTicks }
}

/** One distance sample the closure evaluator consumes. */
export interface ClosureSample {
  at: number
  /** Horizontal distance to the target, blocks. */
  distance: number
}

export type ClosureStatus = 'closing' | 'stalled' | 'escort_inconclusive'

/** D4 window inputs a caller may override (escort design D4). */
export interface ClosureWindowConfig {
  windowMs: number
  stalledWindowsLimit: number
}

export const DEFAULT_CLOSURE_WINDOW: ClosureWindowConfig = {
  /** Evaluation window (design D4 suggests 5 s). */
  windowMs: 5_000,
  /** Consecutive non-closing windows before the chase is called off. */
  stalledWindowsLimit: 2,
}

/**
 * Rolling closure-window evaluator (escort design D4).
 *
 * Every push re-evaluates the trailing window's closure rate; a window whose
 * rate is at or below zero is a stalled window. After the configured number of
 * consecutive stalled windows the evaluator returns
 * `escort_inconclusive` — the caller must enter a safety landing instead of
 * burning more rockets on a chase that is not converging.
 */
export function createClosureEvaluator(options: Partial<typeof DEFAULT_CLOSURE_WINDOW> = {}) {
  const config = { ...DEFAULT_CLOSURE_WINDOW, ...options }
  const samples: ClosureSample[] = []
  let stalledWindows = 0

  return {
    /** Feeds one distance sample and returns the current verdict. */
    push(sample: ClosureSample): { status: ClosureStatus, closureRatePerSecond: number | undefined } {
      samples.push(sample)
      while (samples.length > 2 && sample.at - samples[0]!.at > config.windowMs)
        samples.shift()

      let rate: number | undefined
      if (samples.length >= 2) {
        const oldest = samples[0]!
        const spanSeconds = (sample.at - oldest.at) / 1000
        if (spanSeconds > 0)
          rate = (oldest.distance - sample.distance) / spanSeconds
      }

      if (rate !== undefined && rate <= 0) {
        stalledWindows += 1
        if (stalledWindows >= config.stalledWindowsLimit)
          return { status: 'escort_inconclusive', closureRatePerSecond: rate }
        return { status: 'stalled', closureRatePerSecond: rate }
      }
      stalledWindows = 0
      return { status: 'closing', closureRatePerSecond: rate }
    },
    reset(): void {
      samples.length = 0
      stalledWindows = 0
    },
  }
}

/** How the escort strategy is allowed to act (escort design D1). */
export type EscortMode = 'off' | 'suggest' | 'on'

/** The gate verdict the controller reads before it may assess a takeoff. */
export type EscortPermission
  = | { ok: true }
    | { ok: false, reason: 'cannot_catch_up' | 'cannot_fly' | 'no_supply', requiredRockets?: number }

/** One closure sample the driver owns and records on the receipt (design D5). */
export interface EscortClosureRecord {
  at: number
  distance: number
  status: ClosureStatus
  /** Absent until two samples span a measurable window. */
  closureRatePerSecond?: number
}

export interface EscortPolicy {
  /**
   * Feeds one target observation and returns whether a takeoff may start.
   *
   * `undefined` means "not assessed": no target position was readable, so the
   * policy has no basis to permit or refuse a launch. The controller keeps its
   * normal launch flow in that case (see {@link AirFollowControllerOptions.escort}).
   */
  assessLaunch: (input: {
    observation: TargetObservation
    self: { position: Vec3, fireworks: number, reserve: number, canFly: boolean }
  }) => EscortPermission | undefined
  /** Feeds one in-flight distance sample; returns the closure series so far. */
  feed: (input: { at: number, distance: number }) => { status: ClosureStatus, records: EscortClosureRecord[] }
  /** True once the evaluator has called the chase off (design D4). */
  inconclusive: () => boolean
  /** Fireworks still reserved for the nearest landing site. */
  reserve: () => number
  /** Records that one cooperative suggestion left the application (LR-2). */
  noteSuggestionSent: () => void
  suggestionsSent: () => number
  /**
   * Feeds the corridor's measured route bend into the D2 estimate (LR-4).
   *
   * A value below 1 is not a detour, so it is clamped away; the caller measures
   * with {@link ../movement/flight-energy.routeDetourRatio} and the policy owns
   * the clamp so one odd aim point cannot make the gate refuse everything.
   */
  noteDetourRatio: (ratio: number) => void
  /** The detour factor the next gate call will use. */
  detourRatio: () => number
}

/**
 * Builds fast horizontal closing speed into a target sample.
 *
 * `TargetObservation.velocity` is a per-tick delta, so the estimators take
 * blocks per second; a missing or zero velocity means "not measurably moving",
 * which keeps the gate optimistic instead of inventing a fleeing target.
 */
export function escortSampleFromObservation(observation: TargetObservation): EscortTargetSample | undefined {
  if (!observation.position)
    return undefined
  const velocity = observation.velocity
  const perTick = velocity ? Math.hypot(velocity.x, velocity.z) : 0
  const speed = perTick * 20
  // A speed below the noise floor carries no usable heading.
  const direction = velocity && perTick > 0.001
    ? { x: velocity.x / perTick, z: velocity.z / perTick }
    : undefined
  return {
    position: { ...observation.position },
    speed,
    ...(direction ? { direction } : {}),
  }
}

/**
 * Creates the escort policy one follow command holds (LR-1 wiring).
 *
 * @example
 * const escort = createEscortPolicy({ mode: 'on', reserve: 2 })
 * escort.assessLaunch({ observation, self: { position, fireworks: 20, reserve: 2, canFly: true } })?.ok
 */
export function createEscortPolicy(options: {
  mode: EscortMode
  /** Fireworks the launch assessment treats as unspendable. */
  reserve: number
  /** Overrides for the D2 estimate; the design defaults apply when absent. */
  gate?: { detourFactor?: number, safetyMargin?: number, boostedSpeedPerTick?: number, rocketBoostTicks?: number }
  /** Overrides for the D4 window; the design defaults apply when absent. */
  closure?: { windowMs?: number, stalledWindowsLimit?: number }
  /** Ceiling on a measured detour ratio; the D2 default applies when absent. */
  detourMax?: number
}): EscortPolicy {
  const evaluator = createClosureEvaluator(options.closure)
  const records: EscortClosureRecord[] = []
  let inconclusive = false
  let suggestions = 0
  const detourMax = options.detourMax ?? DETOUR_RATIO_MAX
  // The configured constant is the fallback: a command that never sees a
  // corridor route keeps the design's first-round value.
  let detour = options.gate?.detourFactor ?? DEFAULT_ESCORT_GATE.detourFactor

  return {
    assessLaunch: (input) => {
      const target = escortSampleFromObservation(input.observation)
      if (!target) {
        // Without a position the gate cannot estimate; the controller's own
        // launch assessment still owns the decision.
        return undefined
      }
      return escortGate({
        target,
        self: { position: input.self.position, fireworks: input.self.fireworks, reserve: input.self.reserve, canFly: input.self.canFly },
        // The measured detour wins over the configured one when a corridor route
        // has been seen (LR-4); the rest of the config stays as given.
        config: { ...options.gate, detourFactor: detour },
      })
    },
    feed: ({ at, distance }) => {
      const verdict = evaluator.push({ at, distance })
      records.push({
        at,
        distance,
        status: verdict.status,
        ...(verdict.closureRatePerSecond !== undefined ? { closureRatePerSecond: verdict.closureRatePerSecond } : {}),
      })
      if (verdict.status === 'escort_inconclusive')
        inconclusive = true
      return { status: verdict.status, records }
    },
    inconclusive: () => inconclusive,
    reserve: () => options.reserve,
    noteSuggestionSent: () => {
      suggestions += 1
    },
    suggestionsSent: () => suggestions,
    noteDetourRatio: (ratio) => {
      if (!Number.isFinite(ratio))
        return
      detour = Math.min(detourMax, Math.max(1, ratio))
    },
    detourRatio: () => detour,
  }
}
