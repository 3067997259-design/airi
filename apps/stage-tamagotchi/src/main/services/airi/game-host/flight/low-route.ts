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
import type { MovementControlPort } from '../movement/port'
import type { SnapshotEntry } from '../movement/snapshot'
import type { Vec3 } from '../movement/types'

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
/** How close to the waypoint the trip counts as "reached this leg". */
export const LOW_ROUTE_WAYPOINT_REACH = 16

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

export type LowRouteStatus = 'planned' | 'blocked' | 'read_failed'

export interface LowRoutePlan {
  status: LowRouteStatus
  /** Far end of the passable line; absent when nothing was passable. */
  waypoint?: Vec3
  /** Altitude to hold along the route; absent on a refusal. */
  bandY?: number
  /** How far the line got before it stopped, in blocks. */
  reached: number
  /** Columns the walk accepted, nearest first. */
  points: LowRoutePoint[]
}

const isAir = (id: string | undefined): boolean => !id || id === '' || id.endsWith('air')

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
  /** Altitude the scan starts from: the glider's own level, plus its rise. */
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

export function walkLowRoute(input: {
  points: LowRoutePoint[]
  span: number
  step: number
  startBandY: number
}): { waypoint?: Vec3, bandY?: number, reached: number, accepted: LowRoutePoint[] } {
  const accepted: LowRoutePoint[] = []
  let bandY = input.startBandY
  let blocked = false
  for (let ahead = input.step; ahead <= input.span; ahead += input.step) {
    const atStep = input.points.filter(point => point.ahead === ahead)
    if (atStep.length === 0) {
      blocked = true
      break
    }
    // Prefer the candidate closest to the current band, then the straight one.
    const best = atStep
      .slice()
      .sort((a, b) => {
        const bandDelta = Math.abs(a.bandY - bandY) - Math.abs(b.bandY - bandY)
        if (bandDelta !== 0)
          return bandDelta
        return Math.abs(a.lateral) - Math.abs(b.lateral)
      })[0]!
    const descentLimit = accepted.length === 0 ? LOW_ROUTE_JOIN_DROP : LOW_ROUTE_DESCENT_STEP
    if (best.bandY - bandY > LOW_ROUTE_BAND_STEP || bandY - best.bandY > descentLimit) {
      blocked = true
      break
    }
    accepted.push(best)
    bandY = best.bandY
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
export async function planLowRoute(input: {
  port: MovementControlPort
  self: Vec3
  goal: Vec3
  span?: number
  step?: number
  halfWidth?: number
  minClearance?: number
  drop?: number
  rise?: number
}): Promise<LowRoutePlan> {
  const span = input.span ?? LOW_ROUTE_SPAN
  const step = input.step ?? LOW_ROUTE_STEP
  const halfWidth = input.halfWidth ?? LOW_ROUTE_HALF_WIDTH
  const minClearance = input.minClearance ?? LOW_ROUTE_MIN_CLEARANCE
  const drop = input.drop ?? LOW_ROUTE_DROP
  const rise = input.rise ?? LOW_ROUTE_RISE
  const yawRad = Math.atan2(-(input.goal.x - input.self.x), input.goal.z - input.self.z)
  const dirX = -Math.sin(yawRad)
  const dirZ = Math.cos(yawRad)
  const centerY = Math.floor(input.self.y)
  const topY = centerY + rise
  /**
   * The vertical window follows the read's own footprint.
   *
   * ROOT CAUSE (live, 2026-09-18): the window was a fixed altitude-relative drop,
   * so once a run had climbed, the valley floor fell outside it, no low slot was
   * found, and the route locked onto the cliff top it *could* see — band 109 while
   * the river ran at 62 — and kept climbing to y=173, 260 blocks short. The drop
   * is now wide (80) and the footprint decides how much of it fits under the
   * bridge's cell cap, so a diagonal heading automatically reads fewer layers.
   */
  const bottomOf = (footprint: number): number => {
    const layers = Math.max(8, Math.floor(LOW_ROUTE_MAX_CELLS / Math.max(1, footprint)))
    return Math.max(centerY - drop, topY - layers + 1)
  }

  const points: LowRoutePoint[] = []
  let readFailed = false
  for (let start = 0; start < span; start += LOW_ROUTE_SEGMENT) {
    const near = start
    const far = Math.min(span, start + LOW_ROUTE_SEGMENT)
    const xs = [near, far].map(ahead => input.self.x + dirX * ahead)
    const zs = [near, far].map(ahead => input.self.z + dirZ * ahead)
    const from = {
      x: Math.floor(Math.min(...xs) - halfWidth - 1),
      y: 0,
      z: Math.floor(Math.min(...zs) - halfWidth - 1),
    }
    const to = {
      x: Math.floor(Math.max(...xs) + halfWidth + 1),
      y: topY,
      z: Math.floor(Math.max(...zs) + halfWidth + 1),
    }
    const footprint = (to.x - from.x + 1) * (to.z - from.z + 1)
    from.y = bottomOf(footprint)
    let entries: SnapshotEntry[]
    try {
      entries = await input.port.getBlocksRegion(from, to)
    }
    catch {
      readFailed = true
      continue
    }
    const origin = { x: input.self.x + dirX * near, z: input.self.z + dirZ * near }
    const segment = candidatesOfSegment(entries, origin, { dirX, dirZ }, {
      bottomY: from.y,
      topY,
      startY: centerY,
      step,
      halfWidth,
      minClearance,
    })
    // The segment's own `ahead` values start at `step`; shift them onto the route.
    for (const point of segment)
      points.push({ ...point, ahead: point.ahead + near })
  }

  if (points.length === 0)
    return { status: readFailed ? 'read_failed' : 'blocked', reached: 0, points: [] }

  const walk = walkLowRoute({ points, span, step, startBandY: centerY })
  if (!walk.waypoint)
    return { status: 'blocked', reached: walk.reached, points: walk.accepted }
  return { status: 'planned', waypoint: walk.waypoint, bandY: walk.bandY, reached: walk.reached, points: walk.accepted }
}
