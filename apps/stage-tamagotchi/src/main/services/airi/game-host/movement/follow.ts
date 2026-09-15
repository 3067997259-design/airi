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
 * A run may contain level walk edges, half-block step-ups and full-block
 * jump-ups. The run controller holds forward and jumps at the edge of a
 * one-block ascent instead of stopping for a discrete step, so a hill is
 * crossed continuously (CD-G2 hill follow). Break/place/use and parkour edges
 * remain action boundaries the executor handles separately.
 */
import type { JumpPlan } from './jump-plan'
import type { MovementControlPort, MovementState } from './port'
import type { BlockSource, MovementConfig, MovementMotionKind, PathStep, Vec3 } from './types'

import { standPointOf } from './coordinates'
import { clamp, horizontalDistance } from './geometry'
import { planStepUp } from './jump-plan'

/** Motions a continuous run may contain without an action boundary. */
const CONTINUOUS_MOTIONS: ReadonlySet<MovementMotionKind> = new Set<MovementMotionKind>(['walk', 'step-up', 'jump-up'])

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
 * Length of the consecutive continuous run starting at `start`.
 *
 * A drop, a break/place/use action or a parkour edge ends the run at that
 * edge; level walks, half-block step-ups and one-block jump-ups stay inside
 * it (CD-G1 D1, CD-G2 hill follow).
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
/** A destination this far above the feet still counts as reached and landed. */
const COMPLETION_HEIGHT_TOLERANCE = 0.35
/** Horizontal radius that confirms standing on a jump destination. */
const LANDING_RADIUS = 0.7
/** Dropping this far below a jump destination ends the attempt. */
const FALLBACK_DROP = 1.2
/** View error above which a latched climb withholds the jump key. */
const CLIMB_ALIGN_DEG = 20
/** Highest rise a vanilla jump can clear; above it the edge is impossible. */
const MAX_STEP_JUMP_RISE = 1.26
/** Deadline handed to one per-tick jump task, and the host's transport grace. */
const JUMP_TASK_TIMEOUT_MS = 8_000
const JUMP_TASK_GRACE_MS = 2_500
/** How often the host reads a running jump task's status. */
const JUMP_POLL_MS = 150

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
  /**
   * Snapshot the run was planned on, when the caller has one.
   *
   * With collision shapes the follower geometrically rejects a jump edge that
   * cannot be made and jumps from a computed takeoff line (Step 2); without it
   * the run keeps the plain height check.
   */
  world?: BlockSource
  /** Optional poll trace for live diagnosis (never used by tests). */
  debug?: (message: string) => void
}): Promise<WalkRunResult> {
  const { port, cells, config, shouldStop, sleep, now, tickMs, stepTimeoutMs } = options
  const debug = options.debug
  const world = options.world
  const last = cells[cells.length - 1]!
  let cursor = 0
  let position: Vec3 = cells[0]!
  let lastAdvanceAt = now()
  const recent: Vec3[] = []
  /**
   * The jump currently in flight.
   *
   * A jump-up edge is not complete until the bot stands on the destination
   * support, so the attempt is latched: the bearing stays on the latched cell
   * while airborne (a mid-air height change cannot switch back to plain
   * walking) and the latch clears only on landing confirmation or on a fall
   * back to the lower level.
   */
  let climbLatch: { cell: Vec3, plan?: JumpPlan } | undefined

  for (;;) {
    if (shouldStop())
      return { status: 'cancelled', cursor, position }
    const state: MovementState = await port.getState()
    position = state.position

    // Progress advances only across completed edges. A horizontal pass below
    // the destination does not complete an ascent: without the height check a
    // corner bump could skip a step and make the run chase a cell that is
    // several blocks up.
    while (cursor < cells.length - 1) {
      const a = cells[cursor]!
      const b = cells[cursor + 1]!
      const abx = b.x - a.x
      const abz = b.z - a.z
      const apx = position.x - a.x
      const apz = position.z - a.z
      if (abx * apx + abz * apz <= 0)
        break
      if (b.y - position.y > COMPLETION_HEIGHT_TOLERANCE)
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

    // The pending cell is the next un-reached one: horizontal distance alone is
    // not enough, a bot still below the cursor cell has not reached it.
    const pendingIndex = (horizontalDistance(position, cells[cursor]!) > 0.45 || position.y - cells[cursor]!.y < -0.5)
      ? cursor
      : Math.min(cursor + 1, cells.length - 1)
    const pendingCell = cells[pendingIndex]!

    // End the previous attempt first: landing confirms the edge (the progress
    // loop above passes it because the bot stands at the destination level), a
    // fall back clears the latch so the bot re-approaches from where it landed.
    if (climbLatch) {
      const landed = state.onGround
        && horizontalDistance(position, climbLatch.cell) <= LANDING_RADIUS
        && Math.abs(position.y - climbLatch.cell.y) <= COMPLETION_HEIGHT_TOLERANCE
      const fellBack = position.y < climbLatch.cell.y - FALLBACK_DROP
      if (landed || fellBack)
        climbLatch = undefined
    }
    // Start the next attempt on the same poll. A landing poll that walks
    // un-latched steers at the far lookahead node and can step off a
    // one-block-wide chain before the next ascend latch exists (live chain
    // trace: 0.22 from the far edge with a 0.2-per-poll residual slide).
    if (!climbLatch && pendingCell.y - position.y > COMPLETION_HEIGHT_TOLERANCE) {
      // A rise no jump can clear is a planning error, not a movement failure.
      // Fail the edge now: the executor disables its destination and replans
      // around it, instead of hopping in place until the stuck window and the
      // discrete retry timeout expire (live hill run: seconds lost per
      // impossible edge, and the "dead end" the user saw was a phantom one).
      if (pendingCell.y - position.y > MAX_STEP_JUMP_RISE) {
        debug?.(`run rejected: rise ${(pendingCell.y - position.y).toFixed(2)} at ${pendingCell.x},${pendingCell.y},${pendingCell.z}`)
        return { status: 'stuck', cursor, position }
      }
      // Step 2: with collision shapes, prove the hop first. A missing landing
      // support, a ceiling, or a wall inside the flight rejects the edge here so
      // the planner can route around it; the takeoff line it returns is where
      // the hop must start.
      let plan: JumpPlan | undefined
      if (world && pendingCell.y - position.y > 0.6 + COMPLETION_HEIGHT_TOLERANCE) {
        const source = cells[pendingIndex > cursor ? cursor : Math.max(0, pendingIndex - 1)] ?? cells[cursor]!
        const planned = planStepUp({ from: source, to: pendingCell, world, config })
        if (!planned.ok) {
          if (planned.reason !== 'not-a-jump') {
            debug?.(`run rejected: ${planned.reason} (${planned.detail ?? ''}) at ${pendingCell.x},${pendingCell.y},${pendingCell.z}`)
            return { status: 'stuck', cursor, position }
          }
        }
        else {
          plan = planned
        }
      }
      climbLatch = { cell: pendingCell, ...(plan ? { plan } : {}) }
      // Step 3: hand the hop to the mod's per-tick task when the bridge has it.
      // The task aims and jumps a tick at a time; the host only submits and
      // reads the real landing back, because its 150 ms polls cannot time a
      // takeoff or correct a landing.
      if (plan && port.startJump) {
        const finalEdge = pendingIndex === cells.length - 1
        const outcome = await followJumpTask({ port, plan, sleep, now, shouldStop })
        if (outcome === 'cancelled')
          return { status: 'cancelled', cursor, position }
        if (outcome === 'failed') {
          debug?.(`run jump task failed at ${plan.takeoff.x.toFixed(2)},${plan.takeoff.z.toFixed(2)} -> ${plan.takeoff.x + plan.direction.x * plan.flight},${plan.takeoff.z + plan.direction.z * plan.flight}`)
          return { status: 'stuck', cursor, position }
        }
        climbLatch = undefined
        lastAdvanceAt = now()
        // The task's verdict is authoritative for the edge it ran: `landed`
        // means grounded on the destination within its landing radius, and for
        // the final edge that ends the run. Re-checking with the run's tighter
        // walk radius made the follower fight the settle for the last
        // centimetres and end `stuck` on a pad it already stood on (live lone
        // step: landed 0.28 from the centre, run required 0.45).
        if (finalEdge) {
          const landed = await port.getState()
          position = landed.position
          return { status: 'arrived', cursor: pendingIndex, position }
        }
        continue
      }
    }

    const climbing = climbLatch !== undefined
    const target = climbing ? climbLatch!.cell : cells[targetIndex]!
    const distanceToTarget = horizontalDistance(position, target)

    // A bend anywhere in the lookahead window releases the sprint early. The
    // directions are normalized, so a 45-degree corner is detected regardless
    // of the segment lengths (CD-G1 D3).
    const turnAhead = !climbing && turnAheadWithin(cells, cursor, targetIndex, position)

    const yaw = yawTo(position, target)
    const yawDelta = angleDelta(state.yaw, yaw)
    const aligned = Math.abs(yawDelta) <= CLIMB_ALIGN_DEG

    if (Math.abs(yawDelta) > AIM_TOLERANCE_DEG) {
      // A large error is a fresh bearing and is applied directly; small
      // corrections move at a bounded rate so the view does not snap around
      // while the player keeps moving. A latched climb always snaps: its hop
      // must start with the view already on the destination, otherwise the
      // walk input carries the bot off a one-block chain while the view
      // creeps 20 degrees per poll (live chain trace: off the start block
      // after two polls at 30-45 degrees of error).
      const applied = climbing || Math.abs(yawDelta) > LARGE_TURN_DEG
        ? yawDelta
        : clamp(yawDelta, -MAX_YAW_RATE_DEG, MAX_YAW_RATE_DEG)
      await port.look(state.yaw + applied, 0)
    }

    // A latched climb presses the jump key only on a grounded, aligned sample.
    // Two live failures define this rule:
    // - Holding the key across a bend made the auto-jump fire on the landing
    //   tick, before the rotation for the next cell reached the game; the hop
    //   went in the previous direction and landed in the gap beside the chain.
    // - Releasing it for a whole poll on an airborne sample let her land and
    //   walk into the step's face until she slid off the chain.
    // A grounded press jumps within a poll of touchdown; an airborne release
    // never re-hops before the new aim is applied. A misaligned climb brakes,
    // because pressing forward while the view points away is what walked her
    // off a one-block block.
    // NOTICE: a host-side landing brake (release forward once the flight is
    // within a fixed distance of the destination) was tried and removed: at the
    // 150 ms poll cadence it cannot time the air control, it made dense
    // diagonal chains land short of their pads and fall into the gap beside
    // them (live chain run diagonal-brake), and it did not move the hill
    // numbers. Precise landing control needs the mod's per-tick execution.
    // The takeoff line from the jump plan gates the press: a flight longer than
    // the gap starts as soon as the bot is grounded and aligned (the line is
    // behind it), a shorter flight waits until the bot walks past the line.
    const takeoffPassed = !climbLatch?.plan || (() => {
      const plan = climbLatch!.plan!
      const dx = position.x - plan.takeoff.x
      const dz = position.z - plan.takeoff.z
      return dx * plan.direction.x + dz * plan.direction.z >= 0
    })()
    const jumpHeld = state.inWater || (climbing && aligned && state.onGround && takeoffPassed)
    const walkHeld = !climbing || aligned

    if (debug) {
      debug(`run poll: cursor=${cursor} pos=${position.x.toFixed(2)},${position.y.toFixed(2)},${position.z.toFixed(2)} target=${target.x.toFixed(2)},${target.y.toFixed(2)},${target.z.toFixed(2)} dist=${distanceToTarget.toFixed(2)} yawErr=${yawDelta.toFixed(0)} ground=${state.onGround} latched=${climbing} walk=${walkHeld} jump=${jumpHeld} sprint=${config.allowSprinting && !climbing && !turnAhead && targetIndex < cells.length - 1}`)
    }

    await port.setInput({
      forward: walkHeld,
      // A latched jump keeps the walk speed; ordinary bends still release it.
      sprint: config.allowSprinting && !climbing && !turnAhead && targetIndex < cells.length - 1,
      jump: jumpHeld,
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

/**
 * Submits one planned hop to the mod and waits for its landing verdict.
 *
 * The jump task has a deadline of its own; the poll loop only covers the
 * transport (a task that never answers ends as `failed` after the deadline plus
 * a grace, so a wedged bridge cannot hang the run).
 *
 * @example
 * await followJumpTask({ port, plan, sleep, now, shouldStop })
 * // => 'landed' | 'failed' | 'cancelled'
 */
async function followJumpTask(options: {
  port: MovementControlPort
  plan: JumpPlan
  sleep: (ms: number) => Promise<void>
  now: () => number
  shouldStop: () => boolean
}): Promise<'landed' | 'failed' | 'cancelled'> {
  const { port, plan, sleep, now, shouldStop } = options
  // The plan's own landing, never a reconstruction: the clamped takeoff line
  // makes `takeoff + direction * flight` a different point.
  const target = plan.target
  const deadlineMs = now() + JUMP_TASK_TIMEOUT_MS
  try {
    await port.startJump!({
      target,
      takeoff: plan.takeoff,
      direction: plan.direction,
      sprint: plan.sprint,
      brake: plan.brake,
      deadlineMs,
    })
  }
  catch {
    return 'failed'
  }
  for (;;) {
    if (shouldStop()) {
      await port.cancelJump?.().catch(() => {})
      return 'cancelled'
    }
    if (now() > deadlineMs + JUMP_TASK_GRACE_MS)
      return 'failed'
    await sleep(JUMP_POLL_MS)
    let status
    try {
      status = await port.jumpStatus!()
    }
    catch {
      return 'failed'
    }
    if (status.state === 'running')
      continue
    if (status.state === 'done')
      return 'landed'
    if (status.state === 'idle')
      return 'failed'
    return 'failed'
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
