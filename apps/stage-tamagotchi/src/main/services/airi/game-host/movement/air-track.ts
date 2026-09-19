import type { LiveFlightControl } from '../flight/live-port'
import type { FlightPlannerSwitch } from '../flight/profile'
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
import type { EscortMode, EscortPermission } from './escort'
import type { MovementControlPort, MovementState } from './port'
import type { TargetObservation } from './target-observation'
import type { Vec3 } from './types'

import { createLiveCorridorPort } from '../flight/live-corridor'
import { planLiveFlightControl } from '../flight/live-port'
import { classifyTouchdown } from '../flight/touchdown'
import { createAirFollowController, DEFAULT_AIR_FOLLOW_BUDGET } from './air-follow'
import { createAirSpacingPolicy, DEFAULT_AIR_SPACING_BAND } from './air-spacing'
import { countBySuffix, equipElytra, selectBySuffix, stopIfOwner } from './elytra'
import { createEscortPolicy } from './escort'
import { createEscortSuggestionChannel } from './escort-say'
import { energyMarginForAge, planCruiseThrust, routeDetourRatio } from './flight-energy'
import { clamp, defaultSleep, horizontalDistance, pointAtYaw, yawTo } from './geometry'
import { launchFromGround } from './launch'

const AIR_TRACK_POLL_MS = 200
const AIR_TAKEOFF_TIMEOUT_MS = 10_000
const AIR_DEPLOY_TIMEOUT_MS = 4_000
const AIR_TRACK_BUDGET_MS = 120_000
const AIR_SAFETY_TIMEOUT_MS = 30_000
const TOUCHDOWN_SETTLE_MS = 5_000
const SETTLE_MAX_POLLS = 10
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
  /**
   * CD-E B0 rollout-planner switch for the cruise leg; absent keeps the
   * steer-at-target heuristics byte-identically.
   */
  flightPlanner?: FlightPlannerSwitch
  /**
   * World binding the corridor read belongs to.
   *
   * The corridor plans over live terrain, so it needs the dimension and world
   * the flight is bound to. Without a binding the driver keeps the direct goal
   * instead of planning over a world it cannot name.
   */
  world?: { worldId: string, dimension: string, mapVersion: string }
  /**
   * LR-1 escort switch (escort design D1/D2/D4).
   *
   * `off` (the default) keeps the pre-escort flow: the launch is assessed and
   * taken on resource grounds alone, and the cruise leg has no honest
   * termination. `on` adds the D2 feasibility gate before the takeoff and the
   * D4 closure window during the chase. `suggest` adds the same, and both modes
   * may ask the player for cooperation through {@link AirTrackOptions.suggest}.
   *
   * NOTICE: the design's "suggest without chasing" half of `suggest` is not
   * implemented — the mode still flies and gates like `on`. Removal condition:
   * when the ground-follow loop can compose a suggestion from the ground.
   */
  escort?: EscortMode
  /** D4 window tuning; the design's 5 s default applies when absent. */
  escortClosure?: { windowMs?: number, stalledWindowsLimit?: number }
  /**
   * LR-2: sends one cooperative suggestion to the player's chat.
   *
   * Absent means the command cannot ask for help: the chase still runs, it just
   * cannot improve its odds by cooperation (escort design D3).
   */
  suggest?: (text: string) => Promise<void>
  /** Reads the age of the newest target observation, in ms (receipt field). */
  readTargetAgeMs?: () => number
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
  /** CD-E B0: rollout planner for the cruise leg; absent keeps the heuristics. */
  const planner = options.flightPlanner?.enabled === true ? options.flightPlanner : undefined
  /**
   * B0 item 2: the coarse corridor over the live window. It only exists while
   * the planner switch is on and the flight knows its world binding; either
   * missing keeps the pre-B0 direct goal (see `AirTrackOptions.world`).
   */
  const corridor = planner && options.world
    ? createLiveCorridorPort({ port: options.port, planner, ...options.world, ...(options.deps?.now ? { now: options.deps.now } : {}) })
    : undefined
  let lastRocketAt: number | undefined
  /**
   * LR-1 escort strategy. It exists only while the config asks for it: with
   * `off` the controller gets no escort option at all, so the state machine and
   * the receipt stay exactly as they were before this batch.
   */
  const escortMode: EscortMode = options.escort ?? 'off'
  const escort = escortMode === 'off'
    ? undefined
    : createEscortPolicy({
        mode: escortMode,
        reserve: options.budget?.reserveFireworks ?? DEFAULT_AIR_FOLLOW_BUDGET.reserveFireworks,
        ...(options.escortClosure ? { closure: options.escortClosure } : {}),
      })
  /**
   * LR-2 suggestion channel. It exists only when the caller supplied a chat
   * sender: without one the chase still runs, it just cannot ask for help.
   */
  const suggestions = escort && options.suggest
    ? createEscortSuggestionChannel({ say: options.suggest, now })
    : undefined
  /**
   * The gate is re-evaluated on the latest read, not once at takeoff: the
   * target can turn, land or vanish between two polls, and a stale permission
   * would spend a launch on a chase that no longer exists (escort design D2).
   *
   * `approve` is synchronous because the controller answers inside its step, so
   * the loop publishes the current facts here before each step.
   */
  let escortPermission: EscortPermission | undefined
  let escortObservation: TargetObservation | undefined
  let escortSelf = { position: { x: 0, y: 0, z: 0 } as Vec3, fireworks: 0, canFly: false }
  let escortBlocked = false
  /** Distance flown with the glider, in blocks; the receipt reports per km. */
  let flownBlocks = 0
  let previousPosition: Vec3 | undefined
  /** Closure series for the receipt; the driver owns it because it reads distance. */
  let closureRecords: AirFollowReceipt['escortClosure'] = []

  const controller = options.controller ?? createAirFollowController({
    travelMode: 'auto',
    spacing: band,
    ...(options.budget ? { budget: options.budget } : {}),
    ...(escort
      ? {
          escort: {
            mode: 'on' as const,
            approve: (): 'assess' | 'launch' | 'hold' => {
              // No readable target: the gate has nothing to judge, so the
              // controller's own assessment keeps owning the decision.
              if (!escortObservation?.position)
                return 'assess'
              if (escortBlocked || escort.inconclusive())
                return 'hold'
              const permission = escort.assessLaunch({
                observation: escortObservation,
                self: { position: escortSelf.position, fireworks: escortSelf.fireworks, reserve: escort.reserve(), canFly: escortSelf.canFly },
              })
              if (!permission)
                return 'assess'
              escortPermission = permission
              if (permission.ok)
                return 'launch'
              // A refusal is a decision, not a missing reading: record it and
              // stop spending polls on the same no (escort design D2/D5).
              escortBlocked = true
              debug?.(`escort refused the launch: ${permission.reason}${permission.requiredRockets !== undefined ? ` (needs ${permission.requiredRockets} rockets)` : ''}`)
              return 'hold'
            },
          },
        }
      : {}),
  })
  /**
   * The strategy stream is main-process polling at 5 Hz; the receipt says so
   * until a dedicated IPC stream exists (escort design D6).
   */
  const pollingReceipt = (): AirFollowReceipt => {
    const snapshot = controller.snapshot()
    const distanceKm = flownBlocks / 1000
    return {
      ...snapshot,
      updateStream: 'polling',
      ...(corridor ? { corridor: corridor.status() } : {}),
      ...(escort
        ? {
            escortGate: escortPermission ? (escortPermission.ok ? 'launch' : escortPermission.reason) : 'not_assessed',
            escortClosure: closureRecords,
            reserveFireworks: escort.reserve(),
            escortSuggestions: escort.suggestionsSent(),
            // First-round proxy: straight-line distance between self reads, so
            // it is a lower bound on the flown path (acceptance checklist:
            // fireworks per km is a tuning input, not a criterion, until LR-3).
            flightDistanceKm: Math.round(distanceKm * 100) / 100,
            ...(distanceKm > 0 ? { fireworksPerKm: Math.round((snapshot.fireworkSpend / distanceKm) * 100) / 100 } : {}),
          }
        : {}),
      ...(options.readTargetAgeMs ? { lastTargetAgeMs: Math.round(options.readTargetAgeMs()) } : {}),
    }
  }
  const spacing = createAirSpacingPolicy({ band, lateralOffset: Math.max(2, band.min / 6) })

  const equip = await equipElytra(port, debug)
  if (!equip.ok)
    return { status: 'cannot_air_follow', detail: equip.detail, receipt: pollingReceipt() }
  const fireworkSlot = await selectBySuffix(port, 'firework_rocket')
  let fireworks = await countBySuffix(port, 'firework_rocket')
  if (fireworkSlot === undefined && fireworks === 0)
    return { status: 'cannot_air_follow', detail: 'no firework rockets in the inventory', receipt: pollingReceipt() }
  // An offhand-only rocket still launches (the macro fires that hand), but the
  // thrust below selects a hotbar slot, so `fireworkSlot` may stay undefined.

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
  // LR-1 D2: the feasibility gate owns the decision to spend a launch at all.
  // `equipElytra` above already proved the suit, so `canFly` is a fact here.
  if (escort && !escortBlocked && initialObservation?.position) {
    const permission = escort.assessLaunch({
      observation: initialObservation,
      self: { position: state.position, fireworks, reserve: escort.reserve(), canFly: true },
    })
    if (permission) {
      escortPermission = permission
      if (!permission.ok) {
        escortBlocked = true
        debug?.(`escort refused the takeoff: ${permission.reason}`)
        return {
          status: permission.reason === 'cannot_fly' ? 'cannot_air_follow' : 'low_supply',
          detail: `escort refused the takeoff: ${permission.reason}`,
          receipt: pollingReceipt(),
        }
      }
    }
  }
  const takeoffYaw = initialObservation?.position ? yawTo(state.position, initialObservation.position) : state.yaw
  try {
    await port.look(takeoffYaw, 0)
    // OV-5/OV-D16: the bridge's per-tick launch macro takes off from wherever
    // the bot stands, including flat ground. This path used to hold
    // `forward + sprint` and then press jump without releasing them, which is
    // the sequence that never opened the glider (holding a key is not a new
    // press). The macro owns the release, so the edge run below is the fallback
    // for a bridge without the macro and for a real drop it can still fly.
    const launchGoal = initialObservation?.position
      ? { x: initialObservation.position.x, y: initialObservation.position.y + 20, z: initialObservation.position.z }
      : pointAtYaw(state.position, takeoffYaw, 40)
    const macro = await launchFromGround({
      port,
      goal: launchGoal,
      fireworks,
      shouldStop,
      stillOwnsControl: ownsControl,
      now,
      sleep,
      pollMs: AIR_TRACK_POLL_MS,
      ...(debug ? { debug } : {}),
    })
    if (macro?.outcome === 'cancelled')
      return { status: 'cancelled', detail: 'cancelled during the launch', receipt: pollingReceipt() }
    state = await port.getState()
    deployed = macro?.deployed === true || state.fallFlying === true
    if (!deployed) {
      await port.setInput({ forward: true, sprint: true })
      const takeoffDeadline = now() + AIR_TAKEOFF_TIMEOUT_MS
      while (state.onGround) {
        if (shouldStop() || now() > takeoffDeadline)
          break
        await sleep(AIR_TRACK_POLL_MS)
        state = await port.getState()
      }
      deployed = state.fallFlying === true
      // Release every key before the deploy press: while the run keys stay held
      // the press is not a new press (the E-01 root cause).
      if (!deployed)
        await stopIfOwner(port, ownsControl)
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
  }
  finally {
    await stopIfOwner(port, ownsControl)
  }
  if (!deployed) {
    return { status: 'cannot_air_follow', detail: 'elytra did not deploy', receipt: pollingReceipt() }
  }
  // The driver hands over to the cruise from fresh state (OV-D17).
  state = await port.getState()

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

      // Distance is accumulated from consecutive self reads, so the per-km
      // figure is a lower bound on the flown path (see the receipt field).
      if (previousPosition) {
        flownBlocks += Math.hypot(
          state.position.x - previousPosition.x,
          state.position.y - previousPosition.y,
          state.position.z - previousPosition.z,
        )
      }
      previousPosition = { ...state.position }

      /**
       * Publish the facts the synchronous escort gate reads.
       *
       * The controller answers inside its step, so the gate cannot await a read
       * of its own; `escortObservation` is this poll's read and drives both the
       * D2 gate and the D4 closure window.
       */
      escortObservation = observation
      escortSelf = { position: state.position, fireworks, canFly: true }
      const escortDistance = observation?.position
        ? horizontalDistance(state.position, observation.position)
        : undefined
      if (escort && escortDistance !== undefined) {
        const verdict = escort.feed({ at: now(), distance: escortDistance })
        closureRecords = verdict.records
        // LR-2 (escort design D3): one stalled window is the moment to ask the
        // player for cooperation — heading and speed are the two things the
        // design lets the agent ask for. The channel owns the rate limit (two a
        // minute) and never repeats identical text, and the policy only counts a
        // suggestion that actually left the application.
        if (verdict.status === 'stalled' && suggestions && observation?.velocity) {
          const heading = Math.atan2(-observation.velocity.x, observation.velocity.z) * 180 / Math.PI
          const outcome = await suggestions.send({ heading, kind: 'hold_heading', gapBlocks: escortDistance })
          if (outcome === 'sent') {
            escort.noteSuggestionSent()
            debug?.(`air-follow suggestion sent (gap ${escortDistance.toFixed(0)})`)
          }
          else if (outcome === 'failed') {
            debug?.('air-follow suggestion could not be delivered')
          }
        }
      }

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

      // LR-1 D4: two consecutive non-closing windows end the chase honestly.
      // The bounded safety landing runs instead of burning more rockets
      // (escort design D4/D5); the D5 receipt keeps the closure series.
      if (escort?.inconclusive() && controller.phase() !== 'safety-landing') {
        controller.noteFlightLost('escort_inconclusive')
        safetyDeadline = safetyDeadline || now() + AIR_SAFETY_TIMEOUT_MS
      }

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

      let yaw = yawTo(state.position, target)
      let gap = horizontalDistance(state.position, target)
      let height = state.position.y - target.y
      let pitch: number
      let wantThrust = false
      /** LR-3: which energy case spent the rocket, for the debug trail. */
      let thrustReason = 'economy'
      /** Rockets this command may not spend on progress (escort design D4). */
      const thrustReserve = escort?.reserve() ?? DEFAULT_AIR_FOLLOW_BUDGET.reserveFireworks
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
        // CD-E B0: while the rollout planner switch is on, its chosen
        // primitive replaces the steer-at-target and threshold-ignition
        // heuristics for this poll; any planner miss keeps the heuristics.
        let applied: LiveFlightControl | undefined
        if (planner) {
          // B0 item 2: the coarse corridor owns the near-field route hint. A
          // route point replaces the direct goal so the rollout plans around
          // terrain it can see; any refusal (unknown window, no route, failed
          // read) keeps the direct goal, because unknown space is not a route.
          if (corridor) {
            const routeAim = await corridor.step(state.position, target)
            if (routeAim) {
              // LR-4: the route's own bend is the detour measurement the D2 gate
              // used to guess at with a constant. The gate is re-asked on the
              // next pre-takeoff check with this value.
              escort?.noteDetourRatio(routeDetourRatio({ self: state.position, aim: routeAim, goal: target }))
              target = routeAim
              // The route point is a different aim: re-derive the heading and the
              // glide budget against it instead of the pre-route goal.
              yaw = yawTo(state.position, target)
              gap = horizontalDistance(state.position, target)
              height = state.position.y - target.y
            }
            else if (corridor.status() !== 'planned') {
              debug?.(`air-follow corridor ${corridor.status()}; aiming direct`)
            }
          }
          applied = await planLiveFlightControl({ planner, port, state, poll: tick, fireworks, health: state.health ?? 20, goal: target, lastRocketAt, now })
          if (!applied)
            debug?.('air-follow rollout fell back to heuristics')
        }
        if (applied) {
          yaw = applied.yaw
          pitch = applied.pitch
          // LR-3: the rollout planner owns which primitive to fly, but it does
          // not own the economy — the landing reserve is not progress supply.
          wantThrust = applied.useRocket && fireworks - thrustReserve > 0
          thrustReason = applied.useRocket ? 'required_height' : 'economy'
        }
        else {
          const climbing = target.y - state.position.y > 4
          pitch = climbing ? CLIMB_PITCH : clamp(-(target.y - state.position.y) * 1.2, -30, 35)
          // LR-3 (escort design D4): spend only for the height the remaining
          // glide needs, for the glide floor, or for a chase that is not closing.
          // The three independent thresholds this replaces fired on most polls of
          // a long chase and cost 114 rockets in a 108 s follow.
          const energy = planCruiseThrust({
            gap,
            height,
            speed: horizontalSpeed(state),
            ...(closureRecords.at(-1)?.closureRatePerSecond !== undefined
              ? { closingRatePerSecond: closureRecords.at(-1)!.closureRatePerSecond! }
              : {}),
            ...(distanceToAim !== undefined ? { behindBand: distanceToAim > band.max } : {}),
            fireworks,
            reserve: thrustReserve,
            heightMargin: energyMarginForAge(options.readTargetAgeMs?.()),
          })
          wantThrust = energy.thrust
          thrustReason = energy.reason
          if (energy.thrust) {
            debug?.(`air-follow thrust ${energy.reason} need=${energy.requiredHeight.toFixed(1)} surplus=${energy.surplusHeight.toFixed(1)} spendable=${energy.spendable}`)
          }
        }
      }
      await port.look(yaw, pitch)

      if (fireworks > 0 && fireworkSlot !== undefined && wantThrust) {
        debug?.(`air-follow ignition ${thrustReason}`)
        await port.selectHotbar(fireworkSlot)
        await port.useItem()
        lastRocketAt = now()
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
      return { ...terminated, receipt: pollingReceipt() }
    if (touchdown === 'water')
      return { status: 'unknown', detail: 'landing_in_water', receipt: pollingReceipt() }
    if (touchdown !== 'landed')
      return { status: 'unknown', detail: touchdown, receipt: pollingReceipt() }
    const reason = controller.snapshot().endReason
    return { status: statusForReason(reason), receipt: pollingReceipt() }
  }
  finally {
    // LR-2: the command is over, so the channel must not ask the player for
    // anything else (design D3: no suggestions after the chase ends).
    suggestions?.close()
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
    case 'cannot_catch_up':
      return 'lost'
    case 'escort_inconclusive':
      // The chase ended by its own closure verdict and flew a bounded safety
      // landing; that is a completed air segment, not a lost one.
      return 'landed'
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
