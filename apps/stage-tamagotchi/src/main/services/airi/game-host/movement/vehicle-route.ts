/**
 * Vehicle connectivity graphs (CD-V2).
 *
 * Three per-type route models share this module because they are the same
 * decision — "can this vehicle physically travel this edge?" — applied to
 * different geometry:
 *
 * - waterway: nodes are connected water surfaces a boat can pass, edges are
 *   channels wide/deep/tall enough for the hull. Land-separated waters have no
 *   waterway edge.
 * - road: nodes and edges use the real horse/donkey/mule size, step height and
 *   jump ability.
 * - rail: directed connections come from the real rail `shape`, slope and
 *   powered state, never from the player camera.
 *
 * The graphs are pure data; the travel session reads the world through the
 * port and feeds cells/pieces in.
 */
// --- Shared cell helpers ------------------------------------------------------------------

const CARDINAL: Array<{ dx: number, dz: number }> = [
  { dx: 1, dz: 0 },
  { dx: -1, dz: 0 },
  { dx: 0, dz: 1 },
  { dx: 0, dz: -1 },
]

function cellKey(cell: { x: number, y: number, z: number }): string {
  return `${cell.x},${cell.y},${cell.z}`
}

// --- Waterway (boat, design §4) -----------------------------------------------------------

/** Physical facts of the boat hull the waterway must satisfy. */
export interface BoatPassage {
  /** Hull width in blocks; a channel narrower than this cannot be entered. */
  width: number
  /** Hull draft in blocks; the water must be at least this deep. */
  draft: number
  /** Hull height above the surface; the ceiling must clear it. */
  height: number
  /** Largest surface-height change the boat can ride, in blocks. */
  maxSurfaceStep: number
}

/** Default oak boat hull: width 1.375, draft ~0.5625, height ~0.5625. */
export const DEFAULT_BOAT_PASSAGE: BoatPassage = {
  width: 1.375,
  draft: 0.5625,
  height: 0.5625,
  maxSurfaceStep: 1,
}

/** One water surface cell the boat can occupy. */
export interface WaterCell {
  x: number
  y: number
  z: number
  /** Y coordinate of the water surface top. */
  waterTop: number
  /** Water blocks below the surface. */
  depth: number
  /** Air blocks above the surface. */
  clearance: number
}

export type WaterChokeReason = 'too_shallow' | 'too_low' | 'too_narrow'

export interface WaterChoke {
  cell: WaterCell
  reason: WaterChokeReason
}

function waterPassesCell(cell: WaterCell, passage: BoatPassage): WaterChokeReason | undefined {
  if (cell.depth < passage.draft)
    return 'too_shallow'
  if (cell.clearance < passage.height)
    return 'too_low'
  return undefined
}

/**
 * Finds water cells the boat hull cannot pass.
 *
 * Width is measured as the contiguous water run across the narrowest cardinal
 * axis through the cell, so a one-block canal is rejected even though the
 * player's own box would fit (design §4).
 *
 * @example
 * waterwayChokes([{ x: 0, y: 62, z: 0, waterTop: 63, depth: 1, clearance: 2 }])
 * // => [{ cell, reason: 'too_shallow' }]
 */
export function waterwayChokes(cells: WaterCell[], passage: BoatPassage = DEFAULT_BOAT_PASSAGE): WaterChoke[] {
  const byKey = new Map<string, WaterCell>()
  for (const cell of cells)
    byKey.set(`${cell.x},${cell.y},${cell.z}`, cell)
  const chokes: WaterChoke[] = []
  for (const cell of cells) {
    const shallow = waterPassesCell(cell, passage)
    if (shallow) {
      chokes.push({ cell, reason: shallow })
      continue
    }
    const widthX = contiguousRun(byKey, cell, 1, 0) + 1
    const widthZ = contiguousRun(byKey, cell, 0, 1) + 1
    if (Math.min(widthX, widthZ) < passage.width)
      chokes.push({ cell, reason: 'too_narrow' })
  }
  return chokes
}

function contiguousRun(byKey: Map<string, WaterCell>, origin: WaterCell, dx: number, dz: number): number {
  // Count both directions from the cell, so a cell in the middle of a canal is
  // not measured as a half-width choke.
  let count = 0
  for (const sign of [1, -1]) {
    let cursor = origin
    for (;;) {
      cursor = { ...cursor, x: cursor.x + dx * sign, z: cursor.z + dz * sign }
      const next = byKey.get(`${cursor.x},${cursor.y},${cursor.z}`)
      if (!next || next.waterTop !== origin.waterTop)
        break
      count++
    }
  }
  return count
}

function waterSurfaceRideable(a: WaterCell, b: WaterCell, passage: BoatPassage): boolean {
  return Math.abs(a.waterTop - b.waterTop) <= passage.maxSurfaceStep
}

export interface WaterwayRegion {
  id: string
  cells: WaterCell[]
}

/**
 * Groups passable water cells into surface-connected regions.
 *
 * Two cells join only when the surface step is within the boat's limit; land
 * between them always separates the regions. A cell too narrow, shallow or low
 * is not part of any region, so it cannot create a false waterway edge.
 */
export function buildWaterwayRegions(
  cells: WaterCell[],
  passage: BoatPassage = DEFAULT_BOAT_PASSAGE,
): WaterwayRegion[] {
  const chokeKeys = new Set(waterwayChokes(cells, passage).map(choke => cellKey(choke.cell)))
  const passable = cells.filter(cell => !chokeKeys.has(cellKey(cell)))
  const byKey = new Map(passable.map(cell => [cellKey(cell), cell]))

  const parent = new Map<string, string>()
  const find = (key: string): string => {
    let root = key
    while (parent.get(root) !== root)
      root = parent.get(root)!
    return root
  }
  const union = (a: string, b: string): void => {
    const rootA = find(a)
    const rootB = find(b)
    if (rootA !== rootB)
      parent.set(rootB, rootA)
  }
  for (const cell of passable)
    parent.set(cellKey(cell), cellKey(cell))
  for (const cell of passable) {
    for (const { dx, dz } of CARDINAL) {
      const neighbor = byKey.get(`${cell.x + dx},${cell.y},${cell.z + dz}`)
      if (neighbor && waterSurfaceRideable(cell, neighbor, passage))
        union(cellKey(cell), cellKey(neighbor))
    }
  }

  const groups = new Map<string, WaterCell[]>()
  for (const cell of passable) {
    const root = find(cellKey(cell))
    const list = groups.get(root) ?? []
    list.push(cell)
    groups.set(root, list)
  }
  let index = 0
  return [...groups.values()].map(list => ({ id: `water#${index++}`, cells: list }))
}

/** Region containing a cell, or undefined when the cell is not passable water. */
export function waterwayRegionOf(regions: WaterwayRegion[], cell: { x: number, y: number, z: number }): WaterwayRegion | undefined {
  const key = cellKey(cell)
  return regions.find(region => region.cells.some(candidate => cellKey(candidate) === key))
}

/** True when two water regions are separated by land (no waterway edge). */
export function waterwayLandSeparated(regions: WaterwayRegion[], from: { x: number, y: number, z: number }, to: { x: number, y: number, z: number }): boolean {
  const fromRegion = waterwayRegionOf(regions, from)
  const toRegion = waterwayRegionOf(regions, to)
  if (!fromRegion || !toRegion)
    return true
  return fromRegion.id !== toRegion.id
}

// --- Road (horse/donkey/mule, design §5) --------------------------------------------------

/**
 * A horse/donkey/mule's real traversal ability.
 *
 * The width and height are the entity box; `stepHeight` is the vanilla step
 * (0.6 for horses). `maxJumpHeight`/`maxJumpGap` bound the jump primitive.
 */
export interface HorseProfile {
  width: number
  height: number
  stepHeight: number
  maxJumpHeight: number
  maxJumpGap: number
}

export const DEFAULT_HORSE_PROFILE: HorseProfile = {
  width: 1.4,
  height: 1.6,
  stepHeight: 0.6,
  maxJumpHeight: 1.25,
  maxJumpGap: 4,
}

/** One walkable road cell with its support and headroom facts. */
export interface RoadCell {
  x: number
  y: number
  z: number
  /** Top surface of the support block, in block coordinates. */
  supportTop: number
  /** Air blocks above the support within the horse box. */
  headroom: number
  /** True when another entity or a wall fills the cell (door too narrow). */
  blocked?: boolean
}

export type RoadMotionKind = 'walk' | 'step-up' | 'jump' | 'fall' | 'blocked'

export interface RoadEdge {
  from: RoadCell
  to: RoadCell
  motion: Exclude<RoadMotionKind, 'blocked'>
  /** Vertical change, in blocks. */
  rise: number
  /** Horizontal gap, in blocks. */
  gap: number
}

/**
 * Classifies one horse edge between two road cells.
 *
 * A width narrower than the horse box or a blocked cell yields `blocked`; the
 * step height and jump bounds decide between walk, step-up, jump and fall.
 */
export function horseMotion(from: RoadCell, to: RoadCell, profile: HorseProfile = DEFAULT_HORSE_PROFILE): RoadMotionKind {
  if (to.blocked || to.headroom < profile.height)
    return 'blocked'
  const rise = to.supportTop - from.supportTop
  const gap = Math.hypot(to.x - from.x, to.z - from.z)
  if (rise === 0)
    return gap > 0 ? 'walk' : 'blocked'
  if (rise > 0 && rise <= profile.stepHeight)
    return 'step-up'
  if (rise > 0)
    return rise <= profile.maxJumpHeight && gap <= profile.maxJumpGap ? 'jump' : 'blocked'
  return 'fall'
}

/**
 * Builds the horse road graph: nodes are road cells, edges are the traversable
 * motions. A jump edge is only added when the jump fits the horse's bounds.
 */
export function buildHorseRoadGraph(cells: RoadCell[], profile: HorseProfile = DEFAULT_HORSE_PROFILE): RoadEdge[] {
  const edges: RoadEdge[] = []
  for (const from of cells) {
    for (const other of cells) {
      if (other === from)
        continue
      const gap = Math.hypot(other.x - from.x, other.z - from.z)
      if (gap > Math.max(1.5, profile.maxJumpGap))
        continue
      const motion = horseMotion(from, other, profile)
      if (motion === 'blocked')
        continue
      edges.push({ from, to: other, motion, rise: other.supportTop - from.supportTop, gap })
    }
  }
  return edges
}

// --- Rail (minecart, design §6) -----------------------------------------------------------

export type RailShape
  = | 'north_south'
    | 'east_west'
    | 'ascending_east'
    | 'ascending_west'
    | 'ascending_north'
    | 'ascending_south'
    | 'south_east'
    | 'south_west'
    | 'north_east'
    | 'north_west'

export type RailDirection = 'north' | 'south' | 'east' | 'west'

/**
 * One rail interface: the direction and the interface offset.
 *
 * `offset` is the rail surface height at that end relative to the block base:
 * a flat rail is 0 at both ends; an ascending rail is 1 at the raised end and 0
 * at the other. The interface height (block base + offset) is what two adjacent
 * rails must agree on, so a slope continues into a flat rail at `y+1` and into
 * another ascending rail of the same shape (design §6).
 */
export interface RailConnection {
  dir: RailDirection
  offset: 0 | 1
}

const OPPOSITE: Record<RailDirection, RailDirection> = {
  north: 'south',
  south: 'north',
  east: 'west',
  west: 'east',
}

const DELTA: Record<RailDirection, { dx: number, dz: number }> = {
  north: { dx: 0, dz: -1 },
  south: { dx: 0, dz: 1 },
  east: { dx: 1, dz: 0 },
  west: { dx: -1, dz: 0 },
}

/**
 * The directions one rail shape connects, with their interface offset.
 *
 * This is the real block state, not the view rotation: a corner connects two
 * perpendicular directions and an ascending rail raises exactly one end.
 *
 * @example
 * railConnections('ascending_east')
 * // => [{ dir: 'east', offset: 1 }, { dir: 'west', offset: 0 }]
 */
export function railConnections(shape: RailShape): RailConnection[] {
  switch (shape) {
    case 'north_south':
      return [{ dir: 'north', offset: 0 }, { dir: 'south', offset: 0 }]
    case 'east_west':
      return [{ dir: 'east', offset: 0 }, { dir: 'west', offset: 0 }]
    case 'ascending_east':
      return [{ dir: 'east', offset: 1 }, { dir: 'west', offset: 0 }]
    case 'ascending_west':
      return [{ dir: 'west', offset: 1 }, { dir: 'east', offset: 0 }]
    case 'ascending_north':
      return [{ dir: 'north', offset: 1 }, { dir: 'south', offset: 0 }]
    case 'ascending_south':
      return [{ dir: 'south', offset: 1 }, { dir: 'north', offset: 0 }]
    case 'south_east':
      return [{ dir: 'south', offset: 0 }, { dir: 'east', offset: 0 }]
    case 'south_west':
      return [{ dir: 'south', offset: 0 }, { dir: 'west', offset: 0 }]
    case 'north_east':
      return [{ dir: 'north', offset: 0 }, { dir: 'east', offset: 0 }]
    case 'north_west':
      return [{ dir: 'north', offset: 0 }, { dir: 'west', offset: 0 }]
  }
}

/** Interface height of one rail connection, in block coordinates. */
function railInterfaceHeight(piece: RailPiece, connection: RailConnection): number {
  return piece.y + connection.offset
}

/** One rail piece with its real shape and powered state. */
export interface RailPiece {
  x: number
  y: number
  z: number
  shape: RailShape
  powered: boolean
}

export interface RailNode {
  key: string
  piece: RailPiece
}

export interface RailEdge {
  from: string
  to: string
  /** Horizontal direction of travel. */
  dir: RailDirection
  /** Vertical change along the edge. */
  dy: number
  /** True when the source piece is a powered rail. */
  powered: boolean
}

export interface RailGraph {
  nodes: Map<string, RailNode>
  edges: RailEdge[]
}

/**
 * Builds directed rail connections from real shapes.
 *
 * An edge A->B exists only when A connects toward B and B connects back with
 * the reciprocal slope, so a broken or mismatched rail produces no edge. The
 * vertical step is derived from the slope, never guessed.
 */
export function buildRailGraph(pieces: RailPiece[]): RailGraph {
  const nodes = new Map<string, RailNode>()
  for (const piece of pieces)
    nodes.set(cellKey(piece), { key: cellKey(piece), piece })

  const edges: RailEdge[] = []
  for (const piece of pieces) {
    const fromKey = cellKey(piece)
    for (const connection of railConnections(piece.shape)) {
      const { dx, dz } = DELTA[connection.dir]
      const interfaceHeight = railInterfaceHeight(piece, connection)
      // The neighbor base is not known from the source alone (a slope's raised
      // end adds one). Try the three possible bases and require the reciprocal
      // interface heights to agree exactly, so a broken slope connects nothing.
      for (const dy of [0, 1, -1]) {
        const neighbor = nodes.get(cellKey({ x: piece.x + dx, y: piece.y + dy, z: piece.z + dz }))
        if (!neighbor)
          continue
        const back = railConnections(neighbor.piece.shape).find(entry => entry.dir === OPPOSITE[connection.dir])
        if (!back)
          continue
        if (railInterfaceHeight(neighbor.piece, back) !== interfaceHeight)
          continue
        edges.push({ from: fromKey, to: neighbor.key, dir: connection.dir, dy, powered: piece.powered })
        break
      }
    }
  }
  return { nodes, edges }
}

/**
 * Plan a directed route across the rail graph.
 *
 * Returns the node keys from `startKey` to `goalKey`, or `undefined` when the
 * goal is unreachable through real rail connections. The route is directed, so
 * a one-way slope is respected.
 */
export function planRailRoute(graph: RailGraph, startKey: string, goalKey: string): string[] | undefined {
  if (!graph.nodes.has(startKey) || !graph.nodes.has(goalKey))
    return undefined
  if (startKey === goalKey)
    return [startKey]
  const neighbors = new Map<string, string[]>()
  for (const edge of graph.edges) {
    const list = neighbors.get(edge.from) ?? []
    list.push(edge.to)
    neighbors.set(edge.from, list)
  }
  const queue = [startKey]
  const cameFrom = new Map<string, string>()
  const seen = new Set<string>([startKey])
  while (queue.length > 0) {
    const current = queue.shift()!
    if (current === goalKey) {
      const path = [current]
      let cursor = current
      while (cameFrom.has(cursor)) {
        cursor = cameFrom.get(cursor)!
        path.unshift(cursor)
      }
      return path
    }
    for (const next of neighbors.get(current) ?? []) {
      if (seen.has(next))
        continue
      seen.add(next)
      cameFrom.set(next, current)
      queue.push(next)
    }
  }
  return undefined
}

/**
 * Outgoing directions at one rail node.
 *
 * The intersection decision uses these real connections, so a corner or a
 * switch chooses the branch the rail allows instead of the direction the
 * camera faces (design §6).
 */
export function railBranchDirections(graph: RailGraph, nodeKey: string): RailEdge[] {
  return graph.edges.filter(edge => edge.from === nodeKey)
}

/**
 * Finds a safe stop area: a flat, powered or station-like node near the goal.
 *
 * A node with no descending outgoing edge is a place a cart can be stopped
 * without rolling away; the caller may still need to brake first.
 */
export function findRailStopArea(graph: RailGraph, goalKey: string, maxDistance = 3): string[] {
  const goal = graph.nodes.get(goalKey)?.piece
  if (!goal)
    return []
  const stops: string[] = []
  for (const [key, node] of graph.nodes) {
    const distance = Math.hypot(node.piece.x - goal.x, node.piece.z - goal.z)
    if (distance > maxDistance)
      continue
    const outgoing = railBranchDirections(graph, key)
    if (outgoing.every(edge => edge.dy <= 0))
      stops.push(key)
  }
  return stops
}
