/**
 * Spatial observation contract (capability-deepening CD-0 §3.2).
 *
 * Every spatial fact carries its source, the source's own tick, the
 * main-process receive time, the request window, the world/dimension binding,
 * the connection generation, completeness and a missing reason. Terrain cells
 * distinguish known air, known obstacle, fluid, unloaded, truncated and read
 * failure; a cell the read did not cover is unknown and is never air.
 *
 * The client tick, the server tick and main-process milliseconds are three
 * clocks. This module never subtracts one from another; a mapped clock carries
 * an explicit error bound instead (see {@link mapSourceTickToMain}).
 */
import type { BlockView } from './port'
import type { Vec3 } from './types'

import { normalizeBlockId } from './block-view'

/** The three clock domains a spatial fact can be stamped in. */
export type ClockDomain = 'client-tick' | 'server-tick' | 'main-ms'

/**
 * Error-bounded affine mapping from one source clock to main-process ms.
 *
 * `estimatedMs = epochMs + tick * msPerTick`; the estimate is not a fact, so
 * `errorBoundMs` travels with it and a consumer must widen any threshold by it.
 */
export interface ClockMapping {
  from: ClockDomain
  /** Main-process epoch the mapped clock reads zero at. */
  epochMs: number
  /** Main-process milliseconds per source tick. */
  msPerTick: number
  /** Maximum error of the estimate, in milliseconds. */
  errorBoundMs: number
}

/** One mapped clock reading; `staleByMs` is a bounded age, not an exact age. */
export interface MappedTimestamp {
  estimatedMs: number
  errorBoundMs: number
  /** `mainNow - estimatedMs`, lower-bounded by `-errorBoundMs`. */
  staleByMs: number
}

/**
 * Maps a source tick into main-process ms without subtracting clocks.
 *
 * @example
 * mapSourceTickToMain(100, { from: 'client-tick', epochMs: 0, msPerTick: 50, errorBoundMs: 25 }, 5100)
 * // => { estimatedMs: 5000, errorBoundMs: 25, staleByMs: 100 }
 */
export function mapSourceTickToMain(tick: number, mapping: ClockMapping, mainNow: number): MappedTimestamp {
  const estimatedMs = mapping.epochMs + tick * mapping.msPerTick
  return {
    estimatedMs,
    errorBoundMs: mapping.errorBoundMs,
    staleByMs: mainNow - estimatedMs,
  }
}

/**
 * True when the mapped fact is inside `budgetMs` of the main-process clock.
 *
 * The error bound is added to the budget so a fact is never called stale from
 * clock error alone.
 */
export function isWithinFreshnessBudget(mapped: MappedTimestamp, budgetMs: number): boolean {
  return mapped.staleByMs <= budgetMs + mapped.errorBoundMs
}

/** What the read covered. A failed read is not an empty result. */
export type ObservationCompleteness = 'complete' | 'truncated' | 'partial' | 'failed'

/** Metadata every spatial observation must carry. */
export interface ObservationEnvelope {
  /** Producer of the fact, e.g. `client-loaded-world` or `server-coarse`. */
  source: string
  worldId: string
  dimension: string
  connectionGeneration: number
  /** The source's own tick stamp, when the source reports one. */
  sourceTick?: number
  /** Main-process receive time in ms. */
  receivedAt: number
  requestStartedAt: number
  requestEndedAt: number
  completeness: ObservationCompleteness
  /** Machine-readable reason when completeness is not `complete`. */
  missingReason?: string
}

/** Per-cell state of a terrain read. Only `known-air` means air. */
export type TerrainCellState
  = | { kind: 'known-air' }
    | { kind: 'known-obstacle', block: BlockView }
    | { kind: 'fluid', block: BlockView }
    | { kind: 'unloaded' }
    | { kind: 'truncated' }
    | { kind: 'read-failure', reason?: string }

export interface RegionBounds {
  min: Vec3
  max: Vec3
}

/** One terrain read request. The dimension is required and verified. */
export interface TerrainReadRequest {
  bounds: RegionBounds
  dimension: string
  worldId: string
  connectionGeneration: number
  sourceTick?: number
  startedAt: number
  receiveTime?: number
}

/**
 * Raw region read the source returns.
 *
 * `blocks` missing entirely (while no explicit failure is reported) is a read
 * failure, not an empty region: an unreadable scan must not silently become a
 * world with no blocks.
 */
export interface TerrainReadResponse {
  dimension?: string
  worldId?: string
  connectionGeneration?: number
  source?: string
  sourceTick?: number
  endedAt?: number
  receivedAt?: number
  blocks?: unknown[]
  /** Cells the source knows exist but has not loaded. */
  unloaded?: Vec3[]
  truncated?: boolean
  /** Present when the source failed the whole read. */
  error?: string
}

/** A read that could not be parsed at all; callers must not treat it as empty. */
export class TerrainReadError extends Error {
  readonly detail: string

  constructor(detail: string) {
    super(`Terrain read failed: ${detail}`)
    this.name = 'TerrainReadError'
    this.detail = detail
  }
}

/** A response whose dimension does not match the request (D12). */
export class DimensionMismatchError extends Error {
  readonly requested: string
  readonly received: string

  constructor(requested: string, received: string) {
    super(`Spatial read dimension mismatch: requested ${requested}, received ${received}.`)
    this.name = 'DimensionMismatchError'
    this.requested = requested
    this.received = received
  }
}

/**
 * Rejects a response read for another dimension (D12).
 *
 * `Levels.resolve` defaults to the overworld, so a read that carries no
 * dimension cannot prove it belongs to the request; only a matching explicit
 * dimension passes.
 */
export function assertObservationDimension(requested: string, received: string | undefined): void {
  if (received !== undefined && requested !== '' && received !== requested)
    throw new DimensionMismatchError(requested, received)
}

export interface TerrainSnapshot {
  observation: ObservationEnvelope
  bounds: RegionBounds
  cells: Map<string, TerrainCellState>
  /** State of one cell, or undefined when the read did not cover it. */
  cellAt: (x: number, y: number, z: number) => TerrainCellState | undefined
  /** True only for a cell the read explicitly reported as air. */
  isKnownAir: (x: number, y: number, z: number) => boolean
  /** True only for a cell the read explicitly reported as solid or fluid. */
  isKnownObstacle: (x: number, y: number, z: number) => boolean
  /** Bounds cells the read did not cover; they are never air. */
  uncoveredCells: () => Vec3[]
}

function cellKey(x: number, y: number, z: number): string {
  return `${x},${y},${z}`
}

function blockViewOf(raw: Record<string, unknown>): { view: BlockView, air: boolean } | undefined {
  const x = Number(raw.x)
  const y = Number(raw.y)
  const z = Number(raw.z)
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z))
    return undefined
  const id = typeof raw.id === 'string' && raw.id ? raw.id : 'minecraft:air'
  const normalized = normalizeBlockId(id)
  const air = normalized === 'air' || normalized === 'cave_air' || normalized === 'void_air'
  const properties = raw.properties && typeof raw.properties === 'object' && !Array.isArray(raw.properties)
    ? raw.properties as Record<string, string>
    : undefined
  const view: BlockView = { id, air, ...(properties ? { properties } : {}) }
  return { view, air }
}

function fluidId(id: string): boolean {
  const normalized = normalizeBlockId(id)
  return normalized === 'water' || normalized === 'flowing_water'
    || normalized === 'lava' || normalized === 'flowing_lava'
}

/**
 * Builds a coverage-aware terrain snapshot from one region read.
 *
 * Throws {@link DimensionMismatchError} when the response names another
 * dimension and {@link TerrainReadError} when the read carried no block list
 * and no explicit failure, so an unreadable scan can never be mistaken for a
 * world with air everywhere.
 */
export function buildTerrainSnapshot(request: TerrainReadRequest, response: TerrainReadResponse): TerrainSnapshot {
  assertObservationDimension(request.dimension, response.dimension)
  if (response.error)
    throw new TerrainReadError(response.error)
  if (!Array.isArray(response.blocks))
    throw new TerrainReadError('response carried no block list')

  const cells = new Map<string, TerrainCellState>()
  for (const raw of response.blocks) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      continue
    const parsed = blockViewOf(raw as Record<string, unknown>)
    if (!parsed)
      continue
    const entry = raw as Record<string, unknown>
    const key = cellKey(Number(entry.x), Number(entry.y), Number(entry.z))
    cells.set(key, parsed.air
      ? { kind: 'known-air' }
      : fluidId(parsed.view.id)
        ? { kind: 'fluid', block: parsed.view }
        : { kind: 'known-obstacle', block: parsed.view })
  }

  for (const unloaded of response.unloaded ?? []) {
    if (!Number.isFinite(unloaded.x) || !Number.isFinite(unloaded.y) || !Number.isFinite(unloaded.z))
      continue
    cells.set(cellKey(unloaded.x, unloaded.y, unloaded.z), { kind: 'unloaded' })
  }

  const missingReason = response.truncated ? 'truncated' : undefined
  const completeness: ObservationCompleteness = response.truncated ? 'truncated' : 'complete'
  const sourceTick = response.sourceTick ?? request.sourceTick
  const observation: ObservationEnvelope = {
    source: response.source ?? 'client-loaded-world',
    worldId: response.worldId ?? request.worldId,
    dimension: response.dimension ?? request.dimension,
    connectionGeneration: response.connectionGeneration ?? request.connectionGeneration,
    ...(sourceTick !== undefined ? { sourceTick } : {}),
    receivedAt: response.receivedAt ?? request.receiveTime ?? request.startedAt,
    requestStartedAt: request.startedAt,
    requestEndedAt: response.endedAt ?? request.startedAt,
    completeness,
    ...(missingReason ? { missingReason } : {}),
  }

  const uncovered: Vec3[] = []
  for (let x = request.bounds.min.x; x <= request.bounds.max.x; x++) {
    for (let y = request.bounds.min.y; y <= request.bounds.max.y; y++) {
      for (let z = request.bounds.min.z; z <= request.bounds.max.z; z++) {
        if (!cells.has(cellKey(x, y, z)))
          uncovered.push({ x, y, z })
      }
    }
  }

  return {
    observation,
    bounds: request.bounds,
    cells,
    cellAt: (x, y, z) => cells.get(cellKey(x, y, z)),
    isKnownAir: (x, y, z) => cells.get(cellKey(x, y, z))?.kind === 'known-air',
    isKnownObstacle: (x, y, z) => {
      const state = cells.get(cellKey(x, y, z))
      return state?.kind === 'known-obstacle' || state?.kind === 'fluid'
    },
    uncoveredCells: () => uncovered,
  }
}

/**
 * Phases one action result can be observed in (CD-0 §3.3).
 *
 * A request is not an acceptance, an acceptance is not a client action, and a
 * client action is not a server settlement. Every phase stays false until
 * observed; `unobserved` names the phases the caller could not confirm.
 */
export interface ActionResultPhases {
  requested: boolean
  accepted: boolean
  clientExecuted: boolean
  serverSettled: boolean
  unobserved: string[]
}

/**
 * Builds action-result phases from observed evidence only.
 *
 * @example
 * actionResultPhases({ requested: true, accepted: true, clientExecuted: true })
 * // => { requested: true, accepted: true, clientExecuted: true, serverSettled: false, unobserved: ['server-settled'] }
 */
export function actionResultPhases(observed: Partial<Omit<ActionResultPhases, 'unobserved'>>): ActionResultPhases {
  const phases: Array<keyof Omit<ActionResultPhases, 'unobserved'>> = ['requested', 'accepted', 'clientExecuted', 'serverSettled']
  const unobserved = phases.filter(phase => observed[phase] !== true)
  return {
    requested: observed.requested === true,
    accepted: observed.accepted === true,
    clientExecuted: observed.clientExecuted === true,
    serverSettled: observed.serverSettled === true,
    unobserved,
  }
}
