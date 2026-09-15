/**
 * Continuous walk runs for the movement executor (review batch 2: R1, R5;
 * correctness batch CD-G1: D1, D2, D3, D7).
 *
 * A planned path is a list of integer cells. Walking each cell separately made
 * the executor stop at every node, re-aim from a standstill and steer toward
 * corners. This module follows a run of plain level walk cells with a
 * distance-based lookahead point and a projection cursor: passed nodes are
 * skipped, the first unreached bend is visited before steering across it, and
 * turns release the sprint using normalized segment directions.
 *
 * A run only contains plain level walk edges. Any height change, break/place
 * action or parkour edge is an action boundary the executor handles separately,
 * because the run controller never jumps or interacts (CD-G1 D1).
 */
import type { MovementControlPort, MovementState } from './port'
import type { MovementConfig, MovementMotionKind, PathStep, Vec3 } from './types'

import { standPointOf } from './coordinates'
import { clamp } from './geometry'

/** Motions a continuous run may contain without an action boundary. */
const CONTINUOUS_MOTIONS: ReadonlySet<MovementMotionKind> = new Set<MovementMotionKind>(['walk'])

/**
 * Classifies one edge from its action flags, height change and known support
 * heights.
 *
 * `motion` wins when the generator wrote it. Otherwise break/place/use is an
 * interaction, parkour is a parkour edge, and the rest follows the real rise
 * between the source and destination supports. A rise above a half block is a
 * `jump-up`: the run controller must not walk into it as if it were flat.
 *
 * @example
 * classifyWalkMotion(step({ x: 0, y: 1, z: 0 }, { x: 1, y: 2, z: 0 }))
 * // => 'jump-up'
 */
export function classifyWalkMotion(step: PathStep): MovementMotionKind {
  if (step.motion)
    return step.motion
  if (step.parkour)
    return 'parkour'
  if (step.toBreak.length > 0 || step.toPlace.length > 0)
    return 'interaction'
  const rise = (step.supportHeight ?? step.y) - (step.fromSupportHeight ?? step.from.y)
  if (rise <= -0.01)
    return 'fall'
  if (rise <= 0.01)
    return 'walk'
  return rise <= 0.6 ? 'step-up' : 'jump-up'
}

/**
 * Length of the consecutive continuous-walk run starting at `start`.
 *
 * A full-block ascent, a drop, a break/place/use action or a parkour edge ends
 * the run at that edge, so the executor can perform the boundary action before
 * the next run (CD-G1 D1).
 */
export function walkRunLength(steps: PathStep[], start: number): number {
  let length = 0
  for (let index = start; index < steps.length; index++) {
    if (!CONTINUOUS_MOTIONS.has(classifyWalkMotion(steps[index]!)))
      break
    length += 1
  }
  return length
}

/** Standing centers of a step run, in path order. */
export function runCells(steps: PathStep[], start: number, length: number): Vec3[] {
  return steps.slice(start, start + length).map(step => standPointOf({ x: step.x, y: step.y, z: step.z }, step.supportHeight))
}

/**
 * The path step whose edge the run failed to traverse.
 *
 * `runWalkRun` returns the index of the last passed run cell; the failed edge
 * is the step out of that cell, not the run start (CD-G1 D7). The index is
 * clamped so a stuck final arrival reports the last edge.
 *
 * @example
 * failedRunStep(steps, 4, 0)
 * // => steps[4] (the first edge of the run, not the run's last node)
 */
export function failedRunStep(steps: PathStep[], runStart: number, cursor: number): PathStep {
  return steps[Math.min(runStart + cursor, steps.length - 1)]!
}

const AIM_TOLERANCE_DEG = 7
const STEP_RADIUS = 0.45
const STUCK_WINDOW_POLLS = 12
const STUCK_MIN_MOVE = 0.15
const LOOKAHEAD_MIN = 1
const LOOKAHEAD_MAX = 3
const TURN_SPRINT_DEG = 30
/** A turn wider than this is an acquisition, so the view snaps to the bearing. */
const LARGE_TURN_DEG = 45
/** Small view corrections move at most this many degrees per poll. */
const MAX_YAW_RATE_DEG = 20

export interface WalkRunResult {
  status: 'arrived' | 'stuck' | 'cancelled'
  cursor: number
  position: Vec3
}

/**
 * Follows a run of walk cells continuously.
 *
 * The cursor only moves forward: a node whose outgoing direction lies behind
 * the player is considered passed. The steering target is the farthest run node
 * within the lookahead distance, starting from the first unreached node, so a
 * bend is visited before the controller steers across unchecked space. Sprint
 * is released before any bend in the lookahead window, using normalized segment
 * directions (CD-G1 D2, D3). `stepTimeoutMs` applies per node advance, so a
 * long run is bounded by its length.
 */
export async function runWalkRun(options: {
  port: MovementControlPort
  cells: Vec3[]
  config: MovementConfig
  shouldStop: () => boolean
  sleep: (ms: number) => Promise<void>
  now: () => number
  tickMs: number
  stepTimeoutMs: number
}): Promise<WalkRunResult> {
  const { port, cells, config, shouldStop, sleep, now, tickMs, stepTimeoutMs } = options
  const last = cells[cells.length - 1]!
  let cursor = 0
  let position: Vec3 = cells[0]!
  let lastAdvanceAt = now()
  const recent: Vec3[] = []

  for (;;) {
    if (shouldStop())
      return { status: 'cancelled', cursor, position }
    const state: MovementState = await port.getState()
    position = state.position

    while (cursor < cells.length - 1) {
      const a = cells[cursor]!
      const b = cells[cursor + 1]!
      const abx = b.x - a.x
      const abz = b.z - a.z
      const apx = position.x - a.x
      const apz = position.z - a.z
      if (abx * apx + abz * apz <= 0)
        break
      cursor += 1
      lastAdvanceAt = now()
    }

    if (cursor >= cells.length - 1 && horizontalDistance(position, last) <= STEP_RADIUS && Math.abs(position.y - last.y) <= 0.8)
      return { status: 'arrived', cursor, position }
    if (now() - lastAdvanceAt > stepTimeoutMs)
      return { status: 'stuck', cursor, position }

    // Lookahead window scales with the measured horizontal speed. The target is
    // the farthest node already inside the window; starting at `cursor` keeps
    // an unreached bend in front of the controller instead of skipping it.
    const speed = state.motion ? Math.hypot(state.motion.x, state.motion.z) * 20 : 0
    const lookahead = clamp(0.8 + 0.4 * speed, LOOKAHEAD_MIN, LOOKAHEAD_MAX)
    const targetIndex = lookaheadTargetIndex(cells, cursor, position, lookahead)
    const target = cells[targetIndex]!

    // A bend anywhere in the lookahead window releases the sprint early. The
    // directions are normalized, so a 45-degree corner is detected regardless
    // of the segment lengths (CD-G1 D3).
    const turnAhead = turnAheadWithin(cells, cursor, targetIndex, position)

    const yaw = yawTo(position, target)
    const yawDelta = angleDelta(state.yaw, yaw)
    if (Math.abs(yawDelta) > AIM_TOLERANCE_DEG) {
      // A large error is a fresh bearing and is applied directly; small
      // corrections move at a bounded rate so the view does not snap around
      // while the player keeps moving.
      const applied = Math.abs(yawDelta) > LARGE_TURN_DEG
        ? yawDelta
        : clamp(yawDelta, -MAX_YAW_RATE_DEG, MAX_YAW_RATE_DEG)
      await port.look(state.yaw + applied, 0)
    }

    await port.setInput({
      forward: true,
      sprint: config.allowSprinting && !turnAhead && targetIndex < cells.length - 1,
      jump: state.inWater,
    })

    recent.push({ ...position })
    if (recent.length > STUCK_WINDOW_POLLS) {
      recent.shift()
      const oldest = recent[0]!
      if (horizontalDistance(oldest, position) < STUCK_MIN_MOVE)
        return { status: 'stuck', cursor, position }
    }
    await sleep(tickMs)
  }
}

/** Farthest node within `lookahead` of `position`, never before `cursor`. */
function lookaheadTargetIndex(cells: Vec3[], cursor: number, position: Vec3, lookahead: number): number {
  let target = cursor
  for (let index = cursor + 1; index < cells.length; index++) {
    if (horizontalDistance(position, cells[index]!) <= lookahead)
      target = index
    else break
  }
  return target
}

/**
 * True when any two consecutive directions in the local window form a bend.
 *
 * The window starts at the current heading (player to the first cell) and runs
 * through the segment leaving the steering target, so the first bend after the
 * target is still detected.
 */
function turnAheadWithin(cells: Vec3[], cursor: number, targetIndex: number, position: Vec3): boolean {
  const directions: Array<{ x: number, z: number }> = []
  const first = cells[cursor]
  if (first) {
    const heading = directionBetween(position, first)
    if (heading)
      directions.push(heading)
  }
  // One segment past the steering target is included: the sprint must already
  // be released when the first bend sits just beyond the lookahead point.
  for (let index = cursor; index <= targetIndex + 1 && index + 1 < cells.length; index++) {
    const direction = directionBetween(cells[index]!, cells[index + 1]!)
    if (direction)
      directions.push(direction)
  }
  const cosThreshold = Math.cos(TURN_SPRINT_DEG * Math.PI / 180)
  for (let index = 1; index < directions.length; index++) {
    const previous = directions[index - 1]!
    const current = directions[index]!
    if (previous.x * current.x + previous.z * current.z < cosThreshold)
      return true
  }
  return false
}

/** Unit horizontal direction, or undefined when the points coincide. */
function directionBetween(from: Vec3, to: Vec3): { x: number, z: number } | undefined {
  const dx = to.x - from.x
  const dz = to.z - from.z
  const length = Math.hypot(dx, dz)
  if (length < 1e-9)
    return undefined
  return { x: dx / length, z: dz / length }
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

function horizontalDistance(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.z - b.z)
}
