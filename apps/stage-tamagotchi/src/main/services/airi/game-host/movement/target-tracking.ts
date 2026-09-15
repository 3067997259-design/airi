/**
 * Target source switching, bounded waiting and trajectory history
 * (target-tracking design §4/§5, CD-L2 and CD-L3).
 *
 * This module owns the policy, not the transport:
 *
 * - fine tracking samples the loaded target and the main process samples a
 *   summary; a stale or out-of-order sample is dropped;
 * - a coarse locate runs at most once per second, never overlaps itself and
 *   backs off after a failure;
 * - fine and coarse switch with explicit hysteresis constants, so the source
 *   does not flap;
 * - a coarse sample that stays stale past the start window becomes
 *   `waiting_for_target` with a bounded budget;
 * - the trajectory history keeps a short window of client samples and resets
 *   on teleport, ride switch and landing.
 *
 * Prediction stays in the consumer. This module only presents observations,
 * history and an error estimate.
 */
import type { TargetObservation } from './target-observation'
import type { Vec3 } from './types'

import { estimatePositionUncertainty, speedBlocksPerSecond } from './target-observation'

/** Fine samples absent in a row before the tracker falls back to coarse. */
export const FINE_MAX_MISSES = 3
/** Age of the last fine sample before the tracker falls back to coarse. */
export const FINE_MAX_AGE_MS = 500
/** Increasing fresh fine samples required before the tracker returns to fine. */
export const COARSE_FINE_MIN_SAMPLES = 2
/** Minimum interval between coarse locates for one target. */
export const COARSE_POLL_INTERVAL_MS = 1000
/** Bounded backoff schedule after consecutive coarse locate failures. */
export const COARSE_BACKOFF_MS = [1000, 2000, 4000] as const
/** Coarse staleness before the tracker reports `waiting_for_target`. */
export const WAITING_START_MS = 3000
/** Default waiting budget once `waiting_for_target` begins. */
export const WAITING_BUDGET_MS = 10000
/** Distance a client sample may jump before it looks like a teleport. */
export const TRAJECTORY_TELEPORT_DISTANCE = 16
/** Window in which a distance jump counts as a teleport, not fast motion. */
export const TRAJECTORY_TELEPORT_WINDOW_MS = 1000
/** Default number of samples the trajectory history keeps. */
export const TRAJECTORY_MAX_SAMPLES = 40

/** Typed result of one tracking step (design §4). */
export type TargetTrackingOutcome
  = | 'fine'
    | 'coarse'
    | 'waiting_for_target'
    | 'target_offline'
    | 'target_dimension_changed'
    | 'locator_unavailable'
    | 'entity_unloaded'

/** One sample identity used to reject stale and out-of-order reads. */
export interface TargetSampleStamp {
  sourceTick?: number
  receivedAt: number
}

/**
 * True when `next` is newer than `prev`.
 *
 * When both samples carry a source tick, only a larger tick is newer. The
 * receive time is the fallback. A duplicate (equal tick or equal receive time)
 * is not newer, so it is dropped.
 */
export function isNewerTargetSample(prev: TargetSampleStamp | undefined, next: TargetSampleStamp): boolean {
  if (!prev)
    return true
  if (prev.sourceTick !== undefined && next.sourceTick !== undefined)
    return next.sourceTick > prev.sourceTick
  return next.receivedAt > prev.receivedAt
}

export interface TargetTrackerOptions {
  fineMaxMisses?: number
  fineMaxAgeMs?: number
  coarseFineMinSamples?: number
  waitingStartMs?: number
  waitingBudgetMs?: number
}

export interface TargetTrackerSnapshot {
  mode: 'fine' | 'coarse'
  fineMisses: number
  recoverySamples: number
  lastFine?: TargetObservation
  lastCoarse?: TargetObservation
  waitingSince?: number
  forced?: TargetTrackingOutcome
}

export interface TargetTracker {
  readonly snapshot: () => TargetTrackerSnapshot
  /** Accepts a fine sample; false when it was stale or out of order. */
  acceptFine: (observation: TargetObservation, now: number) => boolean
  /** Records one fine miss and updates the mode. Returns the new mode. */
  missFine: (now: number) => 'fine' | 'coarse'
  /** Accepts a coarse sample; false when it was stale or out of order. */
  acceptCoarse: (observation: TargetObservation, now: number) => boolean
  /** Forces a terminal typed outcome (offline, dimension change, ...). */
  forceOutcome: (outcome: TargetTrackingOutcome) => void
  /** Current typed outcome at `now`. */
  outcome: (now: number) => TargetTrackingOutcome
  /** True when the waiting budget started and is now exhausted. */
  waitingBudgetExceeded: (now: number) => boolean
}

/**
 * Creates the fine/coarse source tracker.
 *
 * @example
 * const tracker = createTargetTracker()
 * tracker.missFine(0); tracker.missFine(1)
 * tracker.missFine(2)
 * // => 'coarse'
 */
export function createTargetTracker(options: TargetTrackerOptions = {}): TargetTracker {
  const fineMaxMisses = options.fineMaxMisses ?? FINE_MAX_MISSES
  const fineMaxAgeMs = options.fineMaxAgeMs ?? FINE_MAX_AGE_MS
  const coarseFineMinSamples = options.coarseFineMinSamples ?? COARSE_FINE_MIN_SAMPLES
  const waitingStartMs = options.waitingStartMs ?? WAITING_START_MS
  const waitingBudgetMs = options.waitingBudgetMs ?? WAITING_BUDGET_MS

  let mode: 'fine' | 'coarse' = 'fine'
  let fineMisses = 0
  let recoverySamples = 0
  let lastFine: TargetObservation | undefined
  let lastCoarse: TargetObservation | undefined
  /** When a fresh sample of either source arrived; drives the waiting window. */
  let lastFreshAt: number | undefined
  /** When coarse tracking began without any coarse sample yet. */
  let coarseSince: number | undefined
  let waitingSince: number | undefined
  let forced: TargetTrackingOutcome | undefined

  return {
    snapshot: () => ({
      mode,
      fineMisses,
      recoverySamples,
      ...(lastFine ? { lastFine } : {}),
      ...(lastCoarse ? { lastCoarse } : {}),
      ...(waitingSince !== undefined ? { waitingSince } : {}),
      ...(forced ? { forced } : {}),
    }),

    acceptFine: (observation, now) => {
      if (!isNewerTargetSample(lastFine ? { sourceTick: lastFine.sourceTick, receivedAt: lastFine.receivedAt } : undefined, { sourceTick: observation.sourceTick, receivedAt: observation.receivedAt }))
        return false
      lastFine = observation
      lastFreshAt = now
      fineMisses = 0
      if (mode === 'fine')
        return true
      // Coarse -> fine needs more than one fresh sample: a single late sample
      // must not flip the source back and forth (design §4 hysteresis).
      recoverySamples += 1
      if (recoverySamples >= coarseFineMinSamples) {
        mode = 'fine'
        recoverySamples = 0
        coarseSince = undefined
        waitingSince = undefined
      }
      return true
    },

    missFine: (now) => {
      if (mode !== 'fine')
        return mode
      fineMisses += 1
      const ageMs = lastFine ? now - lastFine.receivedAt : Number.POSITIVE_INFINITY
      if (fineMisses >= fineMaxMisses || ageMs > fineMaxAgeMs) {
        mode = 'coarse'
        coarseSince = now
        recoverySamples = 0
      }
      return mode
    },

    acceptCoarse: (observation, now) => {
      if (!isNewerTargetSample(lastCoarse ? { sourceTick: lastCoarse.sourceTick, receivedAt: lastCoarse.receivedAt } : undefined, { sourceTick: observation.sourceTick, receivedAt: observation.receivedAt }))
        return false
      lastCoarse = observation
      lastFreshAt = now
      waitingSince = undefined
      return true
    },

    forceOutcome: (outcome) => {
      forced = outcome
    },

    outcome: (now) => {
      if (forced)
        return forced
      if (mode === 'fine')
        return 'fine'
      // The waiting window starts at whichever came later: the return to coarse
      // or the newest fresh sample. A fresh coarse read clears the window.
      const reference = Math.max(lastFreshAt ?? 0, coarseSince ?? 0)
      if (now - reference <= waitingStartMs)
        return 'coarse'
      if (waitingSince === undefined)
        waitingSince = now
      return 'waiting_for_target'
    },

    waitingBudgetExceeded: now => waitingSince !== undefined && now - waitingSince >= waitingBudgetMs,
  }
}

export interface CoarseLocateGateOptions {
  intervalMs?: number
  backoffMs?: readonly number[]
}

/**
 * Rate gate for coarse locates: at most one per interval and no overlap.
 *
 * `tryAcquire` marks a request in flight; `release` ends it. Consecutive
 * failures extend the next allowed time along the backoff schedule, so a
 * broken locator is not hammered.
 */
export function createCoarseLocateGate(options: CoarseLocateGateOptions = {}) {
  const intervalMs = options.intervalMs ?? COARSE_POLL_INTERVAL_MS
  const backoffMs = options.backoffMs ?? COARSE_BACKOFF_MS
  let inFlight = false
  let startedAt = 0
  let nextAllowedAt = Number.NEGATIVE_INFINITY
  let consecutiveFailures = 0

  return {
    /** True when a request may start at `now`. Marks it in flight on success. */
    tryAcquire: (now: number): boolean => {
      if (inFlight || now < nextAllowedAt)
        return false
      inFlight = true
      startedAt = now
      return true
    },
    /** Ends the in-flight request and schedules the next attempt. */
    release: (result: 'success' | 'failure'): void => {
      if (!inFlight)
        return
      inFlight = false
      if (result === 'success') {
        consecutiveFailures = 0
        nextAllowedAt = startedAt + intervalMs
        return
      }
      const delay = backoffMs[Math.min(consecutiveFailures, backoffMs.length - 1)] ?? intervalMs
      consecutiveFailures += 1
      nextAllowedAt = startedAt + delay
    },
    state: () => ({ inFlight, consecutiveFailures, nextAllowedAt }),
  }
}

/** Reads a value once per key and shares the in-flight promise with callers. */
export interface CoalescedReader<K, V> {
  read: (key: K) => Promise<V>
  invalidate: () => void
}

/**
 * Coalesces concurrent reads and reuses one sample for a short TTL.
 *
 * Several consumers of the same coarse locate share a single read-only
 * snapshot instead of starting one request each (design §4).
 */
export function createCoalescedReader<K, V>(
  loader: (key: K) => Promise<V>,
  options: { ttlMs?: number, now?: () => number } = {},
): CoalescedReader<K, V> {
  const ttlMs = options.ttlMs ?? 0
  const now = options.now ?? Date.now
  let key: K | undefined
  let hasKey = false
  let value: V | undefined
  let loadedAt = 0
  let pending: Promise<V> | undefined

  return {
    read: async (requested: K) => {
      if (pending && hasKey && key === requested)
        return await pending
      if (hasKey && key === requested && value !== undefined && now() - loadedAt <= ttlMs)
        return value
      hasKey = true
      key = requested
      const load = loader(requested)
      pending = load
      const result = await load
      value = result
      loadedAt = now()
      pending = undefined
      return result
    },
    invalidate: () => {
      hasKey = false
      key = undefined
      value = undefined
      loadedAt = 0
      pending = undefined
    },
  }
}

/** One client trajectory sample. `velocity` is vanilla blocks per tick. */
export interface TrajectorySample {
  receivedAt: number
  position: Vec3
  velocity?: Vec3
  fallFlying?: boolean
  riding?: boolean
  onGround?: boolean
  dimension?: string
}

/** Why the trajectory history cleared its window. */
export type TrajectoryResetReason = 'teleport' | 'ride-switch' | 'landing' | 'takeoff' | 'dimension-change'

export interface TrajectoryReset {
  reason: TrajectoryResetReason
  at: number
  previous: Vec3
  next: Vec3
}

export interface TrajectoryHistoryOptions {
  maxSamples?: number
  teleportDistance?: number
  teleportWindowMs?: number
  maxAgeMs?: number
}

export interface TrajectoryHistory {
  /** Adds a sample; returns the reset it caused, or undefined. */
  push: (sample: TrajectorySample) => TrajectoryReset | undefined
  samples: () => readonly TrajectorySample[]
  lastReset: () => TrajectoryReset | undefined
  /** Mean velocity in blocks per tick over the retained window. */
  averageVelocity: () => Vec3 | undefined
  /** Age of the newest sample in milliseconds, or undefined when empty. */
  ageMs: (now: number) => number | undefined
  /** Position error estimate in blocks for the newest sample at `now`. */
  positionUncertainty: (now: number) => number
  clear: () => void
}

/**
 * Creates a short client trajectory history.
 *
 * A sample that arrives out of order is dropped, never treated as new. A jump
 * larger than the teleport distance inside the teleport window, a ride switch,
 * a landing or a takeoff clears the window: a linear extrapolation across such
 * an event would be wrong (design §5).
 */
export function createTrajectoryHistory(options: TrajectoryHistoryOptions = {}): TrajectoryHistory {
  const maxSamples = options.maxSamples ?? TRAJECTORY_MAX_SAMPLES
  const teleportDistance = options.teleportDistance ?? TRAJECTORY_TELEPORT_DISTANCE
  const teleportWindowMs = options.teleportWindowMs ?? TRAJECTORY_TELEPORT_WINDOW_MS
  const maxAgeMs = options.maxAgeMs ?? 1500
  let samples: TrajectorySample[] = []
  let reset: TrajectoryReset | undefined

  function resetReason(previous: TrajectorySample, next: TrajectorySample): TrajectoryResetReason | undefined {
    if (previous.dimension !== undefined && next.dimension !== undefined && previous.dimension !== next.dimension)
      return 'dimension-change'
    if (previous.riding !== undefined && next.riding !== undefined && previous.riding !== next.riding)
      return 'ride-switch'
    if (previous.fallFlying === true && next.fallFlying === false)
      return 'landing'
    if (previous.fallFlying === false && next.fallFlying === true)
      return 'takeoff'
    const jump = Math.hypot(next.position.x - previous.position.x, next.position.y - previous.position.y, next.position.z - previous.position.z)
    const elapsed = next.receivedAt - previous.receivedAt
    if (jump > teleportDistance && elapsed <= teleportWindowMs)
      return 'teleport'
    return undefined
  }

  return {
    push: (sample) => {
      const previous = samples[samples.length - 1]
      if (previous && sample.receivedAt < previous.receivedAt)
        return undefined
      if (previous) {
        const reason = resetReason(previous, sample)
        if (reason) {
          reset = { reason, at: sample.receivedAt, previous: previous.position, next: sample.position }
          samples = []
        }
      }
      samples.push(sample)
      if (samples.length > maxSamples)
        samples = samples.slice(samples.length - maxSamples)
      return reset && reset.at === sample.receivedAt ? reset : undefined
    },
    samples: () => samples,
    lastReset: () => reset,
    averageVelocity: () => {
      if (samples.length < 2)
        return undefined
      const last = samples[samples.length - 1]
      // Keep only the recent window: an old displacement would describe a
      // stale trajectory, not the current motion.
      const window = samples.filter(sample => last.receivedAt - sample.receivedAt <= maxAgeMs)
      if (window.length < 2)
        return undefined
      const first = window[0]
      const elapsedMs = last.receivedAt - first.receivedAt
      if (elapsedMs <= 0)
        return undefined
      const perTick = 50 / elapsedMs
      return {
        x: (last.position.x - first.position.x) * perTick,
        y: (last.position.y - first.position.y) * perTick,
        z: (last.position.z - first.position.z) * perTick,
      }
    },
    ageMs: now => (samples.length === 0 ? undefined : Math.max(0, now - samples[samples.length - 1].receivedAt)),
    positionUncertainty: (now) => {
      const latest = samples[samples.length - 1]
      if (!latest)
        return Number.POSITIVE_INFINITY
      const velocity = latest.velocity ?? undefined
      return estimatePositionUncertainty({
        sampleAgeMs: Math.max(0, now - latest.receivedAt),
        latencyMs: 0,
        speedBlocksPerSecond: speedBlocksPerSecond(velocity),
      })
    },
    clear: () => {
      samples = []
      reset = undefined
    },
  }
}
