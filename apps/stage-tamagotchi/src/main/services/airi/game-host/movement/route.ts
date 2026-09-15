/**
 * Coarse route splitting and region entrances for long terrain moves
 * (review R5; entrance graph CD-G3 D6).
 *
 * The planner reads a local cuboid around start and goal. A far goal grows that
 * cuboid past the region read cap, so `splitRoute` cuts the straight line into
 * horizontal hints no farther than `maxHop` apart. The hints are direction
 * guidance only: the executor accepts any reachable cell near a hint, and never
 * treats a straight-line point or a linearly interpolated Y as a required cell.
 *
 * Long routes over several height layers use an entrance graph instead: each
 * node is a reachable region on one layer, and each edge is a door, bridgehead,
 * slope or boundary passage. Cells with the same X/Z on different layers are
 * different regions, so an underground corridor is never merged with the
 * surface above it.
 */
import type { Vec3 } from './types'

/** Horizontal distance above which a move is split into local legs. */
export const LONG_ROUTE_MIN_DISTANCE = 32
/** Longest horizontal hop of one split leg. */
export const LONG_ROUTE_MAX_HOP = 16
/** Height band that separates one walkable layer from another. */
export const LAYER_HEIGHT = 8

/**
 * Intermediate waypoints of the straight line from `start` to `goal`.
 *
 * Returns an empty list when the horizontal distance is at most `maxHop`; the
 * caller then walks to `goal` directly. Otherwise every returned waypoint is at
 * most `maxHop` horizontally from the previous one, and the remaining distance
 * from the last waypoint to `goal` is also at most `maxHop`. The Y value is a
 * starting-layer hint, not an interpolated route plan (D6).
 *
 * @example
 * splitRoute({ x: 0, y: 64, z: 0 }, { x: 40, y: 64, z: 0 }, 16)
 * // => [{ x: 16, y: 64, z: 0 }, { x: 32, y: 64, z: 0 }]
 */
export function splitRoute(start: Vec3, goal: Vec3, maxHop: number): Vec3[] {
  const dx = goal.x - start.x
  const dz = goal.z - start.z
  const horizontal = Math.hypot(dx, dz)
  if (horizontal <= maxHop)
    return []

  const ux = dx / horizontal
  const uz = dz / horizontal
  const waypoints: Vec3[] = []
  for (let traveled = maxHop; traveled < horizontal; traveled += maxHop) {
    waypoints.push({
      x: Math.round(start.x + ux * traveled),
      y: start.y,
      z: Math.round(start.z + uz * traveled),
    })
  }
  return waypoints
}

/**
 * Goal cells a route hint accepts: the hint and its horizontal neighbors.
 *
 * A hint is not a required cell, so reaching any of these satisfies the leg.
 */
export function hintCells(hint: Vec3, radius = 1): Vec3[] {
  const cells: Vec3[] = []
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dz = -radius; dz <= radius; dz++)
      cells.push({ x: hint.x + dx, y: hint.y, z: hint.z + dz })
  }
  return cells
}

export interface RegionCell {
  x: number
  y: number
  z: number
}

/** A reachable area on one height layer. */
export interface CorridorRegion {
  /** Stable id: layer plus a component index. */
  id: string
  layer: number
  cells: RegionCell[]
}

export type EntranceKind = 'door' | 'bridgehead' | 'slope' | 'boundary'

/** One passage between two regions. */
export interface RegionEntrance {
  fromRegion: string
  toRegion: string
  fromCell: RegionCell
  toCell: RegionCell
  kind: EntranceKind
}

export interface EntranceGraph {
  regions: Map<string, CorridorRegion>
  entrances: RegionEntrance[]
}

export function layerOf(y: number, layerHeight = LAYER_HEIGHT): number {
  return Math.floor(y / layerHeight)
}

function cellKey(cell: RegionCell): string {
  return `${cell.x},${cell.y},${cell.z}`
}

function horizontalNeighbors(cell: RegionCell): RegionCell[] {
  const out: RegionCell[] = []
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      if (dx === 0 && dz === 0)
        continue
      out.push({ x: cell.x + dx, y: cell.y, z: cell.z + dz })
    }
  }
  return out
}

/** All 26 neighbors, including the step up/down that an entrance may cross. */
function neighborCandidates(cell: RegionCell): RegionCell[] {
  const out: RegionCell[] = []
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dz = -1; dz <= 1; dz++) {
        if (dx === 0 && dy === 0 && dz === 0)
          continue
        out.push({ x: cell.x + dx, y: cell.y + dy, z: cell.z + dz })
      }
    }
  }
  return out
}

/**
 * Groups walkable cells into same-layer, same-height components.
 *
 * Two cells join only when they are horizontally adjacent, on the same layer,
 * and `connected` accepts them. The default joins level ground; a slope or a
 * step is a passage between regions, not part of one. A different height layer
 * always yields a different region, even at the same X/Z (D6).
 *
 * @example
 * buildRegions([{ x: 0, y: 0, z: 0 }, { x: 0, y: 8, z: 0 }])
 * // => two regions, layers 0 and 1
 */
export function buildRegions(
  cells: RegionCell[],
  layerHeight = LAYER_HEIGHT,
  connected: (a: RegionCell, b: RegionCell) => boolean = (a, b) => a.y === b.y,
): CorridorRegion[] {
  const parent = new Map<string, string>()
  const byKey = new Map<string, RegionCell>()

  const find = (key: string): string => {
    let root = key
    while (parent.get(root) !== root)
      root = parent.get(root)!
    while (parent.get(key) !== root) {
      const next = parent.get(key)!
      parent.set(key, root)
      key = next
    }
    return root
  }

  const union = (a: string, b: string): void => {
    const rootA = find(a)
    const rootB = find(b)
    if (rootA !== rootB)
      parent.set(rootB, rootA)
  }

  for (const cell of cells) {
    const key = cellKey(cell)
    parent.set(key, key)
    byKey.set(key, cell)
  }
  for (const cell of cells) {
    for (const neighbor of horizontalNeighbors(cell)) {
      if (layerOf(neighbor.y, layerHeight) !== layerOf(cell.y, layerHeight))
        continue
      const neighborKey = cellKey(neighbor)
      if (!byKey.has(neighborKey))
        continue
      if (!connected(cell, neighbor))
        continue
      union(cellKey(cell), neighborKey)
    }
  }

  const groups = new Map<string, RegionCell[]>()
  for (const [key, cell] of byKey) {
    const root = find(key)
    const list = groups.get(root) ?? []
    list.push(cell)
    groups.set(root, list)
  }

  const regions: CorridorRegion[] = []
  let componentIndex = 0
  for (const list of groups.values()) {
    const layer = layerOf(list[0]!.y, layerHeight)
    regions.push({ id: `layer${layer}#${componentIndex++}`, layer, cells: list })
  }
  return regions
}

/**
 * Connects regions whose cells touch across a passable boundary.
 *
 * `classify` decides whether a boundary is a passage and what kind it is;
 * returning `undefined` blocks it. The default treats any adjacent same-or-one
 * step boundary as a `boundary` passage.
 */
export function buildEntranceGraph(
  regions: CorridorRegion[],
  classify?: (a: RegionCell, b: RegionCell) => EntranceKind | undefined,
): EntranceGraph {
  const regionOf = new Map<string, string>()
  for (const region of regions) {
    for (const cell of region.cells)
      regionOf.set(cellKey(cell), region.id)
  }
  const decide = classify ?? ((a: RegionCell, b: RegionCell): EntranceKind | undefined =>
    b.y === a.y ? 'boundary' : Math.abs(b.y - a.y) === 1 ? 'slope' : undefined)

  const entrances: RegionEntrance[] = []
  const seen = new Set<string>()
  for (const region of regions) {
    for (const cell of region.cells) {
      for (const neighbor of neighborCandidates(cell)) {
        const otherRegion = regionOf.get(cellKey(neighbor))
        if (!otherRegion || otherRegion === region.id)
          continue
        const kind = decide(cell, neighbor)
        if (!kind)
          continue
        const key = `${region.id}>${otherRegion}`
        if (seen.has(key))
          continue
        seen.add(key)
        entrances.push({ fromRegion: region.id, toRegion: otherRegion, fromCell: cell, toCell: neighbor, kind })
      }
    }
  }
  return { regions: new Map(regions.map(region => [region.id, region])), entrances }
}

/** Region containing `cell`, or undefined when the region map has no match. */
export function regionOfCell(graph: EntranceGraph, cell: RegionCell): CorridorRegion | undefined {
  for (const region of graph.regions.values()) {
    if (region.cells.some(candidate => candidate.x === cell.x && candidate.y === cell.y && candidate.z === cell.z))
      return region
  }
  return undefined
}

function centroid(region: CorridorRegion): Vec3 {
  let x = 0
  let y = 0
  let z = 0
  for (const cell of region.cells) {
    x += cell.x
    y += cell.y
    z += cell.z
  }
  const count = Math.max(1, region.cells.length)
  return { x: x / count, y: y / count, z: z / count }
}

/**
 * A* over regions; returns the region id sequence or undefined.
 *
 * Edge cost is the horizontal distance between the connected cells, and the
 * heuristic is the distance between region centroids.
 */
export function planRegionSequence(graph: EntranceGraph, startRegionId: string, goalRegionId: string): string[] | undefined {
  if (startRegionId === goalRegionId && graph.regions.has(startRegionId))
    return [startRegionId]
  const goalRegion = graph.regions.get(goalRegionId)
  if (!goalRegion)
    return undefined

  const neighbors = new Map<string, Array<{ to: string, cost: number }>>()
  for (const entrance of graph.entrances) {
    const cost = Math.hypot(entrance.toCell.x - entrance.fromCell.x, entrance.toCell.z - entrance.fromCell.z)
    const forward = neighbors.get(entrance.fromRegion) ?? []
    forward.push({ to: entrance.toRegion, cost })
    neighbors.set(entrance.fromRegion, forward)
    const backward = neighbors.get(entrance.toRegion) ?? []
    backward.push({ to: entrance.fromRegion, cost })
    neighbors.set(entrance.toRegion, backward)
  }

  const goalCenter = centroid(goalRegion)
  const gScore = new Map<string, number>([[startRegionId, 0]])
  const cameFrom = new Map<string, string>()
  const open: Array<{ id: string, f: number }> = [{ id: startRegionId, f: 0 }]

  while (open.length > 0) {
    open.sort((a, b) => a.f - b.f)
    const current = open.shift()!
    if (current.id === goalRegionId) {
      const path: string[] = [current.id]
      let cursor = current.id
      while (cameFrom.has(cursor)) {
        cursor = cameFrom.get(cursor)!
        path.unshift(cursor)
      }
      return path
    }
    const currentG = gScore.get(current.id) ?? Number.POSITIVE_INFINITY
    for (const edge of neighbors.get(current.id) ?? []) {
      const tentative = currentG + edge.cost
      if (tentative >= (gScore.get(edge.to) ?? Number.POSITIVE_INFINITY))
        continue
      gScore.set(edge.to, tentative)
      cameFrom.set(edge.to, current.id)
      const region = graph.regions.get(edge.to)
      const h = region ? Math.hypot(centroid(region).x - goalCenter.x, centroid(region).z - goalCenter.z) : 0
      open.push({ id: edge.to, f: tentative + h })
    }
  }
  return undefined
}

/** Entrance leading from `fromRegionId` to `toRegionId`, in either direction. */
export function localEntrance(graph: EntranceGraph, fromRegionId: string, toRegionId: string): RegionEntrance | undefined {
  return graph.entrances.find(entrance =>
    (entrance.fromRegion === fromRegionId && entrance.toRegion === toRegionId)
    || (entrance.fromRegion === toRegionId && entrance.toRegion === fromRegionId),
  )
}

export interface ObservationFrontier {
  /** Reachable, known cell at the edge of the observed area. */
  cell: RegionCell
  /** Neighbor that is not known yet. */
  unknownNeighbor: RegionCell
}

/**
 * Reachable cells that touch an unknown cell.
 *
 * Unknown regions are only entered through these observation frontiers; a
 * region the caller has already observed is not a frontier.
 *
 * @example
 * // Known cell (0,0,0) with unknown east neighbor returns that pair.
 */
export function reachableUnknownFrontier(
  reachable: RegionCell[],
  isKnown: (cell: RegionCell) => boolean,
): ObservationFrontier[] {
  const frontiers: ObservationFrontier[] = []
  for (const cell of reachable) {
    for (const neighbor of horizontalNeighbors(cell)) {
      if (!isKnown(neighbor))
        frontiers.push({ cell, unknownNeighbor: neighbor })
    }
  }
  return frontiers
}

export interface MaterialBudget {
  remaining: number
  /** Decrement for each block actually placed. */
  notePlaced: (count?: number) => void
  /** Replace the estimate with a fresh inventory count. */
  recalibrate: (observed: number) => void
}

/**
 * Scaffolding budget for one command.
 *
 * Every actual placement decrements the count, and a fresh inventory read is
 * authoritative: a later segment must not reuse the command-start count.
 */
export function createMaterialBudget(initial: number): MaterialBudget {
  const budget: MaterialBudget = {
    remaining: Math.max(0, initial),
    notePlaced(count = 1) {
      budget.remaining = Math.max(0, budget.remaining - count)
    },
    recalibrate(observed: number) {
      budget.remaining = Math.max(0, observed)
    },
  }
  return budget
}
