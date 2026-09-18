import type { TriState } from './target-observation'
import type { VehicleContext, VehicleControlPort, VehicleKind, VehicleMoveOptions, VehicleMoveResult } from './vehicle-port'
import type {
  VehicleEntityKind,
  VehicleFailureReason,
  VehicleObservation,
  VehicleReceipt,
  VehicleTravelPhase,
} from './vehicle-types'

/**
 * Vehicle travel session (CD-V1 lifecycle; CD-V2 driving; CD-V3 recovery).
 *
 * One travel owns this lifecycle exactly once:
 * `Discover -> Prepare -> Acquire -> VerifyControl -> Plan -> Travel -> Dock -> Finish`.
 * A failure takes a bounded recovery or ends the trip; it never restarts the
 * whole trip from the beginning.
 *
 * The session binds the command identity and the input generation captured by
 * the registry. Its cleanup only dismounts the vehicle this session boarded, so
 * a newer task that already mounted a vehicle is never thrown off (design §7).
 */
import { errorMessageFrom } from '@moeru/std'

import { angleDelta, defaultSleep, horizontalDistance, yawTo } from './geometry'
import { acquireVehicle } from './vehicle-acquire'
import { boatAngularVelocity, MINECART_MOVING_SPEED, minecartDismountSafe, observeMinecartLaunch, planBoatApproach, planRouteFollow } from './vehicle-drive'
import { isHorseFamily } from './vehicle-observation'

/** Water-route read margin around the boat-to-goal box, in cells. */
const WATER_ROUTE_MARGIN = 12
/** Read volume the route planner accepts; a bigger box degrades to the straight line. */
const WATER_ROUTE_MAX_CELLS = 30_000
/** Cells of look-ahead along the planned water route. */
const WATER_ROUTE_LOOKAHEAD = 4
/** Steering poll interval, in ms. */
const STEER_POLL_MS = 250
/** Stuck detection window, in polls. */
const STUCK_WINDOW_POLLS = 12
/** Minimum movement inside the stuck window, in blocks. */
const STUCK_MIN_MOVE = 0.3
/** Bounded recoveries before the trip ends with `route_unavailable`. */
const MAX_STUCK_ATTEMPTS = 2
/** Default overall travel budget, in ms. */
const DEFAULT_TRAVEL_BUDGET_MS = 120_000
/** Legacy minecart wait when the bridge cannot verify the launch, in ms. */
const LEGACY_MINECART_DEADLINE_MS = 30_000
/** Radius the minecart launch looks for a prepared lever. */
const MECHANISM_RADIUS = 4
/** Eye height used only to aim at the mechanism; a small offset still hits. */
const MECHANISM_AIM_EYE_HEIGHT = 1.6
/** Settle between aiming at the mechanism and interacting with it. */
const MECHANISM_AIM_SETTLE_MS = 250
/** Settle after the mechanism interaction before the rail is re-read. */
const MECHANISM_SETTLE_MS = 600
/** Time given a launched cart to show a real speed before failing, in ms. */
const LAUNCH_VERIFY_MS = 1_500
/** How often the riding identity is re-read, in polls. */
const RIDING_CHECK_EVERY = 4

interface SessionState {
  commandId: string
  controlSessionId: string
  controlSessionGeneration: number
  mover: VehicleKind
  kind: VehicleEntityKind
  phase: VehicleTravelPhase
  phases: VehicleTravelPhase[]
  uuid?: string
  method: VehicleReceipt['acquireMethod']
  asset: VehicleReceipt['asset']
  controlVerified: TriState
  startPosition?: { x: number, y: number, z: number }
  lastPosition?: { x: number, y: number, z: number }
  distance: number
  dimension?: string
  /** Player UUID used to detect a controller change mid-trip. */
  playerUuid?: string
  /** Rail launch state verified after boarding. */
  launchVerified?: boolean
  /** True once a prepared start mechanism was operated for this trip. */
  launchMechanismUsed?: boolean
}

interface TravelOutcome {
  status: 'reached' | 'cancelled' | 'stuck'
  failure?: VehicleFailureReason
  detail?: string
  speed?: number
  onGround?: boolean
  inWater?: boolean
}

function entityKindForMover(kind: VehicleKind): VehicleEntityKind {
  if (kind === 'horse')
    return 'horse'
  return kind as VehicleEntityKind
}

function notePhase(session: SessionState, phase: VehicleTravelPhase): void {
  session.phase = phase
  if (session.phases[session.phases.length - 1] !== phase)
    session.phases.push(phase)
}

function buildReceipt(session: SessionState, input: {
  dismounted: boolean
  arrivedMounted?: boolean
  dockPosition?: { x: number, y: number, z: number }
  failure?: VehicleFailureReason
  endReason: string
}): VehicleReceipt {
  return {
    commandId: session.commandId,
    controlSessionId: session.controlSessionId,
    controlSessionGeneration: session.controlSessionGeneration,
    kind: session.kind,
    acquireMethod: session.method,
    ...(session.uuid ? { vehicleUuid: session.uuid } : {}),
    distanceTravelled: Number(session.distance.toFixed(3)),
    ...(input.dockPosition ? { dockPosition: input.dockPosition } : {}),
    dismounted: input.dismounted,
    ...(input.arrivedMounted ? { arrivedMounted: true } : {}),
    ...(session.asset ? { asset: session.asset } : {}),
    ...(input.failure ? { failure: input.failure } : {}),
    endReason: input.endReason,
    phases: [...session.phases],
  }
}

function trackDistance(session: SessionState, position: { x: number, y: number, z: number }): void {
  if (session.lastPosition)
    session.distance += horizontalDistance(session.lastPosition, position)
  else
    session.startPosition = position
  session.lastPosition = position
}

/** Reads the ridden vehicle observation, or undefined when the bridge cannot. */
async function observeRidden(ctx: VehicleContext, uuid: string | undefined): Promise<VehicleObservation | undefined> {
  if (!uuid || !ctx.port.observeVehicle)
    return undefined
  const state = await ctx.port.getState()
  return await ctx.port.observeVehicle({
    uuid,
    dimension: state.observation?.dimension ?? '',
    worldId: state.observation?.worldId ?? '',
    connectionGeneration: state.observation?.connectionGeneration ?? 0,
    startedAt: ctx.now(),
  })
}

async function clearInput(port: VehicleControlPort): Promise<void> {
  await port.stopMovement().catch(() => {})
}

/**
 * Dismounts only when it is safe and the session still owns the vehicle.
 *
 * A boat in open water, a cart on a moving rail or a lost vehicle keeps the
 * player mounted; the caller receives `dismounted: false` and a typed reason
 * instead of a blind dismount (design §4, §6, §7).
 */
async function safeDismount(ctx: VehicleContext, session: SessionState, outcome: TravelOutcome): Promise<{ dismounted: boolean, failure?: VehicleFailureReason }> {
  const riding = await ctx.port.getRiding()
  // A newer task may have mounted another vehicle: never dismount it.
  if (session.uuid && riding?.uuid && riding.uuid !== session.uuid)
    return { dismounted: false, failure: 'unverified_stop' }
  if (session.uuid && !riding)
    return { dismounted: false, failure: 'vehicle_lost' }

  const kind = session.kind
  if (kind === 'boat') {
    if (outcome.inWater === true || outcome.onGround !== true)
      return { dismounted: false, failure: outcome.status === 'cancelled' ? 'unsafe_dismount' : undefined }
  }
  if (kind === 'minecart') {
    // A stance needs ground: a `reached` cart over the fixture's break
    // dismounted the player into open air and a fall (live V-08, 2026-09-17).
    // An unreadable support read is not a stance (CD-0 §3.3).
    const state = await ctx.port.getState()
    const support = await ctx.port.getBlock({
      x: Math.floor(state.position.x),
      y: Math.floor(state.position.y) - 1,
      z: Math.floor(state.position.z),
    })
    const safe = support !== undefined && support.air !== true
      && minecartDismountSafe({ speed: outcome.speed ?? 0, onRail: 'unobserved', atStation: outcome.status === 'reached' })
    if (!safe) {
      return {
        dismounted: false,
        failure: outcome.status === 'cancelled' || outcome.status === 'reached' ? 'unsafe_dismount' : undefined,
      }
    }
  }
  if (isHorseFamily(kind)) {
    if (outcome.status === 'cancelled' && outcome.onGround !== true)
      return { dismounted: false, failure: 'unsafe_dismount' }
  }
  await ctx.port.dismount()
  return { dismounted: true }
}

/** One read water cell of a planned boat route. */
interface WaterWaypoint {
  x: number
  z: number
  /** Water surface block Y at this cell. */
  y: number
}

/**
 * Plans a boat route through read water cells (CD-V2 minimal).
 *
 * The boat drives toward its waypoint, so steering straight at a goal across a
 * bend pushes the hull into the bank (live V-01/V-02, 2026-09-17: the trip
 * stalled at the diagonal bend and reported route_unavailable). The route is a
 * 4-neighbour BFS over the water cells one region read returns. An unread or
 * waterless region returns undefined and the caller keeps the straight-line
 * behaviour, so a bridge without the read degrades instead of guessing.
 */
async function planWaterRoute(ctx: VehicleContext, from: { x: number, y: number, z: number }, goal: { x: number, y: number, z: number }): Promise<{ path: WaterWaypoint[], water: Set<string> } | undefined> {
  const port = ctx.port
  if (!port.getBlocksRegion) {
    ctx.debug?.('boat route unavailable: bridge has no region read')
    return undefined
  }
  const bounds = {
    min: {
      x: Math.floor(Math.min(from.x, goal.x)) - WATER_ROUTE_MARGIN,
      y: Math.floor(from.y) - 2,
      z: Math.floor(Math.min(from.z, goal.z)) - WATER_ROUTE_MARGIN,
    },
    max: {
      x: Math.floor(Math.max(from.x, goal.x)) + WATER_ROUTE_MARGIN,
      y: Math.floor(from.y) + 1,
      z: Math.floor(Math.max(from.z, goal.z)) + WATER_ROUTE_MARGIN,
    },
  }
  const volume = (bounds.max.x - bounds.min.x + 1) * (bounds.max.y - bounds.min.y + 1) * (bounds.max.z - bounds.min.z + 1)
  if (volume > WATER_ROUTE_MAX_CELLS) {
    ctx.debug?.(`boat route unavailable: corridor read would be ${volume} cells`)
    return undefined
  }
  let entries
  try {
    entries = await port.getBlocksRegion(bounds.min, bounds.max)
  }
  catch (error) {
    ctx.debug?.(`boat route unavailable: read failed: ${errorMessageFrom(error)}`)
    return undefined
  }
  const water = new Map<string, number>()
  for (const entry of entries) {
    if (!entry.id.endsWith('water'))
      continue
    const key = `${entry.x},${entry.z}`
    const surface = water.get(key)
    if (surface === undefined || entry.y > surface)
      water.set(key, entry.y)
  }
  if (water.size === 0) {
    ctx.debug?.(`boat route unavailable: no water in ${entries.length} read blocks`)
    return undefined
  }
  const startKey = nearestWaterKey(water, from)
  const goalKey = nearestWaterKey(water, goal)
  if (!startKey || !goalKey) {
    ctx.debug?.('boat route unavailable: no water cell near the boat or the goal')
    return undefined
  }
  const previous = new Map<string, string | undefined>([[startKey, undefined]])
  const queue: string[] = [startKey]
  while (queue.length > 0) {
    const current = queue.shift()!
    if (current === goalKey)
      break
    const [x, z] = current.split(',').map(Number) as [number, number]
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const neighbour = `${x + dx},${z + dz}`
      if (!water.has(neighbour) || previous.has(neighbour))
        continue
      previous.set(neighbour, current)
      queue.push(neighbour)
    }
  }
  if (!previous.has(goalKey)) {
    ctx.debug?.(`boat route unavailable: the goal is not connected to the boat (start ${startKey}, goal ${goalKey})`)
    return undefined
  }
  const path: WaterWaypoint[] = []
  let cursor: string | undefined = goalKey
  while (cursor !== undefined) {
    path.unshift({ x: Number(cursor.split(',')[0]), z: Number(cursor.split(',')[1]), y: water.get(cursor)! })
    cursor = previous.get(cursor)
  }
  return { path, water: new Set(water.keys()) }
}

/** Key of the read water cell nearest to a world position. */
function nearestWaterKey(water: Map<string, number>, position: { x: number, z: number }): string | undefined {
  let best: string | undefined
  let bestDistance = Number.POSITIVE_INFINITY
  for (const key of water.keys()) {
    const [x, z] = key.split(',').map(Number) as [number, number]
    const distance = Math.hypot(x + 0.5 - position.x, z + 0.5 - position.z)
    if (distance < bestDistance) {
      bestDistance = distance
      best = key
    }
  }
  return best
}

/**
 * The route cell to aim at: the farthest cell ahead whose straight line stays on
 * read water.
 *
 * A fixed look-ahead cut the corner on short legs and steered the hull into the
 * bank (live V-02 follow-up). Walking forward while the line stays on water
 * keeps the aim inside the channel and still smooths the path.
 */
function boatWaypoint(route: { path: WaterWaypoint[], water: Set<string> }, position: { x: number, z: number }): WaterWaypoint | undefined {
  const path = route.path
  if (path.length === 0)
    return undefined
  let nearest = 0
  let bestDistance = Number.POSITIVE_INFINITY
  for (let index = 0; index < path.length; index++) {
    const cell = path[index]!
    const distance = Math.hypot(cell.x + 0.5 - position.x, cell.z + 0.5 - position.z)
    if (distance < bestDistance) {
      bestDistance = distance
      nearest = index
    }
  }
  const limit = Math.min(path.length - 1, nearest + WATER_ROUTE_LOOKAHEAD)
  let target = path[nearest]!
  for (let index = nearest + 1; index <= limit; index++) {
    if (!waterLineClear(route.water, position, path[index]!))
      break
    target = path[index]!
  }
  return target
}

/** True when the straight line from a position to a route cell stays over read water. */
function waterLineClear(water: Set<string>, from: { x: number, z: number }, to: WaterWaypoint): boolean {
  const steps = Math.ceil(Math.hypot(to.x + 0.5 - from.x, to.z + 0.5 - from.z) * 2)
  for (let step = 1; step <= steps; step++) {
    const t = step / steps
    const x = Math.floor(from.x + (to.x + 0.5 - from.x) * t)
    const z = Math.floor(from.z + (to.z + 0.5 - from.z) * t)
    if (!water.has(`${x},${z}`))
      return false
  }
  return true
}

async function runBoatTravel(ctx: VehicleContext, session: SessionState, goal: { x: number, y: number, z: number }, tolerance: number): Promise<TravelOutcome> {
  const port = ctx.port
  const recent: Array<{ x: number, y: number, z: number }> = []
  let stuckAttempts = 0
  let poll = 0
  let previousYaw: number | undefined
  let previousYawAt = 0
  let paddleTurn: TriState = 'unobserved'
  let route: { path: WaterWaypoint[], water: Set<string> } | undefined
  let routePlanned = false

  for (;;) {
    if (ctx.shouldStop())
      return { status: 'cancelled' }
    if (ctx.travelDeadline !== undefined && ctx.now() > ctx.travelDeadline)
      return { status: 'stuck', failure: 'deadline', detail: 'the boat trip exceeded its budget' }
    const state = await port.getState()
    trackDistance(session, state.position)
    if (horizontalDistance(state.position, goal) <= tolerance) {
      const observation = await observeRidden(ctx, session.uuid)
      return { status: 'reached', onGround: state.onGround, inWater: state.inWater, ...(observationSpeed(observation) !== undefined ? { speed: observationSpeed(observation) } : {}) }
    }

    if (poll++ % RIDING_CHECK_EVERY === 0) {
      const riding = await port.getRiding()
      if (session.uuid && (!riding || (riding.uuid && riding.uuid !== session.uuid)))
        return { status: 'stuck', failure: 'vehicle_lost', detail: 'the boat is no longer under the player' }
      const observation = await observeRidden(ctx, session.uuid)
      if (observation && session.dimension && observation.dimension !== session.dimension)
        return { status: 'stuck', failure: 'dimension_changed', detail: 'the world binding changed mid-trip' }
      if (controllerChanged(session, observation))
        return { status: 'stuck', failure: 'passenger_changed', detail: 'another player now controls the boat' }
      if (observation?.yaw !== undefined) {
        if (previousYaw !== undefined && ctx.now() > previousYawAt) {
          const angular = boatAngularVelocity(previousYaw, observation.yaw, ctx.now() - previousYawAt)
          paddleTurn = Math.abs(angular) > 2
        }
        previousYaw = observation.yaw
        previousYawAt = ctx.now()
      }
    }

    const observation = await observeRidden(ctx, session.uuid)
    if (!routePlanned) {
      routePlanned = true
      route = await planWaterRoute(ctx, state.position, goal)
      if (route)
        ctx.debug?.(`boat route planned: ${route.path.length} water cells`)
    }
    const routeWaypoint = route ? boatWaypoint(route, state.position) : undefined
    const waypoint = routeWaypoint ?? goal
    const plan = observation
      ? (routeWaypoint
          ? planRouteFollow({
              position: state.position,
              yaw: observation.yaw ?? state.yaw,
              waypoint: { x: routeWaypoint.x + 0.5, y: routeWaypoint.y + 0.5, z: routeWaypoint.z + 0.5 },
              goal,
              speed: observationSpeed(observation) ?? Math.hypot(state.motion?.x ?? 0, state.motion?.z ?? 0),
            })
          : planBoatApproach({
              position: state.position,
              yaw: observation.yaw ?? state.yaw,
              waypoint: { x: waypoint.x + 0.5, y: waypoint.y + 0.5, z: waypoint.z + 0.5 },
              goal,
              speed: observationSpeed(observation) ?? Math.hypot(state.motion?.x ?? 0, state.motion?.z ?? 0),
            }))
      : undefined
    if (plan) {
      if (Math.abs(angleDelta(state.yaw, plan.yawCommand)) > 10)
        await port.look(plan.yawCommand, 0)
      await port.setInput({ forward: plan.forward, back: plan.back })
    }
    else {
      const yaw = yawTo(state.position, goal)
      if (Math.abs(angleDelta(state.yaw, yaw)) > 20)
        await port.look(yaw, 0)
      await port.setInput({ forward: true, sprint: false })
    }
    // A boat whose forward input never turns the hull needs the opposing paddle
    // to be pulsed; report it once so the caller stops trusting camera yaw.
    if (paddleTurn === false)
      ctx.debug?.('boat paddle turn unverified: hull yaw did not change while paddling forward')
    await ctx.sleep(STEER_POLL_MS)

    recent.push({ ...state.position })
    if (recent.length > STUCK_WINDOW_POLLS) {
      recent.shift()
      const oldest = recent[0]!
      if (horizontalDistance(oldest, state.position) < STUCK_MIN_MOVE) {
        stuckAttempts++
        if (stuckAttempts > MAX_STUCK_ATTEMPTS)
          return { status: 'stuck', failure: 'route_unavailable', detail: 'the boat did not make progress' }
        await port.setInput({ forward: false, back: true })
        await ctx.sleep(450)
        await clearInput(port)
        recent.length = 0
        routePlanned = false
      }
    }
  }
}

/**
 * True when another player now controls the vehicle this session boarded.
 *
 * A controller read that names someone else is a passenger change: the trip
 * must end rather than keep steering a vehicle the local player no longer owns.
 */
function controllerChanged(session: SessionState, observation: VehicleObservation | undefined): boolean {
  if (!session.playerUuid || !observation?.controller)
    return false
  return observation.controller !== session.playerUuid
}

function observationSpeed(observation: VehicleObservation | undefined): number | undefined {
  if (!observation)
    return undefined
  if (observation.state.kind === 'minecart' && observation.state.speed !== undefined)
    return observation.state.speed
  if (observation.velocity)
    return Math.hypot(observation.velocity.x, observation.velocity.z)
  return undefined
}

async function runHorseTravel(ctx: VehicleContext, session: SessionState, goal: { x: number, y: number, z: number }, tolerance: number): Promise<TravelOutcome> {
  const port = ctx.port
  const recent: Array<{ x: number, y: number, z: number }> = []
  let stuckAttempts = 0
  let poll = 0
  for (;;) {
    if (ctx.shouldStop())
      return { status: 'cancelled' }
    if (ctx.travelDeadline !== undefined && ctx.now() > ctx.travelDeadline)
      return { status: 'stuck', failure: 'deadline', detail: 'the horse trip exceeded its budget' }
    const state = await port.getState()
    trackDistance(session, state.position)
    if (horizontalDistance(state.position, goal) <= tolerance)
      return { status: 'reached', onGround: state.onGround, inWater: state.inWater }

    if (poll++ % RIDING_CHECK_EVERY === 0) {
      const riding = await port.getRiding()
      if (session.uuid && (!riding || (riding.uuid && riding.uuid !== session.uuid)))
        return { status: 'stuck', failure: 'vehicle_lost', detail: 'the horse is no longer under the player' }
      const observation = await observeRidden(ctx, session.uuid)
      if (observation) {
        if (session.dimension && observation.dimension !== session.dimension)
          return { status: 'stuck', failure: 'dimension_changed', detail: 'the world binding changed mid-trip' }
        if (controllerChanged(session, observation))
          return { status: 'stuck', failure: 'passenger_changed', detail: 'another player now controls the horse' }
        const horse = observation.state
        if ((horse.kind === 'horse' || horse.kind === 'donkey' || horse.kind === 'mule')) {
          if (horse.saddled === false)
            return { status: 'stuck', failure: 'saddle_missing', detail: 'the saddle was lost while riding' }
          if (horse.controlledByPassenger === false)
            return { status: 'stuck', failure: 'not_controllable', detail: 'the rider was thrown off' }
        }
      }
    }

    const yaw = yawTo(state.position, goal)
    if (Math.abs(angleDelta(state.yaw, yaw)) > 20)
      await port.look(yaw, 0)
    await port.setInput({ forward: true })
    await ctx.sleep(STEER_POLL_MS)

    recent.push({ ...state.position })
    if (recent.length > STUCK_WINDOW_POLLS) {
      recent.shift()
      const oldest = recent[0]!
      if (horizontalDistance(oldest, state.position) < STUCK_MIN_MOVE) {
        stuckAttempts++
        if (stuckAttempts > MAX_STUCK_ATTEMPTS)
          return { status: 'stuck', failure: 'route_unavailable', detail: 'the horse did not make progress' }
        // A charged jump is the bounded recovery: the caller already checked
        // health and run-up before choosing to jump (design §5).
        await port.setInput({ jump: true })
        await ctx.sleep(500)
        await port.setInput({ jump: false })
        await ctx.sleep(300)
        await clearInput(port)
        recent.length = 0
      }
    }
  }
}

/**
 * Operates one prepared launch mechanism beside the cart.
 *
 * The fixture contract (design §6) allows a prepared start, for example a lever
 * beside a powered rail. The host performs that exact mechanism interaction and
 * reports whether one was operated; the caller re-reads the rail afterwards and
 * keeps `rail_not_powered` when the rail is still unpowered. A stationary cart
 * never launches itself on flat track (live probe, 2026-09-17), so the
 * mechanism only powers the track: the caller still waits for real motion.
 */
async function operateLaunchMechanism(ctx: VehicleContext, cartPosition: { x: number, y: number, z: number }): Promise<boolean> {
  const port = ctx.port
  if (!port.getBlocksRegion)
    return false
  const from = {
    x: Math.floor(cartPosition.x) - MECHANISM_RADIUS,
    y: Math.floor(cartPosition.y) - 1,
    z: Math.floor(cartPosition.z) - MECHANISM_RADIUS,
  }
  const to = {
    x: Math.floor(cartPosition.x) + MECHANISM_RADIUS,
    y: Math.floor(cartPosition.y) + 1,
    z: Math.floor(cartPosition.z) + MECHANISM_RADIUS,
  }
  let entries
  try {
    entries = await port.getBlocksRegion(from, to)
  }
  catch {
    return false
  }
  let best: { x: number, y: number, z: number, distance: number } | undefined
  for (const entry of entries) {
    if (!entry.id.endsWith('lever'))
      continue
    const distance = Math.hypot(entry.x + 0.5 - cartPosition.x, entry.z + 0.5 - cartPosition.z)
    if (distance < 1 || distance > MECHANISM_RADIUS)
      continue
    if (best && distance >= best.distance)
      continue
    best = { x: entry.x, y: entry.y, z: entry.z, distance }
  }
  if (!best)
    return false
  const state = await port.getState()
  const dx = best.x + 0.5 - state.position.x
  const dz = best.z + 0.5 - state.position.z
  const horizontal = Math.hypot(dx, dz)
  const yaw = Math.atan2(-dx, dz) * 180 / Math.PI
  const pitch = Math.atan2(state.position.y + MECHANISM_AIM_EYE_HEIGHT - (best.y + 0.5), horizontal) * 180 / Math.PI
  await port.look(yaw, pitch)
  await ctx.sleep(MECHANISM_AIM_SETTLE_MS)
  await ctx.port.useBlock({ x: best.x, y: best.y, z: best.z })
  return true
}

async function runMinecartTravel(ctx: VehicleContext, session: SessionState, goal: { x: number, y: number, z: number }, tolerance: number): Promise<TravelOutcome> {
  const port = ctx.port
  const firstObservation = await observeRidden(ctx, session.uuid)
  const speedBefore = observationSpeed(firstObservation) ?? 0
  const launchDeadline = ctx.now() + LEGACY_MINECART_DEADLINE_MS
  const verifyDeadline = ctx.now() + LAUNCH_VERIFY_MS
  // The launch verdict is decided once, from real speed and power facts.
  let launchChecked = false
  // A bridge whose clock stalls must not spin forever: the poll bound is a
  // safety net under the deadline, not the primary stop condition.
  let polls = 0

  for (;;) {
    if (ctx.shouldStop())
      return { status: 'cancelled', speed: observationSpeed(await observeRidden(ctx, session.uuid)) }
    if (++polls > 5_000)
      return { status: 'stuck', failure: 'launch_unavailable', detail: 'the cart never moved' }
    const state = await port.getState()
    trackDistance(session, state.position)
    // A destroyed cart stops producing observations; the riding read is the
    // fact that names it ehicle_lost instead of a generic speed failure
    // (live V-09a: a killed cart reported launch_unavailable).
    if (polls % RIDING_CHECK_EVERY === 0) {
      const riding = await port.getRiding()
      if (session.uuid && (!riding || (riding.uuid && riding.uuid !== session.uuid)))
        return { status: 'stuck', failure: 'vehicle_lost', detail: 'the cart is no longer under the player' }
    }
    const observation = await observeRidden(ctx, session.uuid)
    if (session.dimension && observation?.dimension !== undefined && observation.dimension !== session.dimension)
      return { status: 'stuck', failure: 'dimension_changed', detail: 'the world binding changed mid-trip' }
    if (controllerChanged(session, observation))
      return { status: 'stuck', failure: 'passenger_changed', detail: 'another player now controls the minecart' }
    const speed = observationSpeed(observation) ?? 0
    if (horizontalDistance(state.position, goal) <= tolerance)
      return { status: 'reached', onGround: state.onGround, inWater: state.inWater, speed }

    const powered = observation?.state.kind === 'minecart' ? observation.state.powered : 'unobserved'
    // An explicitly unpowered rail is a typed failure, but a prepared start
    // mechanism beside the rail is first operated once (design §6): the host
    // may perform that exact mechanism interaction, then the next poll decides
    // from the re-read rail state.
    if (!launchChecked && powered === false) {
      // A coasting cart counts as launched: after a slope or the dispatch
      // settle the cart can already sit on a plain rail, and reading only the
      // rail mislabeled a rolling cart as rail_not_powered (live V-06).
      if (speed > MINECART_MOVING_SPEED) {
        launchChecked = true
      }
      else if (!session.launchMechanismUsed) {
        session.launchMechanismUsed = true
        const operated = await operateLaunchMechanism(ctx, state.position)
        if (operated) {
          await ctx.sleep(MECHANISM_SETTLE_MS)
          continue
        }
      }
      else {
        return { status: 'stuck', failure: 'rail_not_powered', detail: 'the rail under the cart is not powered' }
      }
    }

    if (!launchChecked && ctx.now() >= verifyDeadline) {
      const launch = observeMinecartLaunch({ speedBefore, speedAfter: speed, powered })
      session.launchVerified = launch.launched
      if (!launch.launched && launch.reason === 'rail_not_powered')
        return { status: 'stuck', failure: 'rail_not_powered', detail: 'the cart never gained speed and no propulsion was observed' }
      // A verified launch or an unobservable one stops the launch check; the
      // travel deadline below still bounds an unobservable cart.
      launchChecked = true
    }

    if (ctx.now() > launchDeadline && speed <= 0.02)
      return { status: 'stuck', failure: 'launch_unavailable', detail: 'the cart stopped or never moved before the goal' }

    await port.setInput({ forward: false })
    await ctx.sleep(400)
  }
}

/**
 * Runs the shared lifecycle for one vehicle travel.
 *
 * Returns the MC-3b-compatible status plus the typed failure and the full
 * receipt so the game host can record what actually happened.
 */
export async function runVehicleTravel(kind: VehicleKind, options: VehicleMoveOptions): Promise<VehicleMoveResult> {
  const sleep = options.deps?.sleep ?? defaultSleep
  const now = options.deps?.now ?? (() => Date.now())
  const shouldStop = options.shouldStop ?? (() => false)
  const port = options.port
  const tolerance = options.tolerance ?? (kind === 'boat' ? 1.5 : 2)
  const goal = { x: options.goal.x, y: options.goal.y, z: options.goal.z }
  const entityKind = entityKindForMover(kind)
  const ctx: VehicleContext = {
    port,
    shouldStop,
    sleep,
    now,
    kind,
    travelDeadline: now() + (options.travelBudgetMs ?? DEFAULT_TRAVEL_BUDGET_MS),
    ...(options.debug ? { debug: options.debug } : {}),
  }
  const session: SessionState = {
    commandId: options.commandId ?? 'vehicle-travel',
    controlSessionId: options.controlSessionId ?? 'vehicle-session',
    controlSessionGeneration: options.controlSessionGeneration ?? 0,
    mover: kind,
    kind: entityKind,
    phase: 'discover',
    phases: [],
    method: options.strategy ?? 'existing',
    asset: undefined,
    controlVerified: 'unobserved',
    distance: 0,
    ...(options.playerUuid ? { playerUuid: options.playerUuid } : {}),
  }

  const failureResult = (failure: VehicleFailureReason, detail: string | undefined, status: VehicleMoveResult['status']): VehicleMoveResult => ({
    status,
    ...(detail ? { detail } : {}),
    failure,
    receipt: buildReceipt(session, { dismounted: false, failure, endReason: failure }),
  })

  try {
    notePhase(session, 'discover')
    const riding = await port.getRiding()
    if (riding)
      session.dimension = undefined

    notePhase(session, 'prepare')
    if (options.vehicleUuid)
      session.uuid = options.vehicleUuid

    notePhase(session, 'acquire')
    const acquired = await acquireVehicle({
      kind: entityKind,
      port,
      goal,
      options,
      shouldStop,
      sleep,
      now,
      ...(options.debug ? { debug: options.debug } : {}),
    })
    session.method = acquired.method
    if (acquired.uuid)
      session.uuid = acquired.uuid
    if (acquired.asset)
      session.asset = acquired.asset
    session.controlVerified = acquired.controlVerified
    if (!acquired.ok) {
      notePhase(session, 'finish')
      return {
        status: acquired.failure === 'cancelled' ? 'cancelled' : 'unavailable',
        ...(acquired.detail ? { detail: acquired.detail } : {}),
        ...(acquired.failure ? { failure: acquired.failure } : {}),
        receipt: buildReceipt(session, { dismounted: false, failure: acquired.failure, endReason: acquired.failure ?? 'acquire_failed' }),
      }
    }
    ctx.debug?.(`${kind} acquired via ${acquired.method}`)

    notePhase(session, 'verify-control')
    const controlState = await port.getState()
    trackDistance(session, controlState.position)
    session.dimension = controlState.observation?.dimension
    // Being mounted without the bridge able to verify control is recorded, not
    // silently upgraded to success (CD-0 §3.3).
    if (session.controlVerified === 'unobserved' && !port.observeVehicle)
      ctx.debug?.('vehicle control unverified: the bridge has no vehicle observation tool')

    notePhase(session, 'plan')
    // The route graphs are applied where a read exists; a bridge without the
    // terrain capability leaves the route unverified rather than inventing one.
    if (!port.readTerrain)
      ctx.debug?.('vehicle route unverified: no terrain read capability')

    notePhase(session, 'travel')
    const travel = kind === 'boat'
      ? await runBoatTravel(ctx, session, goal, tolerance)
      : kind === 'horse'
        ? await runHorseTravel(ctx, session, goal, tolerance)
        : await runMinecartTravel(ctx, session, goal, tolerance)

    if (travel.status === 'cancelled') {
      notePhase(session, 'dock')
      const dismount = await safeDismount(ctx, session, travel)
      notePhase(session, 'finish')
      return {
        status: 'cancelled',
        ...(travel.detail ? { detail: travel.detail } : {}),
        ...(dismount.failure ? { failure: dismount.failure } : {}),
        receipt: buildReceipt(session, {
          dismounted: dismount.dismounted,
          failure: dismount.failure,
          endReason: 'cancelled',
        }),
      }
    }
    if (travel.status === 'stuck') {
      notePhase(session, 'dock')
      const dismount = await safeDismount(ctx, session, travel)
      notePhase(session, 'finish')
      return {
        status: 'stuck',
        ...(travel.detail ? { detail: travel.detail } : {}),
        ...(travel.failure ? { failure: travel.failure } : {}),
        receipt: buildReceipt(session, {
          dismounted: dismount.dismounted,
          failure: travel.failure ?? dismount.failure ?? 'route_unavailable',
          endReason: travel.failure ?? 'route_unavailable',
        }),
      }
    }

    notePhase(session, 'dock')
    const dock = await dockVehicle(ctx, session, travel)
    notePhase(session, 'finish')
    const dockPosition = session.lastPosition
    const receipt: VehicleReceipt = buildReceipt(session, {
      dismounted: dock.dismounted,
      ...(dock.arrivedMounted ? { arrivedMounted: true } : {}),
      ...(dockPosition ? { dockPosition } : {}),
      ...(dock.failure ? { failure: dock.failure } : {}),
      endReason: dock.arrivedMounted ? 'arrived_mounted' : 'reached',
    })
    return { status: 'reached', receipt, ...(dock.failure ? { failure: dock.failure } : {}) }
  }
  catch (error) {
    const detail = errorMessageFrom(error) ?? 'unknown vehicle travel error'
    notePhase(session, 'finish')
    return failureResult('route_unavailable', detail, 'unavailable')
  }
  finally {
    await clearInput(port)
  }
}

/**
 * Docks at the goal.
 *
 * A boat picks a bank dismount point first; when no bank exists it stays
 * mounted and reports `arrived_mounted`. A minecart dismounts only when slow
 * and on safe footing (design §4, §6).
 */
async function dockVehicle(ctx: VehicleContext, session: SessionState, travel: TravelOutcome): Promise<{ dismounted: boolean, arrivedMounted?: boolean, failure?: VehicleFailureReason }> {
  const state = await ctx.port.getState()
  const onGround = travel.onGround ?? state.onGround
  const inWater = travel.inWater ?? state.inWater
  if (session.kind === 'boat' && (inWater || !onGround)) {
    // No bank at the goal: keep the boat and report the fact honestly.
    return { dismounted: false, arrivedMounted: true }
  }
  if (session.kind === 'minecart') {
    // A stance needs ground: a `reached` cart over the fixture's break
    // dismounted the player into open air and a fall (live V-08, 2026-09-17).
    // An unreadable support read is not a stance (CD-0 §3.3).
    const support = await ctx.port.getBlock({
      x: Math.floor(state.position.x),
      y: Math.floor(state.position.y) - 1,
      z: Math.floor(state.position.z),
    })
    const stance = support !== undefined && support.air !== true
    if (!stance || !minecartDismountSafe({ speed: travel.speed ?? 0, onRail: 'unobserved', atStation: true }))
      return { dismounted: false, arrivedMounted: true, failure: 'unsafe_dismount' }
  }
  const riding = await ctx.port.getRiding()
  if (session.uuid && riding?.uuid && riding.uuid !== session.uuid)
    return { dismounted: false, arrivedMounted: true, failure: 'vehicle_lost' }
  if (!riding)
    return { dismounted: false }
  await ctx.port.dismount()
  return { dismounted: true }
}
