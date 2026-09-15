/**
 * Vehicle observation contract and candidate verification (CD-V1).
 *
 * Every rideable is identified by its entity UUID. The observation carries the
 * concrete type, the world/dimension binding, position/velocity, yaw, bounds,
 * passengers and controller, plus type-specific state. Tri-state facts stay
 * `'unobserved'` until the source reports them, so a caller never reads "no
 * data" as "free", "tamed" or "powered" (CD-0 §3.3, no fabricated results).
 *
 * This module is pure: the host parses MCP records into these shapes and the
 * offline tests build them directly.
 */
import type { TriState } from './target-observation'
import type { Vec3 } from './types'
import type {
  BoatVehicleState,
  CamelVehicleState,
  HorseFamilyKind,
  HorseVehicleState,
  MinecartVehicleState,
  VehicleBounds,
  VehicleEntityKind,
  VehicleFailureReason,
  VehicleObservation,
  VehicleObservationRequest,
  VehicleTypeState,
} from './vehicle-types'

import { assertObservationDimension } from './observation'
import { triStateOf } from './target-observation'

/** Result cap for one candidate query, mirroring the target query cap. */
export const VEHICLE_QUERY_MAX_RESULTS = 64

/** A vehicle read that could not be parsed; callers must not treat it as absent. */
export class VehicleReadError extends Error {
  readonly detail: string

  constructor(detail: string) {
    super(`Vehicle read failed: ${detail}`)
    this.name = 'VehicleReadError'
    this.detail = detail
  }
}

/** A read whose uuid does not match the requested vehicle. */
export class VehicleIdentityMismatchError extends Error {
  readonly requested: string
  readonly received: string

  constructor(requested: string, received: string) {
    super(`Vehicle identity mismatch: requested ${requested}, received ${received}.`)
    this.name = 'VehicleIdentityMismatchError'
    this.requested = requested
    this.received = received
  }
}

/**
 * Maps a registry entity type id onto the concrete vehicle kind.
 *
 * Camels are their own kind: their taming and motion semantics cannot reuse the
 * horse road model (design §1).
 *
 * @example
 * vehicleKindOf('minecraft:oak_boat')
 * // => 'boat'
 */
export function vehicleKindOf(typeId: string): VehicleEntityKind {
  const name = typeId.includes(':') ? typeId.slice(typeId.indexOf(':') + 1) : typeId
  if (name === 'boat' || name.endsWith('_boat') || name.endsWith('_raft'))
    return 'boat'
  if (name === 'horse')
    return 'horse'
  if (name === 'donkey')
    return 'donkey'
  if (name === 'mule')
    return 'mule'
  if (name === 'camel')
    return 'camel'
  if (name === 'minecart' || name.endsWith('_minecart'))
    return 'minecart'
  if (name === 'strider')
    return 'strider'
  return 'other'
}

/** True for horse, donkey and mule; false for camel and every other kind. */
export function isHorseFamily(kind: VehicleEntityKind): kind is HorseFamilyKind {
  return kind === 'horse' || kind === 'donkey' || kind === 'mule'
}

function finiteNumber(value: unknown): number | undefined {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function positionOf(record: Record<string, unknown>): Vec3 | undefined {
  const nested = record.position && typeof record.position === 'object' && !Array.isArray(record.position)
    ? record.position as Record<string, unknown>
    : record
  const x = finiteNumber(nested.x)
  const y = finiteNumber(nested.y)
  const z = finiteNumber(nested.z)
  return x === undefined || y === undefined || z === undefined ? undefined : { x, y, z }
}

function velocityOf(record: Record<string, unknown>): Vec3 | undefined {
  const raw = record.velocity && typeof record.velocity === 'object' && !Array.isArray(record.velocity)
    ? record.velocity
    : record.motion
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return undefined
  const value = raw as Record<string, unknown>
  const x = finiteNumber(value.x)
  const y = finiteNumber(value.y)
  const z = finiteNumber(value.z)
  return x === undefined || y === undefined || z === undefined ? undefined : { x, y, z }
}

function boundsOf(record: Record<string, unknown>): VehicleBounds | undefined {
  const raw = record.bounds && typeof record.bounds === 'object' && !Array.isArray(record.bounds)
    ? record.bounds as Record<string, unknown>
    : undefined
  const width = finiteNumber(raw?.width ?? record.width)
  const height = finiteNumber(raw?.height ?? record.height)
  return width === undefined || height === undefined ? undefined : { width, height }
}

function stringArrayOf(value: unknown): string[] | undefined {
  if (!Array.isArray(value))
    return undefined
  return value.filter((entry): entry is string => typeof entry === 'string')
}

/**
 * Reads the free/occupied fact from explicit passengers.
 *
 * An empty passenger list is proof the vehicle is free; a missing list is
 * `'unobserved'`, never `false`.
 */
function freeStateOf(record: Record<string, unknown>): TriState {
  if (typeof record.free === 'boolean')
    return record.free
  const passengers = stringArrayOf(record.passengers)
  if (passengers)
    return passengers.length === 0
  return 'unobserved'
}

/**
 * Reads the ownership fact against the requesting player.
 *
 * Only an explicit boolean or an owner UUID equal to the player is a fact; a
 * missing owner field stays `'unobserved'`.
 */
function ownedStateOf(record: Record<string, unknown>, playerUuid: string | undefined): TriState {
  if (typeof record.owned === 'boolean')
    return record.owned
  const owner = typeof record.owner === 'string' ? record.owner : undefined
  if (owner && playerUuid)
    return owner === playerUuid
  return 'unobserved'
}

function boatStateOf(record: Record<string, unknown>): BoatVehicleState {
  const paddle = record.paddleSide
  return {
    kind: 'boat',
    ...(typeof record.boatType === 'string' ? { boatItemId: record.boatType } : {}),
    inWater: triStateOf(record.inWater),
    ...(paddle === 'left' || paddle === 'right' || paddle === 'none' ? { paddleSide: paddle } : {}),
  }
}

function horseStateOf(record: Record<string, unknown>, kind: HorseFamilyKind): HorseVehicleState {
  const health = finiteNumber(record.health)
  const jumpStrength = finiteNumber(record.jumpStrength)
  return {
    kind,
    tamed: triStateOf(record.tamed),
    saddled: triStateOf(record.saddled),
    ...(typeof record.owner === 'string' ? { owner: record.owner } : {}),
    ...(health !== undefined ? { health } : {}),
    ...(jumpStrength !== undefined ? { jumpStrength } : {}),
    controlledByPassenger: triStateOf(record.controlledByPassenger),
  }
}

function camelStateOf(record: Record<string, unknown>): CamelVehicleState {
  return {
    kind: 'camel',
    tamed: triStateOf(record.tamed),
    saddled: triStateOf(record.saddled),
    ...(typeof record.owner === 'string' ? { owner: record.owner } : {}),
  }
}

function minecartStateOf(record: Record<string, unknown>): MinecartVehicleState {
  const speed = finiteNumber(record.speed)
  return {
    kind: 'minecart',
    ...(typeof record.variant === 'string' ? { variant: record.variant } : {}),
    ...(speed !== undefined ? { speed } : {}),
    ...(typeof record.railShape === 'string' ? { railShape: record.railShape } : {}),
    powered: triStateOf(record.powered),
    onRail: triStateOf(record.onRail),
  }
}

function typeStateOf(kind: VehicleEntityKind, record: Record<string, unknown>): VehicleTypeState {
  switch (kind) {
    case 'boat':
      return boatStateOf(record)
    case 'horse':
    case 'donkey':
    case 'mule':
      return horseStateOf(record, kind)
    case 'camel':
      return camelStateOf(record)
    case 'minecart':
      return minecartStateOf(record)
    default:
      return { kind: 'other' }
  }
}

/** Raw read the game host builds from one MCP record. */
export interface VehicleReadResponse {
  uuid?: string
  type?: string
  dimension?: string
  worldId?: string
  connectionGeneration?: number
  source?: string
  sourceTick?: number
  endedAt?: number
  receivedAt?: number
  entity?: Record<string, unknown>
  error?: string
  /** Why the entity was not observed; absent means the read simply had none. */
  absence?: 'out-of-range' | 'unloaded' | 'not-found' | 'unavailable'
}

/**
 * Builds one vehicle observation from a raw read.
 *
 * Throws {@link VehicleReadError} when the read failed and
 * {@link VehicleIdentityMismatchError} when it names another uuid; a response
 * with no entity record returns `undefined` so the caller keeps the absence
 * distinction instead of inventing a zeroed vehicle.
 */
export function buildVehicleObservation(
  request: VehicleObservationRequest,
  response: VehicleReadResponse,
): VehicleObservation | undefined {
  if (response.error)
    throw new VehicleReadError(response.error)
  assertObservationDimension(request.dimension, response.dimension)
  if (response.uuid !== undefined && response.uuid !== request.uuid)
    throw new VehicleIdentityMismatchError(request.uuid, response.uuid)
  const record = response.entity
  if (!record)
    return undefined

  const type = typeof record.type === 'string' ? record.type : (typeof response.type === 'string' ? response.type : '')
  const kind = vehicleKindOf(type)
  const receivedAt = response.receivedAt ?? request.receiveTime ?? request.startedAt
  const sourceTick = response.sourceTick ?? finiteNumber(record.sourceTick) ?? request.sourceTick
  const passengers = stringArrayOf(record.passengers) ?? []
  const position = positionOf(record)
  const velocity = velocityOf(record)
  const yaw = finiteNumber(record.yaw)
  const bounds = boundsOf(record)
  const controller = typeof record.controller === 'string' ? record.controller : undefined

  return {
    uuid: request.uuid,
    type,
    kind,
    worldId: response.worldId ?? request.worldId,
    dimension: response.dimension ?? request.dimension,
    ...(position ? { position } : {}),
    ...(velocity ? { velocity } : {}),
    ...(yaw !== undefined ? { yaw } : {}),
    ...(bounds ? { bounds } : {}),
    passengers,
    ...(controller ? { controller } : {}),
    free: freeStateOf(record),
    owned: ownedStateOf(record, request.playerUuid),
    state: typeStateOf(kind, record),
    source: response.source ?? 'client-loaded-entity',
    ...(sourceTick !== undefined ? { sourceTick } : {}),
    receivedAt,
    requestStartedAt: request.startedAt,
    requestEndedAt: response.endedAt ?? receivedAt,
    requestDurationMs: Math.max(0, receivedAt - request.startedAt),
    connectionGeneration: response.connectionGeneration ?? request.connectionGeneration,
    completeness: 'complete',
  }
}

/** Criteria a candidate must satisfy before it can be acquired (design §3). */
export interface VehicleCandidateCriteria {
  kind: VehicleEntityKind | VehicleEntityKind[]
  /** Require the read to prove the vehicle has no occupant. */
  requireFree?: boolean
  /** Require a tamed horse/donkey/mule. */
  requireTamed?: boolean
  /** Require a saddled horse/donkey/mule. */
  requireSaddled?: boolean
  /** Require a powered minecart launch. */
  requirePowered?: boolean
  /** Require the player to own the vehicle. */
  requireOwned?: boolean
  /** Explicit UUID: when set, no other candidate may be selected. */
  explicitUuid?: string
  origin?: Vec3
  maxDistance?: number
}

export interface VehicleCandidateSelection {
  observation?: VehicleObservation
  reason?: VehicleFailureReason
  /** True when several distinct candidates passed without an explicit uuid. */
  ambiguous: boolean
  rejected: Array<{ uuid: string, reason: VehicleFailureReason }>
}

function withinDistance(observation: VehicleObservation, criteria: VehicleCandidateCriteria): boolean {
  if (criteria.maxDistance === undefined || !criteria.origin || !observation.position)
    return true
  const dx = observation.position.x - criteria.origin.x
  const dz = observation.position.z - criteria.origin.z
  return Math.hypot(dx, dz) <= criteria.maxDistance
}

function distanceOf(observation: VehicleObservation, origin: Vec3 | undefined): number {
  if (!origin || !observation.position)
    return Number.POSITIVE_INFINITY
  return Math.hypot(observation.position.x - origin.x, observation.position.z - origin.z)
}

/**
 * The first precondition a candidate fails, or `undefined` when it passes.
 *
 * Occupation, taming, saddling and power are only checked when the criteria
 * demands them; an unobservable fact fails with `capability_unavailable`
 * instead of silently passing.
 */
export function verifyVehiclePreconditions(
  observation: VehicleObservation,
  criteria: VehicleCandidateCriteria,
): VehicleFailureReason | undefined {
  const kinds = Array.isArray(criteria.kind) ? criteria.kind : [criteria.kind]
  if (!kinds.includes(observation.kind))
    return 'vehicle_not_found'
  if (criteria.requireOwned && observation.owned === false)
    return 'not_owned'
  if (criteria.requireFree) {
    if (observation.free === false)
      return 'occupied'
    if (observation.free === 'unobserved')
      return 'capability_unavailable'
  }
  const state = observation.state
  if (criteria.requireTamed) {
    if (state.kind === 'camel') {
      // A camel is out of scope for the horse flow; never claim it is tamed.
      return 'not_tamed'
    }
    if (state.kind !== 'horse' && state.kind !== 'donkey' && state.kind !== 'mule')
      return 'not_tamed'
    if (state.tamed !== true)
      return state.tamed === 'unobserved' ? 'capability_unavailable' : 'not_tamed'
  }
  if (criteria.requireSaddled) {
    if (state.kind !== 'horse' && state.kind !== 'donkey' && state.kind !== 'mule')
      return 'saddle_missing'
    if (state.saddled !== true)
      return state.saddled === 'unobserved' ? 'capability_unavailable' : 'saddle_missing'
  }
  if (criteria.requirePowered) {
    if (state.kind !== 'minecart')
      return 'launch_unavailable'
    if (state.powered !== true)
      return state.powered === 'unobserved' ? 'capability_unavailable' : 'rail_not_powered'
  }
  return undefined
}

/**
 * Selects one vehicle from a candidate list.
 *
 * An explicit UUID must resolve, and only that entity is examined. Without an
 * explicit UUID, the nearest candidate that satisfies every criterion is used;
 * an object that is occupied, untamed or unsaddled is never claimed silently,
 * and its rejection reason is kept so the caller can report why. Several
 * distinct passing candidates set `ambiguous` so the caller can require an
 * explicit UUID (design §3: no implicit claiming of a nearby object).
 *
 * @example
 * selectVehicleCandidate([boat], { kind: 'boat', requireFree: true }).observation?.uuid
 * // => 'boat-1'
 */
export function selectVehicleCandidate(
  candidates: VehicleObservation[],
  criteria: VehicleCandidateCriteria,
): VehicleCandidateSelection {
  const rejected: Array<{ uuid: string, reason: VehicleFailureReason }> = []
  if (criteria.explicitUuid !== undefined) {
    const match = candidates.find(candidate => candidate.uuid === criteria.explicitUuid)
    if (!match) {
      // The explicit entity was not in the read: it may exist outside the query
      // radius, but this selection cannot use it, so it is not found.
      return { reason: 'vehicle_not_found', ambiguous: false, rejected }
    }
    if (!withinDistance(match, criteria))
      return { reason: 'vehicle_not_found', ambiguous: false, rejected }
    const failure = verifyVehiclePreconditions(match, criteria)
    if (failure)
      return { reason: failure, ambiguous: false, rejected }
    return { observation: match, ambiguous: false, rejected }
  }

  let best: VehicleObservation | undefined
  let bestDistance = Number.POSITIVE_INFINITY
  let passed = 0
  for (const candidate of candidates) {
    if (!withinDistance(candidate, criteria))
      continue
    const failure = verifyVehiclePreconditions(candidate, criteria)
    if (failure) {
      rejected.push({ uuid: candidate.uuid, reason: failure })
      continue
    }
    passed++
    // Without an origin the first passing candidate is the selection; distance
    // only breaks ties when the caller supplied a player position.
    const distance = distanceOf(candidate, criteria.origin)
    if (best === undefined || distance < bestDistance) {
      bestDistance = distance
      best = candidate
    }
  }
  if (best)
    return { observation: best, ambiguous: passed > 1, rejected }
  // Prefer the most specific rejection over a vague "not found".
  const reason = rejected.find(entry => entry.reason === 'occupied')?.reason
    ?? rejected.find(entry => entry.reason === 'not_tamed')?.reason
    ?? rejected.find(entry => entry.reason === 'saddle_missing')?.reason
    ?? rejected.find(entry => entry.reason === 'not_owned')?.reason
    ?? rejected.find(entry => entry.reason === 'rail_not_powered')?.reason
    ?? rejected.find(entry => entry.reason === 'capability_unavailable')?.reason
    ?? 'vehicle_not_found'
  return { reason, ambiguous: false, rejected }
}
