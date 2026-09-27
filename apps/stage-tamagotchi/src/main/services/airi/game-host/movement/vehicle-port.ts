/**
 * The port and per-trip options the vehicle session drives (CD-V1).
 *
 * Split from {@link ./vehicle-types} so the pure domain types stay a leaf:
 * this module is the only place that joins the base movement port with the
 * optional vehicle-observation surface.
 */
import type { FlightPlannerSwitch } from '../flight/profile'
import type { FlightCrossSection, MovementControlPort } from './port'
import type { Vec3 } from './types'
import type { VehicleAcquireStrategy, VehicleFailureReason, VehicleKind, VehicleObservationPort, VehicleReceipt } from './vehicle-types'

/** Base movement port plus the optional vehicle observation surface. */
export type VehicleControlPort = MovementControlPort & VehicleObservationPort

/**
 * Status of a vehicle drive, kept compatible with the MC-3b surface.
 *
 * `unknown` is a bounded ending whose final condition could not be confirmed
 * (a failed touch-down read). It is never reported as `reached`.
 */
export type VehicleMoveStatus = 'reached' | 'stuck' | 'cancelled' | 'unavailable' | 'low_supply' | 'unknown'

export interface VehicleMoveResult {
  status: VehicleMoveStatus
  detail?: string
  /** Typed failure, present whenever the trip did not reach cleanly. */
  failure?: VehicleFailureReason
  /**
   * E-02 venue: how the long-route layer participated in an elytra flight.
   * Present only when the flight planner switch enabled the layer.
   */
  lowRoute?: {
    used: boolean
    replans: number
    refusals: number
    /** Last refusal reason; present only when the layer refused at least once. */
    lastRefusal?: 'blocked' | 'read_failed' | 'search_budget'
  }
  /**
   * R3 channel exchange receipt: how the client-driven cruise participated.
   * Present only when the flight ran in channel mode.
   */
  channel?: {
    /** Submit attempts, including every revision resubmit. */
    submissions: number
    /** Failure replans after client rejections or stale-prefix verification. */
    replans: number
    /**
     * Normal frontier continuations: a local route reached its read frontier
     * and the next leg continued the same flight. Kept apart from `replans`
     * so a long route crossing several read windows does not exhaust the
     * failure budget (R4 review 2026-09-20).
     */
    continuations?: number
    /** The client's terminal end reason for the last channel, when one ended. */
    endReason?: string
    /**
     * Host-side cause that forced the ending, when it was not the client's own
     * end reason (for example `route_unavailable` after a refused replan).
     */
    failure?: string
    /** Per-leg exchange records for evidence; oldest first. */
    legs?: ChannelLegRecord[]
    /**
     * True when the mover returned with the glider still airborne. "Returned"
     * and "safely grounded" are separate facts (R4 review 2026-09-20).
     */
    airborneAtReturn?: boolean
  }
  /** Full end-of-trip receipt; the movers fill this so the host can record it. */
  receipt?: VehicleReceipt
}

/** One planned-and-submitted channel leg, kept for post-run evidence. */
export interface ChannelLegRecord {
  revision: number
  kind: 'initial' | 'frontier' | 'retry' | 'approach'
  /** Where this leg's route was planned from. */
  plannedFrom: Vec3
  planStatus: string
  /** Wall-clock planning cost; a prefetched leg overlaps the previous leg. */
  planMs: number
  /** R1 raw path before channel downsampling; absent for approach legs. */
  rawPath?: Vec3[]
  /** The path actually submitted (channel spacing, terminal point kept). */
  sentPath: Vec3[]
  submittedAtMs: number
  accepted: boolean
  /** Client refusal reason when the submit was not accepted. */
  refusal?: string
  /** Client end reason for this leg, once it ended. */
  endedReason?: string
  endedAtMs?: number
  /** Client position when the leg ended. */
  positionAtEnd?: Vec3
}

export interface VehicleMoveOptions {
  port: VehicleControlPort
  goal: Vec3
  tolerance?: number
  /**
   * Openings the elytra route must actually fly through, in order (ab-30 plan
   * §1). Absent keeps the current planning byte-identically: the planner then
   * ranks open-sky frontier candidates first and never refuses with
   * `no_section_path`.
   */
  mustPass?: FlightCrossSection[]
  shouldStop?: () => boolean
  /**
   * CD-E B0 rollout-planner switch for the elytra cruise phase.
   *
   * Absent keeps the heuristic cruise control byte-identically; see
   * {@link ../flight/profile.FlightPlannerSwitch}.
   */
  flightPlanner?: FlightPlannerSwitch
  /**
   * World binding for the elytra coarse-corridor read.
   *
   * The corridor plans over live terrain, so it needs the dimension and world
   * the trip belongs to. Without a binding the elytra cruise keeps the direct
   * goal, because a route cannot be planned in a world the command cannot name.
   */
  world?: { worldId: string, dimension: string, mapVersion: string }
  /**
   * Whether this session still owns the player's input (CD-0 D8).
   *
   * A late `finally` from an old command must not release input a newer command
   * now owns. When this returns false the mover stops writing controls; the
   * default owner is the command that started it.
   */
  stillOwnsControl?: () => boolean
  /** Acquire strategy; `existing` by default (design §3). */
  strategy?: VehicleAcquireStrategy
  /** Explicit vehicle UUID: the only non-ambiguous acquisition target. */
  vehicleUuid?: string
  /** Horse taming needs explicit permission (design §3). */
  allowTame?: boolean
  /** Overall budget for one acquisition attempt, in ms. */
  acquireBudgetMs?: number
  /** Overall travel budget, in ms. */
  travelBudgetMs?: number
  /** Identity captured by the registry; kept on the session for ownership. */
  commandId?: string
  controlSessionId?: string
  controlSessionGeneration?: number
  /** Player UUID used to attribute controller/passenger facts. */
  playerUuid?: string
  deps?: {
    sleep?: (ms: number) => Promise<void>
    now?: () => number
  }
  debug?: (message: string) => void
}

export interface VehicleContext {
  port: VehicleControlPort
  shouldStop: () => boolean
  sleep: (ms: number) => Promise<void>
  now: () => number
  debug?: (message: string) => void
  kind: VehicleKind
  /** Absolute travel deadline; a trip past it fails with `deadline`. */
  travelDeadline?: number
}

export type { VehicleKind }
