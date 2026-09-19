/**
 * Shared vehicle-travel domain types (vehicle-travel design §3, CD-V1).
 *
 * One travel owns a single lifecycle:
 * `Discover -> Prepare -> Acquire -> VerifyControl -> Plan -> Travel -> Dock -> Finish`.
 * A failure ends the trip or takes a bounded recovery; it never restarts the
 * whole trip. The phase list and the receipt are the contract the movers, the
 * game host and the offline tests share.
 *
 * Types here are the leaf of the vehicle modules: the dispatcher, the session
 * machine, the routing graphs and the drive primitives all import them, so no
 * runtime import cycle forms.
 */
import type { TriState } from './target-observation'
import type { Vec3 } from './types'

export type { TriState }

/** Mover selector the `move_to` command exposes (unchanged MC-3b surface). */
export type VehicleKind = 'boat' | 'horse' | 'minecart' | 'elytra' | 'strider'

/**
 * Concrete rideable the observation names.
 *
 * `camel` is deliberately its own kind: it cannot reuse horse taming, saddle
 * or jump semantics, so it is out of scope rather than folded into `horse`
 * (design §1: `isHorse` must not lump camels in with horses).
 */
export type VehicleEntityKind = 'boat' | 'horse' | 'donkey' | 'mule' | 'camel' | 'minecart' | 'strider' | 'other'

/** Horse family whose abilities are close enough to share one road model. */
export type HorseFamilyKind = 'horse' | 'donkey' | 'mule'

/** Every phase one travel passes through (design §3). */
export type VehicleTravelPhase
  = | 'discover'
    | 'prepare'
    | 'acquire'
    | 'verify-control'
    | 'plan'
    | 'travel'
    | 'dock'
    | 'finish'

/**
 * How the session obtained its vehicle (design §3, §4-§6).
 *
 * `existing` uses a vehicle that already stands in the world; `prepare_owned`
 * places or assembles one from the player's own materials; `tame` is the horse
 * bonding flow, which needs explicit permission and a time budget.
 */
export type VehicleAcquireStrategy = 'existing' | 'prepare_owned' | 'tame'

/** Where a spawned/consumed vehicle asset came from or ended up. */
export type VehicleAssetLocation = 'inventory' | 'placed' | 'vehicle' | 'consumed' | 'unknown'

/**
 * Typed travel failures (design §7).
 *
 * The first group is common to every rideable; horses add `not_tamed` and
 * `saddle_missing`; minecarts add `rail_not_powered` and `launch_unavailable`.
 */
export type VehicleFailureReason
  = | 'vehicle_not_found'
    | 'occupied'
    | 'not_controllable'
    | 'acquire_timeout'
    | 'route_unavailable'
    | 'unsafe_dismount'
    | 'vehicle_lost'
    | 'not_tamed'
    | 'saddle_missing'
    | 'rail_not_powered'
    | 'launch_unavailable'
    | 'no_materials'
    | 'placement_failed'
    | 'duplicate_vehicle'
    | 'not_owned'
    | 'no_permission'
    | 'waterway_unavailable'
    | 'land_separated'
    | 'dimension_changed'
    | 'passenger_changed'
    | 'cancelled'
    | 'unverified_stop'
    | 'capability_unavailable'
    | 'deadline'
    // Elytra lifecycle outcomes (elytra-navigation §6–§7, CD-E0/E3). Each names
    // a definite end that is not a clean arrival or a plain cancellation.
    | 'no_reachable_landing'
    | 'touchdown_unverified'
    | 'landing_in_water'
    | 'go_around_exhausted'
    | 'goal_under_roof'

/** One consumed spawn item and where it went. */
export interface VehicleAssetReceipt {
  itemId?: string
  /** True when the item left the inventory (a boat/minecart was consumed). */
  consumed: number
  /** True when the item came back (a boat/minecart recovered after use). */
  recovered: number
  location: VehicleAssetLocation
}

/**
 * End-of-trip receipt (design §7).
 *
 * A single `reached` boolean cannot express the outcome: the receipt records
 * the acquire method, the fixed vehicle UUID, the distance travelled, where
 * the vehicle stopped, whether the player dismounted, where the assets are and
 * the terminal reason.
 */
export interface VehicleReceipt {
  commandId: string
  controlSessionId: string
  controlSessionGeneration: number
  kind: VehicleEntityKind
  acquireMethod: VehicleAcquireStrategy
  vehicleUuid?: string
  /** Horizontal distance travelled while mounted, in blocks. */
  distanceTravelled: number
  /** Where the vehicle stopped; absent when the position was never read. */
  dockPosition?: Vec3
  /** True only when the player actually left the vehicle. */
  dismounted: boolean
  /** True when the trip ended inside tolerance but no safe bank existed. */
  arrivedMounted?: boolean
  asset?: VehicleAssetReceipt
  /** Present only when the trip failed. */
  failure?: VehicleFailureReason
  endReason: string
  /** Phases the session actually entered, in order, for audit. */
  phases: VehicleTravelPhase[]
}

// --- Observation contract (CD-V1) -------------------------------------------------------

/** Per-type state a boat observation carries when the bridge reports it. */
export interface BoatVehicleState {
  kind: 'boat'
  /** Concrete item id, e.g. `minecraft:oak_boat`; absent when unread. */
  boatItemId?: string
  inWater: TriState
  /** Paddle side at the last read; absent when the source cannot report it. */
  paddleSide?: 'left' | 'right' | 'none'
}

/** Per-type state for horse, donkey and mule. */
export interface HorseVehicleState {
  kind: HorseFamilyKind
  tamed: TriState
  saddled: TriState
  /** Owner UUID when the entity reports one. */
  owner?: string
  health?: number
  /** Vanilla jump strength (0..1) when reported. */
  jumpStrength?: number
  /**
   * True only when the current passenger can steer the animal.
   *
   * Being ridden is not the same as being controllable: a wild horse can throw
   * its rider. This field is the verified answer, not an inference.
   */
  controlledByPassenger: TriState
}

export interface CamelVehicleState {
  kind: 'camel'
  tamed: TriState
  saddled: TriState
  owner?: string
}

/** Per-type state a minecart observation carries when the bridge reports it. */
export interface MinecartVehicleState {
  kind: 'minecart'
  variant?: string
  /** Horizontal speed in blocks per tick at the last read. */
  speed?: number
  /** Rail block state under the cart, e.g. `north_south` or `ascending_east`. */
  railShape?: string
  powered: TriState
  onRail: TriState
}

export type VehicleTypeState
  = | BoatVehicleState
    | HorseVehicleState
    | CamelVehicleState
    | MinecartVehicleState
    | { kind: 'strider' | 'other' }

export interface VehicleBounds {
  width: number
  height: number
}

/**
 * One observed rideable (design §3).
 *
 * Absent position/velocity are `undefined`, never zero. Tri-state facts stay
 * `'unobserved'` until the source reports them, so a consumer never reads "no
 * data" as "free" or "tamed" (CD-0 §3.3).
 */
export interface VehicleObservation {
  uuid: string
  type: string
  kind: VehicleEntityKind
  worldId: string
  dimension: string
  position?: Vec3
  velocity?: Vec3
  yaw?: number
  bounds?: VehicleBounds
  /** Passenger UUIDs, controller first when the source orders them. */
  passengers: string[]
  /** Passenger that currently controls the vehicle, when one is observed. */
  controller?: string
  /** True only when the read proved no passenger occupies it. */
  free: TriState
  /** True only when the read proved the player owns it. */
  owned: TriState
  state: VehicleTypeState
  source: string
  sourceTick?: number
  receivedAt: number
  requestStartedAt: number
  requestEndedAt: number
  requestDurationMs: number
  connectionGeneration: number
  completeness: 'complete' | 'truncated' | 'partial' | 'failed'
  missingReason?: string
}

// --- Legacy port shapes the vehicle port extends -----------------------------------------

/** The rideable the player currently sits on, if any. */
export interface RidingInfo {
  kind: string
  uuid?: string
}

/** One observation read for a fixed entity UUID. */
export interface VehicleObservationRequest {
  uuid: string
  dimension: string
  worldId: string
  connectionGeneration: number
  /** Player whose ownership the read compares against; optional. */
  playerUuid?: string
  sourceTick?: number
  startedAt: number
  receiveTime?: number
}

/** One candidate search over nearby rideables. */
export interface VehicleQueryRequest {
  dimension: string
  worldId: string
  connectionGeneration: number
  /** Restrict to one concrete kind; omitted means every kind. */
  kind?: VehicleEntityKind
  origin?: Vec3
  radius?: number
  maxResults?: number
  sourceTick?: number
  startedAt: number
  receiveTime?: number
}

/**
 * Vehicle-specific IO a bridge may expose on top of the base movement port.
 *
 * Every member is optional: a bridge without the backing tool reports the
 * absence as a typed limit instead of a fabricated observation, and a caller
 * degrades to unverified behavior rather than pretending it verified.
 */
export interface VehicleObservationPort {
  observeVehicle?: (request: VehicleObservationRequest) => Promise<VehicleObservation | undefined>
  queryVehicles?: (request: VehicleQueryRequest) => Promise<VehicleObservation[]>
  /** Boards one exact entity UUID; never picks a nearby object implicitly. */
  boardVehicle?: (uuid: string) => Promise<{ boarded: boolean, info?: RidingInfo }>
  /**
   * Places the held vehicle item (boat/minecart) and reports the spawned UUID
   * when the bridge observes it. `inventoryDelta` is the measured item decrease.
   */
  placeVehicleItem?: (input: { itemId: string }) => Promise<{ placed: boolean, spawnedUuid?: string, inventoryDelta?: number }>
  /** Drives the current interaction for taming or saddling (version-native). */
  interactVehicle?: (input: { uuid: string, action: 'tame' | 'saddle' | 'mount' }) => Promise<{ ok: boolean, detail?: string }>
}

/** Converts a mover kind to the concrete kind its observation should match. */
export function entityKindsForMover(kind: VehicleKind): VehicleEntityKind[] {
  switch (kind) {
    case 'boat':
      return ['boat']
    case 'horse':
      return ['horse', 'donkey', 'mule']
    case 'minecart':
      return ['minecart']
    case 'strider':
      return ['strider']
    case 'elytra':
      return []
  }
}
