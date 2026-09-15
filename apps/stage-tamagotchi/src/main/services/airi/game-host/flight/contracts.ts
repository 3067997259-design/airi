/**
 * Flight domain contracts (elytra-navigation design §3, CD-E1).
 *
 * These are the shared shapes the main process, the client flight session and
 * the offline tests agree on: the intent, the observation, the corridor, the
 * landing site and the status. They are a leaf module: the profile, the
 * simulator, the corridor builder and the lifecycle all import them, so no
 * runtime cycle forms.
 *
 * A `track` intent never authorizes a `land`; the session identity and the
 * monotonic revision are what let a late update be dropped (§3).
 */
import type { Vec3 } from '../movement/types'
import type { LandingSite } from './landing-site'

export type { LandingSite }

/**
 * The lifecycle states (design §6).
 *
 * `GoAround` and `EmergencyLanding` are independent states with their own
 * deadlines and goals, not modifiers of `Approach`.
 */
export type FlightPhase
  = | 'Prepare'
    | 'Launch'
    | 'Cruise'
    | 'Approach'
    | 'Flare'
    | 'Touchdown'
    | 'Terminated'
    | 'GoAround'
    | 'EmergencyLanding'

/** The three ordered go-around sub-phases. */
export type GoAroundPhase = 'recover' | 'leave' | 're-align'

/** What one flight session is for. A `track` update must not trigger a `land`. */
export type FlightIntentType = 'transit' | 'track' | 'land'

/**
 * The region a `track` intent holds, or the destination of a `transit`/`land`.
 *
 * `reachCost` is not here: a target region is a request, not a verified site.
 */
export interface FlightTargetRegion {
  center: Vec3
  radius: number
  dimension: string
  worldId: string
}

/**
 * The supply the session may spend.
 *
 * `reserveTicks` is the thrust reserved to reach the nearest verified landing;
 * a planner must keep it instead of spending it on progress (§8).
 */
export interface FlightSupplyBudget {
  fireworks: number
  reserveTicks: number
}

/**
 * One immutable flight request (design §3).
 *
 * `sessionId` and `revision` are the isolation keys: a late update with an older
 * revision is dropped and never starts a second session.
 */
export interface FlightIntent {
  sessionId: string
  revision: number
  type: FlightIntentType
  target: FlightTargetRegion
  /** Main-process deadline in ms; absent means the session default applies. */
  deadline?: number
  supply: FlightSupplyBudget
}

/** Player pose box the swept collision uses, in blocks. */
export interface FlightPoseBox {
  width: number
  height: number
}

/** Equipped elytra wear, when the read reported it. */
export interface FlightEquipment {
  chestId?: string
  chestDamage?: number
  chestMaxDamage?: number
}

/**
 * The current firework propulsion state.
 *
 * `ticksRemaining` is the modelled boost lifetime. A planner must count a
 * rocket once per use; the remaining ticks are the already-paid thrust.
 */
export interface FlightFireworkState {
  active: boolean
  ticksRemaining: number
}

/** One client tick snapshot the prediction consumes (design §3). */
export interface FlightObservation {
  /** Client tick the observation belongs to. */
  tick: number
  position: Vec3
  velocity: Vec3
  yaw: number
  pitch: number
  poseBox: FlightPoseBox
  health: number
  equipment?: FlightEquipment
  firework: FlightFireworkState
  onGround: boolean
  inWater: boolean
  dimension?: string
  source?: string
}

/** One coarse corridor region and what the map read proved about it. */
export interface FlightCorridorRegion {
  id: string
  bounds: { min: Vec3, max: Vec3 }
  /** Verified headroom inside the region, in blocks. */
  clearance: number
  /** Cell size this region was resolved at, in blocks. */
  resolution: number
  /** True when part of the region is unknown; unknown is never assumed air. */
  hasUnknown: boolean
}

/** A headroom-checked connection between two corridor regions. */
export interface FlightCorridorEntrance {
  from: string
  to: string
  position: Vec3
  width: number
  height: number
}

/**
 * The coarse route the intent should follow (design §3).
 *
 * A corridor is not a list of cell-centre waypoints: the local rollout layer
 * may still reject a geometrically passable but unflyable route.
 */
export interface FlightCorridor {
  mapVersion: string
  dimension: string
  regions: FlightCorridorRegion[]
  entrances: FlightCorridorEntrance[]
  /** Region the route ends in, when one exists. */
  exit?: string
  /** Cells the read did not cover; the route never treats them as free. */
  unknownBoundary: Vec3[]
  speedRange: { min: number, max: number }
}

/**
 * Terminal reason of one flight (design §7, §9).
 *
 * `launch_unavailable` and `no_reachable_landing` are definite limitations,
 * not generic failures; `touchdown_unverified` reports a bounded stop whose
 * landing was never proved.
 */
export type FlightExitReason
  = | 'reached'
    | 'cancelled'
    | 'low_supply'
    | 'safety'
    | 'timeout'
    | 'launch_unavailable'
    | 'no_reachable_landing'
    | 'landing_in_water'
    | 'touchdown_unverified'
    | 'go_around_exhausted'

/** Status the session publishes to the main process (§3). */
export interface FlightStatus {
  phase: FlightPhase
  /** Trajectory id the client is executing, when one is active. */
  activeTrajectoryId?: string
  /** Distance between the observed position and the planned position, blocks. */
  deviation: number
  budget: FlightSupplyBudget
  /** Verified landing sites held as fallbacks. */
  alternates: LandingSite[]
  exitReason?: FlightExitReason
}
