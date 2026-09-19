/**
 * The port and per-trip options the vehicle session drives (CD-V1).
 *
 * Split from {@link ./vehicle-types} so the pure domain types stay a leaf:
 * this module is the only place that joins the base movement port with the
 * optional vehicle-observation surface.
 */
import type { FlightPlannerSwitch } from '../flight/profile'
import type { MovementControlPort } from './port'
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
  /** Full end-of-trip receipt; the movers fill this so the host can record it. */
  receipt?: VehicleReceipt
}

export interface VehicleMoveOptions {
  port: VehicleControlPort
  goal: Vec3
  tolerance?: number
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
