/**
 * Target observation contract (target-tracking design §3, CD-L1).
 *
 * One target has one fixed identity: `targetUuid`. The name and the
 * coordinates never reassign that identity. Every spatial fact carries the
 * world, the dimension, the source, the source tick, the main-process receive
 * time and the request window, so a consumer can compute an age and an error
 * instead of guessing.
 *
 * This module is pure: the game host parses MCP records into these shapes and
 * unit tests build them directly. It reuses the CD-0 clock and dimension rules
 * from {@link ./observation}.
 */
import type { ObservationCompleteness } from './observation'
import type { Vec3 } from './types'

import { assertObservationDimension } from './observation'

/** Query radius the follow target read uses (target-tracking design §1). */
export const TARGET_QUERY_RADIUS = 64
/** Result cap the follow target read uses; a longer list is truncated. */
export const TARGET_QUERY_MAX_RESULTS = 100
/** Base position error in blocks when no motion is known. */
export const TARGET_UNCERTAINTY_BASE_BLOCKS = 0.25
/** Ticks per second, used to turn vanilla motion (blocks/tick) into speed. */
const TICKS_PER_SECOND = 20

/**
 * Tri-state fact: observed true, observed false, or not observed.
 *
 * A missing field is `'unobserved'`, never `false`. The three values are
 * distinct so a consumer never reads "no data" as "the target is on the
 * ground" (CD-0 D4).
 */
export type TriState = true | false | 'unobserved'

/**
 * Normalizes a raw field into a tri-state fact.
 *
 * @example
 * triStateOf(undefined)
 * // => 'unobserved'
 */
export function triStateOf(value: unknown): TriState {
  if (value === true)
    return true
  if (value === false)
    return false
  return 'unobserved'
}

/** Where a target fact came from. Recorded so source switches stay visible. */
export type TargetObservationSource
  = | 'client-loaded-entity'
    | 'server-entity'
    | 'server-player-locate'
    | 'history'

/** What a read covered for one target. */
export type TargetVisibility
  = | 'loaded'
    | 'out-of-range'
    | 'list-truncated'
    | 'unloaded'
    | 'unavailable'

/** Width and height of the entity collision box, in blocks. */
export interface TargetBounds {
  width: number
  height: number
}

/**
 * One target observation (design §3).
 *
 * `position` is absent when the read did not report one, `velocity` is absent
 * when the read did not report one (never zero). The tri-state facts use
 * {@link TriState}. `positionUncertainty` is an estimate in blocks, derived
 * from the sample age, the request latency and the observed speed.
 */
export interface TargetObservation {
  targetUuid: string
  entityType?: string
  isPlayer?: boolean
  worldId: string
  dimension: string
  position?: Vec3
  velocity?: Vec3
  yaw?: number
  pitch?: number
  bounds?: TargetBounds
  onGround: TriState
  fallFlying: TriState
  riding: TriState
  alive: TriState
  source: TargetObservationSource
  sourceTick?: number
  receivedAt: number
  requestStartedAt: number
  requestEndedAt: number
  requestDurationMs: number
  connectionGeneration: number
  visibility: TargetVisibility
  completeness: ObservationCompleteness
  missingReason?: string
  positionUncertainty: number
}

/** One target read request. The dimension is required and verified (D12). */
export interface TargetReadRequest {
  targetUuid: string
  dimension: string
  worldId: string
  connectionGeneration: number
  source: TargetObservationSource
  radius?: number
  maxResults?: number
  sourceTick?: number
  startedAt: number
  receiveTime?: number
}

/**
 * Raw target read the game host builds from one MCP record.
 *
 * `entity` is the matched record. When it is absent, `absence` says why the
 * target was not observed. A list read sets `listTruncated` when it dropped a
 * tail; a truncated list is not proof that the target is gone.
 */
export interface TargetReadResponse {
  uuid?: string
  entityType?: string
  isPlayer?: boolean
  dimension?: string
  worldId?: string
  connectionGeneration?: number
  source?: TargetObservationSource
  sourceTick?: number
  endedAt?: number
  receivedAt?: number
  entity?: Record<string, unknown>
  listTruncated?: boolean
  listTotal?: number
  listReturned?: number
  absence?: 'out-of-range' | 'unloaded' | 'offline' | 'unavailable'
  error?: string
}

/** A target read that failed; callers must not treat it as an absent target. */
export class TargetReadError extends Error {
  readonly detail: string

  constructor(detail: string) {
    super(`Target read failed: ${detail}`)
    this.name = 'TargetReadError'
    this.detail = detail
  }
}

/**
 * A read whose uuid does not match the requested target.
 *
 * The identity is fixed: a response for another uuid must never be relabelled
 * as the tracked target, even when the name or coordinates look similar.
 */
export class TargetIdentityMismatchError extends Error {
  readonly requested: string
  readonly received: string

  constructor(requested: string, received: string) {
    super(`Target identity mismatch: requested ${requested}, received ${received}.`)
    this.name = 'TargetIdentityMismatchError'
    this.requested = requested
    this.received = received
  }
}

function finiteNumber(value: unknown): number | undefined {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * Reads a position from a flat record or a nested `position` object.
 *
 * @example
 * positionOf({ position: { x: 1, y: 2, z: 3 } })
 * // => { x: 1, y: 2, z: 3 }
 */
export function positionOf(record: Record<string, unknown>): Vec3 | undefined {
  const nested = record.position && typeof record.position === 'object' && !Array.isArray(record.position)
    ? record.position as Record<string, unknown>
    : record
  const x = finiteNumber(nested.x)
  const y = finiteNumber(nested.y)
  const z = finiteNumber(nested.z)
  if (x === undefined || y === undefined || z === undefined)
    return undefined
  return { x, y, z }
}

/** Reads a velocity from `velocity` or `motion`; absent when not reported. */
export function velocityOf(record: Record<string, unknown>): Vec3 | undefined {
  const raw = (record.velocity && typeof record.velocity === 'object' && !Array.isArray(record.velocity)
    ? record.velocity
    : record.motion)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return undefined
  const value = raw as Record<string, unknown>
  const x = finiteNumber(value.x)
  const y = finiteNumber(value.y)
  const z = finiteNumber(value.z)
  if (x === undefined || y === undefined || z === undefined)
    return undefined
  return { x, y, z }
}

/** Reads the collision box from `bounds` or the `width`/`height` pair. */
export function boundsOf(record: Record<string, unknown>): TargetBounds | undefined {
  const raw = record.bounds && typeof record.bounds === 'object' && !Array.isArray(record.bounds)
    ? record.bounds as Record<string, unknown>
    : undefined
  const width = finiteNumber(raw?.width ?? record.width)
  const height = finiteNumber(raw?.height ?? record.height)
  if (width === undefined || height === undefined)
    return undefined
  return { width, height }
}

/** Speed in blocks per second from a vanilla velocity in blocks per tick. */
export function speedBlocksPerSecond(velocity: Vec3 | undefined): number {
  if (!velocity)
    return 0
  return Math.hypot(velocity.x, velocity.y, velocity.z) * TICKS_PER_SECOND
}

/**
 * Estimates how far the target may have moved since the sample.
 *
 * The estimate is `base + (sampleAge + latency / 2) * speed`. It is an error
 * budget, not a fact: a consumer must widen a threshold by it before it treats
 * a stale sample as current.
 */
export function estimatePositionUncertainty(input: {
  sampleAgeMs: number
  latencyMs: number
  speedBlocksPerSecond: number
}): number {
  const age = Math.max(0, input.sampleAgeMs)
  const latency = Math.max(0, input.latencyMs) / 2
  return TARGET_UNCERTAINTY_BASE_BLOCKS + ((age + latency) / 1000) * Math.max(0, input.speedBlocksPerSecond)
}

function visibilityOf(response: TargetReadResponse, present: boolean): TargetVisibility {
  if (present)
    return 'loaded'
  switch (response.absence) {
    case 'out-of-range':
      return 'out-of-range'
    case 'unloaded':
      return 'unloaded'
    case 'unavailable':
    case 'offline':
      return 'unavailable'
    default:
      return response.listTruncated ? 'list-truncated' : 'out-of-range'
  }
}

/**
 * Builds one target observation from a raw read.
 *
 * Throws {@link DimensionMismatchError} when the response names another
 * dimension (D12), {@link TargetIdentityMismatchError} when it names another
 * uuid, and {@link TargetReadError} when the read failed. A response with no
 * entity record yields an observation with no position and an explicit
 * visibility; it never fabricates zero coordinates or a "false" fact.
 */
export function buildTargetObservation(request: TargetReadRequest, response: TargetReadResponse): TargetObservation {
  if (response.error)
    throw new TargetReadError(response.error)
  assertObservationDimension(request.dimension, response.dimension)
  if (response.uuid !== undefined && response.uuid !== request.targetUuid)
    throw new TargetIdentityMismatchError(request.targetUuid, response.uuid)

  const entity = response.entity
  const present = entity !== undefined
  const receivedAt = response.receivedAt ?? request.receiveTime ?? request.startedAt
  // A detail read carries its own tick on the entity record; the envelope tick
  // is the list-level fallback.
  const entityTick = entity ? finiteNumber(entity.sourceTick) : undefined
  const sourceTick = response.sourceTick ?? entityTick ?? request.sourceTick
  const visibility = visibilityOf(response, present)
  const completeness: ObservationCompleteness = present
    ? (response.listTruncated ? 'truncated' : 'complete')
    : (response.listTruncated ? 'truncated' : 'partial')
  const missingReason = present
    ? (response.listTruncated ? 'list-truncated' : undefined)
    : (response.absence ?? 'not-in-read')

  const position = entity ? positionOf(entity) : undefined
  const velocity = entity ? velocityOf(entity) : undefined
  const bounds = entity ? boundsOf(entity) : undefined
  const yaw = entity ? finiteNumber(entity.yaw) : undefined
  const pitch = entity ? finiteNumber(entity.pitch) : undefined
  const latencyMs = Math.max(0, receivedAt - request.startedAt)
  const sampleAgeMs = Math.max(0, receivedAt - request.startedAt)
  // The entity record wins over the envelope: a list read may describe the
  // target directly while the envelope carries the query-level defaults.
  const entityType = (entity && typeof entity.type === 'string' ? entity.type : undefined) ?? response.entityType
  const isPlayer = (entity && typeof entity.isPlayer === 'boolean' ? entity.isPlayer : undefined) ?? response.isPlayer

  return {
    targetUuid: request.targetUuid,
    ...(entityType !== undefined ? { entityType } : {}),
    ...(isPlayer !== undefined ? { isPlayer } : {}),
    worldId: response.worldId ?? request.worldId,
    dimension: response.dimension ?? request.dimension,
    ...(position ? { position } : {}),
    ...(velocity ? { velocity } : {}),
    ...(yaw !== undefined ? { yaw } : {}),
    ...(pitch !== undefined ? { pitch } : {}),
    ...(bounds ? { bounds } : {}),
    onGround: entity ? triStateOf(entity.onGround) : 'unobserved',
    fallFlying: entity ? triStateOf(entity.fallFlying ?? entity.flying) : 'unobserved',
    riding: entity ? triStateOf(entity.riding ?? (entity.vehicle !== undefined ? entity.vehicle !== null : undefined)) : 'unobserved',
    alive: entity ? triStateOf(entity.alive) : 'unobserved',
    source: response.source ?? request.source,
    ...(sourceTick !== undefined ? { sourceTick } : {}),
    receivedAt,
    requestStartedAt: request.startedAt,
    requestEndedAt: response.endedAt ?? receivedAt,
    requestDurationMs: latencyMs,
    connectionGeneration: response.connectionGeneration ?? request.connectionGeneration,
    visibility,
    completeness,
    ...(missingReason ? { missingReason } : {}),
    positionUncertainty: estimatePositionUncertainty({
      sampleAgeMs,
      latencyMs,
      speedBlocksPerSecond: speedBlocksPerSecond(velocity),
    }),
  }
}

/** One resolved target from a list read. */
export interface SelectedTarget {
  uuid: string
  name?: string
  entityType?: string
  isPlayer?: boolean
  position?: Vec3
  record: Record<string, unknown>
}

/** Result of searching one entity list for a follow or attack target. */
export interface TargetListSelection {
  match?: SelectedTarget
  /** True when several distinct uuids matched the same name or type id. */
  ambiguous: boolean
  /** True when the list dropped a tail, so the target may be outside the read. */
  truncated: boolean
  total?: number
  returned: number
}

function entityTypeOf(record: Record<string, unknown>): string | undefined {
  if (typeof record.type === 'string')
    return record.type
  if (typeof record.entityType === 'string')
    return record.entityType
  return undefined
}

/**
 * Finds one target in an entity list without reassigning its identity.
 *
 * An exact uuid wins over a name or a type id, so a same-named new entity
 * never replaces a known uuid. When a name or type id matches several distinct
 * uuids, the nearest entry (list order) is chosen and `ambiguous` is set so the
 * caller can record the doubt. A truncated list reports `truncated` so a
 * missing entry is not read as "the target is gone".
 *
 * @example
 * selectTargetFromList([{ uuid: 'u-1', name: 'Alice' }], 'Alice').match?.uuid
 * // => 'u-1'
 */
export function selectTargetFromList(
  list: Array<Record<string, unknown>>,
  target: string,
  options: { total?: number, maxResults?: number } = {},
): TargetListSelection {
  const returned = list.length
  const total = options.total
  // `total` is authoritative when the source reports it; a missing total falls
  // back to the cap. A list of exactly the cap with a matching total is not
  // truncated.
  const truncated = total !== undefined
    ? total > returned
    : (options.maxResults !== undefined && returned >= options.maxResults)

  const byUuid = list.filter(entry => entry.uuid === target)
  if (byUuid.length > 0) {
    const record = byUuid[0]
    return { match: toSelectedTarget(record), ambiguous: byUuid.length > 1, truncated, ...(total !== undefined ? { total } : {}), returned }
  }

  const matches = list.filter((entry) => {
    const name = typeof entry.name === 'string' ? entry.name : undefined
    return name === target || entityTypeOf(entry) === target
  })
  if (matches.length === 0)
    return { ambiguous: false, truncated, ...(total !== undefined ? { total } : {}), returned }

  const distinctUuids = new Set(matches.map(entry => entry.uuid).filter((uuid): uuid is string => typeof uuid === 'string'))
  const record = matches[0]
  return {
    match: toSelectedTarget(record),
    ambiguous: distinctUuids.size > 1,
    truncated,
    ...(total !== undefined ? { total } : {}),
    returned,
  }
}

function toSelectedTarget(record: Record<string, unknown>): SelectedTarget | undefined {
  if (typeof record.uuid !== 'string' || record.uuid.length === 0)
    return undefined
  const position = positionOf(record)
  const name = typeof record.name === 'string' ? record.name : undefined
  const entityType = entityTypeOf(record)
  // A record may omit `isPlayer`; the player type id still identifies it, so a
  // later coarse locate uses the player list.
  const isPlayer = typeof record.isPlayer === 'boolean'
    ? record.isPlayer
    : (entityType === 'minecraft:player' ? true : undefined)
  return {
    uuid: record.uuid,
    record,
    ...(name !== undefined ? { name } : {}),
    ...(entityType !== undefined ? { entityType } : {}),
    ...(isPlayer !== undefined ? { isPlayer } : {}),
    ...(position ? { position } : {}),
  }
}

/** Reads the entity list and its totals from a raw query record. */
export function entityListOf(record: Record<string, unknown> | undefined): {
  list: Array<Record<string, unknown>>
  total?: number
  returned: number
} {
  const list = Array.isArray(record?.entities)
    ? (record!.entities as unknown[]).filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object' && !Array.isArray(entry))
    : []
  const total = finiteNumber(record?.total)
  const returned = finiteNumber(record?.returned) ?? list.length
  return { list, ...(total !== undefined ? { total } : {}), returned }
}
