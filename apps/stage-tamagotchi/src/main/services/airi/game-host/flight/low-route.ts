/**
 * Long-route layer for a single elytra trip (E-07 / LR-4 low-altitude shortcut).
 *
 * The cruise band used to be `goal.y + 30`, which is a promise the terrain does
 * not make: in a canyon it flies 30 blocks above the *goal's* altitude no matter
 * what the ground does, climbs into the wall, and there is no strategic layer to
 * tell it about the valley below. The near-field corridor cannot fill that role
 * either — its window is 32 blocks and it re-plans every 1.5 s, while the glider
 * covers 30 blocks a second (live evidence: `docs/fork/evidence/flight-venue-20260918`).
 *
 * This module answers the strategic question with one cheap measurement: read a
 * few segment slabs along the heading, find the **lowest air slot that is tall
 * enough to fly through** in each column, and walk outward picking the slot that
 * continues the previous one. The result is a waypoint and the altitude to fly
 * there, so the trip follows the valley floor instead of a fixed offset, and a
 * ceiling (a slab over the channel) is a slot to fly under rather than a wall to
 * climb over.
 *
 * Everything is bounded: a fixed number of segment reads, a fixed lateral search,
 * and a typed refusal instead of a guess when no slot exists.
 */
import type { FlightCrossSection, MovementControlPort } from '../movement/port'
import type { SnapshotEntry } from '../movement/snapshot'
import type { Vec3 } from '../movement/types'
import type { SpaceRoute } from './corridor'

import { bodyFootprintClear, planSpaceRoute, spaceRouteCost } from './corridor'

/** How far ahead one plan reaches, in blocks. */
export const LOW_ROUTE_SPAN = 96
/** Distance between two sampled columns along the heading. */
export const LOW_ROUTE_STEP = 4
/** Blocks read on each side of the heading line. */
export const LOW_ROUTE_HALF_WIDTH = 4
/** Air height a column must offer before the route may fly through it. */
export const LOW_ROUTE_MIN_CLEARANCE = 3
/** How far below the current altitude a slot may be found. */
export const LOW_ROUTE_DROP = 80
/** How far above the current altitude the slot scan looks for a ceiling. */
export const LOW_ROUTE_RISE = 8
/**
 * Cell ceiling for one segment read.
 *
 * The bridge returns at most 32768 cells and silently truncates the rest, so a
 * segment's vertical window is derived from its own footprint instead of assumed
 * (a diagonal heading widens the box by the span in both axes).
 */
export const LOW_ROUTE_MAX_CELLS = 32_000
/** Length of one segment read along the heading, in blocks. */
export const LOW_ROUTE_SEGMENT = 16
/** How long a plan stays valid, in ms. */
export const LOW_ROUTE_TTL_MS = 6_000
/**
 * How long the last planned band may steer after the plans stopped, in ms.
 *
 * R3 replaces the historical "has ever had a route" boolean with this bounded
 * window: a temporary plan refusal must not rocket the glider into the canyon
 * ceiling, but a route that stopped refreshing 20 s ago is no longer a fact
 * about the terrain ahead. Three plan lifetimes; after it the forward scan
 * owns the band again.
 */
export const LOW_ROUTE_HOLD_MS = LOW_ROUTE_TTL_MS * 3
/** Default elytra cruise speed used to size read-ahead, blocks/tick. */
const FLIGHT_CRUISE_SPEED = 1.6
/** How close to the waypoint the trip counts as "reached this leg". */
export const LOW_ROUTE_WAYPOINT_REACH = 16

/**
 * The must-pass opening contract lives with the movement port
 * (`movement/port.ts`) so the generic vehicle request can name it without
 * depending on this planner; it is re-exported here for planning callers.
 */
export type { FlightCrossSection } from '../movement/port'

/**
 * One leg of a route that passes through known openings (ab-30 plan §2).
 *
 * The split exists so the client and the host agree on which points are inside
 * an opening and what continuation follows it: a plan that ends inside the
 * opening has nothing to hand over to on the next replan.
 */
export interface FlightLegPlan {
  /** The opening this leg enters through. */
  entry: FlightCrossSection
  /** Verified points from the leg start up to the entry crossing. */
  approach: Vec3[]
  /** Points between the entry and the exit crossing (inside the opening). */
  interior: Vec3[]
  /** The opening the leg leaves through, when the caller named one. */
  exit?: FlightCrossSection
  /** Verified points after the exit: the continuation the next replan uses. */
  suffix: Vec3[]
}

/**
 * Splits a path at a section's plane, inserting the crossing point so both
 * halves are non-empty even when the path is a single chord (a 2-point direct
 * leg would otherwise have nothing on the far side to hand over).
 *
 * @example
 * splitPathAtSection([{ x: 0, y: 70, z: 0 }, { x: 0, y: 70, z: 4 }], { axis: 'z', at: 2, lateralMin: -1, lateralMax: 1, yMin: 69, yMax: 71 })
 * // => { before: [p0, { x: 0, y: 70, z: 2 }], after: [{ x: 0, y: 70, z: 2 }, p1] }
 */
export function splitPathAtSection(path: Vec3[], section: FlightCrossSection): { before: Vec3[], after: Vec3[] } {
  const coordinate = (point: Vec3): number => section.axis === 'x' ? point.x : point.z
  for (let index = 1; index < path.length; index++) {
    const from = path[index - 1]!
    const to = path[index]!
    const fromValue = coordinate(from) - section.at
    const toValue = coordinate(to) - section.at
    if (fromValue * toValue > 0 || fromValue === toValue)
      continue
    const t = fromValue === 0 ? 0 : fromValue / (fromValue - toValue)
    const crossing = {
      x: from.x + (to.x - from.x) * t,
      y: from.y + (to.y - from.y) * t,
      z: from.z + (to.z - from.z) * t,
    }
    return { before: [...path.slice(0, index), crossing], after: [crossing, ...path.slice(index)] }
  }
  return { before: path, after: [] }
}

const isAir = (id: string | undefined): boolean => !id || id === '' || id.endsWith('air')

/** Shrinks a section by a margin on every side (body size + safety). */
export function shrinkCrossSection(section: FlightCrossSection, margin: number): FlightCrossSection {
  return {
    ...section,
    lateralMin: section.lateralMin + margin,
    lateralMax: section.lateralMax - margin,
    yMin: section.yMin + margin,
    yMax: section.yMax - margin,
  }
}

/**
 * Where a route crosses a section's plane, interpolated between the two path
 * points that straddle it.
 *
 * @example
 * crossingOfSection([{ x: 0, y: 70, z: 0 }, { x: 4, y: 70, z: 0 }], { axis: 'x', at: 2, lateralMin: -1, lateralMax: 1, yMin: 69, yMax: 71 })
 * // => { x: 2, y: 70, z: 0, inside: true }
 */
export function crossingOfSection(path: Vec3[], section: FlightCrossSection): { x: number, y: number, z: number, inside: boolean } | undefined {
  const coordinate = (point: Vec3): number => section.axis === 'x' ? point.x : point.z
  for (let index = 1; index < path.length; index++) {
    const from = path[index - 1]!
    const to = path[index]!
    const fromValue = coordinate(from) - section.at
    const toValue = coordinate(to) - section.at
    if (fromValue === 0)
      return { ...from, inside: insideSection(from, section) }
    if (fromValue * toValue > 0 || fromValue === toValue)
      continue
    const t = fromValue / (fromValue - toValue)
    const point = {
      x: from.x + (to.x - from.x) * t,
      y: from.y + (to.y - from.y) * t,
      z: from.z + (to.z - from.z) * t,
    }
    return { ...point, inside: insideSection(point, section) }
  }
  return undefined
}

/** True when a point is inside the section's rectangle. */
export function insideSection(point: Vec3, section: FlightCrossSection): boolean {
  const lateral = section.axis === 'x' ? point.z : point.x
  return lateral >= section.lateralMin && lateral <= section.lateralMax
    && point.y >= section.yMin && point.y <= section.yMax
}

/**
 * Verified route length past a section's plane, from the crossing to the end of
 * the path (ab-30 plan §2).
 *
 * Entering a narrow opening needs a visible continuation: if the route stops
 * right after the opening, the next replan has nothing to hand over to and the
 * client starts to hold or climb inside it. Returns `undefined` when the path
 * never crosses the plane.
 */
export function suffixLengthPastSection(path: Vec3[], section: FlightCrossSection): number | undefined {
  const coordinate = (point: Vec3): number => section.axis === 'x' ? point.x : point.z
  for (let index = 1; index < path.length; index++) {
    const from = path[index - 1]!
    const to = path[index]!
    const fromValue = coordinate(from) - section.at
    const toValue = coordinate(to) - section.at
    if (fromValue * toValue > 0 || fromValue === toValue)
      continue
    const t = fromValue === 0 ? 0 : fromValue / (fromValue - toValue)
    const crossing = {
      x: from.x + (to.x - from.x) * t,
      y: from.y + (to.y - from.y) * t,
      z: from.z + (to.z - from.z) * t,
    }
    let length = Math.hypot(to.x - crossing.x, to.y - crossing.y, to.z - crossing.z)
    for (let rest = index + 1; rest < path.length; rest++) {
      const previous = path[rest - 1]!
      const point = path[rest]!
      length += Math.hypot(point.x - previous.x, point.y - previous.y, point.z - previous.z)
    }
    return length
  }
  return undefined
}

/**
 * How much verified route must exist past a must-pass section before the plan
 * may enter it.
 *
 * The requirement is time-based, not a fixed block count: at cruise speed the
 * glider covers ~1.6 blocks/tick, so the suffix must cover the seconds the next
 * replan needs to arrive (read + plan + handover).
 *
 * @example
 * requiredSuffixBlocks(1.6)
 * // => 4
 */
export function requiredSuffixBlocks(speed: number, seconds = 2.5): number {
  return Math.max(0, speed) * Math.max(0, seconds)
}

/**
 * Extracts the widest passable opening in a plane of the read cells, then
 * shrinks it by `margin` (body size + safety).
 *
 * Passability matches the channel body check (`isAir`): water, leaves, and
 * unknown cells block both checks. An opening never grants permission to
 * cross a cell the client rejects.
 *
 * @example
 * // A 3-wide, 2-tall hole at z=60 (cells read around it are solid):
 * extractCrossSection({ cells, axis: 'z', at: 60, lateralFrom: -6, lateralTo: 6, yFrom: 63, yTo: 74, margin: 0.5 })
 * // => { axis: 'z', at: 60, lateralMin: -2.5, lateralMax: 2.5, yMin: 66, yMax: 71 }
 */
export function extractCrossSection(input: {
  cells: Map<string, string>
  axis: 'x' | 'z'
  at: number
  lateralFrom: number
  lateralTo: number
  yFrom: number
  yTo: number
  margin: number
}): FlightCrossSection | undefined {
  const at = Math.floor(input.at)
  const laterals: number[] = []
  for (let lateral = Math.ceil(input.lateralFrom); lateral <= Math.floor(input.lateralTo); lateral++)
    laterals.push(lateral)
  const ys: number[] = []
  for (let y = Math.ceil(input.yFrom); y <= Math.floor(input.yTo); y++)
    ys.push(y)
  if (laterals.length === 0 || ys.length === 0)
    return undefined
  const passable = (lateral: number, y: number): boolean => {
    const key = input.axis === 'x' ? `${at},${y},${lateral}` : `${lateral},${y},${at}`
    // Unknown (unread) cells are NOT air: treating them as passable invented
    // openings outside the read region in the first version of this extractor.
    const id = input.cells.get(key)
    return id !== undefined && isAir(id)
  }
  // Largest all-passable rectangle, by trying every vertical span and taking
  // the longest horizontal run inside it. The spans are read-window sized, so
  // the quadratic-in-height loop is cheap and stays obviously correct.
  let best: FlightCrossSection | undefined
  let bestArea = 0
  for (let yi = 0; yi < ys.length; yi++) {
    for (let yj = yi; yj < ys.length; yj++) {
      let runStart = -1
      for (let li = 0; li <= laterals.length; li++) {
        let inside = false
        if (li < laterals.length) {
          inside = true
          for (let k = yi; k <= yj; k++) {
            if (!passable(laterals[li]!, ys[k]!)) {
              inside = false
              break
            }
          }
        }
        if (inside && runStart < 0)
          runStart = li
        if (!inside && runStart >= 0) {
          const area = (li - runStart) * (yj - yi + 1)
          if (area > bestArea) {
            bestArea = area
            best = {
              axis: input.axis,
              at,
              lateralMin: laterals[runStart]!,
              lateralMax: laterals[li - 1]!,
              yMin: ys[yi]!,
              yMax: ys[yj]!,
            }
          }
          runStart = -1
        }
      }
    }
  }
  if (best === undefined)
    return undefined
  const shrunk = shrinkCrossSection(best, input.margin)
  return shrunk.lateralMin <= shrunk.lateralMax && shrunk.yMin <= shrunk.yMax ? shrunk : undefined
}

/**
 * Parses diagnostic cross-section specs (`E02_MUST_PASS`), e.g.
 * `z:60:-6:6:63:74;x:-1004:60:64:68:72`. Invalid entries are dropped so a typo
 * cannot silently become a different constraint. Production callers extract
 * sections from terrain instead (ab-30 plan §1).
 *
 * @example
 * parseCrossSections('z:60:-6:6:63:74')
 * // => [{ axis: 'z', at: 60, lateralMin: -6, lateralMax: 6, yMin: 63, yMax: 74 }]
 */
export function parseCrossSections(spec: string | undefined): FlightCrossSection[] {
  if (spec === undefined || spec.trim() === '')
    return []
  const sections: FlightCrossSection[] = []
  for (const part of spec.split(';')) {
    const fields = part.trim().split(':')
    if (fields.length !== 6)
      continue
    const axis = fields[0]!.trim()
    if (axis !== 'x' && axis !== 'z')
      continue
    const numbers = fields.slice(1).map(field => Number(field))
    if (numbers.some(number => !Number.isFinite(number)))
      continue
    const [at, lateralMin, lateralMax, yMin, yMax] = numbers as [number, number, number, number, number]
    if (lateralMin > lateralMax || yMin > yMax)
      continue
    sections.push({ axis, at, lateralMin, lateralMax, yMin, yMax })
  }
  return sections
}

/** One sampled column of the route. */
export interface LowRoutePoint {
  /** Distance along the heading, in blocks. */
  ahead: number
  lateral: number
  x: number
  z: number
  /** Top of the ground/water in the column. */
  surface: number
  /** Underside of the first solid above the slot; absent when the sky is open. */
  ceiling?: number
  /** Air between the surface and the ceiling. */
  clearance: number
  /** Altitude to fly at this column, in feet blocks. */
  bandY: number
}

export type LowRouteStatus = 'planned' | 'blocked' | 'read_failed' | 'search_budget'

export interface LowRoutePlan {
  status: LowRouteStatus
  /**
   * Terminal point of the ordered path: the goal's air cell when the goal was
   * covered, else the covered frontier cell (a local route). Absent on a
   * refusal. Migration note (R1): consumers should move to `path`; the single
   * waypoint remains until R3 rewires the cruise leg.
   */
  waypoint?: Vec3
  /** Altitude of the terminal path point; absent on a refusal. */
  bandY?: number
  /** Progress along the bearing at the terminal point, in blocks. */
  reached: number
  /**
   * Ordered route in verified air, nearest first (R1). Every step's full
   * space was verified by the space search; unknown cells are never on it.
   */
  path?: Vec3[]
  /**
   * The same route thinned to channel spacing, with every straight segment
   * re-verified against the read cells (R4 review: the old host-side thinning
   * joined points without checking the new chord, so the client flew a chord
   * that cut a corner). Each emitted segment keeps a body-box margin from
   * solid cells. Absent on a refusal.
   */
  channelPath?: Vec3[]
  /** True when the goal cell was never read: the route ends at the frontier. */
  local?: boolean
  /** A* expansions of the last space search. */
  expanded?: number
  /** Region reads this plan consumed. */
  reads?: number
  /**
   * Steepest positive climb on the channel path (dy per horizontal block).
   * The glider cannot hover-climb; a route above this slope needs a rocket
   * burn the host may not be able to provide (R4 cave-diag-08/10/12: the
   * route climbed the bank at 0.29–0.74 and the client refused).
   */
  maxClimbSlope?: number
  /** Total height gained on the channel path, blocks. */
  climbTotal?: number
  /** Concrete refusal reason for budget-family outcomes. */
  reason?: string
  /**
   * Waypoint semantics for the client: `stop` ends the trip (the goal was
   * reached), `through` is a handover point the next replan continues from and
   * must not trigger a terminal hold (ab-30 plan §2).
   */
  waypointKind?: 'through' | 'stop'
  /** Leg decomposition when the plan crosses a must-pass opening. */
  leg?: FlightLegPlan
}

/** Target spacing of the channel path after verified thinning, in blocks. */
const CHANNEL_PATH_SPACING = 12
/**
 * Body box the chord re-verification uses, matching the client's sweep
 * (half-width 0.3 + inflation) plus a tracking margin: the client steers with
 * momentum, so a segment that only just fits would clip on drift.
 */
const CHANNEL_BODY_HALF_WIDTH = 0.45
const CHANNEL_BODY_HEIGHT = 1.8
/** Same body margin the space search keeps, so both agree on clearance. */
const CHANNEL_CHORD_MARGIN = 0.2

/**
 * True when the channel body box fits at one point of a chord. An unread
 * cell or water blocks: the client's flight model only supports air.
 */
function channelBodyClear(cells: Map<string, string>, x: number, y: number, z: number): boolean {
  const half = CHANNEL_BODY_HALF_WIDTH + CHANNEL_CHORD_MARGIN
  const bottom = Math.floor(y - 0.15)
  // A voxel at ceil(max) lies beyond the inflated body, including ceilings.
  const top = Math.ceil(y + CHANNEL_BODY_HEIGHT + 0.15) - 1
  for (let ex = Math.floor(x - half); ex < Math.ceil(x + half); ex++) {
    for (let ez = Math.floor(z - half); ez < Math.ceil(z + half); ez++) {
      for (let ey = bottom; ey <= top; ey++) {
        const id = cells.get(`${ex},${ey},${ez}`)
        if (id === undefined || !isAir(id))
          return false
      }
    }
  }
  return true
}

/** Samples the chord at a bounded step and verifies the body box on it. */
function channelChordClear(cells: Map<string, string>, from: Vec3, to: Vec3): boolean {
  const length = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z)
  const steps = Math.max(1, Math.ceil(length / 0.5))
  for (let index = 0; index <= steps; index++) {
    const t = index / steps
    if (!channelBodyClear(
      cells,
      from.x + (to.x - from.x) * t,
      from.y + (to.y - from.y) * t,
      from.z + (to.z - from.z) * t,
    )) {
      return false
    }
  }
  return true
}

/**
 * Thins a verified path to channel spacing without losing its safety: a chord
 * is emitted only when the body box fits along it, otherwise the path keeps
 * the finer A* points around the corner. The terminal point is always kept.
 *
 * Returns undefined when no verified thinning exists. The contract of a
 * "verified channel" is that EVERY submitted segment passed the body sweep;
 * emitting an unverified step (or returning a short path unchecked) would
 * hand the client a route the planner already knows it cannot fly — the
 * caller must refuse the plan instead (R4 review 2026-09-20, item 3).
 */
function channelPathOfVerified(cells: Map<string, string>, path: Vec3[]): Vec3[] | undefined {
  if (path.length < 2)
    return undefined
  const out: Vec3[] = [{ ...path[0]! }]
  let anchor = 0
  let since = 0
  for (let index = 1; index < path.length; index++) {
    const previous = path[index - 1]!
    const point = path[index]!
    since += Math.hypot(point.x - previous.x, point.y - previous.y, point.z - previous.z)
    if (since < CHANNEL_PATH_SPACING && index < path.length - 1)
      continue
    // Emit the farthest point from the current anchor whose chord (and every
    // shorter candidate back to the adjacent A* step) passes the body sweep.
    // No point passes means this leg has no verified thinning: refuse.
    let chosen = -1
    for (let candidate = index; candidate > anchor; candidate--) {
      if (channelChordClear(cells, out[out.length - 1]!, path[candidate]!)) {
        chosen = candidate
        break
      }
    }
    if (chosen === -1)
      return undefined
    out.push({ ...path[chosen]! })
    anchor = chosen
    // Distance already walked past the chosen point stays counted, and the
    // loop continues right after the chosen index (a bend near the terminal
    // then needs one more step instead of aborting the whole leg).
    since = 0
    for (let walked = chosen + 1; walked <= index; walked++)
      since += Math.hypot(path[walked]!.x - path[walked - 1]!.x, path[walked]!.y - path[walked - 1]!.y, path[walked]!.z - path[walked - 1]!.z)
    index = chosen
  }
  const last = out[out.length - 1]!
  const terminal = path[path.length - 1]!
  if (last.x !== terminal.x || last.y !== terminal.y || last.z !== terminal.z)
    return undefined
  return out
}

/**
 * True when the column above a frontier cell stays air until the read's edge.
 *
 * A solid block inside the window proves a ceiling; a missing cell is outside
 * the read (unknown), which does not prove one. Used to keep local frontiers
 * out of cave interiors (R4 cave-diag-03).
 */
function openToSky(cells: Map<string, string>, x: number, fromY: number, z: number): boolean {
  for (let y = fromY; ; y++) {
    const id = cells.get(`${x},${y},${z}`)
    if (id === undefined)
      return true
    if (!isAir(id))
      return false
  }
}

/**
 * Finds the air band the glider descends into, scanning DOWN from its altitude.
 *
 * ROOT CAUSE (live, 2026-09-18): scanning up from the bottom of the column found
 * the *lowest* air run, which in this world is a subterranean cave — a route
 * planned with `band=15` while the river ran at 62, i.e. straight into the
 * ground. Descending from the glider's own altitude instead finds the first
 * ground below it, and the ceiling above that ground is the roof it must fly
 * under: a slab over a channel becomes a passage (`surface 62, ceiling 75,
 * clearance 12`), and a cave under that ground is never a candidate because the
 * scan stops at the surface.
 *
 * @example
 * // water at 62, open sky, glider at 74
 * slotInColumn(entries, { startY: 74, bottomY: 50, topY: 82 })
 * // => { surface: 62, clearance: 20, bandY: 64 }
 */
export function slotInColumn(column: SnapshotEntry[], options: {
  /** Altitude the scan starts from: the glider's own level, or the goal's. */
  startY: number
  bottomY: number
  topY: number
  minClearance?: number
}): { surface: number, ceiling?: number, clearance: number, bandY: number } | undefined {
  const minClearance = options.minClearance ?? LOW_ROUTE_MIN_CLEARANCE
  const byY = new Map<number, string>()
  for (const entry of column) byY.set(entry.y, entry.id)
  const top = Math.min(options.topY, options.startY)

  // A solid block at the entry altitude is a wall: the glider cannot descend
  // into this column at all, and the route has to go around or stop.
  let y = top
  let airBottom: number | undefined
  while (y >= options.bottomY) {
    const id = byY.get(y)
    // An unread cell is not air: a slot may only be claimed from blocks that
    // were actually read (CD-0: unknown is not free space).
    if (id === undefined)
      return undefined
    if (!isAir(id))
      break
    airBottom = y
    y--
  }
  if (airBottom === undefined || y < options.bottomY)
    return undefined
  const surface = y

  // The ceiling is the first solid above the air the glider is descending into.
  let ceiling: number | undefined
  for (let up = airBottom + 1; up <= options.topY; up++) {
    const id = byY.get(up)
    if (id === undefined)
      return undefined
    if (!isAir(id)) {
      ceiling = up
      break
    }
  }
  const clearance = (ceiling ?? options.topY + 1) - surface - 1
  if (clearance < minClearance)
    return undefined
  // Fly two blocks above the floor, never so high that the ceiling is closer
  // than the required clearance.
  const bandY = ceiling === undefined
    ? surface + 2
    : Math.min(surface + 2, ceiling - minClearance)
  return { surface, ...(ceiling !== undefined ? { ceiling } : {}), clearance: Math.min(clearance, options.topY - surface), bandY }
}

/**
 * Samples the columns of one segment and keeps the flyable ones.
 *
 * @example
 * // flat ground at y=64 with open sky: every sampled column is a candidate
 * candidatesOfSegment(entries, { x: 0, z: 0 }, { dirX: 0, dirZ: 1 }, 64).length
 * // => 24
 */
export function candidatesOfSegment(
  entries: SnapshotEntry[],
  origin: { x: number, z: number },
  direction: { dirX: number, dirZ: number },
  options: {
    /** Vertical window the slot scan may use, already absolute. */
    bottomY: number
    topY: number
    /** Altitude the per-column scan starts from (the glider's own level). */
    startY: number
    step?: number
    halfWidth?: number
    minClearance?: number
  },
): LowRoutePoint[] {
  const step = options.step ?? LOW_ROUTE_STEP
  const halfWidth = options.halfWidth ?? LOW_ROUTE_HALF_WIDTH
  const minClearance = options.minClearance ?? LOW_ROUTE_MIN_CLEARANCE
  const byColumn = new Map<string, SnapshotEntry[]>()
  for (const entry of entries) {
    const key = `${entry.x},${entry.z}`
    const list = byColumn.get(key) ?? []
    list.push(entry)
    byColumn.set(key, list)
  }
  const points: LowRoutePoint[] = []
  const laterals: number[] = [0]
  for (let offset = 1; offset <= halfWidth; offset++) {
    laterals.push(offset, -offset)
  }
  for (let ahead = step; ahead <= LOW_ROUTE_SEGMENT; ahead += step) {
    for (const lateral of laterals) {
      const x = Math.floor(origin.x + direction.dirX * ahead - direction.dirZ * lateral)
      const z = Math.floor(origin.z + direction.dirZ * ahead + direction.dirX * lateral)
      const column = byColumn.get(`${x},${z}`)
      if (!column || column.length === 0)
        continue
      const slot = slotInColumn(column, { startY: options.startY, bottomY: options.bottomY, topY: options.topY, minClearance })
      if (!slot)
        continue
      points.push({
        ahead,
        lateral,
        x,
        z,
        surface: slot.surface,
        ...(slot.ceiling !== undefined ? { ceiling: slot.ceiling } : {}),
        clearance: slot.clearance,
        bandY: slot.bandY,
      })
    }
  }
  return points
}

/**
 * Walks the sampled candidates outward and returns the line to fly.
 *
 * Continuity beats altitude: the next column must not force a *climb* of more
 * than {@link LOW_ROUTE_BAND_STEP} blocks nor a *drop* of more than
 * {@link LOW_ROUTE_DESCENT_STEP}, because a climb turns a valley into a wall and
 * a cliff-drop turns it into a hole. The walk stops at the first step with no
 * candidate, and the caller flies the last good column.
 */
export const LOW_ROUTE_BAND_STEP = 6
/**
 * Steepest band drop one step may take.
 *
 * A glider loses height while covering ground; dropping 50 blocks inside four
 * blocks of travel is a dive, not a route, and accepting it is how the planner
 * picked a subterranean cave 50 blocks under the valley (live 2026-09-18).
 */
export const LOW_ROUTE_DESCENT_STEP = 8
/**
 * Drop allowed when the trip first joins the route.
 *
 * Joining is a dive, not a route step: a glider that has already climbed to 130
 * may still take the valley at 64 in one go (E-01 measured −1.66 blocks/tick of
 * sink in a dive). Only the steps *after* the join are held to the glide slope.
 */
export const LOW_ROUTE_JOIN_DROP = 96

/**
 * Walks the candidate slots along the bearing, accepting only laterally
 * connected steps.
 *
 * ROOT CAUSE (user review, 2026-09-19): the walk was purely greedy — it picked
 * the candidate closest to the current band and accepted it if the band delta
 * was within the climb/descent limits, with NO check that the air pocket
 * extends between consecutive points. Underground caves at the goal's altitude
 * were accepted as valid steps even though they are sealed from the surface
 * and lead nowhere near the goal.
 *
 * The fix: before accepting a candidate, verify that the candidate's column
 * has air at the current band altitude (the air pocket continues into this
 * column). If no candidate at a step is both within band limits AND
 * laterally connected, the walk stops — the route ends at the last connected
 * point instead of wandering through disconnected pockets.
 */
export function walkLowRoute(input: {
  points: LowRoutePoint[]
  span: number
  step: number
  startBandY: number
  /**
   * Column data for lateral connectivity checks. Key: `x,z`, value: the
   * column's entries. Built by the caller from the segment reads.
   */
  columns?: Map<string, SnapshotEntry[]>
}): { waypoint?: Vec3, bandY?: number, reached: number, accepted: LowRoutePoint[] } {
  const accepted: LowRoutePoint[] = []
  let bandY = input.startBandY
  let blocked = false

  const hasAirAt = (x: number, z: number, y: number): boolean => {
    if (!input.columns)
      return true // no column data = no check (unit tests without reads)
    const column = input.columns.get(`${x},${z}`)
    if (!column)
      return false // unread column = unknown = not connected (CD-0)
    const entry = column.find(e => e.y === y)
    if (!entry)
      return false
    return isAir(entry.id)
  }

  for (let ahead = input.step; ahead <= input.span; ahead += input.step) {
    const atStep = input.points.filter(point => point.ahead === ahead)
    if (atStep.length === 0) {
      blocked = true
      break
    }
    // Try candidates in band-proximity order; accept the first that is both
    // within the band limits AND laterally connected at the current band.
    const descentLimit = accepted.length === 0 ? LOW_ROUTE_JOIN_DROP : LOW_ROUTE_DESCENT_STEP
    const sorted = atStep
      .slice()
      .sort((a, b) => {
        const bandDelta = Math.abs(a.bandY - bandY) - Math.abs(b.bandY - bandY)
        if (bandDelta !== 0)
          return bandDelta
        return Math.abs(a.lateral) - Math.abs(b.lateral)
      })
    let chosen: LowRoutePoint | undefined
    for (const candidate of sorted) {
      if (candidate.bandY - bandY > LOW_ROUTE_BAND_STEP || bandY - candidate.bandY > descentLimit)
        continue
      // Lateral connectivity: the candidate's column must have air at the
      // current band altitude — the pocket continues into this column, it is
      // not a separate sealed cave that merely shares the altitude.
      if (accepted.length > 0 && !hasAirAt(candidate.x, candidate.z, bandY))
        continue
      chosen = candidate
      break
    }
    if (!chosen) {
      blocked = true
      break
    }
    accepted.push(chosen)
    bandY = chosen.bandY
  }
  if (accepted.length === 0)
    return { reached: 0, accepted, ...(blocked ? {} : { waypoint: undefined }) }
  const last = accepted[accepted.length - 1]!
  return {
    waypoint: { x: last.x + 0.5, y: last.bandY, z: last.z + 0.5 },
    bandY,
    reached: last.ahead,
    accepted,
  }
}

/**
 * Reads a bounded set of segment slabs along the heading and plans the low route.
 *
 * Six 16-block segments cover {@link LOW_ROUTE_SPAN}; each slab is read with the
 * full vertical window so a slot, its ceiling and the sky above it come from one
 * call (a diagonal heading widens the box, which is why the segment is short).
 *
 * @example
 * const plan = await planLowRoute({ port, self, goal })
 * // => { status: 'planned', waypoint: { x, y, z }, bandY, reached: 96, points: [...] }
 */
/** One connectable end-of-read-window cell the route could aim at. */
interface FrontierCandidate {
  point: Vec3
  /** Block progress along the bearing. */
  progress: number
  /** Distance from the bearing line, blocks. */
  offRay: number
  /** No ceiling inside the read window above this cell. */
  openSky: boolean
}

/** How many frontier candidates get their own bounded search. */
const FRONTIER_CANDIDATES_MAX = 8
/** How many of them are actually searched when the direct scores are poor. */
const FRONTIER_SEARCHES_MAX = 4
/** Minimum horizontal separation between compared candidates, blocks. */
const FRONTIER_MIN_SEPARATION = 8

/**
 * Collects the frontier candidates inside the read window: air at the cell
 * and above it, body-box clear, and (when required) open to the sky. Cells
 * above the read edge are unknown, not proof of a ceiling, and a ceilinged
 * channel is a legitimate fallback when no open candidate exists.
 */
function collectFrontierCandidates(input: {
  cells: Map<string, string>
  cellsByY: Map<number, Array<[number, number]>>
  goalY: number
  self: Vec3
  dirX: number
  dirZ: number
  requiredOpenSky: boolean
}): FrontierCandidate[] {
  const found: FrontierCandidate[] = []
  for (let y = input.goalY - 8; y <= input.goalY + 16; y++) {
    const cellsAtLayer = input.cellsByY.get(y)
    if (cellsAtLayer === undefined)
      continue
    for (const [x, z] of cellsAtLayer) {
      if (!isAir(input.cells.get(`${x},${y},${z}`)))
        continue
      if (!isAir(input.cells.get(`${x},${y + 1},${z}`)))
        continue
      // The frontier must be flyable by the body box, not just air at the
      // cell: a frontier one cell from a wall would start the next leg in a
      // collision (R4 cave-diag-07).
      if (!bodyFootprintClear(input.cells, x, y, z))
        continue
      const openSky = openToSky(input.cells, x, y + 2, z)
      if (input.requiredOpenSky && !openSky)
        continue
      const rx = x + 0.5 - input.self.x
      const rz = z + 0.5 - input.self.z
      found.push({
        point: { x: x + 0.5, y: y + 0.5, z: z + 0.5 },
        progress: rx * input.dirX + rz * input.dirZ,
        offRay: Math.abs(rx * input.dirZ - rz * input.dirX),
        openSky,
      })
    }
  }
  return found
}

/**
 * Steepest positive climb on a path: dy per horizontal block, 0 when the path
 * only descends or levels. The glide cannot hover-climb, and a route that
 * needs a steep climb must be traded against a wider-window alternative
 * (R4 cave-diag-08/10/12).
 */
function maxClimbSlopeOf(path: Vec3[]): number {
  let steepest = 0
  for (let index = 1; index < path.length; index++) {
    const previous = path[index - 1]!
    const point = path[index]!
    const horizontal = Math.hypot(point.x - previous.x, point.z - previous.z)
    const climb = point.y - previous.y
    if (horizontal > 0.01 && climb > 0)
      steepest = Math.max(steepest, climb / horizontal)
  }
  return Number(steepest.toFixed(3))
}

/** Total height gained on a path, in blocks. */
function climbTotalOf(path: Vec3[]): number {
  let total = 0
  for (let index = 1; index < path.length; index++) {
    const climb = path[index]!.y - path[index - 1]!.y
    if (climb > 0)
      total += climb
  }
  return Number(total.toFixed(2))
}

export async function planLowRoute(input: {
  port: MovementControlPort
  self: Vec3
  goal: Vec3
  span?: number
  halfWidth?: number
  readBudget?: number
  /** Wall-clock cap for one space search, ms (default 2000). */
  searchTimeCapMs?: number
  /** Blocks below the lower of goal/self the read window reaches. */
  windowDown?: number
  /** Blocks above the higher of goal/self the read window reaches. */
  windowUp?: number
  /**
   * Spheres the route must treat as solid (R3).
   *
   * The client's fresh collision view can reject a region the host's map read
   * believed free; feeding that rejection back as an exclusion makes the
   * replan route around what the flight actually proved unflyable instead of
   * resubmitting the same corridor.
   */
  exclude?: Array<{ position: Vec3, radius: number }>
  /**
   * Unit direction (x,z) for the read window and frontier progress, when the
   * route should follow the glider's own corridor instead of the straight goal
   * bearing. The E-02 canyon bends ~25° from the goal bearing; the straight
   * window then contains only the bank, and the route climbs it (R4
   * cave-diag-08/10: the glider reached 70.8 at the bank face and the client
   * rejected every candidate).
   */
  bearing?: { x: number, z: number }
  /**
   * Openings the route must actually fly through, in order (ab-30 plan §1).
   *
   * When set, an open-sky frontier candidate no longer preempts a
   * ceiling-covered one: candidates are ranked by whether their channel path
   * crosses the next section's rectangle, and a plan whose best candidate
   * misses it is refused with `no_section_path` instead of silently falling
   * back to a bank-top route (low-route.ts frontier selection).
   */
  mustPass?: FlightCrossSection[]
  /**
   * Underside of a known roof above the goal, as probed by the client.
   *
   * NOTICE: accepted but not yet applied to planning. The field used to be
   * missing from this type, so TypeScript's spread-based call dropped it
   * silently and the client believed a roof constraint was in force. The
   * window-cap experiment (yMax = roofY - 1) refused the synthetic plan, so the
   * cap is deferred to the ab-30 plan §2 read-ahead/roof design instead of
   * shipping an unverified behavior change.
   */
  roofY?: number
  /**
   * Horizontal cruise speed in blocks/tick, used to size the read-ahead a
   * must-pass section needs. Defaults to the glider cruise (~1.6) when the
   * caller has no measurement yet.
   */
  speed?: number
}): Promise<LowRoutePlan> {
  const defaultSpan = input.span ?? LOW_ROUTE_SPAN
  // The route never extends past the goal: a span beyond the target reads
  // space past it and planned waypoints pulled the glider through and past
  // the goal (live 2026-09-19, E-02 canyon).
  let span = Math.min(defaultSpan, Math.hypot(input.goal.x - input.self.x, input.goal.z - input.self.z))
  const halfWidth = input.halfWidth ?? LOW_ROUTE_HALF_WIDTH
  const readBudget = input.readBudget ?? 128
  const yawRad = input.bearing
    ? Math.atan2(-input.bearing.x, input.bearing.z)
    : Math.atan2(-(input.goal.x - input.self.x), input.goal.z - input.self.z)
  const dirX = -Math.sin(yawRad)
  const dirZ = Math.cos(yawRad)
  // A must-pass section beyond the local span must still be READ: a leg that has
  // to fly it cannot plan a crossing it cannot see, which is why the leg before
  // the obsidian wall reported no_section_path with the plane just outside its
  // window (ab-30 §2 read ahead). The extension is the section's distance along
  // the bearing plus room for its exit and suffix.
  const sectionSpan = (input.mustPass ?? []).reduce((reach, section) => {
    const offset = section.axis === 'x' ? (section.at - input.self.x) : (section.at - input.self.z)
    const direction = section.axis === 'x' ? dirX : dirZ
    if (Math.abs(direction) < 0.2)
      return reach
    return Math.max(reach, Math.max(0, offset / direction) + 24)
  }, 0)
  span = Math.max(span, sectionSpan)

  /**
   * The read window is anchored to the GOAL's own altitude (user insight,
   * 2026-09-19) with climb and dive allowance on both sides, and the window
   * is CHUNKED per read: widening the lateral box grows the footprint, and a
   * single read under the bridge's 32k cell cap used to respond by cutting
   * layers — which silently dropped the goal layer and turned a planned route
   * into `blocked` (R0 counterexample 2). Chunking keeps every layer; the
   * cost is more reads, bounded by the read budget.
   */
  const yMin = Math.floor(Math.min(input.goal.y, input.self.y)) - (input.windowDown ?? 24)
  const yMax = Math.floor(Math.max(input.goal.y, input.self.y)) + (input.windowUp ?? 32)
  const layers = yMax - yMin + 1
  /**
   * The read window reaches this far past the route span so the body footprint
   * of a cell at the far edge is still fully read. Without the margin the
   * frontier scan and the space search reject every edge cell (their ±1
   * neighbours are unread), and a flat open world reported `blocked`
   * (R4 review: body clearance must not create false refusals).
   */
  const readMargin = 2

  /** Every read cell: key `x,y,z` → id. Air and solids both recorded. */
  const cells = new Map<string, string>()
  /**
   * The same cells grouped by layer. The frontier scan only looks at a few
   * layers; iterating every key and parsing it made the scan dominate the
   * plan on large windows (R4 review: 5 s before the search even started).
   */
  const cellsByY = new Map<number, Array<[number, number]>>()
  let reads = 0
  let readFailed = false
  for (let start = 0; start < span + readMargin; start += LOW_ROUTE_SEGMENT) {
    const near = start
    const far = Math.min(span + readMargin, start + LOW_ROUTE_SEGMENT)
    const xs = [near, far].map(ahead => input.self.x + dirX * ahead)
    const zs = [near, far].map(ahead => input.self.z + dirZ * ahead)
    const x0 = Math.floor(Math.min(...xs) - halfWidth - 1)
    const x1 = Math.floor(Math.max(...xs) + halfWidth + 1)
    const z0 = Math.floor(Math.min(...zs) - halfWidth - 1)
    const z1 = Math.floor(Math.max(...zs) + halfWidth + 1)
    const footprint = (x1 - x0 + 1) * (z1 - z0 + 1)
    const maxLayersPerRead = Math.max(1, Math.floor(LOW_ROUTE_MAX_CELLS / footprint))
    const bands = Math.ceil(layers / maxLayersPerRead)
    for (let band = 0; band < bands; band++) {
      if (reads >= readBudget)
        return { status: 'search_budget', reached: 0, reason: `read budget ${readBudget} exhausted after ${reads} reads`, reads }
      const bandY0 = yMin + band * maxLayersPerRead
      const bandY1 = Math.min(yMax, bandY0 + maxLayersPerRead - 1)
      try {
        const entries = await input.port.getBlocksRegion({ x: x0, y: bandY0, z: z0 }, { x: x1, y: bandY1, z: z1 })
        reads += 1
        for (const entry of entries) {
          const key = `${entry.x},${entry.y},${entry.z}`
          // Read windows overlap: a cell already recorded must not be pushed
          // again, or the layer index grows with duplicates and the frontier
          // scan iterates the same cell several times.
          if (cells.has(key))
            continue
          cells.set(key, entry.id)
          let layer = cellsByY.get(entry.y)
          if (layer === undefined) {
            layer = []
            cellsByY.set(entry.y, layer)
          }
          layer.push([entry.x, entry.z])
        }
      }
      catch {
        // One band's read failing marks the plan degraded; bands that did
        // read still bound the search. An all-failed batch is reported below.
        readFailed = true
      }
    }
  }

  if (cells.size === 0)
    return { status: readFailed ? 'read_failed' : 'blocked', reached: 0, reason: 'no cells read', reads }

  // Exclusions must be stamped only over cells a read actually covered: a
  // sphere over unread space would fabricate knowledge about an unknown
  // region, and unknown is already impassable on its own (CD-0).
  if (input.exclude) {
    for (const blocked of input.exclude) {
      const radius = Math.ceil(blocked.radius)
      for (let dx = -radius; dx <= radius; dx++) {
        for (let dy = -radius; dy <= radius; dy++) {
          for (let dz = -radius; dz <= radius; dz++) {
            if (dx * dx + dy * dy + dz * dz > radius * radius)
              continue
            const key = `${Math.floor(blocked.position.x) + dx},${Math.floor(blocked.position.y) + dy},${Math.floor(blocked.position.z) + dz}`
            if (cells.has(key))
              cells.set(key, 'minecraft:invalidated')
          }
        }
      }
    }
  }

  const goalX = Math.floor(input.goal.x)
  const goalY = Math.floor(input.goal.y)
  const goalZ = Math.floor(input.goal.z)
  const coveredGoal = cells.has(`${goalX},${goalY},${goalZ}`)

  /**
   * Frontier selection for an uncovered goal: the passable cell at the goal's
   * own layer that progressed farthest along the bearing, tie-broken by
   * distance to the bearing line. The goal coordinate only steers the
   * direction; it never claims goal-side terrain (revision doc §4).
   */
  interface ChosenRoute { candidate?: FrontierCandidate, route: Extract<SpaceRoute, { ok: true }>, cost: number, score: number }
  let chosen: ChosenRoute | undefined
  if (!coveredGoal) {
    const openSkyCandidates = collectFrontierCandidates({
      cells,
      cellsByY,
      goalY,
      self: input.self,
      dirX,
      dirZ,
      requiredOpenSky: true,
    })
    // With must-pass sections an open-sky candidate must not preempt a
    // ceiling-covered one: the slab passage is covered, so an open-sky-only
    // pool would keep choosing the bank top (ab-30 plan §1).
    const nextSection = input.mustPass?.[0]
    const candidates = (nextSection === undefined
      ? (openSkyCandidates.length > 0
          ? openSkyCandidates
          : collectFrontierCandidates({
              cells,
              cellsByY,
              goalY,
              self: input.self,
              dirX,
              dirZ,
              requiredOpenSky: false,
            }))
      : collectFrontierCandidates({
          cells,
          cellsByY,
          goalY,
          self: input.self,
          dirX,
          dirZ,
          requiredOpenSky: false,
        }))
      .sort((a, b) => b.progress - a.progress || a.offRay - b.offRay)
    // Greedy thinning for diversity: near-duplicate cells around the same
    // bank top would all be tried and none would offer the river.
    const distinct: FrontierCandidate[] = []
    for (const candidate of candidates) {
      if (distinct.length >= FRONTIER_CANDIDATES_MAX)
        break
      if (distinct.some(chosenCandidate => Math.hypot(chosenCandidate.point.x - candidate.point.x, chosenCandidate.point.z - candidate.point.z) < FRONTIER_MIN_SEPARATION))
        continue
      distinct.push(candidate)
    }
    if (distinct.length === 0)
      return { status: 'blocked', reached: 0, reason: 'no passable cell at the goal layer in covered space', reads, local: true }
    // Score: progress is the objective, the path's own length is not a cost
    // (flying the leg is how progress happens). Walls and height are the
    // penalties, so a level river route beats a bank-top hop even when the
    // hop is shorter (R4 cave-diag-15: leg 2 was again a one-block backward
    // hop because the old score subtracted the leg length).
    const FRONTIER_CLIMB_PENALTY = 3
    const pathLengthOf = (path: Vec3[]): number => {
      let length = 0
      for (let index = 1; index < path.length; index++) {
        const previous = path[index - 1]!
        const point = path[index]!
        length += Math.hypot(point.x - previous.x, point.y - previous.y, point.z - previous.z)
      }
      return length
    }
    const scoreOf = (progress: number, cost: number, path: Vec3[]): number =>
      progress - (cost - pathLengthOf(path)) - climbTotalOf(path) * FRONTIER_CLIMB_PENALTY
    // A candidate whose path actually crosses the next must-pass rectangle
    // outranks any amount of progress along the bearing.
    const SECTION_BONUS = 1_000
    const sectionBonusOf = (path: Vec3[]): number => {
      if (nextSection === undefined)
        return 0
      return crossingOfSection(path, nextSection)?.inside === true ? SECTION_BONUS : 0
    }
    const directCandidates: ChosenRoute[] = []
    const searchCandidates: FrontierCandidate[] = []
    for (const candidate of distinct) {
      if (!channelChordClear(cells, input.self, candidate.point)) {
        searchCandidates.push(candidate)
        continue
      }
      const distance = Math.hypot(candidate.point.x - input.self.x, candidate.point.y - input.self.y, candidate.point.z - input.self.z)
      const climb = Math.max(0, candidate.point.y - input.self.y)
      const cost = distance + climb * 1.2
      const path = [{ ...input.self }, { ...candidate.point }]
      directCandidates.push({
        candidate,
        route: { ok: true, path, expanded: 0 },
        cost,
        score: scoreOf(candidate.progress, cost, path) + sectionBonusOf(path),
      })
    }
    chosen = directCandidates.reduce<ChosenRoute | undefined>((best, entry) => best === undefined || entry.score > best.score ? entry : best, undefined)
    {
      const totalCap = input.searchTimeCapMs ?? 2_000
      const startedAt = Date.now()
      // The farthest-progress candidates are tried first, each with at most
      // half of the remaining budget: a 500 ms slice starved the canyon search
      // and made the level river route lose to a cheap backward hop.
      const searches = searchCandidates.slice(0, FRONTIER_SEARCHES_MAX)
      for (let index = 0; index < searches.length; index++) {
        const candidate = searches[index]!
        const remaining = totalCap - (Date.now() - startedAt)
        if (remaining <= 0)
          break
        const perSearch = Math.max(400, Math.floor(remaining / 2))
        const route = planSpaceRoute({
          cells,
          start: input.self,
          goal: candidate.point,
          clearance: 2,
          timeCapMs: perSearch,
        })
        if (!route.ok)
          continue
        const cost = spaceRouteCost(cells, route.path)
        const terminal = route.path.at(-1)!
        const progress = (terminal.x - 0.5 - input.self.x) * dirX + (terminal.z - 0.5 - input.self.z) * dirZ
        const score = scoreOf(progress, cost, route.path) + sectionBonusOf(route.path)
        if (chosen === undefined || score > chosen.score)
          chosen = { candidate, route, cost, score }
      }
    }
  }
  else {
    const route = planSpaceRoute({
      cells,
      start: input.self,
      goal: input.goal,
      clearance: 2,
      ...(input.searchTimeCapMs !== undefined ? { timeCapMs: input.searchTimeCapMs } : {}),
    })
    if (route.ok)
      chosen = { route, cost: spaceRouteCost(cells, route.path), score: 0 }
  }
  if (chosen === undefined)
    return { status: 'blocked', reached: 0, reason: coveredGoal ? 'no_route' : 'no connectable frontier', reads, local: !coveredGoal }
  // A must-pass section is a hard constraint: delivering a route that misses
  // it would hand the client a plan it cannot fly (ab-30 plan §1). Refuse so
  // the host can widen the read window or exclude the area and replan.
  const mustPassSection = input.mustPass?.[0]
  if (mustPassSection !== undefined) {
    // Refusal telemetry (ab-30 §2): the reason carries where the best route
    // crosses the section plane, so a live run separates "crossed outside the
    // rectangle" (e.g. over the wall) from "no crossing found at all" without a
    // second experiment.
    const crossing = crossingOfSection(chosen.route.path, mustPassSection)
    if (crossing?.inside !== true) {
      const where = crossing === undefined
        ? 'route never crosses the section plane'
        : `crossing at ${crossing.x.toFixed(1)},${crossing.y.toFixed(1)},${crossing.z.toFixed(1)} is outside the rectangle`
      return { status: 'blocked', reached: 0, reason: `no_section_path (${where})`, reads, local: !coveredGoal, expanded: chosen.route.expanded }
    }
  }
  // Entering a must-pass opening needs a visible continuation past it: without
  // a suffix the next replan has nothing to hand over to, and the client holds
  // or climbs inside the opening (ab-30 plan §2).
  if (mustPassSection !== undefined) {
    const suffix = suffixLengthPastSection(chosen.route.path, mustPassSection)
    const required = requiredSuffixBlocks(input.speed ?? FLIGHT_CRUISE_SPEED)
    if (suffix === undefined || suffix < required)
      return { status: 'blocked', reached: 0, reason: 'section_suffix_short', reads, local: !coveredGoal, expanded: chosen.route.expanded }
  }

  const route = chosen.route
  const last = route.path.at(-1)!
  const progress = (last.x - 0.5 - input.self.x) * dirX + (last.z - 0.5 - input.self.z) * dirZ
  const channelPath = channelPathOfVerified(cells, route.path)
  if (channelPath === undefined) {
    // The A* route exists but no verified thinning of it exists: delivering it
    // would break the "every submitted segment passed the body sweep"
    // contract, and delivering the raw path is no better (its adjacent steps
    // were verified cell-wise, not body-wise). Refuse so the host can exclude
    // the area and replan.
    return { status: 'blocked', reached: 0, reason: 'channel_unverified', reads, local: !coveredGoal, expanded: route.expanded }
  }
  return {
    status: 'planned',
    waypoint: { x: last.x, y: Math.floor(last.y), z: last.z },
    bandY: Math.floor(last.y),
    reached: progress,
    path: route.path,
    channelPath,
    // A covered goal ends the trip; a frontier leg is a handover point that the
    // next replan continues from, so the client must not hold on it.
    waypointKind: coveredGoal ? 'stop' : 'through',
    ...(mustPassSection !== undefined
      ? {
          leg: ((): FlightLegPlan => {
            const entry = splitPathAtSection(channelPath, mustPassSection)
            const exit = input.mustPass?.[1]
            if (exit === undefined)
              return { entry: mustPassSection, approach: entry.before, interior: entry.after, suffix: entry.after }
            const afterExit = splitPathAtSection(entry.after, exit)
            return { entry: mustPassSection, approach: entry.before, interior: afterExit.before, exit, suffix: afterExit.after }
          })(),
        }
      : {}),
    maxClimbSlope: maxClimbSlopeOf(channelPath),
    climbTotal: climbTotalOf(channelPath),
    local: !coveredGoal,
    expanded: route.expanded,
    reads,
  }
}
