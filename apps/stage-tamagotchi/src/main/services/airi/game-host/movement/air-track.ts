/**
 * Continuous air follow driver (air-follow design §3–§5, CD-F1–CD-F2).
 *
 * This is the client-side "flight session" for a follow command: it owns the
 * per-tick inputs while the main-process policy owns the state and budget. It
 * reuses the pure {@link createAirFollowController} and
 * {@link createAirSpacingPolicy}, so the same decisions are exercised offline.
 *
 * The driver never copies the target's exact flown gap: it steers at the lagged
 * aim point plus a lateral offset, and lands beside the target's ground position
 * instead of onto its feet. A cancel or a budget limit enters a bounded safety
 * landing; a glide that stops without a confirmed touch-down stays `unknown`.
 */
import type { AirFollowBudgetLimits, AirFollowController, AirFollowReceipt } from './air-follow'
import type { MovementControlPort, MovementState } from './port'
import type { TargetObservation } from './target-observation'
import type { Vec3 } from './types'

import { classifyTouchdown } from '../flight/touchdown'
import { createAirFollowController } from './air-follow'
import { createAirSpacingPolicy, DEFAULT_AIR_SPACING_BAND } from './air-spacing'
import { countBySuffix, equipElytra, selectBySuffix, stopIfOwner } from './elytra'
import { clamp, defaultSleep, horizontalDistance, yawTo } from './geometry'

const AIR_TRACK_POLL_MS = 200
const AIR_TAKEOFF_TIMEOUT_MS = 10_000
const AIR_DEPLOY_TIMEOUT_MS = 4_000
const AIR_TRACK_BUDGET_MS = 120_000
const AIR_SAFETY_TIMEOUT_MS = 30_000
const TOUCHDOWN_SETTLE_MS = 5_000
const SETTLE_MAX_POLLS = 10
/** Horizontal speed under which the glider needs thrust to keep up. */
const THRUST_SPEED = 0.45
/** Nose-up angle used to climb over terrain or toward a higher target. */
const CLIMB_PITCH = -30
/** Nose-up angle that bleeds the sink right before touch-down. */
const FLARE_PITCH = -6
const FLARE_HEIGHT = 6
const FLARE_WINDOW = 14
const FLARE_DISTANCE = 16
/** A late landing assist fires when the sink exceeds this (blocks/tick). */
const LANDING_ASSIST_FALL_SPEED = -0.6
/** Ground distance kept from the target's feet when approaching its landing. */
const APPROACH_LATERAL_MIN = 6

export type AirTrackStatus
  = | 'landed'
    | 'cancelled'
    | 'cannot_air_follow'
    | 'low_supply'
    | 'lost'
    | 'unknown'

export interface AirTrackResult {
  status: AirTrackStatus
  detail?: string
  receipt: AirFollowReceipt
}

export interface AirTrackOptions {
  port: MovementControlPort
  /** Reads one fresh target observation; undefined when the read failed. */
  readTarget: () => Promise<TargetObservation | undefined>
  /** Air spacing band; the ground keep distance is a separate parameter. */
  band?: { min: number, max: number }
  budget?: Partial<AirFollowBudgetLimits>
  /** Wall-clock budget of the air segment, ms. */
  airBudgetMs?: number
  /** Absolute command deadline, ms. */
  deadline?: number
  shouldStop?: () => boolean
  stillOwnsControl?: () => boolean
  /**
   * The already-created state machine.
   *
   * The follow command owns one controller across its ground and air phases, so
   * the receipt and the launch block survive the handover (CD-F3). The driver
   * creates one when the caller does not supply it.
   */
  controller?: AirFollowController
  deps?: {
    sleep?: (ms: number) => Promise<void>
    now?: () => number
  }
  debug?: (message: string) => void
}

function horizontalSpeed(state: MovementState): number {
  return state.motion ? Math.hypot(state.motion.x, state.motion.z) : 0
}

/**
 * Aim point beside the target's ground position.
 *
 * The offset is perpendicular to the approach direction, so the follower lands
 * beside the target instead of intersecting its collision box (design §5).
 */
function approachAim(self: Vec3, target: Vec3, band: { min: number, max: number }): Vec3 {
  const dx = target.x - self.x
  const dz = target.z - self.z
  const length = Math.hypot(dx, dz) || 1
  const offset = Math.max(APPROACH_LATERAL_MIN, band.min)
  return {
    x: target.x + (-dz / length) * offset,
    y: target.y,
    z: target.z + (dx / length) * offset,
  }
}

/**
 * Runs a continuous air follow until the target lands, a budget is reached or
 * the command is cancelled.
 *
 * `landed` means the follower touched down cleanly and the follow loop may
 * resume the ground controller in the same command. `cannot_air_follow` and
 * `lost` are typed limitations, never a fabricated arrival.
 *
 * @example
 * const result = await runAirTrackMove({ port, readTarget })
 * result.status
 * // => 'landed'
 */
export async function runAirTrackMove(options: AirTrackOptions): Promise<AirTrackResult> {
  const sleep = options.deps?.sleep ?? defaultSleep
  const now = options.deps?.now ?? (() => Date.now())
  const shouldStop = options.shouldStop ?? (() => false)
  const ownsControl = options.stillOwnsControl ?? (() => true)
  const port = options.port
  const debug = options.debug
  const band = options.band ?? { min: DEFAULT_AIR_SPACING_BAND.min, max: DEFAULT_AIR_SPACING_BAND.max }

  const controller = options.controller ?? createAirFollowController({ travelMode: 'auto', spacing: band, ...(options.budget ? { budget: options.budget } : {}) })
  const spacing = createAirSpacingPolicy({ band, lateralOffset: Math.max(2, band.min / 6) })

  const equip = await equipElytra(port, debug)
  if (!equip.ok)
    return { status: 'cannot_air_follow', detail: equip.detail, receipt: controller.snapshot() }
  const fireworkSlot = await selectBySuffix(port, 'firework_rocket')
  if (fireworkSlot === undefined)
    return { status: 'cannot_air_follow', detail: 'no firework rockets in the inventory', receipt: controller.snapshot() }
  let fireworks = await countBySuffix(port, 'firework_rocket')

  // Takeoff: run off the edge, then deploy the glider while falling. The whole
  // sequence releases input on every path.
  let state = await port.getState()
  let deployed = false
  let initialObservation: TargetObservation | undefined
  try {
    initialObservation = await options.readTarget()
  }
  catch {
    initialObservation = undefined
  }
  const takeoffYaw = initialObservation?.position ? yawTo(state.position, initialObservation.position) : state.yaw
  try {
    await port.look(takeoffYaw, 0)
    await port.setInput({ forward: true, sprint: true })
    const takeoffDeadline = now() + AIR_TAKEOFF_TIMEOUT_MS
    while (state.onGround) {
      if (shouldStop() || now() > takeoffDeadline)
        break
      await sleep(AIR_TRACK_POLL_MS)
      state = await port.getState()
    }
    deployed = state.fallFlying === true
    for (let attempt = 0; attempt < 3 && !deployed && !state.onGround; attempt++) {
      await port.jumpOnce()
      const deployDeadline = now() + AIR_DEPLOY_TIMEOUT_MS
      while (!deployed && now() < deployDeadline && !state.onGround) {
        await sleep(AIR_TRACK_POLL_MS)
        state = await port.getState()
        deployed = state.fallFlying === true
      }
    }
  }
  finally {
    await stopIfOwner(port, ownsControl)
  }
  if (!deployed) {
    return { status: 'cannot_air_follow', detail: 'elytra did not deploy', receipt: controller.snapshot() }
  }

  controller.noteLaunchBegan()
  controller.noteLaunchDeployed(now())

  const trackDeadline = now() + (options.airBudgetMs ?? AIR_TRACK_BUDGET_MS)
  const commandDeadline = options.deadline
  let safetyDeadline = 0
  let tick = 0
  let terminated: { status: AirTrackStatus, detail?: string } | undefined

  try {
    while (state.fallFlying === true) {
      if (!ownsControl()) {
        terminated = { status: 'unknown', detail: 'input ownership moved to a newer command' }
        break
      }
      if (shouldStop()) {
        controller.cancel()
        safetyDeadline = safetyDeadline || now() + AIR_SAFETY_TIMEOUT_MS
      }
      if (now() > trackDeadline || (commandDeadline !== undefined && now() > commandDeadline)) {
        controller.complete(now() > trackDeadline ? 'timeout' : 'follow_completed')
        safetyDeadline = safetyDeadline || now() + AIR_SAFETY_TIMEOUT_MS
      }
      if (safetyDeadline !== 0 && now() > safetyDeadline) {
        terminated = { status: 'unknown', detail: 'safety landing deadline reached' }
        break
      }

      tick += 1
      let observation: TargetObservation | undefined
      try {
        observation = await options.readTarget()
      }
      catch {
        observation = undefined
      }
      if (observation?.position)
        spacing.push({ at: now(), position: observation.position, ...(observation.velocity ? { velocity: observation.velocity } : {}) })

      const selfSample = {
        position: state.position,
        ...(state.motion ? { velocity: state.motion } : {}),
        onGround: state.onGround,
        ...(state.fallFlying !== undefined ? { fallFlying: state.fallFlying } : {}),
        ...(state.health !== undefined ? { health: state.health } : {}),
        fireworks,
      }
      const aim = spacing.aimAt(now(), state.position)
      const distanceToAim = aim ? horizontalDistance(state.position, aim.point) : undefined
      const directive = controller.step(observation, {
        tick,
        at: now(),
        fine: observation !== undefined,
        self: selfSample,
        ...(distanceToAim !== undefined ? { distance: distanceToAim } : {}),
      })
      debug?.(`air-follow ${directive.phase} d=${distanceToAim?.toFixed?.(1) ?? '?'} fw=${fireworks}`)

      if (directive.action === 'terminate') {
        terminated = { status: 'lost', ...(directive.reason ? { detail: directive.reason } : {}) }
        break
      }

      const landing = directive.action === 'approach-landing' || directive.action === 'safety-landing'
      let target: Vec3
      if (directive.action === 'safety-landing') {
        const radians = state.yaw * Math.PI / 180
        target = {
          x: state.position.x - Math.sin(radians) * 40,
          y: state.position.y - 30,
          z: state.position.z + Math.cos(radians) * 40,
        }
      }
      else if (directive.action === 'approach-landing' && observation?.position) {
        target = approachAim(state.position, observation.position, band)
      }
      else {
        target = aim?.point ?? observation?.position ?? state.position
      }

      const yaw = yawTo(state.position, target)
      const gap = horizontalDistance(state.position, target)
      const height = state.position.y - target.y
      let pitch: number
      let wantThrust = false
      if (landing) {
        if (gap <= FLARE_DISTANCE) {
          // Landing zone: ease the nose up and touch down.
          const blend = clamp((height - FLARE_HEIGHT) / FLARE_WINDOW, 0, 1)
          pitch = clamp(blend * 35 + (1 - blend) * FLARE_PITCH, FLARE_PITCH, 35)
          wantThrust = height <= FLARE_HEIGHT && (state.motion?.y ?? 0) < LANDING_ASSIST_FALL_SPEED
        }
        else {
          const required = Math.atan2(Math.max(0, height), Math.max(1, gap)) * 180 / Math.PI
          pitch = clamp(required, 0, 35)
        }
      }
      else {
        const climbing = target.y - state.position.y > 4
        pitch = climbing ? CLIMB_PITCH : clamp(-(target.y - state.position.y) * 1.2, -30, 35)
        wantThrust = climbing || horizontalSpeed(state) < THRUST_SPEED || (distanceToAim !== undefined && distanceToAim > band.max)
      }
      await port.look(yaw, pitch)

      if (fireworks > 0 && wantThrust) {
        await port.selectHotbar(fireworkSlot)
        await port.useItem()
        fireworks = await countBySuffix(port, 'firework_rocket')
        controller.noteFireworkSpent(1)
      }

      if (directive.action === 'safety-landing')
        safetyDeadline = safetyDeadline || now() + AIR_SAFETY_TIMEOUT_MS

      await sleep(AIR_TRACK_POLL_MS)
      state = await port.getState()
    }

    const touchdown = await settleTouchdown(port, state, sleep, now)
    const verified = touchdown === 'landed'
    const phase = controller.phase()
    if (verified) {
      if (phase === 'safety-landing')
        controller.noteSafetyLandingComplete(true)
      else
        controller.noteSelfLanded(now())
    }
    else if (touchdown !== 'water') {
      // The glide ended without a confirmed touch-down; the bounded safety
      // landing records the unverified stop instead of a fabricated landing.
      controller.noteFlightLost('cannot_air_follow')
      controller.noteSafetyLandingComplete(false)
    }
    else {
      controller.noteSafetyLandingComplete(false)
    }

    if (terminated)
      return { ...terminated, receipt: controller.snapshot() }
    if (touchdown === 'water')
      return { status: 'unknown', detail: 'landing_in_water', receipt: controller.snapshot() }
    if (touchdown !== 'landed')
      return { status: 'unknown', detail: touchdown, receipt: controller.snapshot() }
    const reason = controller.snapshot().endReason
    return { status: statusForReason(reason), receipt: controller.snapshot() }
  }
  finally {
    await stopIfOwner(port, ownsControl)
  }
}

function statusForReason(reason: AirFollowReceipt['endReason']): AirTrackStatus {
  switch (reason) {
    case 'follow_completed':
      return 'landed'
    case 'cancelled':
      return 'cancelled'
    case 'low_supply':
      return 'low_supply'
    case 'target_lost':
    case 'target_offline':
      return 'lost'
    case 'cannot_air_follow':
    case 'launch_unavailable':
      return 'cannot_air_follow'
    default:
      return 'landed'
  }
}

/** Waits a bounded window for the touch-down sample to settle. */
async function settleTouchdown(
  port: MovementControlPort,
  initial: MovementState,
  sleep: (ms: number) => Promise<void>,
  now: () => number,
): Promise<'landed' | 'water' | 'lost-flight' | 'unsettled' | 'unknown'> {
  let state = initial
  const reference = state.position
  let outcome = classifySample(state, reference)
  const deadline = now() + TOUCHDOWN_SETTLE_MS
  let polls = 0
  while ((outcome === 'lost-flight' || outcome === 'unsettled') && polls < SETTLE_MAX_POLLS && now() < deadline) {
    polls += 1
    await sleep(AIR_TRACK_POLL_MS)
    try {
      state = await port.getState()
    }
    catch {
      break
    }
    outcome = classifySample(state, reference)
  }
  return outcome
}

function classifySample(state: MovementState, reference: Vec3): 'landed' | 'water' | 'lost-flight' | 'unsettled' | 'unknown' {
  const result = classifyTouchdown({
    position: state.position,
    ...(state.motion ? { motion: state.motion } : {}),
    onGround: state.onGround,
    inWater: state.inWater,
    ...(state.fallFlying !== undefined ? { fallFlying: state.fallFlying } : {}),
  }, reference)
  switch (result.kind) {
    case 'landed':
      return 'landed'
    case 'water':
      return 'water'
    case 'lost-flight':
      return 'lost-flight'
    case 'unsettled':
      return 'unsettled'
    default:
      return 'unknown'
  }
}
