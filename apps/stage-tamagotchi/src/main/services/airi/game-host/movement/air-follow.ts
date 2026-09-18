/**
 * Ground/launch/air follow state machine, budget and receipt
 * (air-follow design §3–§6, CD-F1–CD-F3).
 *
 * The machine is pure: the follow loop feeds it one target/self sample per
 * client tick and explicit action results (launch began, deployed, landed,
 * cancel), and it answers which controller should run next. It never drives the
 * player itself, so the same policy is exercised offline.
 *
 * Rules with their reasons:
 *
 * - Target `fallFlying` comes from the target observation, never the own player
 *   state, and a launch is only assessed after several consecutive true
 *   samples.
 * - Stopping a glide is not a landing. A target touch-down needs a fresh
 *   `onGround`, a non-gliding pose and a low residual speed over consecutive
 *   samples.
 * - A cancel revokes the pursuit immediately and hands to a bounded safety
 *   landing; it never auto-resumes.
 * - The budget is command deadline, fireworks (with a reserve for the backup
 *   landing site), elytra wear and a health floor, not a fixed rocket count.
 */
import type { TargetObservation, TriState } from './target-observation'
import type { Vec3 } from './types'

/** Consecutive target-flying samples required before a launch is assessed. */
export const AIR_LAUNCH_CONFIRM_TICKS = 3
/** Consecutive landed-like target samples required to confirm a touch-down. */
export const AIR_LANDING_CONFIRM_TICKS = 3
/** Horizontal target speed at or below which a grounded pose is plausible. */
export const AIR_GROUNDED_SPEED = 0.15
/** Bounded window in which a lost target must be reacquired before landing. */
export const AIR_REACQUIRE_BUDGET_MS = 6000

/** The follow states of the design §3 state machine. */
export type AirFollowPhase
  = | 'ground-follow'
    | 'escort'
    | 'assess-launch'
    | 'launching'
    | 'air-track'
    | 'intercept'
    | 'reacquire'
    | 'approach-landing'
    | 'safety-landing'
    | 'terminated'

/**
 * Typed terminal outcomes.
 *
 * `follow_completed` is a normal duration end; it is never a "reached a
 * coordinate". `cannot_air_follow` is a definite limitation, not a crash.
 */
export type AirFollowEndReason
  = | 'follow_completed'
    | 'cannot_air_follow'
    | 'launch_unavailable'
    | 'low_supply'
    | 'low_health'
    | 'elytra_worn'
    | 'no_reachable_landing'
    | 'target_lost'
    | 'target_offline'
    | 'target_dimension_changed'
    | 'cancelled'
    | 'dead'
    | 'connection_lost'
    | 'dimension_changed'
    | 'timeout'

/**
 * Budget limits for one air follow.
 *
 * `reserveFireworks` is the thrust kept for the nearest backup landing site; a
 * launch or a track must not spend it. The values are engineering defaults, not
 * verified safety constants.
 */
export interface AirFollowBudgetLimits {
  reserveFireworks: number
  healthFloor: number
  elytraWornRatio: number
}

export const DEFAULT_AIR_FOLLOW_BUDGET: AirFollowBudgetLimits = {
  reserveFireworks: 2,
  healthFloor: 8,
  elytraWornRatio: 0.75,
}

/** The action the follow loop must take for a directive. */
export type AirFollowAction
  = | 'ground-follow'
    | 'escort-hold'
    | 'assess-launch'
    | 'launch'
    | 'track'
    | 'intercept'
    | 'reacquire'
    | 'approach-landing'
    | 'safety-landing'
    | 'terminate'

export interface AirFollowDirective {
  phase: AirFollowPhase
  action: AirFollowAction
  reason?: AirFollowEndReason
}

/** Own-player facts the budget and landing checks consume. */
export interface AirFollowSelfSample {
  position?: Vec3
  velocity?: Vec3
  onGround?: boolean
  fallFlying?: boolean
  health?: number
  /** Remaining fireworks; undefined when the read failed. */
  fireworks?: number
  /** Elytra wear (0 intact, 1 destroyed); undefined when unread. */
  elytraWornRatio?: number
}

export interface AirFollowSampleOptions {
  /** Monotonic client tick; the consecutive-sample counters only advance on a new tick. */
  tick: number
  at: number
  /** False when only coarse coordinates are available. */
  fine: boolean
  self: AirFollowSelfSample
  /** Horizontal distance to the lagged follow point; computed from positions when absent. */
  distance?: number
}

/** Accumulated evidence for the command receipt (design §6). */
export interface AirFollowReceipt {
  endReason: AirFollowEndReason
  /** Wall-clock ms spent in an air phase. */
  activeMs: number
  /** Wall-clock ms with the spacing inside its band. */
  bandMs: number
  /** Share of active time inside the band. */
  bandRatio: number
  lossCount: number
  modeSwitches: number
  fireworkSpend: number
  launchAttempts: number
  finalTargetObservation?: TargetObservation
  /** True when the mode chose a ground rendezvous instead of an air follow. */
  cannotAirFollow?: boolean
  /** Whether the bounded safety landing proved a touch-down. */
  landingVerified?: boolean
  /** How strategy updates reached the driver; polling until a stream exists (escort design D6). */
  updateStream?: 'polling' | 'ipc'
}

export interface AirFollowControllerOptions {
  travelMode: 'ground' | 'auto'
  budget?: Partial<AirFollowBudgetLimits>
  spacing?: { min: number, max: number }
  launchConfirmTicks?: number
  landingConfirmTicks?: number
  /**
   * LR-0 escort insertion point (escort design D1). The strategy itself lands
   * with LR-2/LR-3; the default `off` and an absent gate keep today's
   * ground-to-launch flow exactly.
   */
  escort?: { mode: 'off' | 'on', gate?: () => 'launch' | 'hold' }
}

export interface AirFollowController {
  phase: () => AirFollowPhase
  endReason: () => AirFollowEndReason | undefined
  snapshot: () => AirFollowReceipt
  /** Feeds one observation; returns the directive for the follow loop. */
  step: (observation: TargetObservation | undefined, options: AirFollowSampleOptions) => AirFollowDirective
  /** The loop accepted the launch assessment and is starting the elytra. */
  noteLaunchBegan: () => AirFollowDirective
  /** The elytra deployed: the session is airborne and tracking. */
  noteLaunchDeployed: (at: number) => AirFollowDirective
  /** The launch was refused before takeoff; the mode returns to the ground. */
  noteLaunchRefused: (reason: AirFollowEndReason, cannotAirFollow?: boolean) => AirFollowDirective
  /** The elytra stopped gliding without a confirmed landing in the approach. */
  noteFlightLost: (reason: AirFollowEndReason) => AirFollowDirective
  /** The self touch-down in the approach was confirmed. */
  noteSelfLanded: (at: number) => AirFollowDirective
  /** The bounded safety landing finished. */
  noteSafetyLandingComplete: (verified: boolean) => AirFollowDirective
  /** One firework was spent; counted once per use. */
  noteFireworkSpent: (count?: number) => void
  /** The command deadline elapsed; a ground phase completes normally. */
  complete: (reason?: AirFollowEndReason) => AirFollowDirective
  /** Revokes the pursuit and hands to a bounded safety landing. */
  cancel: () => AirFollowDirective
  /** Death, a dimension change or a lost connection interrupts every state. */
  interrupt: (cause: 'death' | 'dimension-change' | 'connection-loss') => AirFollowDirective
}

function horizontalSpeed(velocity: Vec3 | undefined): number {
  return velocity ? Math.hypot(velocity.x, velocity.z) : 0
}

function distanceOf(self: AirFollowSelfSample, observation: TargetObservation | undefined): number | undefined {
  if (!self.position || !observation?.position)
    return undefined
  return Math.hypot(observation.position.x - self.position.x, observation.position.z - self.position.z)
}

/**
 * Creates the air follow controller.
 *
 * @example
 * const controller = createAirFollowController({ travelMode: 'auto' })
 * controller.step(observation, { tick: 1, at: 0, fine: true, self: {} }).action
 * // => 'ground-follow'
 */
export function createAirFollowController(options: AirFollowControllerOptions): AirFollowController {
  const budget: AirFollowBudgetLimits = {
    reserveFireworks: options.budget?.reserveFireworks ?? DEFAULT_AIR_FOLLOW_BUDGET.reserveFireworks,
    healthFloor: options.budget?.healthFloor ?? DEFAULT_AIR_FOLLOW_BUDGET.healthFloor,
    elytraWornRatio: options.budget?.elytraWornRatio ?? DEFAULT_AIR_FOLLOW_BUDGET.elytraWornRatio,
  }
  const band = options.spacing ?? { min: 12, max: 24 }
  const launchConfirmTicks = options.launchConfirmTicks ?? AIR_LAUNCH_CONFIRM_TICKS
  const landingConfirmTicks = options.landingConfirmTicks ?? AIR_LANDING_CONFIRM_TICKS

  let phase: AirFollowPhase = 'ground-follow'
  let endReason: AirFollowEndReason | undefined
  let terminalReason: AirFollowEndReason | undefined
  let flyingTicks = 0
  let landingTicks = 0
  let landed = false
  let lossActive = false
  let lastTick: number | undefined
  let lastSampleAt: number | undefined
  let activeSince: number | undefined
  let reacquireSince: number | undefined
  let activeMs = 0
  let bandMs = 0
  let lossCount = 0
  let modeSwitches = 0
  let fireworkSpend = 0
  let launchAttempts = 0
  let cannotAirFollow = false
  let landingVerified: boolean | undefined
  let finalTargetObservation: TargetObservation | undefined
  /**
   * A refused launch blocks reassessment until the target stops gliding.
   *
   * Without this, a target that keeps gliding would make the loop assess a
   * launch on every tick: the repeated-jump failure the design forbids.
   */
  let launchBlocked = false
  /** True while the session is airborne and the spacing band applies. */
  let airborne = false

  function isAirPhase(): boolean {
    return phase === 'launching' || phase === 'air-track' || phase === 'intercept'
      || phase === 'reacquire' || phase === 'approach-landing'
  }

  function accountTime(at: number, inBand: boolean): void {
    const previous = lastSampleAt
    lastSampleAt = at
    if (previous === undefined)
      return
    const delta = Math.max(0, at - previous)
    if (activeSince !== undefined)
      activeMs += delta
    if (airborne && inBand)
      bandMs += delta
  }

  function enterSafetyLanding(reason: AirFollowEndReason): AirFollowDirective {
    terminalReason ??= reason
    phase = 'safety-landing'
    return { phase, action: 'safety-landing', reason: terminalReason }
  }

  function terminate(reason: AirFollowEndReason): AirFollowDirective {
    phase = 'terminated'
    endReason = reason
    airborne = false
    return { phase, action: 'terminate', reason }
  }

  function enterGroundFollow(): AirFollowDirective {
    if (airborne) {
      airborne = false
      modeSwitches += 1
    }
    phase = 'ground-follow'
    activeSince = undefined
    reacquireSince = undefined
    return { phase, action: 'ground-follow' }
  }

  function enterAirTrack(at: number): AirFollowDirective {
    phase = 'air-track'
    lossActive = false
    reacquireSince = undefined
    activeSince ??= at
    return { phase, action: 'track' }
  }

  function targetTouchedDown(): boolean {
    return landed && landingTicks >= landingConfirmTicks
  }

  function budgetDirective(self: AirFollowSelfSample): AirFollowDirective | undefined {
    if (phase !== 'air-track' && phase !== 'intercept' && phase !== 'reacquire' && phase !== 'approach-landing')
      return undefined
    if (self.health !== undefined && self.health <= budget.healthFloor)
      return enterSafetyLanding('low_health')
    if (self.fireworks !== undefined && self.fireworks <= budget.reserveFireworks)
      return enterSafetyLanding('low_supply')
    if (self.elytraWornRatio !== undefined && self.elytraWornRatio >= budget.elytraWornRatio)
      return enterSafetyLanding('elytra_worn')
    return undefined
  }

  function noteSelfLanded(at: number): AirFollowDirective {
    lastSampleAt = at
    return enterGroundFollow()
  }

  function step(observation: TargetObservation | undefined, sample: AirFollowSampleOptions): AirFollowDirective {
    const { tick, at, fine, self } = sample
    const advanced = lastTick === undefined || tick > lastTick
    lastTick = tick
    if (observation)
      finalTargetObservation = observation

    const targetDistance = sample.distance ?? distanceOf(self, observation)
    const inBand = targetDistance !== undefined && targetDistance >= band.min && targetDistance <= band.max
    accountTime(at, inBand)

    if (phase === 'terminated')
      return { phase, action: 'terminate', reason: endReason }

    if (observation?.fallFlying === true) {
      landingTicks = 0
      landed = false
      if (advanced)
        flyingTicks += 1
    }
    else if (observation?.fallFlying !== false) {
      // An unreadable pose cannot confirm either a takeoff or a landing, so
      // neither consecutive counter advances.
      flyingTicks = 0
      landingTicks = 0
    }
    else {
      // An observed non-gliding pose releases the launch block: the next
      // takeoff is a new event, not the continuation of a refused one.
      launchBlocked = false
      if (advanced)
        flyingTicks = 0
      const speed = horizontalSpeed(observation.velocity)
      const groundedPose = observation.onGround === true && speed <= AIR_GROUNDED_SPEED
      if (groundedPose) {
        if (advanced)
          landingTicks += 1
        landed = true
      }
      else {
        landingTicks = 0
        landed = observation.onGround === true
      }
    }

    if (phase === 'ground-follow') {
      if (options.travelMode === 'auto' && !launchBlocked && flyingTicks >= launchConfirmTicks) {
        // LR-0 escort insertion point: a holding gate keeps the ground follow
        // while the escort strategy decides whether the launch is worth its
        // fireworks (escort design D1).
        if (options.escort?.mode === 'on' && options.escort.gate?.() === 'hold') {
          phase = 'escort'
          return { phase, action: 'escort-hold' }
        }
        phase = 'assess-launch'
        return { phase, action: 'assess-launch' }
      }
      return { phase, action: 'ground-follow' }
    }

    if (phase === 'escort') {
      if (flyingTicks < launchConfirmTicks)
        return enterGroundFollow()
      if (options.escort?.gate?.() === 'hold')
        return { phase, action: 'escort-hold' }
      phase = 'assess-launch'
      return { phase, action: 'assess-launch' }
    }

    if (phase === 'assess-launch') {
      if (flyingTicks < launchConfirmTicks)
        return enterGroundFollow()
      return { phase, action: 'launch' }
    }

    if (phase === 'launching') {
      if (flyingTicks < launchConfirmTicks && !landed)
        return enterGroundFollow()
      return { phase, action: 'launch' }
    }

    if (phase === 'safety-landing')
      return { phase, action: 'safety-landing', reason: terminalReason }

    if (phase === 'approach-landing') {
      if (self.onGround === true && self.fallFlying !== true && horizontalSpeed(self.velocity) <= AIR_GROUNDED_SPEED)
        return noteSelfLanded(at)
      // A glide that ends without a confirmed ground contact is not a landing;
      // the bounded safety landing owns the cleanup.
      if (self.fallFlying === false && self.onGround === false)
        return enterSafetyLanding('cannot_air_follow')
      return { phase, action: 'approach-landing' }
    }

    const budgetStep = budgetDirective(self)
    if (budgetStep)
      return budgetStep

    if (!fine || !observation?.position) {
      if (!lossActive) {
        lossCount += 1
        lossActive = true
      }
      if (phase !== 'reacquire') {
        phase = 'reacquire'
        reacquireSince = at
        return { phase, action: 'reacquire' }
      }
      if (reacquireSince !== undefined && at - reacquireSince >= AIR_REACQUIRE_BUDGET_MS)
        return enterSafetyLanding('target_lost')
      return { phase, action: 'reacquire' }
    }

    // A fresh fine sample ends a loss episode.
    lossActive = false
    reacquireSince = undefined

    if ((phase === 'air-track' || phase === 'intercept') && targetTouchedDown()) {
      phase = 'approach-landing'
      return { phase, action: 'approach-landing' }
    }

    if (phase === 'intercept') {
      if (targetDistance !== undefined && targetDistance <= band.max)
        return enterAirTrack(at)
      return { phase, action: 'intercept' }
    }

    if (phase === 'air-track' || phase === 'reacquire') {
      if (targetDistance !== undefined && targetDistance > band.max) {
        phase = 'intercept'
        return { phase, action: 'intercept' }
      }
      return enterAirTrack(at)
    }

    // Any other air phase keeps tracking; a state not covered above must not
    // silently drop control.
    return { phase, action: 'track' }
  }

  return {
    phase: () => phase,
    endReason: () => endReason,
    snapshot: () => ({
      endReason: endReason ?? terminalReason ?? 'follow_completed',
      activeMs: Math.round(activeMs),
      bandMs: Math.round(bandMs),
      bandRatio: activeMs > 0 ? Math.min(1, bandMs / activeMs) : 0,
      lossCount,
      modeSwitches,
      fireworkSpend,
      launchAttempts,
      ...(finalTargetObservation ? { finalTargetObservation } : {}),
      ...(cannotAirFollow ? { cannotAirFollow } : {}),
      ...(landingVerified !== undefined ? { landingVerified } : {}),
    }),

    step,

    noteLaunchBegan: () => {
      launchAttempts += 1
      phase = 'launching'
      airborne = true
      modeSwitches += 1
      return { phase, action: 'launch' }
    },

    noteLaunchDeployed: (at) => {
      activeSince ??= at
      return enterAirTrack(at)
    },

    noteLaunchRefused: (reason, refusedCannotAirFollow) => {
      terminalReason ??= reason
      cannotAirFollow = refusedCannotAirFollow ?? (reason === 'cannot_air_follow' || reason === 'launch_unavailable')
      airborne = false
      // The block persists until the target stops gliding, so the loop does not
      // re-assess the same refused takeoff every tick.
      launchBlocked = true
      flyingTicks = 0
      const directive = enterGroundFollow()
      return { ...directive, reason }
    },

    noteFlightLost: reason => enterSafetyLanding(reason),

    noteSelfLanded,

    noteSafetyLandingComplete: (verified) => {
      landingVerified = verified
      airborne = false
      return terminate(terminalReason ?? 'cannot_air_follow')
    },

    noteFireworkSpent: (count = 1) => {
      fireworkSpend += count
    },

    complete: (reason) => {
      if (phase === 'terminated')
        return { phase, action: 'terminate', reason: endReason }
      if (isAirPhase())
        return enterSafetyLanding(reason ?? 'follow_completed')
      return terminate(reason ?? 'follow_completed')
    },

    cancel: () => {
      terminalReason = 'cancelled'
      cannotAirFollow = false
      if (isAirPhase() || phase === 'safety-landing')
        return enterSafetyLanding('cancelled')
      return terminate('cancelled')
    },

    interrupt: (cause) => {
      const reason: AirFollowEndReason = cause === 'death' ? 'dead' : cause === 'connection-loss' ? 'connection_lost' : 'dimension_changed'
      airborne = false
      return terminate(reason)
    },
  }
}

/** Whether a receipt reports a clean duration end rather than a limitation. */
export function airFollowCompleted(reason: AirFollowEndReason): boolean {
  return reason === 'follow_completed'
}

export interface AirLaunchAssessmentInput {
  hasElytra: boolean
  fireworks: number
  health: number
  elytraWornRatio?: number
  launchSiteAvailable: boolean
  deadlineReached: boolean
  budget?: Partial<AirFollowBudgetLimits>
}

export type AirLaunchAssessment
  = | { ok: true }
    | { ok: false, reason: AirFollowEndReason }

/**
 * Assesses whether an air follow may start.
 *
 * The reserve fireworks are not spendable on launch; a suit worn past its limit
 * or a health below the floor refuses the takeoff. A missing launch edge is
 * `launch_unavailable`, and missing gear is `cannot_air_follow`.
 */
export function assessAirLaunch(input: AirLaunchAssessmentInput): AirLaunchAssessment {
  const budget = {
    reserveFireworks: input.budget?.reserveFireworks ?? DEFAULT_AIR_FOLLOW_BUDGET.reserveFireworks,
    healthFloor: input.budget?.healthFloor ?? DEFAULT_AIR_FOLLOW_BUDGET.healthFloor,
    elytraWornRatio: input.budget?.elytraWornRatio ?? DEFAULT_AIR_FOLLOW_BUDGET.elytraWornRatio,
  }
  if (input.deadlineReached)
    return { ok: false, reason: 'timeout' }
  if (!input.hasElytra)
    return { ok: false, reason: 'cannot_air_follow' }
  if (input.fireworks <= budget.reserveFireworks)
    return { ok: false, reason: 'low_supply' }
  if (input.health <= budget.healthFloor)
    return { ok: false, reason: 'low_health' }
  if (input.elytraWornRatio !== undefined && input.elytraWornRatio >= budget.elytraWornRatio)
    return { ok: false, reason: 'elytra_worn' }
  if (!input.launchSiteAvailable)
    return { ok: false, reason: 'launch_unavailable' }
  return { ok: true }
}

/** Tri-state helper kept here so a caller never reads `unobserved` as false. */
export function targetGliding(state: TriState): boolean {
  return state === true
}
