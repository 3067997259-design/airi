/**
 * Shape-driven movement corridors (CD-G2).
 *
 * A planned path is a list of integer cells. Before a run of plain walk cells
 * is followed continuously, this module sweeps the player box along the
 * candidate centerline and verifies support and headroom for the whole run
 * using the block collision shapes from the current game state. Verified cells
 * become an arc-length parameterized centerline `P(s)`; the follower keeps a
 * local projection window so a U-turn cannot project onto its other arm, and a
 * lookahead target that truncates at the next bend.
 *
 * When any cell on the candidate is unknown or the sweep fails, the caller
 * keeps the existing discrete action path. Smoothness is never traded for
 * collision safety.
 */
import type { MovementControlPort } from './port'
import type { BlockInfo, BlockSource, MovementConfig, PathStep, Vec3 } from './types'

import { classifyWalkMotion, runCells } from './follow'
import { clamp, horizontalDistance } from './geometry'

/** Player collision footprint, matching the vanilla standing box. */
const PLAYER_HALF_WIDTH = 0.3
const PLAYER_HEIGHT = 1.8
/** A rise up to this height is a step the player can walk up without a jump. */
const STEP_UP_TOLERANCE = 0.6
/** A drop up to this height keeps the feet on the support below. */
const SUPPORT_DROP_TOLERANCE = 1.2
/** Sampling resolution of the sweep along one segment, in blocks. */
const SWEEP_SAMPLE = 0.2
/** A direction change wider than this is a bend the lookahead must respect. */
const BEND_DEG = 15

export interface Aabb {
  min: Vec3
  max: Vec3
}

export interface SweepResult {
  verified: boolean
  reason?: 'unsupported' | 'no-headroom' | 'unknown'
  at?: Vec3
}

/** World-space collision boxes of one block, derived when the source sent none. */
export function collisionBoxesOf(block: BlockInfo): Aabb[] {
  if (block.collision)
    return block.collision.map(box => worldBox(block, box))
  if (block.physical)
    return [worldBox(block, { minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 })]
  // Slabs, stairs and carpets are not full cubes but still collide. The derived
  // box is the lower part up to the classified top; the exact shape of a top
  // slab or stair step needs the source's collision data.
  if (block.safe && block.height > block.y + 0.01) {
    const maxY = clamp(block.height - block.y, 0, 1)
    return [worldBox(block, { minX: 0, minY: 0, minZ: 0, maxX: 1, maxY, maxZ: 1 })]
  }
  return []
}

function worldBox(block: BlockInfo, box: { minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number }): Aabb {
  return {
    min: { x: block.x + box.minX, y: block.y + box.minY, z: block.z + box.minZ },
    max: { x: block.x + box.maxX, y: block.y + box.maxY, z: block.z + box.maxZ },
  }
}

/** Player AABB for a foot position. */
export function playerBox(foot: Vec3): Aabb {
  return {
    min: { x: foot.x - PLAYER_HALF_WIDTH, y: foot.y, z: foot.z - PLAYER_HALF_WIDTH },
    max: { x: foot.x + PLAYER_HALF_WIDTH, y: foot.y + PLAYER_HEIGHT, z: foot.z + PLAYER_HALF_WIDTH },
  }
}

function overlapsXZ(a: Aabb, b: Aabb): boolean {
  return a.min.x < b.max.x - 1e-6 && a.max.x > b.min.x + 1e-6
    && a.min.z < b.max.z - 1e-6 && a.max.z > b.min.z + 1e-6
}

/**
 * Sweeps the player box along one straight segment.
 *
 * Every sample must have a support top within the step/drop tolerance and no
 * block inside the body interval above the step height. A cell the read did not
 * cover stops the sweep as `unknown` (never air).
 */
export function sweepWalkSegment(from: Vec3, to: Vec3, world: BlockSource, _config: MovementConfig): SweepResult {
  const distance = horizontalDistance(from, to)
  const samples = Math.max(1, Math.ceil(distance / SWEEP_SAMPLE))
  for (let index = 0; index <= samples; index++) {
    const t = index / samples
    const foot = {
      x: from.x + (to.x - from.x) * t,
      y: from.y + (to.y - from.y) * t,
      z: from.z + (to.z - from.z) * t,
    }
    const result = sampleFoot(foot, world)
    if (!result.verified)
      return result
  }
  return { verified: true }
}

function sampleFoot(foot: Vec3, world: BlockSource): SweepResult {
  const box = playerBox(foot)
  const minX = Math.floor(box.min.x)
  const maxX = Math.floor(box.max.x - 1e-9)
  const minZ = Math.floor(box.min.z)
  const maxZ = Math.floor(box.max.z - 1e-9)
  // The body reaches foot.y + 1.8, so one cell above is enough; scan a little
  // further for a block whose bottom is just above the feet.
  const minY = Math.floor(foot.y) - 1
  const maxY = Math.floor(foot.y) + 3

  let support: number | undefined
  for (let x = minX; x <= maxX; x++) {
    for (let z = minZ; z <= maxZ; z++) {
      for (let y = minY; y <= maxY; y++) {
        const block = world.getBlock(x, y, z)
        if (!block)
          return { verified: false, reason: 'unknown', at: { ...foot } }
        for (const collision of collisionBoxesOf(block)) {
          if (!overlapsXZ(box, collision))
            continue
          const top = collision.max.y
          if (top <= foot.y + STEP_UP_TOLERANCE + 1e-6 && top >= foot.y - SUPPORT_DROP_TOLERANCE && (support === undefined || top > support))
            support = top
          // A block that enters the body above the step height is a ceiling.
          if (collision.max.y > foot.y + STEP_UP_TOLERANCE && collision.min.y < foot.y + PLAYER_HEIGHT - 1e-6)
            return { verified: false, reason: 'no-headroom', at: { ...foot } }
        }
      }
    }
  }
  if (support === undefined || support < foot.y - SUPPORT_DROP_TOLERANCE || support > foot.y + STEP_UP_TOLERANCE)
    return { verified: false, reason: 'unsupported', at: { ...foot } }
  return { verified: true }
}

/**
 * Arc-length parameterized polyline `P(s)`.
 *
 * `cumulative[i]` is the length from the start to `points[i]`; `total` is the
 * length of the whole line.
 */
export interface ArcPath {
  points: Vec3[]
  cumulative: number[]
  total: number
}

export function buildArcPath(points: Vec3[]): ArcPath {
  const copied = points.map(point => ({ ...point }))
  const cumulative = [0]
  for (let index = 1; index < copied.length; index++)
    cumulative.push(cumulative[index - 1]! + distance3(copied[index - 1]!, copied[index]!))
  return { points: copied, cumulative, total: cumulative[cumulative.length - 1] ?? 0 }
}

/** Point at arc length `s`; clamped to the path ends. */
export function pointAt(path: ArcPath, s: number): Vec3 {
  if (path.points.length === 0)
    return { x: 0, y: 0, z: 0 }
  const clamped = clamp(s, 0, path.total)
  for (let index = 1; index < path.points.length; index++) {
    const segmentEnd = path.cumulative[index]!
    if (clamped <= segmentEnd || index === path.points.length - 1) {
      const segmentStart = path.cumulative[index - 1]!
      const length = segmentEnd - segmentStart
      const t = length <= 1e-9 ? 0 : clamp((clamped - segmentStart) / length, 0, 1)
      return lerp(path.points[index - 1]!, path.points[index]!, t)
    }
  }
  return { ...path.points[path.points.length - 1]! }
}

/**
 * Projects a position onto the path inside a local arc-length window.
 *
 * Only segments whose interval intersects `[window.from, window.to]` are
 * considered, so a point near one arm of a U-turn cannot snap to the other arm.
 */
export function projectOnPath(
  path: ArcPath,
  position: Vec3,
  window: { from: number, to: number },
): { s: number, lateral: number } | undefined {
  let best: { s: number, lateral: number } | undefined
  for (let index = 1; index < path.points.length; index++) {
    const segmentStart = path.cumulative[index - 1]!
    const segmentEnd = path.cumulative[index]!
    if (segmentEnd < window.from || segmentStart > window.to)
      continue
    const a = path.points[index - 1]!
    const b = path.points[index]!
    const abx = b.x - a.x
    const abz = b.z - a.z
    const lengthSq = abx * abx + abz * abz
    if (lengthSq <= 1e-12)
      continue
    const t = clamp(((position.x - a.x) * abx + (position.z - a.z) * abz) / lengthSq, 0, 1)
    const s = segmentStart + t * (segmentEnd - segmentStart)
    if (s < window.from - 1e-9 || s > window.to + 1e-9)
      continue
    const projectedX = a.x + abx * t
    const projectedZ = a.z + abz * t
    const lateral = Math.hypot(position.x - projectedX, position.z - projectedZ)
    if (!best || lateral < best.lateral)
      best = { s, lateral }
  }
  return best
}

/**
 * Lookahead point from `sProgress + lookahead`, truncated at the next bend.
 *
 * When a bend sits inside the lookahead window, the target becomes the bend
 * vertex itself so the controller does not cut across the inside of the corner.
 * A vertex closer than `minCornerGap` is skipped: aiming at a point almost
 * under the player collapses the bearing and makes the steering oscillate, so
 * past that point the normal lookahead (already beyond the corner) is used.
 *
 * @example
 * truncatedLookahead(path, 4.9, 2).x
 * // => the normal lookahead point, not the vertex at s = 5
 */
export function truncatedLookahead(path: ArcPath, sProgress: number, lookahead: number, minCornerGap = 0.8): Vec3 {
  for (let index = 1; index < path.points.length - 1; index++) {
    const vertexS = path.cumulative[index]!
    if (vertexS <= sProgress + minCornerGap)
      continue
    if (vertexS > sProgress + lookahead)
      break
    if (isBend(path.points[index - 1]!, path.points[index]!, path.points[index + 1]!))
      return { ...path.points[index]! }
  }
  return pointAt(path, sProgress + lookahead)
}

function isBend(a: Vec3, b: Vec3, c: Vec3): boolean {
  const incoming = horizontalDirection(a, b)
  const outgoing = horizontalDirection(b, c)
  if (!incoming || !outgoing)
    return false
  const dot = incoming.x * outgoing.x + incoming.z * outgoing.z
  return dot < Math.cos(BEND_DEG * Math.PI / 180)
}

function horizontalDirection(from: Vec3, to: Vec3): { x: number, z: number } | undefined {
  const dx = to.x - from.x
  const dz = to.z - from.z
  const length = Math.hypot(dx, dz)
  if (length < 1e-9)
    return undefined
  return { x: dx / length, z: dz / length }
}

/**
 * True when the snapshot carries at least one explicit collision box.
 *
 * The region read currently sends ids and properties but no shapes, so the
 * executor keeps the discrete path until a source provides them. Derived shapes
 * are only used by callers that opted in (tests, shape-aware sources).
 */
export function worldHasCollisionShapes(world: { entries?: Map<string, BlockInfo> }): boolean {
  if (!world.entries)
    return false
  for (const block of world.entries.values()) {
    if (block.collision && block.collision.length > 0)
      return true
  }
  return false
}

/**
 * Number of run cells the follower has passed at arc length `sProgress`.
 *
 * Mirrors the discrete run cursor: passing the first cell is `1`, and the value
 * stays at `steps.length - 1` at the end.
 */
export function stepIndexAtProgress(path: ArcPath, sProgress: number): number {
  let passed = 0
  for (let index = 0; index + 1 < path.points.length; index++) {
    if (path.cumulative[index]! < sProgress)
      passed = index + 1
  }
  return passed
}

export interface BuiltCorridor {
  path: ArcPath
  /** Number of source steps the corridor covers. */
  stepCount: number
}

/**
 * Builds a verified corridor over a run of plain walk steps.
 *
 * Returns `undefined` when the run is shorter than two cells, contains an
 * action boundary, or any sweep fails. The caller then keeps the discrete path.
 */
export function buildCorridor(
  steps: PathStep[],
  start: number,
  length: number,
  world: BlockSource,
  config: MovementConfig,
  debug?: (message: string) => void,
): BuiltCorridor | undefined {
  if (length < 2) {
    debug?.(`corridor rejected: run of ${length} cells`)
    return undefined
  }
  for (let index = start; index < start + length; index++) {
    const kind = classifyWalkMotion(steps[index]!)
    // The corridor sweeps a level band, so it covers level walks and
    // half-block step-ups only. A jump-up (or any other motion) falls back to
    // the continuous run controller, which scripts the jump.
    if (kind !== 'walk' && kind !== 'step-up') {
      const step = steps[index]!
      debug?.(`corridor rejected: ${kind} at ${step.x},${step.y},${step.z}`)
      return undefined
    }
  }
  const points = runCells(steps, start, length)
  for (let index = 1; index < points.length; index++) {
    const sweep = sweepWalkSegment(points[index - 1]!, points[index]!, world, config)
    if (!sweep.verified) {
      const at = sweep.at
      debug?.(`corridor rejected: sweep ${sweep.reason} at ${at ? `${at.x.toFixed(1)},${at.y.toFixed(1)},${at.z.toFixed(1)}` : 'unknown'}`)
      return undefined
    }
  }
  debug?.(`corridor built: ${length} cells`)
  return { path: buildArcPath(points), stepCount: length }
}

export interface CorridorFollowResult {
  status: 'arrived' | 'stuck' | 'cancelled'
  sProgress: number
  position: Vec3
}

const AIM_TOLERANCE_DEG = 7
const DEFAULT_LATERAL_TOLERANCE = 0.6
const STUCK_WINDOW_POLLS = 12
const STUCK_MIN_MOVE = 0.15
/** How far behind the progress point the projection window reaches, in blocks. */
const PROJECTION_BACK = 1.5
/** How far ahead of the progress point the projection window reaches. */
const PROJECTION_AHEAD = 3

/**
 * Follows a verified arc-length corridor.
 *
 * The progress `sProgress` only moves forward and never leaves the path: when
 * the lateral error is too large the follower reports `stuck` so the executor
 * reverts instead of cutting across unchecked space. Sprint is released near
 * the goal, at bends and when the required yaw change is large.
 */
export async function followCorridor(options: {
  port: MovementControlPort
  path: ArcPath
  config: MovementConfig
  shouldStop: () => boolean
  sleep: (ms: number) => Promise<void>
  now: () => number
  tickMs: number
  stepTimeoutMs: number
  lateralTolerance?: number
  debug?: (message: string) => void
}): Promise<CorridorFollowResult> {
  const { port, path, config, shouldStop, sleep, now, tickMs, stepTimeoutMs } = options
  const debug = options.debug
  const lateralTolerance = options.lateralTolerance ?? DEFAULT_LATERAL_TOLERANCE
  let sProgress = 0
  let position: Vec3 = pointAt(path, 0)
  let lastAdvanceAt = now()
  const recent: Vec3[] = []
  let polls = 0

  for (;;) {
    if (shouldStop())
      return { status: 'cancelled', sProgress, position }
    const state = await port.getState()
    position = state.position
    polls += 1

    const projection = projectOnPath(path, position, {
      from: Math.max(0, sProgress - PROJECTION_BACK),
      to: Math.min(path.total, sProgress + PROJECTION_AHEAD),
    })
    if (projection && projection.lateral <= lateralTolerance && projection.s > sProgress) {
      sProgress = projection.s
      lastAdvanceAt = now()
    }

    const endPoint = pointAt(path, path.total)
    const distanceToEnd = horizontalDistance(position, endPoint)
    const remaining = path.total - sProgress
    // Arrival accepts a stop short of the exact end: the approach brake below
    // holds the last fraction of a block, so `sProgress` may never reach total.
    if (sProgress >= path.total - 1 && distanceToEnd <= 0.45) {
      await port.stopMovement()
      return { status: 'arrived', sProgress, position }
    }
    if (now() - lastAdvanceAt > stepTimeoutMs)
      return { status: 'stuck', sProgress, position }

    const speed = state.motion ? Math.hypot(state.motion.x, state.motion.z) * 20 : 0
    // Approach brake: within one reaction step of the end, release the forward
    // key instead of coasting past it. A stopped bot is below the speed floor
    // and walks the remaining gap normally.
    if (sProgress >= path.total - 2 && speed > 0.05 && distanceToEnd <= 0.12 * speed + 0.35) {
      await port.setInput({ forward: false })
      await sleep(tickMs)
      continue
    }
    const lookahead = clamp(0.8 + 0.4 * speed, 1, 3)
    const target = truncatedLookahead(path, sProgress, lookahead)
    const yaw = yawTo(position, target)
    const yawDelta = angleDelta(state.yaw, yaw)
    if (polls % 4 === 1) {
      debug?.(`corridor poll: s=${sProgress.toFixed(2)}/${path.total.toFixed(2)} pos=${position.x.toFixed(2)},${position.y.toFixed(2)},${position.z.toFixed(2)} target=${target.x.toFixed(2)},${target.z.toFixed(2)} yaw=${state.yaw.toFixed(1)} want=${yaw.toFixed(1)} lat=${projection ? projection.lateral.toFixed(2) : 'none'}`)
    }
    if (Math.abs(yawDelta) > AIM_TOLERANCE_DEG)
      await port.look(state.yaw + (Math.abs(yawDelta) > 45 ? yawDelta : clamp(yawDelta, -20, 20)), 0)

    // Sprint stops near the goal and when a large steering change is pending.
    const nearGoal = remaining <= 2
    const steered = Math.abs(yawDelta) > 20
    await port.setInput({
      forward: true,
      sprint: config.allowSprinting && !nearGoal && !steered,
      jump: state.inWater,
    })

    recent.push({ ...position })
    if (recent.length > STUCK_WINDOW_POLLS) {
      recent.shift()
      const oldest = recent[0]!
      if (horizontalDistance(oldest, position) < STUCK_MIN_MOVE)
        return { status: 'stuck', sProgress, position }
    }
    await sleep(tickMs)
  }
}

function distance3(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
}

function lerp(a: Vec3, b: Vec3, t: number): Vec3 {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t }
}

function yawTo(from: Vec3, to: Vec3): number {
  return Math.atan2(-(to.x - from.x), to.z - from.z) * 180 / Math.PI
}

function angleDelta(a: number, b: number): number {
  let delta = (b - a) % 360
  if (delta > 180)
    delta -= 360
  if (delta < -180)
    delta += 360
  return delta
}
