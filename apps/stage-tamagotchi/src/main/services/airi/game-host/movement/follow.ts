/**
 * Continuous walk runs for the movement executor (review batch 2: R1, R5).
 *
 * A planned path is a list of integer cells. Walking each cell separately made
 * the executor stop at every node, re-aim from a standstill and steer toward
 * corners. This module follows a run of plain walk cells with a lookahead point
 * and a projection cursor: passed nodes are skipped, turns release the sprint
 * early, and only action boundaries stop the input.
 */
import type { MovementControlPort, MovementState } from './port'
import type { MovementConfig, PathStep, Vec3 } from './types'

import { standPointOf } from './coordinates'

/** Length of the consecutive plain-walk run starting at `start`. */
export function walkRunLength(steps: PathStep[], start: number): number {
  let length = 0
  for (let index = start; index < steps.length; index++) {
    const step = steps[index]!
    if (step.parkour || step.toBreak.length > 0 || step.toPlace.length > 0)
      break
    length += 1
  }
  return length
}

/** Standing centers of a step run, in path order. */
export function runCells(steps: PathStep[], start: number, length: number): Vec3[] {
  return steps.slice(start, start + length).map(step => standPointOf({ x: step.x, y: step.y, z: step.z }))
}

const AIM_TOLERANCE_DEG = 7
const STEP_RADIUS = 0.45
const STUCK_WINDOW_POLLS = 12
const STUCK_MIN_MOVE = 0.15
const LOOKAHEAD_MIN = 1
const LOOKAHEAD_MAX = 1.5
const TURN_SPRINT_DEG = 30

export interface WalkRunResult {
  status: 'arrived' | 'stuck' | 'cancelled'
  cursor: number
  position: Vec3
}

/**
 * Follows a run of walk cells continuously.
 *
 * The cursor only moves forward: a node whose outgoing direction lies behind
 * the player is considered passed. `stepTimeoutMs` applies per node advance, so
 * a long run is bounded by its length.
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

    // Lookahead window scales with the measured horizontal speed.
    const speed = state.motion ? Math.hypot(state.motion.x, state.motion.z) * 20 : 0
    const lookahead = Math.min(LOOKAHEAD_MAX, Math.max(LOOKAHEAD_MIN, 0.8 + 0.4 * speed))
    let targetIndex = Math.min(cursor + 1, cells.length - 1)
    for (let index = cursor + 1; index < cells.length; index++) {
      if (horizontalDistance(position, cells[index]!) <= lookahead)
        targetIndex = index
      else break
    }
    const target = cells[targetIndex]!

    // Turn ahead of the target releases the sprint before the corner.
    const previous = cells[targetIndex - 1] ?? target
    const after = cells[targetIndex + 1]
    let turnAhead = false
    if (after) {
      const dirA = { x: Math.sign(target.x - previous.x), z: Math.sign(target.z - previous.z) }
      const dirB = { x: Math.sign(after.x - target.x), z: Math.sign(after.z - target.z) }
      const dot = dirA.x * dirB.x + dirA.z * dirB.z
      turnAhead = dot < Math.cos(TURN_SPRINT_DEG * Math.PI / 180)
    }

    const yaw = yawTo(position, target)
    if (Math.abs(angleDelta(state.yaw, yaw)) > AIM_TOLERANCE_DEG)
      await port.look(yaw, 0)

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
