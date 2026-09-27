/**
 * Elytra mover (MC-3c D2/D3; elytra-navigation CD-E0).
 *
 * The client keeps the flight physics; this loop owns the intent: it wears the
 * elytra, runs off the launch edge, deploys on the way down, holds a cruise
 * band with firework thrust, and lands near the goal. Low firework supply, low
 * durability, or low health turn the loop into a bounded early landing instead
 * of a hard failure.
 *
 * CD-E0 lifecycle rules:
 *
 * - Cancellation changes the business reason immediately at any phase, then a
 *   bounded safety landing owns the cleanup. An in-progress approach never
 *   blocks it.
 * - Every phase has its own deadline, checked at the top of the loop. A slowly
 *   improving distance cannot extend the approach deadline.
 * - A go-around is a real bounded process (recover altitude, leave the approach
 *   zone, re-align). It never flips `landing` back to false into another
 *   immediate approach.
 * - Touch-down is verified from a fresh `onGround`, a plausible contact and a
 *   low residual speed. Stopping the glide is not a landing; water is its own
 *   outcome; a missing state read stays unknown.
 * - Landing targets must be verified support areas. A same-height coordinate is
 *   never recorded as a safe landing.
 */
import type { LandingSite } from '../flight/landing-site'
import type { LiveFlightControl } from '../flight/live-port'
import type { MovementControlPort, MovementState } from './port'
import type { Vec3 } from './types'
import type { VehicleMoveOptions, VehicleMoveResult } from './vehicle'

import { errorMessageFrom } from '@moeru/std'

import { evaluatePatch, lowestRoofAboveGoal } from '../flight/landing-site'
import { createLiveCorridorPort } from '../flight/live-corridor'
import { planLiveFlightControl } from '../flight/live-port'
import { LOW_ROUTE_TTL_MS, LOW_ROUTE_WAYPOINT_REACH, planLowRoute } from '../flight/low-route'
import { classifyTouchdown } from '../flight/touchdown'
import { angleDelta, clamp, defaultSleep, horizontalDistance, yawTo } from './geometry'
import { launchFromGround } from './launch'

const FLIGHT_POLL_MS = 200
/** Preferred altitude above the goal while cruising (MC-3c D2). */
const CRUISE_BAND_ABOVE = 30
const MIN_CRUISE_SPEED = 0.45
const FIREWORK_INTERVAL_MS = 1_200
const FIREWORK_LOW_SUPPLY = 3
const APPROACH_DISTANCE = 80
/** Flare floor: below this height the nose eases up to bleed descent speed. */
const FLARE_HEIGHT = 6
/** Height band over which the dive angle eases into the flare. */
const FLARE_WINDOW = 14
/** Nose-up angle in the flare; stops the sink right before touch-down. */
const FLARE_PITCH = -6
/** A late landing assist fires when the sink exceeds this (blocks/tick). */
const LANDING_ASSIST_FALL_SPEED = -0.6
/** Nose-up angle for climbing over terrain ahead. */
const CLIMB_PITCH = -30
/**
 * Steepest nose-down angle used to spend a large height surplus.
 *
 * The calibrated profile still glides at this angle (E-01 measured −1.66
 * blocks/tick of vertical speed at pitch −89), and the approach and flare below
 * pull the nose back up long before the ground.
 */
const DIVE_PITCH = 60
/**
 * Height kept above the low route's band.
 *
 * The band is the middle of a proven air slot, so a few blocks of margin cover
 * the glider's own sink between two corrections without pushing it into the
 * ceiling the slot was measured under.
 */
const LOW_ROUTE_BAND_MARGIN = 2
/** Terrain this close ahead forces a climb, never a level glide. */
const TERRAIN_GUARD_DISTANCE = 12
/** The final flare starts only this close to the aim point. */
const FLARE_DISTANCE = 16
/** Terrain scan window along the heading, in blocks. */
const SCAN_FROM = 8
const SCAN_TO = 48
/** Blocks farther than this to either side of the heading do not block flight. */
const CORRIDOR_HALF_WIDTH = 1.5
const LOW_HEALTH = 8
const TAKEOFF_TIMEOUT_MS = 10_000
const DEPLOY_TIMEOUT_MS = 4_000
const CRUISE_TIMEOUT_MS = 180_000
/** The goal approach gets its own deadline so it cannot circle before touch-down. */
const APPROACH_TIMEOUT_MS = 40_000
/** A safety landing owns a total deadline; it cannot hover forever (CD-E0). */
const SAFETY_LANDING_TIMEOUT_MS = 30_000
/** The whole go-around (all three phases) is bounded. */
const GO_AROUND_TIMEOUT_MS = 20_000
/** Height above the goal the go-around must recover before it stops climbing. */
const GO_AROUND_MIN_HEIGHT = 8
/** Distance past the approach radius before a go-around may re-align. */
const GO_AROUND_LEAVE_DISTANCE = APPROACH_DISTANCE + 12
/** Heading error under which the re-align phase hands back to the approach. */
const GO_AROUND_REALIGN_TOLERANCE_DEG = 20
/** An approach whose gap reopens by this much counts as an overshoot. */
const GO_AROUND_GAP_MARGIN = 6
/** A glide needs at least this much height per block of remaining distance. */
const MIN_GLIDE_RATIO = 0.08
/** At most this many go-arounds before the mover lands nearby instead. */
const MAX_GO_AROUNDS = 1
const STUCK_WINDOW_POLLS = 15
const STUCK_MIN_MOVE = 0.5
/** Touch-down drift the mover may close on foot before declaring a miss. */
const LANDING_WALK_LIMIT = 24
const LANDING_WALK_TIMEOUT_MS = 15_000
/**
 * Chest armor index inside the player inventory.
 *
 * NOTICE:
 * Why 38 and not 37: `Inventory` stores armor in the order boots, leggings,
 * chestplate, helmet at indices 36..39, so the chestplate is 38. The bridge's
 * `InventoryHandlers.toMenuSlot` maps 36..39 onto menu 5..8 while documenting
 * them as "helmet..boots", so a chestplate written as 37 lands on the leggings
 * slot and the swap does nothing — a live `swapSlots(5, 36)` answered `swapped`
 * while the chest slot never changed.
 * Source: D:/mcpfabric InventoryHandlers.toMenuSlot and the `Inventory` field
 * order; verified against a live inventory read on 2026-09-18.
 * Removal condition: when the bridge documents inventory indices by their real
 * field order, or exposes an armor-slot API instead of raw indices.
 */
const CHEST_ARMOR_SLOT = 38
/** Bound on the forward landing scan; the mover never aims farther ahead. */
const LANDING_SCAN_MAX = 24
/** First forward offset the landing scan tries; the nearest patch wins. */
const LANDING_SCAN_MIN = 2
/** Blocks to either side of the heading the landing scan checks. */
const LANDING_SCAN_LATERAL = 4
/** How far below the current feet the landing column scan may descend. */
const LANDING_SCAN_DEPTH = 24
/** Refresh the equipped elytra durability every 100 flight ticks (50 ms each). */
const DURABILITY_REFRESH_TICKS = 100
const MS_PER_TICK = 50
const DURABILITY_REFRESH_MS = DURABILITY_REFRESH_TICKS * MS_PER_TICK
/** Bounded wait after the glide ends for the touch-down sample to settle. */
const TOUCHDOWN_SETTLE_MS = 5_000
/** Hard cap on settle re-reads so a stuck sample cannot spin the loop. */
const SETTLE_MAX_POLLS = 10
/** Worn this far, the suit still flies but only to the nearest landing. */
const WORN_ELYTRA_RATIO = 0.75
/** Worn this far without a backup, the mover refuses to take off at all. */
const BROKEN_ELYTRA_RATIO = 0.9

type LandingReason = 'goal' | 'cancelled' | 'low_supply' | 'safety' | 'timeout'
/** The lifecycle phase the loop is in. `safety-landing` owns the cleanup. */
type FlightPhase = 'cruise' | 'approach' | 'go-around' | 'flare' | 'safety-landing'
/** The three ordered go-around phases (design §6). */
type GoAroundPhase = 'recover' | 'leave' | 're-align'

export async function runElytraMove(options: VehicleMoveOptions): Promise<VehicleMoveResult> {
  const sleep = options.deps?.sleep ?? defaultSleep
  const now = options.deps?.now ?? (() => Date.now())
  const tolerance = options.tolerance ?? 4
  const shouldStop = options.shouldStop ?? (() => false)
  const ownsControl = options.stillOwnsControl ?? (() => true)
  const port = options.port
  const debug = options.debug
  const goal: Vec3 = { x: options.goal.x, y: options.goal.y, z: options.goal.z }

  // 1. Wear the elytra; a backup replaces a worn suit before takeoff.
  const equip = await equipElytra(port, debug)
  if (!equip.ok)
    return { status: 'unavailable', detail: equip.detail }

  // 2. Rockets: the mover needs one selected stack to thrust with.
  let fireworkSlot = await selectBySuffix(port, 'firework_rocket')
  let fireworks = await countBySuffix(port, 'firework_rocket')
  if (fireworkSlot === undefined && fireworks === 0)
    return { status: 'unavailable', detail: 'no firework rockets in the inventory' }
  // `fireworkSlot` stays undefined when the only rocket sits in the offhand: the
  // launch macro can fire that hand, but the cruise thrust selects a hotbar slot,
  // so the flight takes off and reports `low_supply` instead of refusing here.

  // 3. Takeoff. The bridge's per-tick macro runs first when it exists (OV-D16):
  // it lifts off flat ground, which the edge run cannot, and it owns the two
  // single-tick steps (the deploy press after a released jump key, and the boost
  // from the airborne state) that a 200 ms poll cannot hit. The edge run stays
  // as the fallback, so a cliff takeoff does not regress.
  let state = await port.getState()
  await port.look(yawTo(state.position, goal), 0)
  const macro = await launchFromGround({
    port,
    goal,
    fireworks,
    shouldStop,
    stillOwnsControl: ownsControl,
    now,
    sleep,
    ...(debug ? { debug } : {}),
  })
  if (macro?.outcome === 'cancelled')
    return { status: 'cancelled' }
  // The macro's verdict is not the only source of truth: read once after it, so
  // the fallback run and the cruise work from the state the bot holds now.
  state = await port.getState()
  let deployed = macro?.deployed === true || state.fallFlying === true
  if (!deployed) {
    // Every path that touches input releases it (review R7).
    await port.setInput({ forward: true, sprint: true })
    try {
      const takeoffDeadline = now() + TAKEOFF_TIMEOUT_MS
      while (state.onGround) {
        if (shouldStop()) {
          await stopIfOwner(port, ownsControl)
          return { status: 'cancelled' }
        }
        if (now() > takeoffDeadline) {
          await stopIfOwner(port, ownsControl)
          return { status: 'stuck', detail: macro?.detail ?? 'no takeoff edge reached' }
        }
        await sleep(FLIGHT_POLL_MS)
        state = await port.getState()
      }

      deployed = state.fallFlying === true
      /**
       * Release the run keys before the deploy press.
       *
       * ROOT CAUSE (live, 2026-09-18):
       *
       * Holding a key is not a new press. While the takeoff sprint kept
       * `forward + sprint` held, every `jumpOnce()` was a no-op for the glider:
       * a live run off the ridge at (-384, 161, 19) fell 24 blocks with
       * `fallFlying: false` the whole way and died (`airitest fell from a high
       * place`), and the receipt reported the takeoff as unavailable. The same
       * failure cost four attempts during the E-01 calibration, where the working
       * sequence was "release every key, then press jump once".
       *
       * The release must come first and the horizontal speed survives it: in E-01
       * the glider deployed on the first press after the release and recorded a
       * 30-second glide.
       */
      if (!deployed)
        await stopIfOwner(port, ownsControl)
      for (let attempt = 0; attempt < 3 && !deployed && !state.onGround; attempt++) {
        await port.jumpOnce()
        const deployDeadline = now() + DEPLOY_TIMEOUT_MS
        while (!deployed && now() < deployDeadline && !state.onGround) {
          await sleep(FLIGHT_POLL_MS)
          state = await port.getState()
          deployed = state.fallFlying === true
        }
      }
    }
    finally {
      // The takeoff inputs must be released on every path: a state read error
      // used to leave forward+sprint held (review R7).
      await stopIfOwner(port, ownsControl)
    }
  }
  if (!deployed) {
    return { status: 'unavailable', detail: macro?.detail ?? 'elytra did not deploy' }
  }
  // OV-D17: the cruise takes over from the state the handoff left behind, read
  // fresh, so a stale pre-launch position cannot seed the cruise band.
  state = await port.getState()
  debug?.(`elytra deployed via ${macro ? macro.outcome : 'edge-run'}${macro?.detail ? ` (${macro.detail})` : ''}`)

  // 4. Cruise and land. A worn suit turns the flight into an early landing;
  // the mover never cruises on an elytra that may break mid-air.
  let reason: LandingReason = equip.lowDurability ? 'safety' : 'goal'
  let phase: FlightPhase = equip.lowDurability ? 'safety-landing' : 'cruise'
  let cruiseY = Math.max(goal.y + CRUISE_BAND_ABOVE, state.position.y)
  let lastFireworkAt = 0
  /** CD-E B0: rollout planner for the cruise phase; absent keeps the heuristics. */
  const planner = options.flightPlanner?.enabled === true ? options.flightPlanner : undefined
  /**
   * CD-E2 corridor for the cruise phase (B0 item 2 remainder).
   *
   * The rollout planner is the tactical layer: it chooses a primitive for the
   * next 12 ticks. It has no way to pick a lane, so a wall taller than the
   * glider can climb leaves it nothing to do but raise the cruise band and
   * eventually land. A live trip proved that on 2026-09-18: the mover saw the
   * wall 48 blocks out (`SCAN_TO`), raised the cruise band to 194, fired a
   * rocket, could not climb 35 blocks of wall, then aimed its safety landing at
   * the wall's own face (`landing target -392.0,146,26.0`) and died on impact
   * (`experienced kinetic energy`).
   *
   * The corridor supplies the missing decision: a coarse route the cruise leg
   * aims along, computed over a bounded read and re-planned on a slow cadence.
   * It exists only while the planner switch is on and the trip knows its world
   * binding; either missing keeps the pre-corridor direct goal.
   */
  const corridor = planner && options.world
    ? createLiveCorridorPort({ port: options.port, planner, ...options.world, ...(options.deps?.now ? { now: options.deps.now } : {}) })
    : undefined
  /** Monotonic poll counter the planner observation falls back to without a source tick. */
  let pollIndex = 0
  /**
   * E-07 low route: the waypoint and band the cruise is following right now.
   *
   * Gated on the same switch as the other decision layers so a bridge with the
   * planner off keeps the pre-B0 behaviour byte for byte.
   */
  const lowRouteEnabled = planner !== undefined
  let lowRoute: { waypoint: Vec3, bandY: number } | undefined
  let lowRouteAt = Number.NEGATIVE_INFINITY
  let lastDurabilityAt = now()
  let approachDeadline = 0
  let minApproachGap = Infinity
  let goArounds = 0
  let goAroundPhase: GoAroundPhase = 'recover'
  let goAroundDeadline = 0
  let safetyDeadline = 0
  const recent: Vec3[] = []
  const cruiseDeadline = now() + CRUISE_TIMEOUT_MS

  // The landing target resolves once and is then held: an early landing keeps
  // one verified site instead of chasing a new one every poll.
  let landingSite: LandingSite | undefined
  let landingPoint: Vec3 = goal
  let landingResolved = false
  /** True when no verified support area existed; an unverified point is not a site. */
  let noReachableLanding = false
  /** Lowest solid block over the goal, probed once; landing above it is not arrival. */
  let goalRoofY: number | undefined
  let goalRoofProbed = false
  /** E-02 venue gap 2: how the long-route layer participated, typed into the result. */
  let lowRouteUsed = false
  let lowRouteReplans = 0
  let lowRouteRefusals = 0
  let lowRouteLastRefusal: 'blocked' | 'read_failed' | undefined
  // The goal's roof caps the strategic route from the first plan: probe once
  // before the cruise so every low-route scan enters the columns below it
  // (E-02 canyon gap 1, success half — she used to overfly the cave glass).
  {
    const probe = await probeGoalRoof(port, goal, debug)
    if (probe.covered) {
      goalRoofY = probe.roofY
      goalRoofProbed = true
    }
  }

  /**
   * Resolves the landing aim once. A verified site steers the glider; when no
   * site exists the mover keeps an unverified point for steering and marks the
   * flight so the receipt reports `no_reachable_landing` instead of a safe site.
   */
  const resolveLanding = async (): Promise<void> => {
    if (landingResolved)
      return
    landingResolved = true
    // A goal under a roof (a cave mouth, a slab) must be reached from below.
    // Probe the goal column once; the roof constrains both the site search and
    // the arrival judgment (E-02 canyon gap 1).
    if (!goalRoofProbed) {
      const probe = await probeGoalRoof(port, goal, debug)
      if (probe.covered) {
        goalRoofY = probe.roofY
        goalRoofProbed = true
      }
    }
    landingSite = await findLandingSite(port, state, now, debug, goalRoofY)
    if (landingSite) {
      landingPoint = {
        x: landingSite.support.x + landingSite.support.width / 2,
        y: landingSite.contactY,
        z: landingSite.support.z + landingSite.support.depth / 2,
      }
      return
    }
    noReachableLanding = reason !== 'goal'
    landingPoint = unverifiedPointAhead(state)
    debug?.(`elytra landing target ${landingPoint.x.toFixed(1)},${landingPoint.y},${landingPoint.z.toFixed(1)} (unverified)`)
  }
  if (reason !== 'goal')
    await resolveLanding()

  /** Enters the bounded safety landing that owns cancellation and timeouts. */
  const enterSafetyLanding = async (): Promise<FlightPhase> => {
    safetyDeadline = now() + SAFETY_LANDING_TIMEOUT_MS
    await resolveLanding()
    return 'safety-landing'
  }

  /** Enters a bounded go-around, or falls back to a safety landing. */
  const enterGoAround = async (): Promise<FlightPhase> => {
    if (goArounds >= MAX_GO_AROUNDS || fireworks <= FIREWORK_LOW_SUPPLY) {
      if (reason === 'goal')
        reason = 'timeout'
      return await enterSafetyLanding()
    }
    goArounds++
    goAroundPhase = 'recover'
    goAroundDeadline = now() + GO_AROUND_TIMEOUT_MS
    debug?.(`elytra overshot the goal; go-around ${goArounds}/${MAX_GO_AROUNDS}`)
    return 'go-around'
  }

  // The main loop only runs while the glide is observed. A missing `fallFlying`
  // ends the loop and the touch-down classifier decides the outcome.
  try {
    while (state.fallFlying === true) {
      // Ownership first: a newer command that took the input must not be
      // disturbed by this session's writes (CD-0 D8).
      if (!ownsControl())
        return { status: 'unknown', failure: 'unverified_stop', detail: 'input ownership moved to a newer command' }

      // Cancellation changes the business reason at any phase; the safety
      // landing below owns the cleanup. It is never blocked by `phase`.
      if (shouldStop() && reason !== 'cancelled') {
        reason = 'cancelled'
        phase = await enterSafetyLanding()
      }
      // Independent deadlines are checked at the top, not inside a branch that
      // a slowly improving distance could skip (CD-E0).
      if (phase === 'cruise' && reason === 'goal' && now() > cruiseDeadline) {
        reason = 'timeout'
        phase = await enterSafetyLanding()
      }
      if ((phase === 'approach' || phase === 'flare') && now() > approachDeadline) {
        if (reason !== 'cancelled')
          reason = 'timeout'
        phase = await enterSafetyLanding()
      }
      if (phase === 'go-around' && now() > goAroundDeadline) {
        if (reason !== 'cancelled')
          reason = 'timeout'
        phase = await enterSafetyLanding()
      }
      if (phase === 'safety-landing' && now() > safetyDeadline) {
        // The safety landing owns the cleanup but not forever. The touch-down
        // classifier below reports whether the bounded stop actually landed.
        debug?.('elytra safety landing deadline reached')
        break
      }

      // A goal under a roof cannot be approached from above: the approach
      // must start below the roof so the glide enters the cave mouth, not
      // the glass over it. While above the roof the cruise keeps descending
      // along the low-route band (E-02 canyon, live 2026-09-19: 3/3 runs
      // landed on the glass at y=86 because the approach started from y=150).
      if (phase === 'cruise' && reason === 'goal' && horizontalDistance(state.position, goal) <= APPROACH_DISTANCE
        && (goalRoofY === undefined || state.position.y <= goalRoofY)) {
        phase = 'approach'
        approachDeadline = now() + APPROACH_TIMEOUT_MS
        minApproachGap = horizontalDistance(state.position, goal)
      }
      if (phase === 'cruise' && reason !== 'goal' && !landingResolved)
        await resolveLanding()

      if (phase === 'approach' || phase === 'flare') {
        const gapToGoal = horizontalDistance(state.position, goal)
        if (gapToGoal < minApproachGap) {
          minApproachGap = gapToGoal
        }
        else if (gapToGoal > minApproachGap + GO_AROUND_GAP_MARGIN && state.position.y - goal.y < GO_AROUND_MIN_HEIGHT) {
          // The glide carried past the goal with no height to bank around.
          phase = await enterGoAround()
        }
        else if (!canReachAim(state, landingPoint)) {
          // Too low to glide the remaining distance: go around early instead of
          // overflying the site and then turning (design §6).
          phase = await enterGoAround()
        }
        else if (phase === 'approach' && gapToGoal <= FLARE_DISTANCE) {
          phase = 'flare'
        }
        else if (phase === 'flare' && gapToGoal > FLARE_DISTANCE + GO_AROUND_GAP_MARGIN) {
          phase = 'approach'
        }
      }
      else if (phase === 'go-around') {
        if (goAroundPhase === 'recover' && state.position.y >= goal.y + GO_AROUND_MIN_HEIGHT) {
          goAroundPhase = 'leave'
        }
        else if (goAroundPhase === 'leave' && horizontalDistance(state.position, goal) >= GO_AROUND_LEAVE_DISTANCE) {
          goAroundPhase = 're-align'
        }
        else if (goAroundPhase === 're-align' && Math.abs(angleDelta(state.yaw, yawTo(state.position, goal))) <= GO_AROUND_REALIGN_TOLERANCE_DEG) {
          phase = 'approach'
          approachDeadline = now() + APPROACH_TIMEOUT_MS
          minApproachGap = horizontalDistance(state.position, goal)
        }
      }

      // Early-landing reasons raised while cruising enter the bounded safety
      // landing the deadlines own. `cancelled` is sticky and never upgraded.
      if (!landingResolved && reason === 'goal' && fireworks <= FIREWORK_LOW_SUPPLY) {
        reason = 'low_supply'
        phase = await enterSafetyLanding()
      }
      if (!landingResolved && reason === 'goal' && (state.health ?? 20) <= LOW_HEALTH) {
        reason = 'safety'
        phase = await enterSafetyLanding()
      }
      // A suit that wears down in flight lands at the nearest site instead of
      // breaking mid-air; the read is skipped when the bridge cannot report it.
      if (reason !== 'safety' && reason !== 'cancelled' && now() - lastDurabilityAt >= DURABILITY_REFRESH_MS) {
        lastDurabilityAt = now()
        const ratio = await equippedDurabilityRatio(port)
        if (ratio !== undefined && ratio >= WORN_ELYTRA_RATIO) {
          reason = 'safety'
          phase = await enterSafetyLanding()
          debug?.(`elytra worn in flight (${Math.round(ratio * 100)}% used); early landing`)
        }
      }

      pollIndex += 1
      /**
       * E-07 long-route leg: a low route along the terrain, re-planned on a slow
       * cadence.
       *
       * ROOT CAUSE (live, 2026-09-18): without it the cruise band is
       * `goal.y + 30`, so a 380-block trip through a canyon flew 30 blocks above
       * the *goal's* altitude, hit the canyon wall and lost 7-15 health per
       * attempt (one death). The near-field corridor cannot answer that question:
       * its window is 32 blocks and the glider covers 30 blocks a second.
       */
      if (lowRouteEnabled && phase === 'cruise') {
        const routeStale = lowRoute === undefined || now() - lowRouteAt >= LOW_ROUTE_TTL_MS
        const routeReached = lowRoute !== undefined
          && horizontalDistance(state.position, lowRoute.waypoint) <= LOW_ROUTE_WAYPOINT_REACH
        if (routeStale || routeReached) {
          const plan = await planLowRoute({ port, self: state.position, goal, ...(goalRoofY !== undefined ? { roofY: goalRoofY } : {}) })
          lowRouteAt = now()
          if (plan.status === 'planned' && plan.waypoint) {
            lowRoute = { waypoint: plan.waypoint, bandY: plan.bandY ?? plan.waypoint.y }
            lowRouteUsed = true
            lowRouteReplans += 1
            debug?.(`elytra low-route waypoint ${plan.waypoint.x.toFixed(0)},${plan.waypoint.y.toFixed(0)},${plan.waypoint.z.toFixed(0)} band=${(plan.bandY ?? plan.waypoint.y).toFixed(0)} reached=${plan.reached}`)
          }
          else {
            lowRoute = undefined
            // A 'planned' without a waypoint falls through the same branch but
            // is not a typed refusal; only blocked/read_failed count.
            if (plan.status !== 'planned') {
              lowRouteRefusals += 1
              lowRouteLastRefusal = plan.status
            }
            debug?.(`elytra low-route ${plan.status} at ${plan.reached}; flying the direct goal`)
          }
        }
      }
      let target = phase === 'cruise' ? (lowRoute?.waypoint ?? goal) : landingPoint
      // The band follows the route's altitude, not a fixed offset above the goal.
      if (phase === 'cruise' && lowRoute)
        cruiseY = Math.max(lowRoute.bandY + LOW_ROUTE_BAND_MARGIN, Math.min(cruiseY, state.position.y))
      // A goal under a roof caps the cruise band: the approach must enter the
      // cave mouth, and the band cannot sit above the roof while the glider
      // still needs to descend under it (live 2026-09-19: without the cap the
      // band followed the canyon wall upward and she overflew east 300 blocks).
      if (phase === 'cruise' && goalRoofY !== undefined && reason === 'goal')
        cruiseY = Math.min(cruiseY, goalRoofY)
      // CD-E2: on the cruise leg the coarse corridor owns the near-field route
      // hint. A route point replaces the direct goal so the rollout plans around
      // terrain it can see; any refusal (unknown window, no route, failed read)
      // keeps the direct goal, because unknown space is not a route.
      if (corridor && phase === 'cruise') {
        // The corridor answers the NEAR field: its target is the fresh
        // long-route waypoint when one exists (usually inside the window), so
        // it never guesses clamped exits for a goal hundreds of blocks out.
        // Live 2026-09-19: aiming at the far goal picked west-corner window
        // exits and spiralled two canyon runs off-course.
        const corridorTarget = lowRoute !== undefined && now() - lowRouteAt < LOW_ROUTE_TTL_MS
          ? lowRoute.waypoint
          : goal
        const routeAim = await corridor.step(state.position, corridorTarget)
        if (routeAim) {
          // The corridor is a LATERAL avoidance layer; the low-route band owns
          // altitude. Live 2026-09-19: an unclamped corridor aim at y=163 made
          // the rollout chase the corridor's own upward detour to y=166, where
          // stale chunk reads turned into unknown cells and the grid routed
          // west around them. The corridor may command descent, never climb.
          const aimY = lowRoute !== undefined && now() - lowRouteAt < LOW_ROUTE_TTL_MS
            ? Math.min(routeAim.y, state.position.y)
            : routeAim.y
          target = { x: routeAim.x, y: aimY, z: routeAim.z }
          debug?.(`elytra corridor aim ${routeAim.x.toFixed(1)},${aimY.toFixed(1)},${routeAim.z.toFixed(1)}`)
        }
        else if (corridor.status() !== 'planned') {
          const reason = corridor.refusal?.()
          debug?.(`elytra corridor ${corridor.status()}${reason ? ` (${reason})` : ''}; aiming direct`)
        }
      }
      let yaw = yawTo(state.position, target)
      const gap = horizontalDistance(state.position, target)
      // Landings still scan: flying into a hillside is worse than an early
      // touch-down. Inside the landing zone the scan stops — terrain there is
      // the ground she is about to touch, not an obstacle to climb.
      const scan = (phase !== 'cruise' && gap <= FLARE_DISTANCE)
        ? { cruiseY, obstacleDistance: undefined }
        : await scanTerrainAhead(port, state, target, cruiseY, debug)
      /**
       * A fresh low route owns the band, and the ahead-scan owns the emergency.
       *
       * ROOT CAUSE (live, 2026-09-18): the scan raises the band by 35 whenever any
       * block sits in the corridor at the flight's altitude. Approaching a cave
       * whose mouth is cut into a badlands cliff, that made the trip climb *over*
       * the cliff instead of entering: the run ended 2.6 blocks from the goal but
       * 20 blocks above it, standing on the cave's glass roof, after circling the
       * goal at y≈90-115 with 50 blocks of height it could not lose. The low
       * route had already measured a flyable slot through the cave, so the scan
       * must not overrule it; a block immediately ahead still does.
       */
      const lowRouteFresh = phase === 'cruise' && lowRoute !== undefined && now() - lowRouteAt < LOW_ROUTE_TTL_MS
      cruiseY = lowRouteFresh ? cruiseY : scan.cruiseY
      const obstacleDistance = scan.obstacleDistance
      const emergency = obstacleDistance !== undefined && obstacleDistance <= TERRAIN_GUARD_DISTANCE

      let pitch: number
      let wantThrust = false
      if (phase === 'cruise') {
        // CD-E B0: while the rollout planner switch is on, its chosen
        // primitive replaces the cruise heuristics for this poll. Approach,
        // go-around, flare and safety keep the audited heuristics until
        // E-02/E-03 wire their lifecycle counterparts.
        let applied: LiveFlightControl | undefined
        if (planner) {
          applied = await planLiveFlightControl({ planner, port, state, poll: pollIndex, fireworks, health: state.health ?? 20, goal: target, lastRocketAt: lastFireworkAt === 0 ? undefined : lastFireworkAt, now })
          if (!applied)
            debug?.('elytra rollout fell back to heuristics')
        }
        if (applied) {
          yaw = applied.yaw
          pitch = applied.pitch
          wantThrust = applied.useRocket
        }
        else {
          // Climb over anything close ahead; the scan may only see terrain at
          // the last safe distance, so the nose-up must be decisive.
          const climbing = state.position.y < cruiseY - 4 || emergency
          // A large surplus is dived away, not waited away: the elytra trades
          // height for speed, and the old 35-degree ceiling made the mover arrive
          // over a goal under a roof with 20-50 blocks it could not lose (live
          // 2026-09-18, the cave fixture). Bounded at DIVE_PITCH.
          const surplus = state.position.y - cruiseY
          const diveCeiling = surplus > 12 ? DIVE_PITCH : 35
          pitch = climbing ? CLIMB_PITCH : clamp(-(cruiseY - state.position.y) * 1.2, -30, diveCeiling)
          wantThrust = climbing || horizontalSpeed(state) < MIN_CRUISE_SPEED
        }
      }
      else if (phase === 'go-around') {
        // Recover altitude on the way out, then keep a shallow climb so the
        // re-align has room to turn.
        const climbing = state.position.y < goal.y + GO_AROUND_MIN_HEIGHT
        pitch = climbing || emergency ? CLIMB_PITCH : -8
        wantThrust = climbing
      }
      else if (gap <= FLARE_DISTANCE) {
        // Landing zone: ease the nose up and touch down. A rocket may arrest
        // a hard sink; it fires with the nose up, never nose-down.
        const height = state.position.y - target.y
        const required = Math.atan2(Math.max(0, height), Math.max(1, gap)) * 180 / Math.PI
        const blend = clamp((height - FLARE_HEIGHT) / FLARE_WINDOW, 0, 1)
        pitch = clamp(blend * required + (1 - blend) * FLARE_PITCH, FLARE_PITCH, 35)
        wantThrust = height <= FLARE_HEIGHT && (state.motion?.y ?? 0) < LANDING_ASSIST_FALL_SPEED
      }
      else if (obstacleDistance !== undefined && state.position.y < cruiseY - 4) {
        // A wall in the landing path: spend a rocket to clear it.
        pitch = CLIMB_PITCH
        wantThrust = true
      }
      else {
        // Steer by the descent angle the remaining distance needs; a negative
        // value is clamped to level because she can only glide, not climb.
        const height = Math.max(0, state.position.y - target.y)
        const required = Math.atan2(height, Math.max(1, gap)) * 180 / Math.PI
        pitch = clamp(required, 0, 35)
      }
      await port.look(yaw, pitch)
      debug?.(`elytra fly y=${state.position.y.toFixed(1)} h=${(state.position.y - goal.y).toFixed(1)} d=${gap.toFixed(1)} vy=${(state.motion?.y ?? 0).toFixed(2)} pitch=${pitch.toFixed(1)} fw=${fireworks}${phase !== 'cruise' ? `:${reason}` : ''}`)

      if (fireworks > 0 && fireworkSlot !== undefined && wantThrust && now() - lastFireworkAt > FIREWORK_INTERVAL_MS) {
        await port.selectHotbar(fireworkSlot)
        await port.useItem()
        lastFireworkAt = now()
        fireworks = await countBySuffix(port, 'firework_rocket')
        // A used-up stack would keep thrusting into an empty slot; move to the
        // next stack while rockets remain, otherwise `low_supply` ends the flight.
        if (fireworks > 0 && await countInSlot(port, fireworkSlot) === 0)
          fireworkSlot = await selectBySuffix(port, 'firework_rocket')
        debug?.('elytra thrust fired')
      }

      recent.push({ ...state.position })
      if (recent.length > STUCK_WINDOW_POLLS) {
        recent.shift()
        const oldest = recent[0]!
        if (phase === 'cruise' && reason === 'goal' && horizontalDistance(oldest, state.position) < STUCK_MIN_MOVE && fireworks === 0) {
          // No thrust and no progress: land instead of hovering forever.
          reason = 'timeout'
          phase = await enterSafetyLanding()
        }
      }

      await sleep(FLIGHT_POLL_MS)
      state = await port.getState()
    }

    // The roof probe must not depend on the approach path: a mid-cruise stop
    // (cancel, safety, an immediate landing) never resolves a site, and the
    // arrival judgment still needs the roof (E-02 canyon gap 1).
    if (!goalRoofProbed) {
      const probe = await probeGoalRoof(port, goal, debug)
      if (probe.covered) {
        goalRoofY = probe.roofY
        goalRoofProbed = true
      }
    }
    return await finishFlight({
      port,
      finalState: state,
      reason,
      goal,
      landingPoint,
      landingSite,
      noReachableLanding,
      ...(goalRoofY !== undefined ? { goalRoofY } : {}),
      ...(lowRouteEnabled
        ? { lowRoute: { used: lowRouteUsed, replans: lowRouteReplans, refusals: lowRouteRefusals, ...(lowRouteLastRefusal ? { lastRefusal: lowRouteLastRefusal } : {}) } }
        : {}),
      tolerance,
      fireworks,
      shouldStop,
      ownsControl,
      sleep,
      now,
      debug,
    })
  }
  finally {
    await stopIfOwner(port, ownsControl)
  }
}

/** Calls `port.stopMovement()` only while this session still owns the input. */
async function stopIfOwner(port: MovementControlPort, ownsControl: () => boolean): Promise<void> {
  if (!ownsControl())
    return
  await port.stopMovement().catch(() => {})
}

/** Whether the remaining height can still glide to the aim point. */
function canReachAim(state: MovementState, aim: Vec3): boolean {
  const gap = horizontalDistance(state.position, aim)
  if (gap <= FLARE_DISTANCE)
    return true
  return state.position.y - aim.y >= gap * MIN_GLIDE_RATIO
}

/** Walks the remaining gap after a short landing; stops at tolerance or the timeout. */
async function walkCloser(
  port: MovementControlPort,
  goal: Vec3,
  tolerance: number,
  shouldStop: () => boolean,
  ownsControl: () => boolean,
  sleep: (ms: number) => Promise<void>,
  now: () => number,
): Promise<void> {
  const deadline = now() + LANDING_WALK_TIMEOUT_MS
  try {
    for (;;) {
      // A newer command that took the input must not be steered by this walk.
      if (!ownsControl())
        return
      const state = await port.getState()
      if (horizontalDistance(state.position, goal) <= tolerance)
        return
      if (shouldStop() || now() > deadline)
        return
      await port.look(yawTo(state.position, goal), 0)
      await port.setInput({ forward: true })
      await sleep(FLIGHT_POLL_MS)
    }
  }
  finally {
    await stopIfOwner(port, ownsControl)
  }
}

/** The furthest point ahead on the current heading, explicitly unverified. */
function unverifiedPointAhead(state: MovementState): Vec3 {
  const radians = state.yaw * Math.PI / 180
  return {
    x: state.position.x - Math.sin(radians) * LANDING_SCAN_MAX,
    y: state.position.y,
    z: state.position.z + Math.cos(radians) * LANDING_SCAN_MAX,
  }
}

/** Maps a player-state read to the touch-down sample the classifier takes. */
function touchdownSampleOf(state: MovementState) {
  return {
    position: state.position,
    ...(state.motion ? { motion: state.motion } : {}),
    onGround: state.onGround,
    inWater: state.inWater,
    // A missing `fallFlying` stays absent so the classifier returns unknown.
    ...(state.fallFlying !== undefined ? { fallFlying: state.fallFlying } : {}),
  }
}

/**
 * Confirms the touch-down, walks a short gap, and builds the typed receipt.
 *
 * Stopping the glide is not a landing: only a settled `onGround` touch-down is
 * accepted. Water is its own outcome; an unreadable or incomplete final sample
 * stays `unknown` instead of being reported as a safe landing (CD-E0).
 */
async function finishFlight(input: {
  port: MovementControlPort
  finalState: MovementState
  reason: LandingReason
  goal: Vec3
  landingPoint: Vec3
  landingSite: LandingSite | undefined
  noReachableLanding: boolean
  /** Roof over the goal when probed; landing above it is not arrival. */
  goalRoofY?: number
  /** Long-route participation typed into every terminal outcome. */
  lowRoute?: VehicleMoveResult['lowRoute']
  tolerance: number
  fireworks: number
  shouldStop: () => boolean
  /** Whether this session still owns the input during the final walk. */
  ownsControl: () => boolean
  sleep: (ms: number) => Promise<void>
  now: () => number
  debug?: (message: string) => void
}): Promise<VehicleMoveResult> {
  const { port, goal, landingPoint, landingSite, reason, shouldStop, ownsControl, sleep, now, debug, fireworks } = input
  const lowRouteField = input.lowRoute ? { lowRoute: input.lowRoute } : {}
  // Only a verified site or the goal can be the reference; an unverified point
  // ahead is not a support claim, so contact there is not a plausible landing.
  const reference = landingSite ? { x: landingPoint.x, y: landingPoint.y, z: landingPoint.z } : goal
  let finalState = input.finalState
  let outcome = classifyTouchdown(touchdownSampleOf(finalState), reference)
  const settleDeadline = now() + TOUCHDOWN_SETTLE_MS
  // Only a falling or still-sliding sample is transient; `unknown` is decisive
  // and must never be retried into a fabricated landing.
  let settlePolls = 0
  while ((outcome.kind === 'lost-flight' || outcome.kind === 'unsettled') && settlePolls < SETTLE_MAX_POLLS && now() < settleDeadline) {
    settlePolls++
    if (shouldStop() && reason !== 'cancelled')
      break
    await sleep(FLIGHT_POLL_MS)
    try {
      finalState = await port.getState()
    }
    catch {
      break
    }
    outcome = classifyTouchdown(touchdownSampleOf(finalState), reference)
  }

  if (outcome.kind === 'water') {
    return { status: 'stuck', failure: 'landing_in_water', detail: 'touch-down landed in water', ...lowRouteField }
  }
  if (outcome.kind !== 'landed' && outcome.kind !== 'unsettled') {
    if (outcome.kind === 'still-flying')
      return { status: 'unknown', failure: 'touchdown_unverified', detail: 'the glide was still active at the deadline', ...lowRouteField }
    if (input.noReachableLanding)
      return { status: 'unknown', failure: 'no_reachable_landing', detail: 'no verified landing site on the flight', ...lowRouteField }
    const detail = outcome.kind === 'lost-flight'
      ? 'the glide ended without a confirmed ground contact'
      : outcome.kind === 'unknown' ? outcome.reason : 'the touch-down was never verified'
    return { status: 'unknown', failure: 'touchdown_unverified', detail, ...lowRouteField }
  }

  // A confirmed ground contact can stop a few blocks short of the aim; close
  // the gap on foot (bounded) so the final distance is measured after the walk.
  let distance = horizontalDistance(finalState.position, goal)
  const targetGap = horizontalDistance(finalState.position, landingPoint)
  if (reason !== 'cancelled' && targetGap > input.tolerance && targetGap <= LANDING_WALK_LIMIT) {
    await walkCloser(port, landingPoint, input.tolerance, shouldStop, ownsControl, sleep, now)
    try {
      finalState = await port.getState()
    }
    catch {
      // Keep the last known position; the walk is already the approximate part.
    }
    distance = horizontalDistance(finalState.position, goal)
    debug?.(`elytra landed short; walked to ${distance.toFixed(1)} blocks`)
  }

  if (reason === 'cancelled') {
    return {
      status: 'cancelled',
      ...(input.noReachableLanding ? { failure: 'no_reachable_landing' as const } : {}),
      detail: `landed ${distance.toFixed(1)} blocks from the goal`,
      ...lowRouteField,
    }
  }
  if (reason === 'low_supply')
    return { status: 'low_supply', detail: `landed early with ${fireworks} rockets`, ...lowRouteField }
  if (distance <= input.tolerance) {
    // Landing on the roof over the goal is horizontally "at" it but is not
    // arrival: the goal sits under that roof (E-02 canyon gap 1).
    if (input.goalRoofY !== undefined && finalState.position.y > input.goalRoofY) {
      return {
        status: 'stuck',
        failure: 'goal_under_roof',
        detail: `landed on the roof y=${finalState.position.y.toFixed(0)} above goal ceiling y=${input.goalRoofY.toFixed(0)} at ${distance.toFixed(1)} blocks horizontal`,
        ...lowRouteField,
      }
    }
    return { status: 'reached', ...lowRouteField }
  }
  return {
    status: 'stuck',
    ...(input.noReachableLanding ? { failure: 'no_reachable_landing' as const } : {}),
    detail: `landing miss: ${distance.toFixed(1)} blocks`,
    ...lowRouteField,
  }
}

/**
 * Reads the goal column once and returns the lowest roof over the goal.
 *
 * A failed or partial read keeps the roof unset: arrival then stays
 * horizontal-only rather than refusing on a fabricated ceiling.
 */
/**
 * Reads the goal column once and reports the lowest roof over the goal.
 *
 * The result distinguishes a definitive answer from an unread column: the
 * server-side read only covers chunks a player has within view distance, so
 * at run start the goal column (hundreds of blocks out) is often unloaded and
 * the read comes back empty. An empty read is NOT "no roof" — the caller must
 * retry once the glider is actually near the goal (her own presence loads the
 * chunk). ROOT CAUSE (live, 2026-09-19): treating the empty read as final
 * disabled the roof protection for whole batches and two runs falsely
 * reported `reached` on the glass.
 */
async function probeGoalRoof(
  port: MovementControlPort,
  goal: Vec3,
  debug?: (message: string) => void,
): Promise<{ roofY?: number, covered: boolean }> {
  try {
    const gx = Math.floor(goal.x)
    const gz = Math.floor(goal.z)
    // The helper scans at most 40 above the goal; read two extra layers.
    const topProbe = Math.floor(goal.y) + 42
    const column = await port.getBlocksRegion(
      { x: gx, y: Math.floor(goal.y), z: gz },
      { x: gx, y: topProbe, z: gz },
    )
    if (column.length === 0) {
      // Unloaded chunk, not an open sky: name it and let the caller retry.
      debug?.(`elytra goal roof probe read an empty column (chunk unloaded); will retry near the goal`)
      return { covered: false }
    }
    const roofY = lowestRoofAboveGoal(column, goal, topProbe)
    if (roofY !== undefined)
      debug?.(`elytra goal roof at y=${roofY}; landing above it is not arrival`)
    else
      debug?.(`elytra goal roof: none within ${topProbe - Math.floor(goal.y)} blocks above the goal`)
    return { ...(roofY !== undefined ? { roofY } : {}), covered: true }
  }
  catch (error) {
    debug?.(`elytra goal roof probe failed: ${errorMessageFrom(error) ?? 'unknown error'}`)
    return { covered: false }
  }
}

/**
 * Finds a verified landing patch ahead and to the sides of the heading.
 *
 * The scan reads one forward region, then evaluates 2x2 patches nearest-first.
 * An empty or failed read returns `undefined`; the caller must not substitute a
 * same-height coordinate (design §7).
 */
async function findLandingSite(
  port: MovementControlPort,
  state: MovementState,
  now: () => number,
  debug?: (message: string) => void,
  /** When set, patches standing at or above this y are roofs over the goal, not ways in. */
  maxContactY?: number,
): Promise<LandingSite | undefined> {
  const radians = state.yaw * Math.PI / 180
  const dirX = -Math.sin(radians)
  const dirZ = Math.cos(radians)
  const topY = Math.floor(state.position.y)
  const bottomY = topY - LANDING_SCAN_DEPTH
  const startX = state.position.x + dirX * LANDING_SCAN_MIN
  const startZ = state.position.z + dirZ * LANDING_SCAN_MIN
  const endX = state.position.x + dirX * LANDING_SCAN_MAX
  const endZ = state.position.z + dirZ * LANDING_SCAN_MAX
  const margin = LANDING_SCAN_LATERAL + 1
  let entries
  try {
    entries = await port.getBlocksRegion(
      { x: Math.min(startX, endX) - margin, y: bottomY, z: Math.min(startZ, endZ) - margin },
      { x: Math.max(startX, endX) + margin, y: topY + 2, z: Math.max(startZ, endZ) + margin },
    )
  }
  catch {
    // A missing region is unknown, not an empty world: no site is claimed.
    return undefined
  }

  const lateralOffsets = [0, -1, 1, -2, 2, -3, 3, -4, 4]
  // Step by one block: a two-block step can skip the only patch min-corner.
  for (let step = LANDING_SCAN_MIN; step <= LANDING_SCAN_MAX; step++) {
    for (const lateral of lateralOffsets) {
      const x = Math.floor(state.position.x + dirX * step - dirZ * lateral)
      const z = Math.floor(state.position.z + dirZ * step + dirX * lateral)
      const site = evaluatePatch({
        entries,
        x,
        z,
        from: state.position,
        topY,
        scanDepth: LANDING_SCAN_DEPTH,
        now: now(),
      })
      if (site) {
        // A patch standing on a roof over the goal is not a way in: the goal
        // is under that roof (E-02 canyon gap 1). Keep scanning for a site
        // below the roof instead of aiming at the glass.
        if (maxContactY !== undefined && site.contactY >= maxContactY)
          continue
        debug?.(`elytra landing target ${(site.support.x + site.support.width / 2).toFixed(1)},${site.contactY},${(site.support.z + site.support.depth / 2).toFixed(1)}`)
        return site
      }
    }
  }
  return undefined
}

function horizontalSpeed(state: MovementState): number {
  return state.motion ? Math.hypot(state.motion.x, state.motion.z) : 0
}

function durabilityRatio(item: { damage?: number, maxDamage?: number }): number {
  return item.damage !== undefined && item.maxDamage ? item.damage / item.maxDamage : 0
}

/** Reads the worn elytra wear; undefined skips the refresh when unreadable. */
async function equippedDurabilityRatio(port: MovementControlPort): Promise<number | undefined> {
  const readEquipment = port.getEquipment
  if (!readEquipment)
    return undefined
  const equipment = await readEquipment.call(port).catch(() => undefined)
  const worn = equipment?.chest
  if (!worn || worn.damage === undefined || !worn.maxDamage)
    return undefined
  return worn.damage / worn.maxDamage
}

async function equipElytra(
  port: MovementControlPort,
  debug?: (message: string) => void,
): Promise<{ ok: true, lowDurability: boolean } | { ok: false, detail: string }> {
  const readEquipment = port.getEquipment
  if (!readEquipment)
    return { ok: false, detail: 'equipment read unavailable' }
  const equipment = await readEquipment.call(port).catch(() => undefined)
  const worn = equipment?.chest
  const ratio = worn ? durabilityRatio(worn) : 0

  const slots = await port.getInventory()
  const candidates = slots.filter(slot => slot.id.includes('elytra'))
  const backup = candidates.find(slot => durabilityRatio(slot) < WORN_ELYTRA_RATIO)

  if (worn?.id.includes('elytra') && ratio < WORN_ELYTRA_RATIO)
    return { ok: true, lowDurability: false }

  if (backup) {
    if (await wearFromHotbar(port, backup, worn, debug))
      return { ok: true, lowDurability: false }
    // Last resort for a bridge that can write the armor slot directly; a bridge
    // that cannot answers `swapped` and changes nothing (see wearFromHotbar).
    await port.swapSlots(backup.slot, CHEST_ARMOR_SLOT)
    return { ok: true, lowDurability: false }
  }

  if (worn?.id.includes('elytra')) {
    // No backup: a suit that may break mid-air is grounded; a worn one flies
    // but only to an early landing.
    if (ratio >= BROKEN_ELYTRA_RATIO) {
      debug?.('elytra is nearly broken and no backup exists')
      return { ok: false, detail: 'elytra is nearly broken and no backup exists' }
    }
    debug?.(`flying a worn elytra (${Math.round(ratio * 100)}% used); early landing only`)
    return { ok: true, lowDurability: true }
  }

  return { ok: false, detail: 'no elytra in the inventory' }
}

/**
 * Wears a carried elytra by hand, and proves it happened.
 *
 * NOTICE:
 * Why not `swapSlots(backup, CHEST_ARMOR_SLOT)`: `InventoryHandlers.toMenuSlot`
 * maps inventory indices 36..39 onto menu slots 5..8 documented as
 * "helmet..boots", while `Inventory` stores armor as feet, legs, chest, head —
 * the mapping is reversed, so an armor write lands on another slot. Live
 * 2026-09-18: all four indices (36/37/38/39) left the chest untouched while the
 * call answered `swapped`, so a worn suit stayed on and the flight then failed
 * with `not_deployed` (a 431/432 elytra is not fly-enabled).
 * Fix: move the spare into an empty hotbar slot, hold it and use it — vanilla
 * swaps it onto the body. Verified live the same day.
 * Removal condition: when the bridge maps armor indices by their real order.
 */
async function wearFromHotbar(
  port: MovementControlPort,
  backup: { slot: number, damage?: number },
  worn: { damage?: number } | undefined,
  debug?: (message: string) => void,
): Promise<boolean> {
  const slots = await port.getInventory()
  const empty = [0, 1, 2, 3, 4, 5, 6, 7, 8]
    .find(index => !slots.some(slot => slot.hotbar && slot.slot === index))
  if (empty === undefined) {
    debug?.('no empty hotbar slot to wear the spare elytra from')
    return false
  }
  await port.swapSlots(backup.slot, empty)
  await port.selectHotbar(empty)
  await port.useItem()
  const after = await port.getEquipment?.().catch(() => undefined)
  const chest = after?.chest
  if (!chest?.id.includes('elytra'))
    return false
  // The suit on the body must be a different one than the suit that was there.
  return (chest.damage ?? 0) !== (worn?.damage ?? -1)
}

/**
 * Selects a hotbar stack whose id contains `suffix`, moving one from the main
 * inventory when needed. Returns the hotbar slot or undefined when none exists.
 */
async function selectBySuffix(port: MovementControlPort, suffix: string): Promise<number | undefined> {
  const slots = await port.getInventory()
  const hotbar = slots.find(slot => slot.hotbar && slot.id.includes(suffix) && slot.count > 0)
  if (hotbar)
    return hotbar.slot
  const main = slots.find(slot => !slot.hotbar && slot.id.includes(suffix) && slot.count > 0)
  if (!main)
    return undefined
  const empty = [0, 1, 2, 3, 4, 5, 6, 7, 8].find(index => !slots.some(slot => slot.hotbar && slot.slot === index))
  if (empty === undefined)
    return undefined
  await port.swapSlots(main.slot, empty)
  return empty
}

async function countBySuffix(port: MovementControlPort, suffix: string): Promise<number> {
  const slots = await port.getInventory()
  return slots
    .filter(slot => slot.id.includes(suffix))
    .reduce((total, slot) => total + slot.count, 0)
}

async function countInSlot(port: MovementControlPort, slot: number): Promise<number> {
  const slots = await port.getInventory()
  return slots.find(entry => entry.slot === slot)?.count ?? 0
}

/** The flight-corridor geometry one scan resolves before filtering blocks. */
export interface CorridorScan {
  originX: number
  originZ: number
  dirX: number
  dirZ: number
  baseY: number
}

/**
 * True when `block` blocks the corridor. Only terrain within
 * `CORRIDOR_HALF_WIDTH` of the heading and at the player's feet or one block
 * above counts; a block the snapshot could not resolve (empty id) counts as
 * an obstacle because absence of a readable id is not proof of air.
 */
export function isObstacleInCorridor(
  block: { x: number, y: number, z: number, id: string },
  corridor: CorridorScan,
): boolean {
  if (block.y !== corridor.baseY && block.y !== corridor.baseY + 1)
    return false
  const dx = block.x + 0.5 - corridor.originX
  const dz = block.z + 0.5 - corridor.originZ
  const ahead = dx * corridor.dirX + dz * corridor.dirZ
  if (ahead < SCAN_FROM / 2 || ahead > SCAN_TO)
    return false
  const lateral = dx * corridor.dirZ - dz * corridor.dirX
  if (Math.abs(lateral) > CORRIDOR_HALF_WIDTH)
    return false
  if (!block.id)
    return true
  return !block.id.endsWith('air') && block.id !== 'minecraft:water'
}

/**
 * Scans ahead at the player's altitude in one region read. The region is a
 * slab from `SCAN_FROM` to `SCAN_TO` along the heading, two blocks tall (the
 * feet layer and the one above). Terrain in that corridor raises the cruise
 * band; the nearest block gives the caller the distance it has left to react.
 */
async function scanTerrainAhead(
  port: MovementControlPort,
  state: MovementState,
  goal: Vec3,
  cruiseY: number,
  debug?: (message: string) => void,
): Promise<{ cruiseY: number, obstacleDistance?: number }> {
  const yaw = yawTo(state.position, goal)
  const radians = yaw * Math.PI / 180
  const dirX = -Math.sin(radians)
  const dirZ = Math.cos(radians)
  const y = Math.floor(state.position.y)
  const startX = Math.floor(state.position.x + dirX * SCAN_FROM)
  const startZ = Math.floor(state.position.z + dirZ * SCAN_FROM)
  const endX = Math.floor(state.position.x + dirX * SCAN_TO)
  const endZ = Math.floor(state.position.z + dirZ * SCAN_TO)
  // One block of slack on each axis so the corridor width is covered even when
  // the heading is nearly cardinal (cos/sin never land on an exact zero).
  const across = 1

  let obstacleDistance: number | undefined
  try {
    const blocks = await port.getBlocksRegion(
      { x: Math.min(startX, endX) - across, y, z: Math.min(startZ, endZ) - across },
      { x: Math.max(startX, endX) + across, y: y + 1, z: Math.max(startZ, endZ) + across },
    )
    const corridor: CorridorScan = {
      originX: state.position.x,
      originZ: state.position.z,
      dirX,
      dirZ,
      baseY: y,
    }
    for (const block of blocks) {
      if (!isObstacleInCorridor(block, corridor))
        continue
      const dx = block.x + 0.5 - state.position.x
      const dz = block.z + 0.5 - state.position.z
      const ahead = dx * dirX + dz * dirZ
      obstacleDistance = obstacleDistance === undefined ? ahead : Math.min(obstacleDistance, ahead)
    }
  }
  catch {
    // A missing chunk or a busy bridge skips this scan; the next poll retries.
  }

  const raised = obstacleDistance === undefined ? cruiseY : Math.max(cruiseY, y + 35)
  if (obstacleDistance !== undefined)
    debug?.(`elytra terrain ahead at ${obstacleDistance.toFixed(0)}; cruise band raised to ${raised}`)
  return { cruiseY: raised, obstacleDistance }
}

// Reused by the air-follow driver, which owns the continuous track loop but
// shares the elytra equipment, firework and ownership helpers.
export { countBySuffix, equipElytra, selectBySuffix, stopIfOwner }
