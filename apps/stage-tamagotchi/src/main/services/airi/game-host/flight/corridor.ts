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

// --- Block-scale space route (R1, execution plan §5) ------------------------------------

const keyOf3 = (x: number, y: number, z: number): string => `${x},${y},${z}`

/**
 * True when the block id is flyable air (empty or any *air suffix).
 *
 * Water, solids and unknown cells are not air. Unknown is represented by the
 * cell's absence from the map, so the caller never hands this a fake id.
 */
function isAirId(id: string | undefined): boolean {
  return id !== undefined && id.endsWith('air')
}

/** Pose half-width the client sweeps; the planner keeps a margin beyond it. */
export const SPACE_BODY_HALF_WIDTH = 0.45
/**
 * Required body margin beyond the pose half-width, blocks. A cell whose
 * horizontal neighbours fall inside `half + margin` is not passable, so a
 * route keeps clear of walls instead of hugging them (R4 cave-diag-07: the
 * route ran one cell from the bank, the body box clipped it, and the client
 * rejected all 20 candidates in 0 ms).
 */
export const SPACE_BODY_MARGIN = 0.2

/**
 * True when the body box fits horizontally at a cell: the cell and every
 * neighbour within the box's reach must be air at the body's height. The
 * clearance cells above are included, so a low ceiling is rejected too.
 */
export function bodyFootprintClear(
  cells: Map<string, string>,
  x: number,
  y: number,
  z: number,
  options?: { clearance?: number, margin?: number },
): boolean {
  const clearance = options?.clearance ?? 2
  const margin = options?.margin ?? SPACE_BODY_MARGIN
  const radius = Math.max(0, Math.ceil(SPACE_BODY_HALF_WIDTH + margin - 0.5))
  for (let ex = x - radius; ex <= x + radius; ex++) {
    for (let ez = z - radius; ez <= z + radius; ez++) {
      for (let ey = y; ey < y + clearance; ey++) {
        if (!isAirId(cells.get(keyOf3(ex, ey, ez))))
          return false
      }
    }
  }
  return true
}

/**
 * Per-step cost added for each wall on the body's shoulder ring. The route
 * already keeps a one-cell footprint; the extra cost centers it in wide
 * passages instead of running along one side (R4 cave-diag-07: the flight
 * drifted 0.2 blocks and clipped the bank the route hugged).
 */
const SPACE_WALL_COST = 0.25
/**
 * Extra cost per block climbed. The glider trades speed for height or burns a
 * rocket; a route that climbs early spends resources and can arrive without
 * the ability to follow its own profile (R4 cave-diag-08: the A* found a steep
 * climb over the east bank, the glider reached the bank at 70.8 and the client
 * rejected every candidate).
 */
const SPACE_CLIMB_COST = 1.2

function wallCost(cells: Map<string, string>, x: number, y: number, z: number): number {
  let walls = 0
  for (let ex = x - 2; ex <= x + 2; ex++) {
    for (let ez = z - 2; ez <= z + 2; ez++) {
      if (Math.abs(ex - x) <= 1 && Math.abs(ez - z) <= 1)
        continue
      for (let ey = y; ey < y + 2; ey++) {
        if (!isAirId(cells.get(keyOf3(ex, ey, ez)))) {
          walls += 1
          break
        }
      }
    }
  }
  return walls * SPACE_WALL_COST
}

/**
 * A* over block-scale cells in already-read space (R1, execution plan §5).
 *
 * A node is a cell the agent's feet can occupy: the cell and `clearance - 1`
 * cells above it are read and air. Edges span the 26-neighbourhood; every
 * multi-axis edge verifies its corner cells, so a diagonal cannot cut through
 * two solid blocks' shared corner. Unknown cells are not air and not
 * passable — the route stays inside read space by construction.
 *
 * The search is bounded twice: an expansion (node) cap and a wall-clock cap.
 * A capped search reports `no_route`-adjacent budget reasons instead of a
 * pretended route.
 */
export interface SpaceRouteInput {
  /**
   * Every read cell of the search volume, keyed `x,y,z`, mapped to its block
   * id. Air and solid ids are both required: the passability test must
   * distinguish air from unknown, and unknown is a missing key.
   */
  cells: Map<string, string>
  start: Vec3
  goal: Vec3
  /** Agent height in blocks; the elytra pose is 2. */
  clearance?: number
  nodeCap?: number
  timeCapMs?: number
}

export type SpaceRoute
  = | { ok: true, path: Vec3[], expanded: number }
    | { ok: false, reason: 'start_blocked' | 'no_route' | 'node_cap' | 'time_cap', expanded: number }

/**
 * Recomputes the search's own edge cost for a finished path (step + wall +
 * climb). Callers use it to compare routes to different frontier candidates
 * with the same currency the search used (R4 review item 1).
 */
export function spaceRouteCost(cells: Map<string, string>, path: Vec3[]): number {
  let cost = 0
  for (let index = 1; index < path.length; index++) {
    const previous = path[index - 1]!
    const point = path[index]!
    const dx = point.x - previous.x
    const dy = point.y - previous.y
    const dz = point.z - previous.z
    cost += Math.hypot(dx, dy, dz)
    cost += wallCost(cells, Math.floor(point.x), Math.floor(point.y), Math.floor(point.z))
    cost += Math.max(0, dy) * SPACE_CLIMB_COST
  }
  return cost
}

export function planSpaceRoute(input: SpaceRouteInput): SpaceRoute {
  const clearance = input.clearance ?? 2
  const nodeCap = input.nodeCap ?? 120_000
  const timeCapMs = input.timeCapMs ?? 2_000
  const startedAt = Date.now()
  const cells = input.cells

  // Passability is computed lazily and memoized: the footprint check touches
  // 10+ cells per node, and precomputing it for every read cell dominated the
  // search on large volumes (a 300k-cell window spent the whole 2 s cap before
  // expanding one node, R4 review). Only nodes the search actually asks about
  // pay for the check.
  const passableCache = new Map<string, boolean>()
  const passable = (x: number, y: number, z: number): boolean => {
    const key = keyOf3(x, y, z)
    const cached = passableCache.get(key)
    if (cached !== undefined)
      return cached
    const value = isAirId(cells.get(key)) && bodyFootprintClear(cells, x, y, z, { clearance })
    passableCache.set(key, value)
    return value
  }

  // The wall cost is a node property, not an edge property: memoize it so the
  // 26-neighbour edge loop does not recompute the shoulder ring per edge.
  const wallCostCache = new Map<string, number>()
  const wallCostAt = (x: number, y: number, z: number): number => {
    const key = keyOf3(x, y, z)
    const cached = wallCostCache.get(key)
    if (cached !== undefined)
      return cached
    const value = wallCost(cells, x, y, z)
    wallCostCache.set(key, value)
    return value
  }

  const startKey = keyOf3(Math.floor(input.start.x), Math.floor(input.start.y), Math.floor(input.start.z))
  const goalKey = keyOf3(Math.floor(input.goal.x), Math.floor(input.goal.y), Math.floor(input.goal.z))
  if (!passable(Math.floor(input.start.x), Math.floor(input.start.y), Math.floor(input.start.z)))
    return { ok: false, reason: 'start_blocked', expanded: 0 }

  // The goal cell itself may be inside a solid column (a pad's own block);
  // the route target is the passable cell at the goal's position, else one of
  // the cells just above it within reach.
  let goalNode: string | undefined
  if (passable(Math.floor(input.goal.x), Math.floor(input.goal.y), Math.floor(input.goal.z))) {
    goalNode = goalKey
  }
  else {
    for (let h = 1; h <= 2; h++) {
      if (passable(Math.floor(input.goal.x), Math.floor(input.goal.y) + h, Math.floor(input.goal.z))) {
        goalNode = keyOf3(Math.floor(input.goal.x), Math.floor(input.goal.y) + h, Math.floor(input.goal.z))
        break
      }
    }
  }
  if (goalNode === undefined)
    return { ok: false, reason: 'no_route', expanded: 0 }

  const offsets: Array<[number, number, number]> = []
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dz = -1; dz <= 1; dz++) {
        if (dx !== 0 || dy !== 0 || dz !== 0)
          offsets.push([dx, dy, dz])
      }
    }
  }

  /** Minimal binary heap so the hot loop never sorts the whole open set. */
  const heap: Array<{ key: string, f: number }> = []
  const heapPush = (item: { key: string, f: number }): void => {
    heap.push(item)
    let i = heap.length - 1
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (heap[parent]!.f <= heap[i]!.f)
        break
      const tmp = heap[parent]!
      heap[parent] = heap[i]!
      heap[i] = tmp
      i = parent
    }
  }
  const heapPop = (): { key: string, f: number } | undefined => {
    const top = heap[0]
    const last = heap.pop()
    if (top === undefined)
      return undefined
    if (heap.length > 0 && last) {
      heap[0] = last
      let i = 0
      for (;;) {
        const left = i * 2 + 1
        const right = left + 1
        let smallest = i
        if (left < heap.length && heap[left]!.f < heap[smallest]!.f)
          smallest = left
        if (right < heap.length && heap[right]!.f < heap[smallest]!.f)
          smallest = right
        if (smallest === i)
          break
        const tmp = heap[smallest]!
        heap[smallest] = heap[i]!
        heap[i] = tmp
        i = smallest
      }
    }
    return top
  }

  const coordCache = new Map<string, [number, number, number]>()
  const coordsOf = (key: string): [number, number, number] => {
    const cached = coordCache.get(key)
    if (cached)
      return cached
    const parts = key.split(',').map(Number) as [number, number, number]
    coordCache.set(key, parts)
    return parts
  }

  const heuristic = (a: string, b: string): number => {
    const [ax, ay, az] = coordsOf(a)
    const [bx, by, bz] = coordsOf(b)
    return Math.hypot(bx - ax, by - ay, bz - az)
  }

  // Weighted A*: the factor trades a little path quality for a bounded open
  // set. It is deliberately above the wall/climb cost scale so the extra
  // terms do not turn the search into a breadth-first sweep (R4 cave-diag-11:
  // the canyon plan hit the time cap at 1.2).
  heapPush({ key: startKey, f: heuristic(startKey, goalKey) * 1.5 })
  const gScore = new Map<string, number>([[startKey, 0]])
  const cameFrom = new Map<string, string>()
  const closed = new Set<string>()
  let expanded = 0

  for (;;) {
    if (expanded >= nodeCap)
      return { ok: false, reason: 'node_cap', expanded }
    if (Date.now() - startedAt > timeCapMs)
      return { ok: false, reason: 'time_cap', expanded }

    const current = heapPop()
    if (current === undefined) {
      return { ok: false, reason: 'no_route', expanded }
    }
    if (closed.has(current.key))
      continue
    closed.add(current.key)
    expanded += 1

    if (current.key === goalNode) {
      const path: Vec3[] = []
      let node: string | undefined = current.key
      while (node !== undefined) {
        const [x, y, z] = coordsOf(node)
        path.push({ x: x + 0.5, y: y + 0.5, z: z + 0.5 })
        node = cameFrom.get(node)
      }
      path.reverse()
      return { ok: true, path, expanded }
    }

    const [cx, cy, cz] = coordsOf(current.key)
    for (const [dx, dy, dz] of offsets) {
      // The glider cannot hover-climb: gaining height without horizontal
      // progress is not a flyable step, only a rocket burn in place.
      if (dy > 0 && dx === 0 && dz === 0)
        continue
      const nx = cx + dx
      const ny = cy + dy
      const nz = cz + dz
      const nextKey = keyOf3(nx, ny, nz)
      if (closed.has(nextKey) || !passable(nx, ny, nz))
        continue
      // Corner rule: a multi-axis move must also fit through the cells the
      // motion sweeps on each single axis, or it cuts a shared corner.
      const axes = (dx !== 0 ? 1 : 0) + (dy !== 0 ? 1 : 0) + (dz !== 0 ? 1 : 0)
      if (axes > 1) {
        const corners: Array<[number, number, number]> = []
        if (dx !== 0)
          corners.push([cx + dx, cy, cz])
        if (dy !== 0)
          corners.push([cx, cy + dy, cz])
        if (dz !== 0)
          corners.push([cx, cy, cz + dz])
        const clear = corners.every(([ex, ey, ez]) => passable(ex, ey, ez))
        if (!clear)
          continue
      }
      const step = Math.hypot(dx, dy, dz)
      const climb = Math.max(0, dy)
      const tentative = gScore.get(current.key)! + step + wallCostAt(nx, ny, nz) + climb * SPACE_CLIMB_COST
      const known = gScore.get(nextKey)
      if (known !== undefined && tentative >= known)
        continue
      gScore.set(nextKey, tentative)
      cameFrom.set(nextKey, current.key)
      heapPush({ key: nextKey, f: tentative + heuristic(nextKey, goalNode!) * 1.5 })
    }
  }
}
