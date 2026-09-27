/**
 * Three-dimensional coarse corridor (elytra-navigation design §4, CD-E2).
 *
 * The corridor is built from loaded chunks as a multi-resolution free space.
 * A coarse cell is `free` only when every column inside it was covered by the
 * read, has a solid floor and enough verified air above. Any uncovered or
 * unloaded cell makes the coarse cell `unknown`, and unknown is never routed
 * through as if it were air.
 *
 * The coarse output is a corridor plus headroom-checked entrances, not a list
 * of cell-centre waypoints. The local rollout layer may still reject a route
 * that is geometrically passable but unflyable at the current speed.
 */
import type { SnapshotEntry } from '../movement/snapshot'
import type { Vec3 } from '../movement/types'
import type { FlightCorridor, FlightCorridorEntrance, FlightCorridorRegion } from './contracts'

import { classifyBlock } from '../movement/block-view'

/** Default coarse cell size, in blocks. */
export const DEFAULT_COARSE_RESOLUTION = 4
/** Default clearance a free cell must have above its floor. */
export const DEFAULT_MIN_CLEARANCE = 3

export interface FreeSpaceRequest {
  bounds: { min: Vec3, max: Vec3 }
  /** Coarse cell size in blocks. */
  resolution: number
  /** Air blocks required above the floor for a cell to be free. */
  minClearance: number
  dimension: string
  worldId: string
  mapVersion: string
}

/** What the read proved about one cell. */
export type FreeCellState = 'free' | 'occupied' | 'unknown' | 'low-clearance'

export interface FreeCell {
  id: string
  min: Vec3
  max: Vec3
  resolution: number
  state: FreeCellState
  /** Highest floor found in the cell, when one was found. */
  floorY?: number
  /** Verified air above the floor. */
  clearance: number
}

export interface FreeSpace {
  request: FreeSpaceRequest
  cells: FreeCell[]
  /** Coarse cells keyed by their min-corner id. */
  byId: Map<string, FreeCell>
  unknown: Vec3[]
  /** Alias for {@link byId}, kept for callers that iterate one cell. */
  cellAtIndex: (index: number) => FreeCell | undefined
}

function keyOf(x: number, y: number, z: number): string {
  return `${x},${y},${z}`
}

function isSolidEntry(entry: SnapshotEntry): boolean {
  // Water is flyable space; plants and unknown blocks are conservative
  // obstacles so the coarse layer never opens an unverified route.
  const info = classifyBlock({ id: entry.id, x: entry.x, y: entry.y, z: entry.z, ...(entry.collision ? { collision: entry.collision } : {}) })
  return info.physical && !info.liquid
}

interface ColumnScan {
  floorY?: number
  clearance: number
  unknown: boolean
}

/** Scans one column for its highest floor and the verified air above it. */
function scanColumn(cells: Map<string, SnapshotEntry>, x: number, z: number, minY: number, maxY: number): ColumnScan {
  let floorY: number | undefined
  for (let y = maxY; y >= minY; y--) {
    const entry = cells.get(keyOf(x, y, z))
    if (!entry)
      return { clearance: 0, unknown: true }
    if (isSolidEntry(entry)) {
      floorY = y
      break
    }
  }
  if (floorY === undefined)
    return { clearance: 0, unknown: false }
  let clearance = 0
  for (let y = floorY + 1; y <= maxY; y++) {
    const entry = cells.get(keyOf(x, y, z))
    if (!entry)
      return { floorY, clearance, unknown: true }
    if (isSolidEntry(entry))
      break
    clearance++
  }
  return { floorY, clearance, unknown: false }
}

function evaluateCell(
  cells: Map<string, SnapshotEntry>,
  request: FreeSpaceRequest,
  min: Vec3,
  resolution: number,
  id: string,
): FreeCell {
  const max = { x: min.x + resolution - 1, y: min.y + resolution - 1, z: min.z + resolution - 1 }
  let unknown = false
  let lowClearance = false
  let floorY: number | undefined
  let clearance = Number.POSITIVE_INFINITY
  for (let x = min.x; x <= max.x; x++) {
    for (let z = min.z; z <= max.z; z++) {
      const column = scanColumn(cells, x, z, min.y, max.y)
      if (column.unknown) {
        unknown = true
        continue
      }
      if (column.floorY === undefined) {
        // No floor in the band: the cell is open sky, which is free only when
        // every cell in the band was covered (checked above).
        clearance = Math.min(clearance, max.y - min.y)
        continue
      }
      floorY = floorY === undefined ? column.floorY : Math.max(floorY, column.floorY)
      if (column.clearance < request.minClearance)
        lowClearance = true
      clearance = Math.min(clearance, column.clearance)
    }
  }

  const state: FreeCellState = unknown
    ? 'unknown'
    : lowClearance ? 'low-clearance' : 'free'
  return {
    id,
    min,
    max,
    resolution,
    state,
    ...(floorY !== undefined ? { floorY } : {}),
    clearance: Number.isFinite(clearance) ? clearance : 0,
  }
}

/**
 * Builds the coarse free space for a region read.
 *
 * The read must cover every cell it claims; a missing entry is unknown, not
 * air. `entries` is the bridge's `includeAir` region read (or the coverage-aware
 * `readTerrain` block list).
 */
export function buildFreeSpace(request: FreeSpaceRequest, entries: SnapshotEntry[]): FreeSpace {
  const cells = new Map<string, SnapshotEntry>()
  for (const entry of entries)
    cells.set(keyOf(entry.x, entry.y, entry.z), entry)

  const resolution = Math.max(1, Math.floor(request.resolution))
  const minX = Math.floor(request.bounds.min.x)
  const minY = Math.floor(request.bounds.min.y)
  const minZ = Math.floor(request.bounds.min.z)
  const maxX = Math.floor(request.bounds.max.x)
  const maxY = Math.floor(request.bounds.max.y)
  const maxZ = Math.floor(request.bounds.max.z)

  const out: FreeCell[] = []
  const unknown: Vec3[] = []
  for (let y = minY; y <= maxY; y += resolution) {
    for (let z = minZ; z <= maxZ; z += resolution) {
      for (let x = minX; x <= maxX; x += resolution) {
        const min = { x, y, z }
        const id = keyOf(x, y, z)
        const cell = evaluateCell(cells, request, min, resolution, id)
        out.push(cell)
        if (cell.state === 'unknown')
          unknown.push({ ...min })
      }
    }
  }

  const byId = new Map(out.map(cell => [cell.id, cell]))
  return {
    request,
    cells: out,
    byId,
    unknown,
    cellAtIndex: position => out[position],
  }
}

/** Iterates the cell ids of a free space for a planner. */
function cellIdOf(x: number, y: number, z: number): string {
  return keyOf(x, y, z)
}

export interface EntranceOptions {
  /** Minimum shared headroom for a connection. */
  minHeight: number
  /** Minimum face width in blocks. */
  minWidth: number
}

/**
 * Connects adjacent free cells with headroom-checked entrances.
 *
 * A face between two free cells is an entrance only when both cells are free;
 * the entrance height is the smaller verified clearance.
 */
export function buildEntrances(space: FreeSpace, options: EntranceOptions): FlightCorridorEntrance[] {
  const free = new Map(space.cells.filter(cell => cell.state === 'free').map(cell => [cell.id, cell]))
  const entrances: FlightCorridorEntrance[] = []
  const resolution = space.request.resolution
  for (const cell of free.values()) {
    if (cell.state !== 'free')
      continue
    const neighbours: Array<[number, number, number]> = [
      [resolution, 0, 0],
      [-resolution, 0, 0],
      [0, 0, resolution],
      [0, 0, -resolution],
    ]
    for (const [dx, dy, dz] of neighbours) {
      const otherId = cellIdOf(cell.min.x + dx, cell.min.y + dy, cell.min.z + dz)
      const other = free.get(otherId)
      if (!other)
        continue
      const height = Math.min(cell.clearance, other.clearance)
      if (height < options.minHeight || resolution < options.minWidth)
        continue
      entrances.push({
        from: cell.id,
        to: other.id,
        position: {
          x: (cell.min.x + other.min.x) / 2 + resolution / 2,
          y: Math.max(cell.floorY ?? cell.min.y, other.floorY ?? other.min.y) + 1,
          z: (cell.min.z + other.min.z) / 2 + resolution / 2,
        },
        width: resolution,
        height,
      })
    }
  }
  return entrances
}

export interface CorridorPlanOptions {
  start: Vec3
  goal: Vec3
  /** Climb penalty per block of altitude gain. */
  climbCost?: number
  /** Extra cost for routing next to unknown cells. */
  unknownPenalty?: number
  /** Penalty per block the cell's clearance falls below the request. */
  clearanceCost?: number
  /** Cost per estimated rocket use; climbing is the coarse rocket proxy. */
  fireworkWeight?: number
  /** Verified backup landing sites; a route far from all of them costs more. */
  backupSites?: Vec3[]
  /** Weight of the deviation from the nearest backup site. */
  backupWeight?: number
  /** Maximum visited cells; a search past it fails rather than running long. */
  maxVisited?: number
}

export type CorridorPlan
  = | { ok: true, corridor: FlightCorridor }
    | { ok: false, reason: 'no_corridor' | 'start_unknown' | 'goal_unknown' | 'budget' }

function cellKeyFor(space: FreeSpace, position: Vec3): string {
  const resolution = space.request.resolution
  const x = Math.floor(position.x / resolution) * resolution
  const y = Math.floor(position.y / resolution) * resolution
  const z = Math.floor(position.z / resolution) * resolution
  return cellIdOf(x, y, z)
}

/**
 * Plans a coarse corridor over free cells.
 *
 * Cost includes length, climb, a penalty for travelling beside unknown cells
 * and a deviation term from the straight line. The result is a corridor of
 * merged regions, not waypoints. A start or goal in an unknown cell fails with
 * a typed reason instead of guessing a nearby free cell.
 */
export function planCorridor(space: FreeSpace, options: CorridorPlanOptions): CorridorPlan {
  const climbCost = options.climbCost ?? 2
  const unknownPenalty = options.unknownPenalty ?? 4
  const clearanceCost = options.clearanceCost ?? 1
  const fireworkWeight = options.fireworkWeight ?? 1
  const backupWeight = options.backupWeight ?? 0.05
  const maxVisited = options.maxVisited ?? 20_000
  const byId = space.byId
  const startId = cellKeyFor(space, options.start)
  const goalId = cellKeyFor(space, options.goal)
  const startCell = byId.get(startId)
  const goalCell = byId.get(goalId)
  if (!startCell || startCell.state === 'unknown')
    return { ok: false, reason: 'start_unknown' }
  if (!goalCell || goalCell.state === 'unknown')
    return { ok: false, reason: 'goal_unknown' }
  if (startCell.state !== 'free' || goalCell.state !== 'free')
    return { ok: false, reason: 'no_corridor' }

  const resolution = space.request.resolution
  const open = new Set<string>([startId])
  const cameFrom = new Map<string, string>()
  const gScore = new Map<string, number>([[startId, 0]])
  const fScore = new Map<string, number>([[startId, heuristic(startCell, goalCell)]])
  const visited = new Set<string>()

  while (open.size > 0) {
    if (visited.size > maxVisited)
      return { ok: false, reason: 'budget' }
    let currentId = ''
    let best = Number.POSITIVE_INFINITY
    for (const id of open) {
      const score = fScore.get(id) ?? Number.POSITIVE_INFINITY
      if (score < best) {
        best = score
        currentId = id
      }
    }
    if (currentId === goalId)
      return { ok: true, corridor: buildCorridor(space, cameFrom, currentId) }
    open.delete(currentId)
    visited.add(currentId)
    const current = byId.get(currentId)!

    for (const [dx, dy, dz] of [[resolution, 0, 0], [-resolution, 0, 0], [0, 0, resolution], [0, 0, -resolution], [0, resolution, 0], [0, -resolution, 0]] as Array<[number, number, number]>) {
      const neighbourId = cellIdOf(current.min.x + dx, current.min.y + dy, current.min.z + dz)
      const neighbour = byId.get(neighbourId)
      if (!neighbour || neighbour.state !== 'free' || visited.has(neighbourId))
        continue
      const step = Math.hypot(dx, dy, dz)
      const unknownNear = countUnknownNeighbours(space, neighbour) * unknownPenalty
      // A low-clearance cell or a climb is riskier and spends rockets; a route
      // far from every verified backup landing cannot be bailed out cheaply.
      const climbBlocks = Math.max(0, dy)
      // Prefer more headroom inside a free cell: a cell at the bare minimum is
      // riskier than one with room to turn.
      const preferredClearance = space.request.minClearance + 2
      const clearancePenalty = Math.max(0, preferredClearance - neighbour.clearance) * clearanceCost
      const fireworkEstimate = climbBlocks * fireworkWeight
      const backupDeviation = nearestBackupDistance(options.backupSites, neighbour) * backupWeight
      const tentative = (gScore.get(currentId) ?? 0)
        + step
        + climbBlocks * climbCost
        + unknownNear
        + clearancePenalty
        + fireworkEstimate
        + backupDeviation
      if (tentative < (gScore.get(neighbourId) ?? Number.POSITIVE_INFINITY)) {
        cameFrom.set(neighbourId, currentId)
        gScore.set(neighbourId, tentative)
        fScore.set(neighbourId, tentative + heuristic(neighbour, goalCell))
        open.add(neighbourId)
      }
    }
  }
  return { ok: false, reason: 'no_corridor' }
}

function heuristic(a: FreeCell, b: FreeCell): number {
  return Math.hypot(a.min.x - b.min.x, a.min.y - b.min.y, a.min.z - b.min.z)
}

/** Distance from a cell centre to the nearest backup site; 0 when none exist. */
function nearestBackupDistance(backups: Vec3[] | undefined, cell: FreeCell): number {
  if (!backups || backups.length === 0)
    return 0
  const center = { x: cell.min.x + cell.resolution / 2, y: cell.min.y + cell.resolution / 2, z: cell.min.z + cell.resolution / 2 }
  let nearest = Number.POSITIVE_INFINITY
  for (const backup of backups)
    nearest = Math.min(nearest, Math.hypot(center.x - backup.x, center.y - backup.y, center.z - backup.z))
  return Number.isFinite(nearest) ? nearest : 0
}

const NEIGHBOUR_OFFSETS: Array<[number, number, number]> = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0]]

function countUnknownNeighbours(space: FreeSpace, cell: FreeCell): number {
  const resolution = space.request.resolution
  let count = 0
  for (const [dx, dy, dz] of NEIGHBOUR_OFFSETS) {
    const id = cellIdOf(cell.min.x + dx * resolution, cell.min.y + dy * resolution, cell.min.z + dz * resolution)
    // A missing neighbour is outside the read; only a cell the read marked
    // unknown counts as unknown data near the route.
    if (!space.byId.has(id))
      continue
    const other = space.byId.get(id)!
    if (other.state === 'unknown')
      count++
  }
  return count
}

/** Merges a cell path into axis-aligned corridor regions and their entrances. */
function buildCorridor(space: FreeSpace, cameFrom: Map<string, string>, goalId: string): FlightCorridor {
  const byId = space.byId
  const path: FreeCell[] = []
  let current: string | undefined = goalId
  while (current) {
    const cell = byId.get(current)
    if (!cell)
      break
    path.push(cell)
    current = cameFrom.get(current)
  }
  path.reverse()

  const regions: FlightCorridorRegion[] = []
  const entrances: FlightCorridorEntrance[] = []
  const run: FreeCell[] = []
  const flush = () => {
    if (run.length === 0)
      return
    const min = {
      x: Math.min(...run.map(cell => cell.min.x)),
      y: Math.min(...run.map(cell => cell.min.y)),
      z: Math.min(...run.map(cell => cell.min.z)),
    }
    const max = {
      x: Math.max(...run.map(cell => cell.max.x)),
      y: Math.max(...run.map(cell => cell.max.y)),
      z: Math.max(...run.map(cell => cell.max.z)),
    }
    regions.push({
      id: `region-${regions.length}`,
      bounds: { min, max },
      clearance: Math.min(...run.map(cell => cell.clearance)),
      resolution: run[0]!.resolution,
      hasUnknown: run.some(cell => cell.state === 'unknown'),
    })
    run.length = 0
  }

  for (let index = 0; index < path.length; index++) {
    const cell = path[index]!
    const previous = path[index - 1]
    if (previous && (previous.min.x !== cell.min.x && previous.min.z !== cell.min.z))
      flush()
    run.push(cell)
  }
  flush()

  for (let index = 1; index < path.length; index++) {
    const from = path[index - 1]!
    const to = path[index]!
    entrances.push({
      from: from.id,
      to: to.id,
      position: {
        x: (from.min.x + to.min.x) / 2 + space.request.resolution / 2,
        y: Math.max(from.floorY ?? from.min.y, to.floorY ?? to.min.y) + 1,
        z: (from.min.z + to.min.z) / 2 + space.request.resolution / 2,
      },
      width: space.request.resolution,
      height: Math.min(from.clearance, to.clearance),
    })
  }

  const unknownBoundary: Vec3[] = []
  const resolution = space.request.resolution
  const routeIds = new Set(path.map(cell => cell.id))
  for (const cell of path) {
    for (const [dx, dy, dz] of NEIGHBOUR_OFFSETS) {
      const id = cellIdOf(cell.min.x + dx * resolution, cell.min.y + dy * resolution, cell.min.z + dz * resolution)
      if (routeIds.has(id))
        continue
      const other = byId.get(id)
      if (!other || other.state === 'unknown')
        unknownBoundary.push({ ...cell.min })
    }
  }

  return {
    mapVersion: space.request.mapVersion,
    dimension: space.request.dimension,
    regions,
    entrances,
    ...(regions.length > 0 ? { exit: regions[regions.length - 1]!.id } : {}),
    unknownBoundary: dedupePoints(unknownBoundary),
    // The allowed speed range is refined by the rollout layer from the current
    // observation; the corridor only records the coarse band.
    speedRange: { min: 0, max: 1.5 },
  }
}

function dedupePoints(points: Vec3[]): Vec3[] {
  const seen = new Set<string>()
  const out: Vec3[] = []
  for (const point of points) {
    const key = keyOf(point.x, point.y, point.z)
    if (seen.has(key))
      continue
    seen.add(key)
    out.push(point)
  }
  return out
}
