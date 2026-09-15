/**
 * Flight lifecycle state machine (elytra-navigation design §6–§7, CD-E3).
 *
 * `Prepare → Launch → Cruise → Approach → Flare → Touchdown → Terminated`, with
 * `GoAround` and `EmergencyLanding` as independent states that own their own
 * deadlines and goals.
 *
 * The module is pure: the main process reduces events into a new state, and the
 * launch selection, the approach feasibility check, the three-phase go-around
 * and the emergency-site choice are plain functions the offline tests exercise
 * without a client or a real world.
 */
import type { Vec3 } from '../movement/types'
import type { FlightExitReason, FlightIntent, FlightObservation, FlightPhase, GoAroundPhase, LandingSite } from './contracts'

import { horizontalDistance, yawTo } from '../movement/geometry'

/** Default go-around height above the goal. */
export const GO_AROUND_RECOVER_HEIGHT = 8
/** Default distance past the approach zone before re-aligning. */
export const GO_AROUND_LEAVE_DISTANCE = 60
/** Heading error under which the re-align phase completes, in degrees. */
export const GO_AROUND_REALIGN_TOLERANCE_DEG = 20
/** A glide needs at least this much height per block of remaining distance. */
export const MIN_GLIDE_RATIO = 0.08
/** Approach speed above which a short remaining distance cannot bleed off. */
export const MAX_APPROACH_SPEED = 1.2
/** Distance under which a fast approach cannot decelerate, in blocks. */
export const APPROACH_STOP_DISTANCE = 24

export interface LifecycleState {
  phase: FlightPhase
  /** The active go-around sub-phase, when `phase` is `GoAround`. */
  goAroundPhase?: GoAroundPhase
  /** Completed go-arounds; the design allows at most one full loop by default. */
  goArounds: number
  /** Main-process ms the current phase must finish by. */
  phaseDeadline?: number
  exitReason?: FlightExitReason
}

export const INITIAL_LIFECYCLE: LifecycleState = { phase: 'Prepare', goArounds: 0 }

/**
 * Allowed transitions of the state machine.
 *
 * A transition not in this table is refused, which keeps an old event from
 * moving a terminated session and keeps `GoAround` from jumping straight back
 * into `Approach`.
 */
const ALLOWED: Record<FlightPhase, FlightPhase[]> = {
  Prepare: ['Launch', 'Terminated'],
  Launch: ['Cruise', 'EmergencyLanding', 'Terminated'],
  Cruise: ['Approach', 'EmergencyLanding', 'GoAround', 'Terminated'],
  Approach: ['Flare', 'GoAround', 'EmergencyLanding', 'Terminated'],
  Flare: ['Touchdown', 'GoAround', 'EmergencyLanding', 'Terminated'],
  Touchdown: ['Terminated'],
  // The three go-around phases stay inside GoAround until the re-align
  // finishes; only then may the session return to Cruise.
  GoAround: ['GoAround', 'Cruise', 'EmergencyLanding', 'Terminated'],
  EmergencyLanding: ['Touchdown', 'Terminated'],
  Terminated: [],
}

export type LifecycleEvent
  = | { kind: 'enter', phase: 'Launch' | 'Cruise' | 'Approach' | 'Flare' | 'Touchdown' }
    | { kind: 'go-around' }
    | { kind: 'go-around-phase', phase: GoAroundPhase }
    | { kind: 'go-around-complete' }
    | { kind: 'emergency-landing' }
    | { kind: 'terminate', reason: FlightExitReason }

/**
 * Reduces one event into the next lifecycle state.
 *
 * @example
 * reduceLifecycle(INITIAL_LIFECYCLE, { kind: 'enter', phase: 'Launch' }).phase
 * // => 'Launch'
 */
export function reduceLifecycle(
  state: LifecycleState,
  event: LifecycleEvent,
  options: { maxGoArounds?: number } = {},
): LifecycleState {
  if (state.phase === 'Terminated')
    return state
  switch (event.kind) {
    case 'enter':
      return allowedTransition(state, event.phase)
    case 'go-around':
      // The default is one full go-around; a session with little firework or
      // durability reserve lowers the budget and lands instead.
      if (state.goArounds >= (options.maxGoArounds ?? 1))
        return allowedTransition(state, 'EmergencyLanding')
      return { ...allowedTransition(state, 'GoAround'), goAroundPhase: 'recover', goArounds: state.goArounds + 1 }
    case 'go-around-phase':
      if (state.phase !== 'GoAround')
        return state
      return { ...state, goAroundPhase: event.phase }
    case 'go-around-complete':
      if (state.phase !== 'GoAround')
        return state
      // Re-entering Approach is only legal through this completion event; the
      // `enter` event alone cannot skip the three phases above.
      return { phase: 'Approach', goArounds: state.goArounds }
    case 'emergency-landing':
      return allowedTransition(state, 'EmergencyLanding')
    case 'terminate':
      return { phase: 'Terminated', goArounds: state.goArounds, exitReason: event.reason }
  }
}

function allowedTransition(state: LifecycleState, phase: FlightPhase): LifecycleState {
  if (!ALLOWED[state.phase].includes(phase))
    return state
  return { phase, goArounds: state.goArounds }
}

// --- Launch selection (design §6) --------------------------------------------------------

export interface LaunchRequirements {
  /** Forward air blocks the takeoff run needs. */
  minRunway: number
  /** Height the ground must drop beyond the runway. */
  minDrop: number
  /** Air blocks required on the launch column. */
  minClearance: number
  /**
   * Ticks the glider needs to open after leaving the edge.
   *
   * The drop must cover the free fall over this window, or the player would
   * reach the ground before the elytra can deploy.
   */
  deployTicks: number
}

/** Vanilla player gravity used to size the deploy fall. */
const DEPLOY_FALL_GRAVITY = 0.08

export const DEFAULT_LAUNCH_REQUIREMENTS: LaunchRequirements = {
  minRunway: 4,
  minDrop: 12,
  minClearance: 3,
  deployTicks: 10,
}

export interface LaunchCandidate {
  /** Launch edge the player runs off. */
  position: Vec3
  yaw: number
  /** Height from the launch edge to the surface beyond the runway. */
  drop: number
  runway: number
}

export type LaunchPlan
  = | { ok: true, candidate: LaunchCandidate }
    | { ok: false, reason: 'launch_unavailable' }

export interface LaunchSearchInput {
  from: Vec3
  heading: number
  /** Surface top y of a column, or undefined when unknown or open air. */
  surfaceAt: (x: number, z: number) => number | undefined
  /** Air above the launch column at `y`, or undefined when unknown. */
  clearAt: (x: number, y: number, z: number) => boolean | undefined
  requirements?: LaunchRequirements
  /** A post-launch corridor must exist from the edge, when the caller can check. */
  corridorFrom?: (edge: Vec3, yaw: number) => boolean
  /** How far around the observer to search, in blocks. */
  searchRadius?: number
}

/**
 * Finds a launch edge by ground reachability, forward clearance and drop.
 *
 * Plain flat ground with no viable launch returns `launch_unavailable`; the
 * mover must not build a tower or throw itself off a ledge (design §6).
 *
 * @example
 * selectLaunchPoint({ from, heading: 0, surfaceAt: () => 64, clearAt: () => true }).ok
 * // => false on flat ground
 */
export function selectLaunchPoint(input: LaunchSearchInput): LaunchPlan {
  const requirements = input.requirements ?? DEFAULT_LAUNCH_REQUIREMENTS
  const radius = input.searchRadius ?? 8
  const yawRad = input.heading * Math.PI / 180
  const dirX = -Math.sin(yawRad)
  const dirZ = Math.cos(yawRad)
  let best: LaunchCandidate | undefined

  for (let offset = 0; offset <= radius; offset++) {
    for (const lateral of [0, -1, 1]) {
      const x = Math.floor(input.from.x + dirX * offset - dirZ * lateral)
      const z = Math.floor(input.from.z + dirZ * offset + dirX * lateral)
      const surface = input.surfaceAt(x, z)
      if (surface === undefined)
        continue
      const clearanceOk = input.clearAt(x, surface + 1, z) === true
        && input.clearAt(x, surface + 2, z) === true
        && input.clearAt(x, surface + 3, z) === true
      if (!clearanceOk)
        continue
      const runwayEnd = input.surfaceAt(Math.floor(x + dirX * requirements.minRunway), Math.floor(z + dirZ * requirements.minRunway))
      let drop: number
      if (runwayEnd === undefined) {
        // Air beyond the runway is a cliff; it qualifies with the minimum drop
        // instead of an invented larger number.
        drop = requirements.minDrop
      }
      else {
        // Flat ground keeps the same surface at the runway end: no drop.
        drop = surface - runwayEnd
        if (drop < requirements.minDrop)
          continue
      }
      // The drop must also cover the free fall while the glider opens.
      const deployFall = 0.5 * DEPLOY_FALL_GRAVITY * requirements.deployTicks * requirements.deployTicks
      if (drop < Math.max(requirements.minDrop, deployFall))
        continue
      const edge = { x: x + 0.5, y: surface + 1, z: z + 0.5 }
      if (input.corridorFrom && !input.corridorFrom(edge, input.heading))
        continue
      const candidate: LaunchCandidate = {
        position: edge,
        yaw: input.heading,
        drop: runwayEnd === undefined ? requirements.minDrop : surface - runwayEnd,
        runway: requirements.minRunway,
      }
      if (!best || candidate.drop > best.drop)
        best = candidate
    }
  }

  if (!best)
    return { ok: false, reason: 'launch_unavailable' }
  return { ok: true, candidate: best }
}

// --- Approach feasibility (design §6) ----------------------------------------------------

export interface ApproachPlan {
  site: LandingSite
  entryYaw: number
  /** Speed the plan needs at the entry point, blocks/tick. */
  requiredSpeed: number
  /** Descent angle the remaining height needs, degrees. */
  requiredDescentDeg: number
}

export type ApproachDecision
  = | { ok: true, plan: ApproachPlan }
    | { ok: false, reason: 'go_around' }

/**
 * Checks whether the remaining height and speed can meet a landing plan.
 *
 * Too low to glide the remaining distance, or too fast to decelerate over it,
 * returns `go_around` so the session turns early instead of overflying the site.
 */
export function planApproach(input: { site: LandingSite, observation: FlightObservation }): ApproachDecision {
  const { site, observation } = input
  const gap = horizontalDistance(observation.position, { x: site.support.x, y: site.contactY, z: site.support.z })
  const height = observation.position.y - site.contactY
  const speed = Math.hypot(observation.velocity.x, observation.velocity.z)
  if (height < gap * MIN_GLIDE_RATIO)
    return { ok: false, reason: 'go_around' }
  if (speed > MAX_APPROACH_SPEED && gap < speed * APPROACH_STOP_DISTANCE)
    return { ok: false, reason: 'go_around' }
  return {
    ok: true,
    plan: {
      site,
      entryYaw: site.entryYaw,
      requiredSpeed: Math.min(speed, MAX_APPROACH_SPEED),
      requiredDescentDeg: Math.atan2(Math.max(0, height), Math.max(1, gap)) * 180 / Math.PI,
    },
  }
}

// --- Go-around phases (design §6) --------------------------------------------------------

/** One go-around sub-phase step; `done` hands back to the approach. */
export function stepGoAroundPhase(input: {
  phase: GoAroundPhase
  observation: FlightObservation
  goal: Vec3
}): GoAroundPhase | 'done' {
  const { phase, observation, goal } = input
  switch (phase) {
    case 'recover':
      return observation.position.y >= goal.y + GO_AROUND_RECOVER_HEIGHT ? 'leave' : 'recover'
    case 'leave':
      return horizontalDistance(observation.position, goal) >= GO_AROUND_LEAVE_DISTANCE ? 're-align' : 'leave'
    case 're-align': {
      const error = Math.abs(angleDelta(observation.yaw, yawTo(observation.position, goal)))
      return error <= GO_AROUND_REALIGN_TOLERANCE_DEG ? 'done' : 're-align'
    }
  }
}

function angleDelta(a: number, b: number): number {
  let delta = (b - a) % 360
  if (delta > 180)
    delta -= 360
  if (delta < -180)
    delta += 360
  return delta
}

// --- Emergency landing (design §7) -------------------------------------------------------

export interface EmergencyInput {
  observation: FlightObservation
  /** Verified sites ahead and to the sides, already reachability-filtered. */
  candidates: LandingSite[]
}

export type EmergencyDecision
  = | { ok: true, site: LandingSite }
    | { ok: false, reason: 'no_reachable_landing', minimalRisk: { point: Vec3, note: string } }

/**
 * Chooses the cheapest reachable emergency site.
 *
 * With no verified candidate the outcome is `no_reachable_landing` plus a
 * bounded minimal-risk point that is explicitly not recorded as a safe landing
 * (design §7).
 */
export function planEmergencyLanding(input: EmergencyInput): EmergencyDecision {
  const reachable = input.candidates
    .filter(site => site.hazards.length === 0)
    .sort((a, b) => a.reachCost - b.reachCost)
  const best = reachable[0]
  if (best)
    return { ok: true, site: best }
  return {
    ok: false,
    reason: 'no_reachable_landing',
    minimalRisk: {
      point: { ...input.observation.position },
      note: 'unverified minimal-risk point; not a landing site',
    },
  }
}

/** Builds the status snapshot a session publishes (design §3). */
export function buildFlightStatus(input: {
  state: LifecycleState
  budget: { fireworks: number, reserveTicks: number }
  deviation: number
  alternates?: LandingSite[]
  activeTrajectoryId?: string
}): import('./contracts').FlightStatus {
  return {
    phase: input.state.phase,
    ...(input.activeTrajectoryId ? { activeTrajectoryId: input.activeTrajectoryId } : {}),
    deviation: input.deviation,
    budget: input.budget,
    alternates: input.alternates ?? [],
    ...(input.state.exitReason ? { exitReason: input.state.exitReason } : {}),
  }
}

/** Validates an intent before a session starts (design §3). */
export function prepareFlight(intent: FlightIntent): { ok: true, state: LifecycleState } | { ok: false, reason: 'launch_unavailable' | 'deadline' } {
  if (intent.supply.fireworks <= 0)
    return { ok: false, reason: 'launch_unavailable' }
  if (intent.deadline !== undefined && intent.deadline <= 0)
    return { ok: false, reason: 'deadline' }
  return { ok: true, state: INITIAL_LIFECYCLE }
}
