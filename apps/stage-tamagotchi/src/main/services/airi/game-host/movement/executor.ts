/**
 * Terrain move executor (MC-3 Phase 1, increment 2)。
 *
 * Walks a planned path with the stable-aim policy: while a step is in
 * progress the executor re-aims at the step and never rotates for anything
 * else. Break/place/use steps return `unsupported_action` until increment 3
 * implements the interaction executor.
 */
import type { BlockFace, MovementControlPort, MovementInput, MovementState } from './port'
import type { WorldSnapshot } from './snapshot'
import type { BlockSource, MovementConfig, PathStep, PlanFailureReason, PlanSuccess, Vec3 } from './types'

import { normalizeBlockId } from './block-view'
import { standPointOf } from './coordinates'
import { buildCorridor, followCorridor, stepIndexAtProgress, worldHasCollisionShapes } from './corridor'
import { failedRunStep, runCells, runWalkRun, walkRunLength } from './follow'
import { planPath } from './planner'
import { movementRegionBounds, readMovementRegion } from './region'
import { hintCells, LONG_ROUTE_MAX_HOP, LONG_ROUTE_MIN_DISTANCE, splitRoute } from './route'
import { createSnapshot } from './snapshot'
import { DEFAULT_MOVEMENT_CONFIG } from './types'

/**
 * Horizontal read windows one leg tries, in cells.
 *
 * 16 is the scale a mob uses to follow a target; 32 and 48 cover a detour the
 * base window cannot see before the leg ends `unreachable`.
 */
const LOCAL_WINDOW_MARGINS = [16, 32, 48] as const

export type TerrainMoveStatus
  = | 'reached'
    | PlanFailureReason
    | 'stuck'
    | 'unsupported_action'
    | 'cancelled'

export interface TerrainMoveResult {
  status: TerrainMoveStatus
  position: Vec3
  replans: number
  stuckEscalations: number
  detail?: string
}

export interface TerrainMoveOptions {
  port: MovementControlPort
  goal: Vec3
  /** Alternate goal cells. When non-empty any of them satisfies arrival. */
  goalCells?: Vec3[]
  tolerance?: number
  config?: MovementConfig
  remainingPlaceables?: number
  shouldStop?: () => boolean
  /** Shared failed-edge memory; kept across replans and legs of one command. */
  failedEdges?: Map<string, FailedEdge>
  maxReplans?: number
  maxStuckEscalations?: number
  tickMs?: number
  stepTimeoutMs?: number
  /** Optional trace sink for live diagnosis (never used by tests). */
  debug?: (message: string) => void
  deps?: {
    sleep?: (ms: number) => Promise<void>
    now?: () => number
  }
}

/** One edge the executor failed to traverse, keyed by {@link failedEdgeKey}. */
export interface FailedEdge {
  /** Destination cell of the failed edge; the planner disables this node. */
  to: Vec3
  /** Failure time for the TTL check. */
  at: number
  /** Scaffolding count when the edge failed; more materials invalidates it. */
  materials: number
  /**
   * Block id at the destination cell when the edge failed. The executor reads
   * the cell again before honoring the edge and drops it when the world
   * changed (review R5 world invalidation).
   */
  id: string
}

/** Stable key for a failed edge; `from` and `to` are integer cells. */
export function failedEdgeKey(from: Vec3, to: Vec3): string {
  return `${from.x},${from.y},${from.z}>${to.x},${to.y},${to.z}`
}

/** A recorded failed edge is honored for this long after the failure. */
const FAILED_EDGE_TTL_MS = 30_000

/**
 * Pure failed-edge rules: TTL and material invalidation only.
 *
 * An edge expires after {@link FAILED_EDGE_TTL_MS}, or when the current
 * scaffolding count is higher than the recorded one (the inventory changed, so
 * the edge is worth retrying). World block changes are checked separately
 * because they need IO; see `validatedFailedEdges`.
 *
 * @example
 * activeFailedEdges(map, { now: 40_000, materials: 6 })
 * // => entries at most 30 s old whose materials is at least 6
 */
export function activeFailedEdges(
  entries: Iterable<[string, FailedEdge]>,
  context: { now: number, materials: number },
): FailedEdge[] {
  const active: FailedEdge[] = []
  for (const [, edge] of entries) {
    if (context.now - edge.at > FAILED_EDGE_TTL_MS)
      continue
    if (context.materials > edge.materials)
      continue
    active.push(edge)
  }
  return active
}

/**
 * Pure rules plus a live block check for a failed edge.
 *
 * The block at the destination is read again; a changed id, a missing block, or
 * a read error means the world moved on and the record must not disable the
 * cell. Reads are bounded by the number of surviving candidates.
 */
async function validatedFailedEdges(
  port: MovementControlPort,
  entries: Iterable<[string, FailedEdge]>,
  context: { now: number, materials: number },
): Promise<FailedEdge[]> {
  const kept: FailedEdge[] = []
  for (const edge of activeFailedEdges(entries, context)) {
    try {
      const block = await port.getBlock(edge.to)
      // The snapshot id is normalized (no namespace); normalize the live read
      // the same way before comparing.
      if (block && normalizeBlockId(block.id) === edge.id)
        kept.push(edge)
    }
    catch {
      // An unreadable destination cannot be trusted: drop the record.
    }
  }
  return kept
}

/** Node keys the planner must skip for the active failed edges. */
function disabledCellsOf(edges: FailedEdge[]): Set<string> {
  return new Set(edges.map(edge => `${edge.to.x},${edge.to.y},${edge.to.z}`))
}

const TICK_MS = 150
const STEP_TIMEOUT_MS = 8_000
const STUCK_WINDOW_POLLS = 12
const STUCK_MIN_MOVE = 0.15
const AIM_TOLERANCE_DEG = 7
const STEP_RADIUS = 0.45
/** A lost break start is retried at this interval. */
const BREAK_RETRY_MS = 1_200

function defaultSleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function floorVec(v: Vec3): Vec3 {
  return { x: Math.floor(v.x), y: Math.floor(v.y), z: Math.floor(v.z) }
}

function horizontalDistance(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.z - b.z)
}

/** Minecraft yaw for a direction vector: 0 = south, -90 = east. */
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

function reachedGoal(position: Vec3, goal: Vec3, tolerance: number): boolean {
  return horizontalDistance(position, goal) <= Math.max(0.5, tolerance) && Math.abs(position.y - goal.y) <= 1
}

/**
 * Cheap placeable blocks the executor selects when building a step.
 *
 * Sand is deliberately absent: it falls without support, so a sand pillar or
 * bridge drops as soon as it is placed (review R3).
 */
export const SCAFFOLDING_ITEMS = new Set([
  'minecraft:andesite',
  'minecraft:cobblestone',
  'minecraft:diorite',
  'minecraft:dirt',
  'minecraft:granite',
  'minecraft:oak_planks',
  'minecraft:stone',
])

interface ActionContext {
  port: MovementControlPort
  shouldStop: () => boolean
  sleep: (ms: number) => Promise<void>
  now: () => number
}

async function aimAtBlock(pos: Vec3, ctx: ActionContext): Promise<void> {
  const state = await ctx.port.getState()
  const eye = { x: state.position.x, y: state.position.y + 1.62, z: state.position.z }
  const center = { x: pos.x + 0.5, y: pos.y + 0.5, z: pos.z + 0.5 }
  const horizontal = Math.hypot(center.x - eye.x, center.z - eye.z)
  const yaw = yawTo(eye, center)
  const pitch = Math.atan2(-(center.y - eye.y), horizontal) * 180 / Math.PI
  await ctx.port.look(yaw, pitch)
}

/**
 * Stable-aim mining: lock the view on the block and poll until it is gone.
 *
 * This is the core deviation from Baritone's behavior, whose aim wobble reset
 * block-breaking progress in the Phase 0 spike. The bridge's survival break is
 * a *started* action that continues each tick, so it is issued once; re-issuing
 * it every poll would reset the mining progress. A slow retry covers a lost
 * start, and the view stays locked between polls.
 */
async function breakBlockStable(pos: Vec3, ctx: ActionContext): Promise<boolean> {
  const before = await ctx.port.getBlock(pos)
  if (!before || before.air)
    return true
  const deadline = ctx.now() + Math.min(20_000, 2_000 + (before.hardness ?? 1.5) * 2_000)
  let nextRetry = ctx.now() + BREAK_RETRY_MS
  await aimAtBlock(pos, ctx)
  await ctx.port.breakBlock(pos)
  for (;;) {
    await ctx.sleep(150)
    if (ctx.shouldStop())
      return false
    const after = await ctx.port.getBlock(pos)
    if (!after || after.air || after.id !== before.id)
      return true
    await aimAtBlock(pos, ctx)
    if (ctx.now() >= nextRetry) {
      await ctx.port.breakBlock(pos)
      nextRetry = ctx.now() + BREAK_RETRY_MS
    }
    if (ctx.now() > deadline)
      return false
  }
}

/** Picks a solid neighbor to place against, with the face that points at the target. */
async function chooseSupport(target: Vec3, ctx: ActionContext): Promise<{ pos: Vec3, face: BlockFace } | undefined> {
  const candidates: Array<{ dx: number, dy: number, dz: number, face: BlockFace }> = [
    { dx: 0, dy: -1, dz: 0, face: 'up' },
    { dx: 0, dy: 1, dz: 0, face: 'down' },
    { dx: -1, dy: 0, dz: 0, face: 'east' },
    { dx: 1, dy: 0, dz: 0, face: 'west' },
    { dx: 0, dy: 0, dz: -1, face: 'south' },
    { dx: 0, dy: 0, dz: 1, face: 'north' },
  ]
  for (const candidate of candidates) {
    const pos = { x: target.x + candidate.dx, y: target.y + candidate.dy, z: target.z + candidate.dz }
    const block = await ctx.port.getBlock(pos)
    if (block && !block.air)
      return { pos, face: candidate.face }
  }
  return undefined
}

async function ensureScaffolding(ctx: ActionContext): Promise<boolean> {
  const slots = await ctx.port.getInventory()
  const hotbar = slots.find(entry => entry.hotbar && SCAFFOLDING_ITEMS.has(entry.id))
  if (hotbar) {
    await ctx.port.selectHotbar(hotbar.slot)
    return true
  }
  // The host counts scaffolding in the main inventory too; move one stack into
  // an empty hotbar slot instead of failing the pillar/bridge step (review R3).
  const fromMain = slots.find(entry => !entry.hotbar && SCAFFOLDING_ITEMS.has(entry.id))
  if (!fromMain)
    return false
  const emptyHotbar = [0, 1, 2, 3, 4, 5, 6, 7, 8]
    .find(index => !slots.some(entry => entry.hotbar && entry.slot === index))
  if (emptyHotbar === undefined)
    return false
  await ctx.port.swapSlots(fromMain.slot, emptyHotbar)
  await ctx.port.selectHotbar(emptyHotbar)
  return true
}

/** Places one scaffolding block at the action target and verifies the block. */
async function placeBlockStable(action: { x: number, y: number, z: number, jump?: boolean }, ctx: ActionContext): Promise<boolean> {
  const target: Vec3 = { x: action.x, y: action.y, z: action.z }
  const existing = await ctx.port.getBlock(target)
  if (existing && !existing.air)
    return true
  if (!await ensureScaffolding(ctx))
    return false
  const support = await chooseSupport(target, ctx)
  if (!support)
    return false
  for (let attempt = 0; attempt < 2; attempt++) {
    if (ctx.shouldStop())
      return false
    await aimAtBlock(support.pos, ctx)
    if (action.jump) {
      // Pillar: jump first so the block lands in the space just left behind.
      await ctx.port.jumpOnce()
      await ctx.sleep(250)
    }
    await ctx.port.placeBlock(support.pos, support.face)
    await ctx.sleep(200)
    const after = await ctx.port.getBlock(target)
    if (after && !after.air)
      return true
  }
  return false
}

/** Opens a door or gate with a right-click and verifies the open state. */
async function useBlockStable(pos: Vec3, ctx: ActionContext): Promise<boolean> {
  const before = await ctx.port.getBlock(pos)
  if (!before)
    return true
  if (before.properties?.open === 'true')
    return true
  for (let attempt = 0; attempt < 2; attempt++) {
    if (ctx.shouldStop())
      return false
    await aimAtBlock(pos, ctx)
    await ctx.port.useBlock(pos)
    await ctx.sleep(200)
    const after = await ctx.port.getBlock(pos)
    if (!after || after.properties?.open === 'true' || after.id !== before.id)
      return true
  }
  return false
}

/** Runs the break/place/use actions a step requires before walking it. */
async function performStepActions(step: PathStep, ctx: ActionContext): Promise<'ok' | 'failed' | 'cancelled'> {
  for (const pos of step.toBreak) {
    if (ctx.shouldStop())
      return 'cancelled'
    if (!await breakBlockStable(pos, ctx))
      return 'failed'
  }
  for (const action of step.toPlace) {
    if (ctx.shouldStop())
      return 'cancelled'
    const ok = action.kind === 'use'
      ? await useBlockStable({ x: action.x, y: action.y, z: action.z }, ctx)
      : await placeBlockStable(action, ctx)
    if (!ok)
      return 'failed'
  }
  return 'ok'
}

/** Releases inputs twice: before a recovery and after the move finishes. */
async function recover(port: MovementControlPort, sleep: (ms: number) => Promise<void>, attempt: number): Promise<void> {
  await port.stopMovement()
  if (attempt % 3 === 1) {
    await port.jumpOnce()
  }
  else if (attempt % 3 === 2) {
    await port.setInput({ right: true, forward: true })
    await sleep(300)
  }
  else {
    await port.setInput({ back: true })
    await sleep(300)
    await port.jumpOnce()
  }
  await port.stopMovement()
}

async function walkStep(step: PathStep, options: {
  port: MovementControlPort
  goal: Vec3
  tolerance: number
  config: MovementConfig
  shouldStop: () => boolean
  sleep: (ms: number) => Promise<void>
  now: () => number
  tickMs: number
  stepTimeoutMs: number
  /** The next step turns away from this one; sprint must be released early. */
  turnAhead?: boolean
  /**
   * Stop the move input when this step arrives. Plain walk steps keep moving
   * (review R1); the step before a parkour jump or a break/place/use boundary
   * must stop so the takeoff edge or the action spot is not overrun.
   */
  stopOnArrival?: boolean
}): Promise<'arrived' | 'stuck' | 'cancelled'> {
  const { port, goal, tolerance, config, shouldStop, sleep, now, tickMs, stepTimeoutMs, turnAhead } = options
  // Goal/aim is the standing point of the cell (center X/Z), never the integer
  // corner: aiming at corners walked players diagonally (review R1).
  const stepTarget: Vec3 = standPointOf({ x: step.x, y: step.y, z: step.z })
  const from: Vec3 = step.from
  const dir = { x: Math.sign(stepTarget.x - from.x), z: Math.sign(stepTarget.z - from.z) }
  const takeoffEdge = { x: from.x + dir.x, y: from.y, z: from.z + dir.z }
  const deadline = now() + stepTimeoutMs
  const recent: Vec3[] = []
  let jumped = false

  for (;;) {
    if (shouldStop())
      return 'cancelled'
    const state: MovementState = await port.getState()
    if (horizontalDistance(state.position, stepTarget) <= STEP_RADIUS && Math.abs(state.position.y - stepTarget.y) <= 0.8) {
      if (options.stopOnArrival)
        await port.stopMovement()
      return 'arrived'
    }
    if (now() > deadline)
      return 'stuck'

    const yaw = yawTo(state.position, stepTarget)
    if (Math.abs(angleDelta(state.yaw, yaw)) > AIM_TOLERANCE_DEG)
      await port.look(yaw, 0)

    const nearGoal = horizontalDistance(state.position, goal) <= tolerance
    const jumpingUp = stepTarget.y > Math.floor(state.position.y) && horizontalDistance(state.position, stepTarget) < 1.4
    const parkourJump = step.parkour && !jumped && horizontalDistance(state.position, takeoffEdge) < 0.8
    const input: MovementInput = {
      forward: true,
      // Sprint only on straight segments: a turn ahead (or the goal) needs the
      // slower approach speed, otherwise the corner is overrun (review R1).
      sprint: config.allowSprinting && (step.parkour || (!nearGoal && !turnAhead)),
      jump: state.inWater,
      ...(jumpingUp && state.onGround ? { jump: true } : {}),
    }
    await port.setInput(input)
    if (parkourJump && state.onGround) {
      jumped = true
      await port.jumpOnce()
    }

    recent.push({ ...state.position })
    if (recent.length > STUCK_WINDOW_POLLS) {
      recent.shift()
      const oldest = recent[0]!
      if (horizontalDistance(oldest, state.position) < STUCK_MIN_MOVE)
        return 'stuck'
    }
    await sleep(tickMs)
  }
}

export async function runTerrainMove(options: TerrainMoveOptions): Promise<TerrainMoveResult> {
  const {
    port,
    goal,
    goalCells,
    tolerance = 1,
    config = DEFAULT_MOVEMENT_CONFIG,
    remainingPlaceables = 0,
    shouldStop = () => false,
    failedEdges = new Map<string, FailedEdge>(),
    maxReplans = 3,
    maxStuckEscalations = 3,
    tickMs = TICK_MS,
    stepTimeoutMs = STEP_TIMEOUT_MS,
    debug,
    deps = {},
  } = options
  const sleep = deps.sleep ?? defaultSleep
  const now = deps.now ?? (() => Date.now())
  // A region goal accepts any cell; the single `goal` is the fallback and the
  // debug label.
  const goals = goalCells && goalCells.length > 0 ? goalCells : [goal]
  const reachedAny = (candidate: Vec3): boolean => goals.some(cell => reachedGoal(candidate, cell, tolerance))

  let replans = 0
  let stuckEscalations = 0
  let position: Vec3 = { x: goal.x, y: goal.y, z: goal.z }
  const finish = (status: TerrainMoveStatus, detail?: string): TerrainMoveResult => ({
    status,
    position,
    replans,
    stuckEscalations,
    ...(detail ? { detail } : {}),
  })

  // The failed edge of the step that just got stuck; recorded so the next
  // replan can avoid its destination cell (review R5). The id comes from the
  // snapshot the plan was built on, so a later world change can be detected.
  const noteFailedEdge = (step: PathStep, source: BlockSource): void => {
    const to = { x: step.x, y: step.y, z: step.z }
    const id = source.getBlock(to.x, to.y, to.z)?.id ?? 'minecraft:air'
    failedEdges.set(failedEdgeKey(step.from, to), { to, at: now(), materials: remainingPlaceables, id })
  }

  try {
    for (;;) {
      if (shouldStop())
        return finish('cancelled')
      const state = await port.getState()
      position = state.position
      if (reachedAny(position))
        return finish('reached')

      const start = floorVec(position)
      // A local window around start and goal keeps one leg cheap. The base
      // window is 16 cells, the scale a mob uses to follow a target; when the
      // direct line is walled off, the window grows stepwise so a detour the
      // base window cannot see is still found instead of ending `unreachable`.
      // The entrance graph (CD-G3) remains the long-term replacement.
      let snapshot: WorldSnapshot | undefined
      let exactShapes = false
      let plan: PlanSuccess | undefined
      for (const margin of LOCAL_WINDOW_MARGINS) {
        // The lower read margin must cover the deepest allowed drop plus the
        // support block below it, and one more scan from a landing node; the
        // planner otherwise reports a missing block outside the region and the
        // whole leg fails (live MC-4c follow).
        const bounds = movementRegionBounds(start, goals, margin, 2 * config.maxDropDown + 1)
        const read = await readMovementRegion(port, bounds)
        const candidateSnapshot = createSnapshot(read.entries, { exactShapes: read.exactShapes })
        const insideBounds = (p: Vec3): boolean =>
          p.x >= bounds.min.x && p.x <= bounds.max.x
          && p.y >= bounds.min.y && p.y <= bounds.max.y
          && p.z >= bounds.min.z && p.z <= bounds.max.z
        // Blocks outside the snapshot are stubbed as obstacles (upstream
        // behavior); a missing block *inside* the requested region means the
        // read was incomplete and the plan must fail loudly.
        // A failed edge is honored on every plan once the map has entries, so a
        // shared map disables an edge on the first plan of the next leg too.
        // Each candidate is checked against the live block first, so a record
        // made before the world changed is dropped rather than trusted.
        let disabled: ReadonlySet<string> | undefined
        if (failedEdges.size > 0) {
          const validated = await validatedFailedEdges(port, failedEdges, { now: now(), materials: remainingPlaceables })
          disabled = validated.length > 0 ? disabledCellsOf(validated) : undefined
        }
        // The base budget is doubled: a climb with many jump-up edges needs
        // more labels than a flat walk even inside the base window.
        const candidate = planPath({ source: candidateSnapshot, start, goal, goalCells: goals, disabled, config, remainingPlaceables, onMissingBlock: 'stub', searchScale: (margin / LOCAL_WINDOW_MARGINS[0]) * 2 })
        if (candidate.ok) {
          plan = candidate
          snapshot = candidateSnapshot
          exactShapes = read.exactShapes
          const incomplete = candidate.missing?.find(insideBounds)
          if (incomplete)
            return finish('no_chunk', `missing ${incomplete.x},${incomplete.y},${incomplete.z}`)
          break
        }
        debug?.(`plan failed at margin ${margin}: ${candidate.reason}${candidate.missing ? ` missing ${candidate.missing.x},${candidate.missing.y},${candidate.missing.z}` : ''} start=${start.x},${start.y},${start.z} goal=${goal.x},${goal.y},${goal.z}`)
        const incomplete = candidate.missing && insideBounds(candidate.missing)
        if (incomplete) {
          // The base window is the readability gate: a missing block inside it
          // means the read was incomplete and the leg fails loudly. A wider
          // window that is only partly loaded must not turn a decided local
          // `no_path` into a read failure, so expansion simply stops there.
          if (margin === LOCAL_WINDOW_MARGINS[0])
            return finish('no_chunk', `missing ${candidate.missing!.x},${candidate.missing!.y},${candidate.missing!.z}`)
          break
        }
        if (candidate.reason !== 'no_path')
          return finish(candidate.reason, candidate.missing ? `missing ${candidate.missing.x},${candidate.missing.y},${candidate.missing.z}` : undefined)
      }
      if (!plan || !snapshot)
        return finish('no_path', `no path within ${LOCAL_WINDOW_MARGINS[LOCAL_WINDOW_MARGINS.length - 1]} cells`)
      debug?.(`plan: ${plan.steps.length} steps from ${start.x},${start.y},${start.z}`)
      debug?.(`plan path: ${JSON.stringify(plan.steps.map(step => [step.x, step.y, step.z]))}`)

      let stuck = false
      let index = 0
      while (index < plan.steps.length) {
        const step = plan.steps[index]!
        debug?.(`step -> ${step.x},${step.y},${step.z} break=${step.toBreak.length} place=${step.toPlace.length} parkour=${step.parkour}`)
        // Action boundaries stop first: breaking, placing or opening a door
        // while a move input is held walks the player off the spot.
        if (step.toBreak.length > 0 || step.toPlace.length > 0)
          await port.stopMovement()
        const actions = await performStepActions(step, { port, shouldStop, sleep, now })
        if (actions === 'cancelled')
          return finish('cancelled')
        if (actions === 'failed') {
          debug?.('step actions failed')
          noteFailedEdge(step, snapshot)
          stuck = true
          break
        }
        // A run of plain walk cells is followed continuously: no stop between
        // nodes, lookahead steering and passed-node skipping (batch 2).
        const runLength = walkRunLength(plan.steps, index)
        if (runLength >= 2) {
          // A shape-complete snapshot enables the verified corridor follower
          // (exact shapes from the source, or explicit boxes in a test fake).
          // The corridor is only used when every walk cell sweeps clean;
          // otherwise the discrete run stays the safe path (CD-G2 fallback).
          const explicitShapes = worldHasCollisionShapes(snapshot)
          const shapesAvailable = exactShapes || explicitShapes
          if (!shapesAvailable)
            debug?.(`corridor skipped: no shape data (exactShapes=${exactShapes}, explicit=${explicitShapes})`)
          const corridor = shapesAvailable
            ? buildCorridor(plan.steps, index, runLength, snapshot, config, debug)
            : undefined
          if (corridor) {
            const corridorResult = await followCorridor({
              port,
              path: corridor.path,
              config,
              shouldStop,
              sleep,
              now,
              tickMs,
              stepTimeoutMs,
              ...(debug ? { debug } : {}),
            })
            if (corridorResult.status === 'cancelled')
              return finish('cancelled')
            if (corridorResult.status === 'stuck') {
              debug?.(`corridor stuck at ${corridorResult.position.x.toFixed(1)},${corridorResult.position.y.toFixed(1)},${corridorResult.position.z.toFixed(1)}`)
              noteFailedEdge(failedRunStep(plan.steps, index, stepIndexAtProgress(corridor.path, corridorResult.sProgress)), snapshot)
              stuck = true
              break
            }
            position = corridorResult.position
            if (reachedAny(position))
              return finish('reached')
            index += runLength
            continue
          }
          const runResult = await runWalkRun({
            port,
            cells: runCells(plan.steps, index, runLength),
            config,
            shouldStop,
            sleep,
            now,
            tickMs,
            stepTimeoutMs: stepTimeoutMs * Math.max(1, runLength - 1),
          })
          if (runResult.status === 'cancelled')
            return finish('cancelled')
          if (runResult.status === 'stuck') {
            // The run reports how far it got; the failed edge is the one out of
            // the last passed cell, not the run's start (CD-G1 D7). A diagonal
            // one-block step can defeat the run's jump (the corner blocks the
            // side sweep), so the edge is retried with the discrete stepper,
            // whose takeoff logic is proven on single steps, before giving up.
            const failedIndex = index + runResult.cursor
            const failedStep = plan.steps[failedIndex]
            debug?.(`walk run stuck at ${runResult.position.x.toFixed(1)},${runResult.position.y.toFixed(1)},${runResult.position.z.toFixed(1)}; retrying ${failedStep ? `${failedStep.x},${failedStep.y},${failedStep.z}` : 'edge'} discretely`)
            if (failedStep) {
              const retry = await walkStep(failedStep, { port, goal, tolerance, config, shouldStop, sleep, now, tickMs, stepTimeoutMs, stopOnArrival: true })
              if (retry === 'cancelled')
                return finish('cancelled')
              if (retry === 'arrived') {
                position = (await port.getState()).position
                if (reachedAny(position))
                  return finish('reached')
                index = failedIndex + 1
                continue
              }
            }
            noteFailedEdge(failedStep ?? failedRunStep(plan.steps, index, runResult.cursor), snapshot)
            stuck = true
            break
          }
          position = runResult.position
          if (reachedAny(position))
            return finish('reached')
          index += runLength
          continue
        }

        const nextStep = plan.steps[index + 1]
        const stepDirection = { x: Math.sign(step.x - step.from.x), z: Math.sign(step.z - step.from.z) }
        const nextDirection = nextStep
          ? { x: Math.sign(nextStep.x - nextStep.from.x), z: Math.sign(nextStep.z - nextStep.from.z) }
          : undefined
        // Plain walk steps keep the input held; only a turn ahead slows down.
        const turnAhead = nextDirection !== undefined
          && (nextDirection.x !== stepDirection.x || nextDirection.z !== stepDirection.z)
        // A jump takeoff or an action boundary needs a standstill first: the
        // held input otherwise walks the player past the edge or the spot. The
        // arrival of a parkour/action step also stops, so the landing is not
        // overrun. Only plain walk steps keep moving (batch 2 replaces this
        // with continuous path following).
        const boundaryStep = step.parkour || step.toBreak.length > 0 || step.toPlace.length > 0
        const boundaryAhead = nextStep !== undefined
          && (nextStep.parkour || nextStep.toBreak.length > 0 || nextStep.toPlace.length > 0)
        const stopOnArrival = boundaryStep || boundaryAhead
        const outcome = await walkStep(step, { port, goal, tolerance, config, shouldStop, sleep, now, tickMs, stepTimeoutMs, turnAhead, stopOnArrival })
        debug?.(`walk ${step.x},${step.y},${step.z}: ${outcome} at ${position.x.toFixed(1)},${position.y.toFixed(1)},${position.z.toFixed(1)}`)
        if (outcome === 'cancelled')
          return finish('cancelled')
        if (outcome === 'stuck') {
          noteFailedEdge(step, snapshot)
          stuck = true
          break
        }
        const after = await port.getState()
        position = after.position
        if (reachedAny(position))
          return finish('reached')
        index += 1
      }

      if (stuck) {
        stuckEscalations++
        if (stuckEscalations > maxStuckEscalations)
          return finish('stuck', 'stuck escalations exhausted')
        await recover(port, sleep, stuckEscalations)
        if (replans++ >= maxReplans)
          return finish('stuck', 'replans exhausted')
        continue
      }

      if (replans++ >= maxReplans)
        return finish('stuck', 'no progress after replans')
    }
  }
  finally {
    await port.stopMovement().catch(() => {})
  }
}

export interface TerrainRouteOptions extends TerrainMoveOptions {
  /** Horizontal distance above which the goal is split into local legs. */
  longRouteMinDistance?: number
  /** Longest horizontal hop of one split leg. */
  maxHop?: number
}

/**
 * Walks to a far goal through local legs (review R5).
 *
 * A short goal is one {@link runTerrainMove} call. A far goal is split into
 * intermediate waypoints; each waypoint is a separate leg with its own local
 * region read and a fresh player read, and every leg shares the same
 * `failedEdges` map. The first failing leg ends the route with its typed
 * reason; the last leg keeps the caller's tolerance and goal cells.
 */
export async function runTerrainRoute(options: TerrainRouteOptions): Promise<TerrainMoveResult> {
  const {
    longRouteMinDistance = LONG_ROUTE_MIN_DISTANCE,
    maxHop = LONG_ROUTE_MAX_HOP,
    ...moveOptions
  } = options

  const start = floorVec((await moveOptions.port.getState()).position)
  if (horizontalDistance(start, moveOptions.goal) <= longRouteMinDistance)
    return await runTerrainMove(moveOptions)

  for (const waypoint of splitRoute(start, moveOptions.goal, maxHop)) {
    // Each leg reads the player again and plans over a local window around the
    // current position and the waypoint, so no read spans the whole route. The
    // waypoint is a hint: any reachable cell near it satisfies the leg (D6).
    const leg = await runTerrainMove({ ...moveOptions, goal: waypoint, goalCells: hintCells(waypoint), tolerance: 1 })
    if (leg.status !== 'reached')
      return leg
  }
  return await runTerrainMove(moveOptions)
}
