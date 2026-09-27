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
import type { FlightChannelSample, MovementControlPort, MovementState } from './port'
import type { Vec3 } from './types'
import type { VehicleMoveOptions, VehicleMoveResult } from './vehicle'
import type { ChannelLegRecord } from './vehicle-port'

import { errorMessageFrom } from '@moeru/std'

import { createFlightChannelRunner } from '../flight/channel'
import { evaluatePatch, lowestRoofAboveGoal } from '../flight/landing-site'
import { createLiveCorridorPort } from '../flight/live-corridor'
import { planLiveFlightControl } from '../flight/live-port'
import { LOW_ROUTE_DESCENT_STEP, LOW_ROUTE_HOLD_MS, LOW_ROUTE_SPAN, LOW_ROUTE_TTL_MS, LOW_ROUTE_WAYPOINT_REACH, planLowRoute } from '../flight/low-route'
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
/**
 * Approach-entry gate (R4). The 80-block radius is only a candidate trigger:
 * entry also needs alignment with the aim, a speed the flare can bleed, a
 * position under the roof that caps the goal, and enough height to glide the
 * remaining distance. Each refusal names its condition so the receipt and the
 * trail say why the cruise kept flying.
 */
/** Heading error over which the entry is refused; she turns first. */
const APPROACH_ALIGN_DEG = 60
/** Horizontal speed over which the flare cannot settle, blocks/tick. */
const APPROACH_MAX_SPEED = 1.1
/** Short-final distance where alignment and speed no longer gate the entry. */
const APPROACH_SHORT_FINAL = FLARE_DISTANCE * 2
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

/**
 * Channel-mode constants (R3). The client drives per tick; the host only
 * exchanges channels and reads receipts, so its cadence is receipt-paced, not
 * control-paced.
 */
/** Wall-clock ms between two channel status polls. */
const CHANNEL_POLL_MS = 500
/** Waypoint advance radius sent with the channel path, in blocks. */
const CHANNEL_ENTRY_REACH = 8
/** Replans (revisions) one flight may spend before it must land. */
const CHANNEL_MAX_REVISIONS = 3
/**
 * Normal frontier continuations one flight may spend. A long route crossing
 * several read windows is progress, not failure, so it must not consume the
 * failure budget above (R4 review 2026-09-20).
 */
const CHANNEL_MAX_CONTINUATIONS = 12
/**
 * Distance to the local frontier that starts planning the next leg, in blocks.
 * The plan then overlaps the current leg instead of running after it, which is
 * where the 44-tick unowned glide came from (R4 review 2026-09-20).
 */
const CHANNEL_PREFETCH_DISTANCE = 64
/**
 * Distance to the frontier that submits the prefetched leg as a handover, in
 * blocks. The client adopts it at a tick boundary, so this window only bounds
 * how long the client's own hold (if any) has to cover.
 */
const CHANNEL_HANDOVER_DISTANCE = 32
/**
 * Wall-clock cap for one channel-leg plan. The space search carries body
 * clearance, wall and climb costs; the open-air 2 s default starved it on the
 * canyon and reported `blocked: time_cap` (R4 cave-diag-11).
 */
const CHANNEL_PLAN_TIME_CAP_MS = 4_000
/** Consecutive status-read failures before the exchange is declared broken. */
const CHANNEL_POLL_ERROR_BUDGET = 5
/** No positional progress this long while applying ends the channel. */
const CHANNEL_STALL_MS = 10_000
/** Movement under this distance counts as no progress, in blocks. */
const CHANNEL_STALL_MOVE = 0.5
/**
 * No reduction of the distance to the goal this long counts as loitering.
 *
 * The movement stall above only catches a frozen bot; cave-diag-04 circled a
 * two-block radius for 165 s with every sample "moving", so the host never
 * noticed. Route progress is the distance to the goal decreasing; a legitimate
 * detour may increase it for a while, so the window is generous.
 */
const CHANNEL_PROGRESS_WINDOW_MS = 30_000
/** Distance improvement that counts as progress, blocks. */
const CHANNEL_PROGRESS_EPSILON = 2
/** Radius of the exclusion stamped where the client rejected the route, in blocks. */
const CHANNEL_INVALIDATE_RADIUS = 24
/** Remaining-route re-verification runs after this much route progress, in blocks. */
const CHANNEL_PREFIX_VERIFY_BLOCKS = 48
/** First-waypoint divergence between plans that invalidates the prefix, in blocks. */
const CHANNEL_PREFIX_DIVERGENCE = 24
/**
 * How far off the submitted route the glider may be before a prefix
 * verification is skipped. The launch boost can leave her 50 blocks above her
 * own first waypoint; a fresh plan from up there routes differently, and that
 * is not evidence the prefix diverged (R4 cave-diag-14).
 */
const CHANNEL_PREFIX_VERIFY_MAX_OFFSET = 24
/** Final approach through the client channel (R4): the client flies the last leg. */
const CHANNEL_APPROACH_MAX_DISTANCE = 80
/** Waypoint radius for the final approach; the client hands over just above the pad. */
const CHANNEL_APPROACH_ENTRY_REACH = 4
/**
 * The approach aim sits this far above the verified contact height. Aiming at
 * the surface itself makes the client's glide sink below the pad edge before
 * the horizontal reach, and the handover happens under the platform
 * (pad-diag-01: the host flare then missed by 2.5 blocks and sank 7). The
 * clearance keeps the handover above the pad; the host flare descends onto it.
 */
const CHANNEL_APPROACH_AIM_CLEARANCE = 2.5
/** Preferred spacing between approach-profile waypoints, blocks. */
const CHANNEL_APPROACH_PROFILE_STEP = 14
/** A refused profile is retried once with the direct two-point leg. */
const CHANNEL_APPROACH_ATTEMPTS = 1
/** A route refusal this close to the goal ends with the host landing, not a failure. */
const CHANNEL_HOST_LANDING_DISTANCE = 48

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

  // 3. Cruise mode selection (R3). With the planner on, a world binding, and a
  // bridge exposing the flight channel tools, the client drives per tick and
  // the host only exchanges channels and reads receipts. The legacy
  // look/useItem cruise stays for a planner-off flight and for a bridge
  // without the channel tools, so neither mode pretends to be the other.
  /** Lowest solid block over the goal, probed once; landing above it is not arrival. */
  let goalRoofY: number | undefined
  let goalRoofProbed = false
  // The goal's roof is probed before the cruise band is built: the band
  // initialisation consumes it, and the low-route scan enters every column
  // below it (E-02 canyon gap 1 — she used to overfly the cave glass). An
  // unloaded chunk leaves the roof unknown; the pre-finish and resolveLanding
  // call sites retry once her own presence has loaded the column.
  {
    const probe = await probeGoalRoof(port, goal, debug)
    if (probe.covered) {
      goalRoofY = probe.roofY
      goalRoofProbed = true
    }
  }

  /** Channel-exchange receipts collected for the terminal result (R3). */
  let channelSubmissions = 0
  let channelReplans = 0
  let channelContinuations = 0
  let channelEndReason: string | undefined
  /** Host-side cause that forced a bounded ending instead of a clean arrival. */
  let channelFailure: string | undefined
  /** Raw client refusal reason, kept for the terminal detail. */
  let channelRefusal: string | undefined
  /**
   * Per-leg evidence (R4 review item 1): the planned-from point, planning
   * cost, the raw R1 path, the path actually submitted, and when the leg
   * ended. Written into the result so a live run can explain a gap without
   * the debug console.
   */
  const channelLegs: ChannelLegRecord[] = []
  /** Set just before a submit so the leg record carries its plan facts. */
  let legMeta: { kind: ChannelLegRecord['kind'], plannedFrom: Vec3, planMs: number, rawPath?: Vec3[] } | undefined
  let currentLeg: ChannelLegRecord | undefined
  /** A leg accepted as a pending handover; promoted when the client adopts it. */
  let pendingLeg: ChannelLegRecord | undefined
  let pendingLegSessionId: string | undefined
  /** The pending leg's path; promoted to the flown path only on adoption. */
  let pendingChannelPath: Vec3[] | undefined
  let pendingPlanLocal: boolean | undefined
  /** Final-state freshness fact for the terminal receipt. */
  let channelAirborneAtReturn: boolean | undefined
  const channelReceipt = (): NonNullable<VehicleMoveResult['channel']> => ({
    submissions: channelSubmissions,
    replans: channelReplans,
    ...(channelContinuations > 0 ? { continuations: channelContinuations } : {}),
    ...(channelEndReason ? { endReason: channelEndReason } : {}),
    ...(channelFailure ? { failure: channelFailure } : {}),
    ...(channelLegs.length > 0 ? { legs: channelLegs } : {}),
    ...(channelAirborneAtReturn !== undefined ? { airborneAtReturn: channelAirborneAtReturn } : {}),
  })

  /**
   * The channel path a plan carries: the planner's verified thinning when it
   * produced one, else the raw A* path. The host must not thin on its own —
   * that is where an unverified chord cut the river bank (R4 cave-diag-07).
   */
  const channelPathOf = (plan: { path?: Vec3[], channelPath?: Vec3[] }): Vec3[] =>
    plan.channelPath ?? plan.path ?? []

  /** Nearest path index to a position; cuts the remaining prefix for verification. */
  const nearestPathIndex = (path: Vec3[], position: Vec3): number => {
    let best = 0
    let bestDistance = Number.POSITIVE_INFINITY
    for (let index = 0; index < path.length; index++) {
      const point = path[index]!
      const distance = Math.hypot(point.x - position.x, point.y - position.y, point.z - position.z)
      if (distance < bestDistance) {
        bestDistance = distance
        best = index
      }
    }
    return best
  }

  /**
   * Builds the client-flown terminal approach profile (R4): descending
   * waypoints from the current state to the verified aim.
   *
   * A two-point direct leg asks the client to lose the whole vertical gap
   * inside one `entryReach` window; its bounded pitch candidates cannot do
   * that, so the session circles or refuses (`no_viable`, approach-diag-01).
   * The profile steps the descent at `CHANNEL_APPROACH_PROFILE_STEP` spacing
   * so every leg stays inside a normal glide, and each waypoint below a roof
   * stays under it. The client's sweep still verifies every candidate against
   * the live world, so these are aim points, not a claim of cleared space.
   */
  const buildApproachPath = (position: Vec3, aim: Vec3, roofY?: number): Vec3[] => {
    const gap = horizontalDistance(position, aim)
    const legs = Math.max(1, Math.min(4, Math.round(gap / CHANNEL_APPROACH_PROFILE_STEP)))
    const points: Vec3[] = []
    for (let index = 1; index <= legs; index++) {
      const t = index / legs
      const y = position.y + (aim.y - position.y) * t
      points.push({
        x: position.x + (aim.x - position.x) * t,
        y: roofY !== undefined ? Math.min(y, roofY - 1) : y,
        z: position.z + (aim.z - position.z) * t,
      })
    }
    // The terminal point is the verified aim, never an interpolated one.
    points[points.length - 1] = { ...aim }
    return points
  }

  /**
   * R3 channel cruise (design `elytra-flight-control-r3-channel-loop` §3–§4):
   * submit the planned path, read typed receipts with a monotonic cursor, and
   * answer exactly one question for the rest of the mover — is a verified
   * channel still carrying the flight? The host writes no `look` or `useItem`
   * during this phase (single-writer rule §7); the client drives per tick and
   * enforces its own deadline.
   *
   * Returns a terminal receipt when the flight is over, or a loop seed the
   * airborne landing machinery continues from.
   */
  const runChannelFlight = async (startState: MovementState): Promise<{
    terminal?: VehicleMoveResult
    seed?: { phase: FlightPhase, reason: LandingReason, state: MovementState, landingAim?: Vec3, landingSite?: LandingSite }
  }> => {
    const world = options.world
    if (!world) {
      return { terminal: { status: 'unavailable', failure: 'capability_unavailable', detail: 'no world binding for the flight channel', channel: channelReceipt() } }
    }

    // A client rejection is a typed outcome, not a retry loop: only a busy
    // writer (1 s wait) and the runner's own stale/leftover repairs retry.
    const excludes: Array<{ position: Vec3, radius: number }> = []
    /**
     * The glider's own corridor direction, refreshed from the last sample.
     * The canyon bends away from the straight goal bearing; a window anchored
     * on the goal line contains only the bank there (R4 cave-diag-08/10).
     * Only used while it roughly agrees with the goal bearing, so a heading
     * into a wall cannot steer the replan window.
     */
    let corridorBearing: { x: number, z: number } | undefined
    const goalBearing = Math.atan2(-(goal.x - startState.position.x), goal.z - startState.position.z)
    /**
     * Plans one leg and stamps its wall-clock cost. The cost is evidence: a
     * prefetched leg overlaps the previous leg, a late one explains a gap.
     *
     * The default (narrow) window is enough now that the frontier comparison
     * scores every candidate: on the captured canyon snapshot the narrow
     * window already yields a level river route (R4 cave-coverage-02), so the
     * planner is not forced into the expensive wide-window retry.
     */
    const planFrom = async (position: Vec3) => {
      const startedAt = now()
      const result = await planLowRoute({
        port,
        self: position,
        goal,
        // Read the river bends beside the goal bearing. The four-block strip
        // in host-03 lost the low continuation and selected the bank top.
        // Each slab still obeys the planner's 32,000-cell read bound.
        halfWidth: 12,
        // The canyon plan needs the longer cap: the body-clearance and climb
        // costs make the search explore more than the open-air default did.
        searchTimeCapMs: CHANNEL_PLAN_TIME_CAP_MS,
        ...(goalRoofY !== undefined ? { roofY: goalRoofY } : {}),
        ...(excludes.length > 0 ? { exclude: excludes } : {}),
        ...(corridorBearing ? { bearing: corridorBearing } : {}),
        ...(options.mustPass && options.mustPass.length > 0 ? { mustPass: options.mustPass } : {}),
      })
      debug?.(`channel plan from=${JSON.stringify(position)} status=${result.status} kind=${result.waypointKind ?? 'none'} climb=${result.maxClimbSlope ?? 0} path=${JSON.stringify(result.channelPath ?? [])}`)
      return { ...result, planMs: now() - startedAt }
    }

    let plan = await planFrom(startState.position)
    if (plan.status !== 'planned' || !plan.path || plan.path.length < 2) {
      debug?.(`channel route refused (${plan.status}${plan.reason ? `: ${plan.reason}` : ''}); refusing the flight instead of flying direct`)
      return { terminal: { status: 'unavailable', failure: 'route_unavailable', detail: `no verified flight channel (${plan.status})`, channel: channelReceipt() } }
    }
    // Launch changes height before the first frontier can be reached. A short
    // local leg exposed its endpoint as a terminal constraint while the next
    // region was still being read (host-02: y75 above the y64.5 frontier).
    // Read up to two connected suffixes while grounded. Only exact shared
    // vertices are joined: this adds no chord outside the verified segments.
    if (startState.onGround) {
      for (let extension = 0; extension < 2 && plan.local === true && !shouldStop(); extension++) {
        const initialPath = channelPathOf(plan)
        let length = 0
        for (let index = 1; index < initialPath.length; index++)
          length += horizontalDistance(initialPath[index - 1]!, initialPath[index]!)
        if (length >= LOW_ROUTE_SPAN)
          break
        const frontier = initialPath.at(-1)!
        const suffix = await planFrom(frontier)
        const suffixPath = channelPathOf(suffix)
        const entry = suffixPath[0]
        if (suffix.status !== 'planned' || !suffix.path || suffixPath.length < 2 || !entry
          || Math.hypot(frontier.x - entry.x, frontier.y - entry.y, frontier.z - entry.z) > 1e-6) {
          debug?.(`channel startup continuation refused (${suffix.status}; exact join=${entry !== undefined && frontier.x === entry.x && frontier.y === entry.y && frontier.z === entry.z})`)
          break
        }
        plan = {
          ...suffix,
          path: [...plan.path!, ...suffix.path.slice(1)],
          channelPath: [...initialPath, ...suffixPath.slice(1)],
          planMs: plan.planMs + suffix.planMs,
        }
        debug?.(`channel startup continuation joined: points=${plan.channelPath!.length}`)
      }
    }
    legMeta = { kind: 'initial', plannedFrom: startState.position, planMs: plan.planMs, rawPath: plan.path }
    let activePath = channelPathOf(plan)
    // A frontier leg hands over to the next revision, so the client must not
    // enter the terminal hold at its end (ab-30 plan §2).
    let activeWaypointKind = plan.waypointKind
    /**
     * True while the submitted route ends at the covered frontier because the
     * goal's chunk was never read (R1 `local`). A frontier completion is NOT
     * arrival: the host re-plans from the new position and resubmits until a
     * full route exists or the replan budget is spent (R3 live 2026-09-20: the
     * client reported `channel_complete` 85 blocks out at the frontier and the
     * host landed there, reporting a 117-block miss).
     */
    let activePlanLocal = plan.local === true
    /** Final-approach state: the client flies the last leg to a verified site. */
    let finalApproachActive = false
    let approachAim: Vec3 | undefined
    let approachSite: LandingSite | undefined
    let approachAttempts = 0
    /** Last client-rejection spot (8-block cells); a repeat stops replanning. */
    let lastRejectionKey: string | undefined
    /**
     * The next leg's plan started while the current one still flies. Only used
     * when the exclusion set did not change after the prefetch (a rejection
     * invalidates the prefetched route).
     */
    let prefetch: { from: Vec3, excludeCount: number, promise: ReturnType<typeof planFrom> } | undefined
    const deadlineMs = now() + CRUISE_TIMEOUT_MS
    const baseId = `fl-${options.commandId ?? 'elytra'}-${Math.floor(now())}`
    let revision = 0
    const runner = createFlightChannelRunner({
      port,
      ...(options.controlSessionGeneration !== undefined ? { generation: () => options.controlSessionGeneration! } : {}),
      dimension: () => world.dimension,
      now,
      ...(debug ? { debug } : {}),
    })
    /**
     * Submits the active path, or a pending candidate when the client supports
     * handover: the candidate must not become the flown path until the client
     * reports adoption, or the host would run prefix checks and prefetches
     * around a route that is not flying yet (R4 review 4).
     */
    const submitCurrent = async (entryReach = CHANNEL_ENTRY_REACH, pending = false): Promise<boolean> => {
      revision += 1
      channelSubmissions += 1
      const meta = legMeta ?? { kind: 'retry' as const, plannedFrom: startState.position, planMs: 0 }
      const sentPath = pending && pendingChannelPath ? pendingChannelPath : activePath
      const leg: ChannelLegRecord = {
        revision,
        kind: meta.kind,
        plannedFrom: { ...meta.plannedFrom },
        planStatus: 'planned',
        planMs: meta.planMs,
        ...(meta.rawPath ? { rawPath: meta.rawPath.map(point => ({ ...point })) } : {}),
        sentPath: sentPath.map(point => ({ ...point })),
        submittedAtMs: now(),
        accepted: false,
      }
      channelLegs.push(leg)
      // A handover leg is not the flown leg yet: the client adopts it at a
      // tick boundary, and the old leg's end facts are stamped then (R4
      // review item 3). A normal leg replaces the flown one at once.
      if (pending) {
        pendingLeg = leg
        pendingLegSessionId = `${baseId}-${revision}`
      }
      else {
        currentLeg = leg
      }
      legMeta = undefined
      // A submitted leg starts its own flight window: a prefetch for the old
      // frontier must not be consumed by the new leg's completion.
      prefetch = undefined
      const submitted = await runner.submit({
        sessionId: `${baseId}-${revision}`,
        revision,
        mapVersion: world.mapVersion,
        deadlineMs,
        path: sentPath,
        entryReach,
        ...(activeWaypointKind !== undefined ? { kind: activeWaypointKind } : {}),
        ...(activeWaypointKind === 'stop' ? { terminalReach: 1, terminalPlanning: true } : {}),
        ...(options.controlSessionId ? { controlSessionId: options.controlSessionId } : {}),
      })
      if (!submitted.ok) {
        leg.refusal = submitted.receipt.reason ?? submitted.refusal
        if (pending) {
          pendingLeg = undefined
          pendingLegSessionId = undefined
          pendingChannelPath = undefined
          pendingPlanLocal = undefined
        }
        channelEndReason = submitted.refusal
        channelRefusal = submitted.receipt.reason
        debug?.(`channel submit refused (${submitted.refusal}; client reason=${submitted.receipt.reason ?? 'none'})`)
        return false
      }
      leg.accepted = true
      debug?.(`channel submitted ${baseId}-${revision} revision=${revision} points=${sentPath.length}${pending ? ' (handover)' : ''}`)
      return true
    }

    let submittedOk = await submitCurrent()
    if (!submittedOk && channelEndReason === 'control_busy') {
      debug?.('channel busy with another drive; retrying once after 1 s')
      await sleep(1_000)
      submittedOk = await submitCurrent()
    }
    if (!submittedOk) {
      return { terminal: { status: 'unavailable', failure: 'launch_unavailable', detail: `the client refused the flight channel (${channelRefusal ?? channelEndReason ?? 'rejected'})`, channel: channelReceipt() } }
    }

    const readState = async (): Promise<MovementState | undefined> => {
      try {
        return await port.getState()
      }
      catch {
        return undefined
      }
    }

    /**
     * Unified in-air failure ending (R4 review item 5): an airborne failure
     * must not return control to the caller while the glider still flies —
     * that is how cave-diag-06 reported `route_unavailable` with
     * `onGround=false` and left the bot to drift. Every such failure now seeds
     * the bounded safety landing; the failure reason is kept in the receipt so
     * "returned" and "safely grounded" stay separate facts.
     */
    const endAirborne = async (
      failure: string,
      detail: string,
      state?: MovementState,
      sample?: FlightChannelSample,
    ): Promise<{ seed: { phase: FlightPhase, reason: LandingReason, state: MovementState } }> => {
      channelFailure = failure
      debug?.(`channel ${failure} (${detail}); bounded safety ending`)
      await runner.revoke()
      // Precedence: the caller's fresh state, then a live read, then the last
      // channel sample (a read-failure ending must not pretend she is grounded
      // by falling back to the launch state), then the start state.
      const current = state ?? (await readState()) ?? (sample ? stateOfSample(sample, startState) : startState)
      return { seed: { phase: 'safety-landing', reason: 'safety', state: current } }
    }

    let lastProgressAt = now()
    let lastProgressPosition = startState.position
    /** Closest goal distance seen; only a new best resets the loiter clock. */
    let bestGoalDistance = horizontalDistance(startState.position, goal)
    let lastGoalProgressAt = now()
    let traveled = 0
    let lastSample: FlightChannelSample | undefined
    let pollErrors = 0
    let resourcePoll = 0
    let nextVerifyAt = CHANNEL_PREFIX_VERIFY_BLOCKS
    /** The client can adopt a pending route; learned from its status. */
    let handoverCapable = false
    let handoverCount = 0
    /** One continuation attempt per client hold window; avoids a submit loop. */
    let holdingLegRequested = false
    /** Minimum spacing between landing-site offers to a recovering client (C2). */
    const CHANNEL_LANDING_OFFER_MS = 2_000
    let nextLandingOfferAt = 0

    for (;;) {
      if (!ownsControl()) {
        // Another command owns the input; the host must not fight it. Record
        // whether the glider was airborne so the receipt does not imply a
        // grounded stop (R4 review item 5).
        channelAirborneAtReturn = isAirborneState((await readState()) ?? startState)
        await runner.revoke()
        return { terminal: { status: 'unknown', failure: 'unverified_stop', detail: 'input ownership moved to a newer command', channel: channelReceipt() } }
      }
      if (shouldStop()) {
        channelEndReason = 'host_cancelled'
        await runner.revoke()
        return { seed: { phase: 'safety-landing', reason: 'cancelled', state: (await readState()) ?? startState } }
      }
      // The client enforces its own deadline; this one bounds the host wait.
      if (now() > deadlineMs) {
        channelEndReason = 'host_deadline'
        await runner.revoke()
        return { seed: { phase: 'safety-landing', reason: 'timeout', state: (await readState()) ?? startState } }
      }

      let poll
      try {
        poll = await runner.poll()
      }
      catch (error) {
        pollErrors += 1
        debug?.(`channel status read failed (${pollErrors}/${CHANNEL_POLL_ERROR_BUDGET}): ${errorMessageFrom(error) ?? 'unknown error'}`)
        if (pollErrors >= CHANNEL_POLL_ERROR_BUDGET) {
          return await endAirborne('touchdown_unverified', 'channel status reads failed', undefined, lastSample)
        }
        await sleep(CHANNEL_POLL_MS)
        continue
      }
      pollErrors = 0
      handoverCapable = handoverCapable || poll.status.handoverCapable === true

      const sample = poll.status.trajectory[poll.status.trajectory.length - 1] ?? lastSample
      if (sample) {
        const moved = Math.hypot(sample.x - lastProgressPosition.x, sample.y - lastProgressPosition.y, sample.z - lastProgressPosition.z)
        if (moved > CHANNEL_STALL_MOVE) {
          traveled += moved
          lastProgressPosition = { x: sample.x, y: sample.y, z: sample.z }
          lastProgressAt = now()
        }
        lastSample = sample
        const goalDistance = horizontalDistance(lastProgressPosition, goal)
        if (goalDistance < bestGoalDistance - CHANNEL_PROGRESS_EPSILON) {
          bestGoalDistance = goalDistance
          lastGoalProgressAt = now()
        }
        // Refresh the corridor bearing from the measured motion; keep it only
        // while it agrees with the goal bearing within 75 degrees.
        const speed = Math.hypot(sample.vx, sample.vz)
        if (speed > 0.15) {
          const bearing = { x: sample.vx / speed, z: sample.vz / speed }
          const bearingYaw = Math.atan2(-bearing.x, bearing.z)
          let delta = bearingYaw - goalBearing
          while (delta > Math.PI) delta -= 2 * Math.PI
          while (delta < -Math.PI) delta += 2 * Math.PI
          corridorBearing = Math.abs(delta) <= (75 * Math.PI) / 180 ? bearing : undefined
        }
        // Plan the next leg while this one still flies (R4 review item 2): the
        // old flow planned only after `channel_complete`, and the 44-tick
        // unowned glide (cave-diag-06) happened inside that wait.
        if (activePlanLocal && !prefetch) {
          const frontier = activePath[activePath.length - 1]!
          const remaining = Math.hypot(frontier.x - sample.x, frontier.y - sample.y, frontier.z - sample.z)
          if (remaining <= CHANNEL_PREFETCH_DISTANCE) {
            debug?.(`channel prefetching the next leg ${remaining.toFixed(0)} blocks out`)
            prefetch = { from: { ...frontier }, excludeCount: excludes.length, promise: planFrom(frontier) }
          }
        }
      }

      // The client adopted the pending leg when its session id changes; that
      // is when the old leg's record closes and the pending path becomes the
      // flown one (R4 review item 3 and 4).
      const statusSessionId = poll.status.sessionId
      if (pendingLeg && statusSessionId !== undefined && statusSessionId === pendingLegSessionId) {
        if (currentLeg) {
          currentLeg.endedReason = 'handover'
          currentLeg.endedAtMs = now()
          if (lastSample)
            currentLeg.positionAtEnd = { x: lastSample.x, y: lastSample.y, z: lastSample.z }
        }
        currentLeg = pendingLeg
        pendingLeg = undefined
        pendingLegSessionId = undefined
        if (pendingChannelPath) {
          activePath = pendingChannelPath
          activePlanLocal = pendingPlanLocal === true
        }
        pendingChannelPath = undefined
        pendingPlanLocal = undefined
        handoverCount += 1
        holdingLegRequested = false
        debug?.(`channel handover adopted by the client (${handoverCount})`)
      }

      // One state read per poll: the resource guard reuses it, and a glider
      // that stopped flying ends the exchange here. The check is gated on the
      // client having started applying, so the grounded launch phase is not
      // mistaken for a touchdown. This is the host's own observer: it does not
      // depend on the client reporting its end (older jars, or a session that
      // joined mid-air and landed).
      const liveState = await readState()
      if (poll.phase !== 'ended' && poll.status.applyingStarted === true
        && liveState && liveState.fallFlying !== true) {
        channelEndReason = channelEndReason ?? 'touchdown'
        debug?.('channel glider stopped flying; host owns the landing')
        await runner.revoke()
        return {
          seed: {
            phase: 'safety-landing',
            reason: 'goal',
            state: liveState,
            ...(approachAim ? { landingAim: approachAim } : {}),
            ...(approachSite ? { landingSite: approachSite } : {}),
          },
        }
      }

      // Handover-capable clients keep flying the current route until the next
      // one is adopted, so the next leg can be submitted early: the prefetched
      // plan is ready while she is still ~30 blocks from the frontier (R4
      // review items 2-3). A non-capable client is never submitted to early —
      // the runner's leftover repair would revoke the live channel.
      if (handoverCapable && activePlanLocal && prefetch && !pendingLeg
        && poll.phase === 'applying' && lastSample) {
        const frontier = activePath[activePath.length - 1]!
        const remaining = Math.hypot(frontier.x - lastSample.x, frontier.y - lastSample.y, frontier.z - lastSample.z)
        if (remaining <= CHANNEL_HANDOVER_DISTANCE) {
          const planned = prefetch.excludeCount === excludes.length
            ? await prefetch.promise.catch(() => undefined)
            : undefined
          const prefetchedFrom = prefetch.from
          prefetch = undefined
          if (planned && planned.status === 'planned' && planned.path && planned.path.length >= 2) {
            pendingChannelPath = channelPathOf(planned)
            pendingPlanLocal = planned.local === true
            legMeta = { kind: 'frontier', plannedFrom: prefetchedFrom, planMs: planned.planMs, rawPath: planned.path }
            activeWaypointKind = planned.waypointKind
            debug?.(`channel handover leg ready ${remaining.toFixed(0)} blocks out; submitting early`)
            if (await submitCurrent(CHANNEL_ENTRY_REACH, true))
              channelContinuations += 1
            else
              debug?.('channel early handover submit refused; the client hold will retry once')
          }
        }
      }

      // The client finished its path but holds instead of releasing input
      // (R4 review item 4). Continue the same flight with one next leg; if the
      // plan is refused, the client's bounded hold ends the flight and the
      // host lands. Old clients report `channel_complete` instead and take the
      // branch below.
      if (poll.phase === 'applying' && poll.status.holding === true && !pendingLeg && !holdingLegRequested) {
        holdingLegRequested = true
        const from = lastSample
          ? { x: lastSample.x, y: lastSample.y, z: lastSample.z }
          : (await readState())?.position ?? startState.position
        const prefetched = prefetch && prefetch.excludeCount === excludes.length
          ? await prefetch.promise.catch(() => undefined)
          : undefined
        const prefetchedFrom = prefetch?.from
        prefetch = undefined
        const replanned = prefetched ?? await planFrom(from)
        if (replanned.status === 'planned' && replanned.path && replanned.path.length >= 2) {
          pendingChannelPath = channelPathOf(replanned)
          pendingPlanLocal = replanned.local === true
          legMeta = { kind: 'frontier', plannedFrom: prefetchedFrom ?? from, planMs: replanned.planMs, rawPath: replanned.path }
          debug?.('channel client holds after the path; submitting the next leg')
          if (await submitCurrent(CHANNEL_ENTRY_REACH, true)) {
            channelContinuations += 1
            debug?.('channel hold continued with a handover leg')
          }
        }
        else {
          debug?.(`channel hold could not continue (${replanned.status}); the client grace ends the flight`)
        }
      }

      if (poll.phase === 'ended') {
        const endReason = poll.endReason ?? 'unknown'
        channelEndReason = endReason
        debug?.(`channel ended: ${endReason}`)
        const finalState = (await readState()) ?? startState
        if (pendingLeg) {
          // The client ended without adopting the pending leg: record it as
          // dropped so the evidence shows the handover never completed.
          pendingLeg.refusal = 'handover_dropped'
          pendingLeg = undefined
          pendingLegSessionId = undefined
          pendingChannelPath = undefined
          pendingPlanLocal = undefined
        }
        holdingLegRequested = false
        if (currentLeg) {
          currentLeg.endedReason = endReason
          currentLeg.endedAtMs = now()
          currentLeg.positionAtEnd = { ...finalState.position }
          currentLeg = undefined
        }
        // The route ended, but the client's recovery may still own the
        // aircraft. The host must not start its own flight until the physical
        // phase is released (ab-23 repair plan, A3); while it waits it offers
        // a verified landing site so the recovery has an executable exit (C2).
        if (poll.controlReleased === false && now() <= deadlineMs) {
          if (poll.recovering === true && now() >= nextLandingOfferAt) {
            nextLandingOfferAt = now() + CHANNEL_LANDING_OFFER_MS
            const site = (await findLandingSite(port, finalState, now, debug, goalRoofY))
              ?? (await findGoalLandingSite(port, goal, finalState, now, debug, goalRoofY))
            if (site) {
              const aim = {
                x: site.support.x + site.support.width / 2,
                y: site.contactY + CHANNEL_APPROACH_AIM_CLEARANCE,
                z: site.support.z + site.support.depth / 2,
                contactY: site.contactY,
              }
              const receipt = await runner.landingSite({ sessionId: runner.active()?.sessionId ?? '', ...aim }).catch(() => undefined)
              debug?.(`channel landing site offered: accepted=${receipt?.accepted === true}${receipt?.reason ? ` reason=${receipt.reason}` : ''}`)
            }
            else {
              debug?.('channel recovery has no reachable landing site to offer')
            }
          }
          debug?.(`channel route ended (${endReason}); waiting for the client to release control`)
          await sleep(CHANNEL_POLL_MS)
          continue
        }
        if (endReason === 'channel_complete') {
          // The client-driven final approach (R4): when the route completes
          // near the goal and a verified landing site exists, the LAST leg is
          // another channel instead of the host's heuristic flight. The client
          // then hands over within `CHANNEL_APPROACH_ENTRY_REACH` of the pad,
          // and the host only flares and classifies.
          if (finalApproachActive) {
            return {
              seed: {
                phase: 'approach',
                reason: 'goal',
                state: finalState,
                ...(approachAim ? { landingAim: approachAim } : {}),
                ...(approachSite ? { landingSite: approachSite } : {}),
              },
            }
          }
          if (!activePlanLocal && horizontalDistance(finalState.position, goal) <= CHANNEL_APPROACH_MAX_DISTANCE) {
            const site = (await findGoalLandingSite(port, goal, finalState, now, debug, goalRoofY))
              ?? (await findLandingSite(port, finalState, now, debug, goalRoofY))
            if (site) {
              const aim: Vec3 = {
                x: site.support.x + site.support.width / 2,
                y: goalRoofY !== undefined
                  ? Math.min(site.contactY + CHANNEL_APPROACH_AIM_CLEARANCE, goalRoofY - 1)
                  : site.contactY + CHANNEL_APPROACH_AIM_CLEARANCE,
                z: site.support.z + site.support.depth / 2,
              }
              if (horizontalDistance(finalState.position, aim) <= CHANNEL_APPROACH_MAX_DISTANCE) {
                approachAim = aim
                approachSite = site
                finalApproachActive = true
                approachAttempts = 0
                // A descending profile, not a direct two-point hop: the client
                // cannot lose the whole vertical gap inside one entryReach.
                activePath = [{ ...finalState.position }, ...buildApproachPath(finalState.position, aim, goalRoofY)]
                activePlanLocal = false
                legMeta = { kind: 'approach', plannedFrom: finalState.position, planMs: 0 }
                debug?.(`channel final approach to ${aim.x.toFixed(0)},${aim.y.toFixed(0)},${aim.z.toFixed(0)}`)
                if (await submitCurrent(CHANNEL_APPROACH_ENTRY_REACH))
                  continue
                finalApproachActive = false
                approachAim = undefined
                approachSite = undefined
              }
            }
            debug?.('channel final approach unavailable; landing with the host')
          }
          // A local route ends at the frontier, not at the goal: continue the
          // same flight while the continuation budget allows. This is normal
          // progress, not a failure, so it has its own counter (R4 review
          // item 2) and consumes the prefetched plan when one is ready.
          if (activePlanLocal && channelContinuations < CHANNEL_MAX_CONTINUATIONS) {
            const prefetched = prefetch && prefetch.excludeCount === excludes.length
              ? await prefetch.promise.catch(() => undefined)
              : undefined
            const prefetchedFrom = prefetch?.from
            prefetch = undefined
            const replanned = prefetched ?? await planFrom(finalState.position)
            if (replanned.status === 'planned' && replanned.path && replanned.path.length >= 2) {
              activePath = channelPathOf(replanned)
              activePlanLocal = replanned.local === true
              legMeta = {
                kind: 'frontier',
                plannedFrom: prefetchedFrom ?? finalState.position,
                planMs: replanned.planMs,
                rawPath: replanned.path,
              }
              if (await submitCurrent()) {
                channelContinuations += 1
                debug?.(`channel frontier reached; local route continues (continuation ${channelContinuations}, revision ${revision}, plan ${replanned.planMs}ms${prefetched ? ', prefetched' : ''})`)
                continue
              }
            }
            debug?.('channel frontier replan refused; landing at the frontier')
          }
          return { seed: { phase: 'approach', reason: 'goal', state: finalState } }
        }
        if (endReason === 'touchdown') {
          return {
            seed: {
              phase: 'safety-landing',
              reason: 'goal',
              state: finalState,
              ...(approachAim ? { landingAim: approachAim } : {}),
              ...(approachSite ? { landingSite: approachSite } : {}),
            },
          }
        }
        if (endReason === 'deadline')
          return { seed: { phase: 'safety-landing', reason: 'timeout', state: finalState } }
        // A water entry is an explicit failure terminal, not a glide that the
        // host should keep flying: the client's aerodynamic model has no water
        // state, and the host must report what actually happened (R4 review
        // 3.2/6). Stable water entry is never a safe ground contact.
        if (endReason === 'water') {
          channelAirborneAtReturn = false
          channelFailure = 'landing_in_water'
          return { terminal: { status: 'stuck', failure: 'landing_in_water', detail: 'the client entered the water', channel: channelReceipt() } }
        }
        // The client held after its path and no next leg arrived in time: the
        // hold is bounded, and the host owns the landing that follows.
        if (endReason === 'handover_timeout')
          return await endAirborne('handover_timeout', 'the client held for a handover that never arrived', finalState)
        // Damage while the channel applies ends it at once: the host lands.
        if (endReason === 'damage')
          return { seed: { phase: 'safety-landing', reason: 'safety', state: finalState } }
        if (endReason === 'no_viable_trajectory') {
          // The client-driven final approach (R4): retry once with the direct
          // leg, then fall back only short — a long host heuristic flight into
          // the terminal area is what caused the collision damage.
          if (finalApproachActive) {
            if (approachAttempts < CHANNEL_APPROACH_ATTEMPTS && approachAim) {
              approachAttempts += 1
              activePath = [{ ...finalState.position }, approachAim]
              legMeta = { kind: 'approach', plannedFrom: finalState.position, planMs: 0 }
              debug?.(`channel approach refused; retrying direct (${approachAttempts}/${CHANNEL_APPROACH_ATTEMPTS})`)
              if (await submitCurrent(CHANNEL_APPROACH_ENTRY_REACH))
                continue
            }
            const aim = approachAim
            const closeToAim = aim !== undefined
              && horizontalDistance(finalState.position, aim) <= CHANNEL_APPROACH_ENTRY_REACH * 2
              // At or above the aim: flaring from below means a climb into
              // whatever put her under it (pad-diag-02: flare from 5 below the
              // aim, damage 20 -> 0). Below the aim the bounded safety landing
              // owns the ending instead.
              && finalState.position.y >= aim.y - 1
              && finalState.position.y - aim.y <= FLARE_HEIGHT
            if (closeToAim && aim) {
              debug?.('channel approach refused; short host flare')
              return {
                seed: {
                  phase: 'approach',
                  reason: 'goal',
                  state: finalState,
                  landingAim: aim,
                  ...(approachSite ? { landingSite: approachSite } : {}),
                },
              }
            }
            debug?.('channel approach refused far from the aim; bounded safety ending')
            return { seed: { phase: 'safety-landing', reason: 'safety', state: finalState } }
          }
          const rejectionKey = lastSample
            ? `${Math.round(lastSample.x / 8)},${Math.round(lastSample.z / 8)}`
            : undefined
          if (rejectionKey !== undefined && rejectionKey === lastRejectionKey) {
            // The same spot was rejected twice: a fresh plan has nothing new to
            // say (cave-diag-03 burned three revisions and two minutes on the
            // same waypoint). Land with the host instead.
            debug?.('channel rejected twice at the same spot; bounded host landing')
            return { seed: { phase: 'safety-landing', reason: 'safety', state: finalState } }
          }
          lastRejectionKey = rejectionKey
          if (channelReplans < CHANNEL_MAX_REVISIONS && lastSample) {
            channelReplans += 1
            // Exclude the space AHEAD of the failure, not the cell the glider
            // occupies: a sphere over the current position would invalidate the
            // start node and the replan could never leave (R3 test caught it).
            const heading = lastSample.yaw * Math.PI / 180
            const ahead = CHANNEL_INVALIDATE_RADIUS * 1.5
            excludes.push({
              position: {
                x: lastSample.x - Math.sin(heading) * ahead,
                y: lastSample.y,
                z: lastSample.z + Math.cos(heading) * ahead,
              },
              radius: CHANNEL_INVALIDATE_RADIUS,
            })
            const replanned = await planFrom({ x: lastSample.x, y: lastSample.y, z: lastSample.z })
            if (replanned.status === 'planned' && replanned.path && replanned.path.length >= 2) {
              activePath = channelPathOf(replanned)
              activePlanLocal = replanned.local === true
              legMeta = {
                kind: 'retry',
                plannedFrom: { x: lastSample.x, y: lastSample.y, z: lastSample.z },
                planMs: replanned.planMs,
                rawPath: replanned.path,
              }
              debug?.(`channel invalidated at ${lastSample.x.toFixed(0)},${lastSample.z.toFixed(0)}; replan ${revision + 1}`)
              if (await submitCurrent())
                continue
            }
          }
          // A refusal this close to the goal is a landing problem, not a route
          // failure: the host lands instead of reporting route_unavailable
          // (R4 diag-04: the last 21 blocks were refused after the budget).
          if (lastSample && horizontalDistance({ x: lastSample.x, y: lastSample.y, z: lastSample.z }, goal) <= CHANNEL_HOST_LANDING_DISTANCE) {
            debug?.('channel route refused near the goal; landing with the host')
            return { seed: { phase: 'approach', reason: 'goal', state: finalState } }
          }
          // Far from the goal with no route left: a terminal `route_unavailable`
          // here is what left cave-diag-06 airborne with no owner. The bounded
          // safety landing owns the ending instead (R4 review item 5).
          return await endAirborne('route_unavailable', `the client rejected the route after ${channelReplans} replans`, finalState)
        }
        if (endReason.startsWith('launch_') || endReason === 'no_elytra')
          return { terminal: { status: 'unavailable', failure: 'launch_unavailable', detail: `client takeoff failed (${endReason})`, channel: channelReceipt() } }
        if (endReason === 'dimension_changed')
          return { terminal: { status: 'unknown', failure: 'dimension_changed', detail: 'channel ended (dimension_changed)', channel: channelReceipt() } }
        return { terminal: { status: 'unknown', failure: 'unverified_stop', detail: `channel ended (${endReason})`, channel: channelReceipt() } }
      }

      // Host-side resource guards, receipt-paced (every fourth poll).
      resourcePoll += 1
      if (resourcePoll % 4 === 0 && poll.phase === 'applying') {
        const health = liveState?.health
        if (health !== undefined && health <= LOW_HEALTH) {
          await runner.revoke()
          return { seed: { phase: 'safety-landing', reason: 'safety', state: (await readState()) ?? startState } }
        }
        fireworks = await countBySuffix(port, 'firework_rocket').catch(() => fireworks)
        if (fireworks <= FIREWORK_LOW_SUPPLY) {
          await runner.revoke()
          return { seed: { phase: 'safety-landing', reason: 'low_supply', state: (await readState()) ?? startState } }
        }
      }

      // Applying without progress: a frozen bot or a loitering one. Re-plan
      // once, else land. Loitering is movement that never reduces the distance
      // to the goal (cave-diag-04 circled a two-block radius for 165 s).
      const frozen = poll.phase === 'applying' && now() - lastProgressAt > CHANNEL_STALL_MS
      const loitering = poll.phase === 'applying' && now() - lastGoalProgressAt > CHANNEL_PROGRESS_WINDOW_MS
      if (frozen || loitering) {
        debug?.(`channel ${frozen ? 'stalled' : 'loitering'} at ${lastProgressPosition.x.toFixed(0)},${lastProgressPosition.z.toFixed(0)}; replan budget ${channelReplans}/${CHANNEL_MAX_REVISIONS}`)
        if (channelReplans < CHANNEL_MAX_REVISIONS) {
          channelReplans += 1
          const replanned = await planFrom(lastProgressPosition)
          if (replanned.status === 'planned' && replanned.path && replanned.path.length >= 2) {
            await runner.revoke()
            activePath = channelPathOf(replanned)
            activePlanLocal = replanned.local === true
            legMeta = { kind: 'retry', plannedFrom: lastProgressPosition, planMs: replanned.planMs, rawPath: replanned.path }
            if (await submitCurrent()) {
              lastProgressAt = now()
              lastGoalProgressAt = now()
              bestGoalDistance = horizontalDistance(lastProgressPosition, goal)
              continue
            }
          }
        }
        await runner.revoke()
        return { seed: { phase: 'safety-landing', reason: 'timeout', state: (await readState()) ?? startState } }
      }

      // Prefix re-verification every CHANNEL_PREFIX_VERIFY_BLOCKS of progress:
      // the remaining prefix must still lead where a fresh plan leads, or the
      // channel is revoked and re-submitted as a new revision.
      //
      // ROOT CAUSE (R3 live 2026-09-20): comparing the new plan's FIRST point
      // with the submitted next waypoint is not a comparison of like roles.
      // The plan starts at the glider's current (launch-boosted) altitude while
      // the submitted waypoint sits at the route band 30+ blocks below, so
      // every verification "diverged" and the host replanned on a loop. The
      // check now compares HORIZONTAL route shape only: a vertical difference
      // at one station is a descent in progress, and a real vertical obstacle
      // is the client sweep's job to refuse. A fresh plan that cannot be
      // planned right now (read failure, search budget, terrain context) does
      // NOT invalidate the submitted prefix, which the client is still flying;
      // only a divergent horizontal route does.
      if (traveled >= nextVerifyAt && poll.phase === 'applying') {
        nextVerifyAt = traveled + CHANNEL_PREFIX_VERIFY_BLOCKS
        // A fresh plan is only comparable from the route: the launch boost can
        // leave the glider 50 blocks above its own first waypoint, and the
        // fresh plan from up there routes over the bank — that mismatch is not
        // evidence the submitted prefix diverged (R4 cave-diag-14: a false
        // divergence at the bridge spent the replan budget before the canyon).
        const nearestRoutePoint = activePath[nearestPathIndex(activePath, lastProgressPosition)]!
        const offRoute = Math.hypot(
          nearestRoutePoint.x - lastProgressPosition.x,
          nearestRoutePoint.y - lastProgressPosition.y,
          nearestRoutePoint.z - lastProgressPosition.z,
        )
        if (offRoute > CHANNEL_PREFIX_VERIFY_MAX_OFFSET) {
          debug?.(`channel prefix verification skipped; ${offRoute.toFixed(0)} blocks off the route`)
        }
        else {
          const replanned = await planFrom(lastProgressPosition)
          const refused = replanned.status !== 'planned' || !replanned.path || replanned.path.length < 2
          const expectedIndex = Math.min(nearestPathIndex(activePath, lastProgressPosition) + 1, activePath.length - 1)
          const expected = activePath[expectedIndex]!
          const aligned = !refused && replanned.path
            ? replanned.path[nearestPathIndex(replanned.path, expected)]
            : undefined
          const diverged = aligned !== undefined
            && Math.hypot(aligned.x - expected.x, aligned.z - expected.z) > CHANNEL_PREFIX_DIVERGENCE
          if (refused || diverged)
            debug?.(`channel prefix ${refused ? 'refused' : 'diverged'} at ${lastProgressPosition.x.toFixed(0)},${lastProgressPosition.z.toFixed(0)}; replan budget ${channelReplans}/${CHANNEL_MAX_REVISIONS}`)
          if (diverged && channelReplans < CHANNEL_MAX_REVISIONS) {
            channelReplans += 1
            await runner.revoke()
            if (replanned.path) {
              activePath = channelPathOf(replanned)
              activePlanLocal = replanned.local === true
              legMeta = { kind: 'retry', plannedFrom: lastProgressPosition, planMs: replanned.planMs, rawPath: replanned.path }
            }
            if (await submitCurrent()) {
              lastProgressAt = now()
              continue
            }
          }
          else if (refused) {
            debug?.('channel prefix verification refused; holding the submitted route')
          }
          else if (diverged) {
            debug?.('channel prefix diverged with no replan budget; holding the route')
          }
        }
      }

      await sleep(CHANNEL_POLL_MS)
    }
  }

  let state = await port.getState()
  // A worn suit flies straight to the nearest landing; that flow is the
  // legacy safety landing, not a planned channel.
  const channelCapable = options.flightPlanner?.enabled === true
    && !equip.lowDurability
    && options.world !== undefined
    && port.flightSubmit !== undefined
    && port.flightStatus !== undefined
    && port.flightRevoke !== undefined

  let deployed = false
  /** Terminal receipt from the channel exchange; the flight never enters a loop. */
  let channelTerminal: VehicleMoveResult | undefined
  /** Loop seed after the channel ended with the glider still flying. */
  let channelSeed: { phase: FlightPhase, reason: LandingReason, state: MovementState, landingAim?: Vec3, landingSite?: LandingSite } | undefined
  /** Last approach-gate refusal; the trail logs a change, not every poll. */
  let lastApproachRefusal: ApproachRefusal | undefined
  if (channelCapable) {
    const outcome = await runChannelFlight(state)
    if (outcome.terminal)
      channelTerminal = outcome.terminal
    else
      channelSeed = outcome.seed
  }
  if (channelTerminal)
    return channelTerminal

  if (!channelCapable) {
    // Legacy takeoff. The bridge's per-tick macro runs first when it exists
    // (OV-D16): it lifts off flat ground, which the edge run cannot, and it
    // owns the two single-tick steps (the deploy press after a released jump
    // key, and the boost from the airborne state) that a 200 ms poll cannot
    // hit. The edge run stays as the fallback, so a cliff takeoff does not
    // regress. The channel mode needs none of this: the client's own driver
    // equips, launches toward the first waypoint and hands over mid-air.
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
    deployed = macro?.deployed === true || state.fallFlying === true
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
  }
  else if (channelSeed) {
    state = channelSeed.state
    debug?.(`elytra channel ended (${channelSeed.reason}); host owns the landing`)
    // R4 gate: a seed approach still passes the approach-entry gate. A refusal
    // (misaligned, too fast, above the roof, cannot glide) cruises first to
    // re-align instead of forcing the entry.
    if (channelSeed.phase === 'approach') {
      const gate = evaluateApproachEntry({
        position: state.position,
        yaw: state.yaw,
        horizontalSpeed: horizontalSpeed(state),
        goal,
        aim: channelSeed.landingAim ?? goal,
        ...(goalRoofY !== undefined ? { roofY: goalRoofY } : {}),
      })
      if (!gate.enter) {
        lastApproachRefusal = gate.reason
        channelSeed.phase = 'cruise'
        debug?.(`elytra approach held after the channel (${gate.reason}); cruising to re-align`)
      }
    }
  }

  let reason: LandingReason = channelSeed
    ? channelSeed.reason
    : equip.lowDurability ? 'safety' : 'goal'
  let phase: FlightPhase = channelSeed
    ? channelSeed.phase
    : equip.lowDurability ? 'safety-landing' : 'cruise'
  /**
   * The cruise band starts at the goal-anchored route band when the planner
   * is on: that band (goal.y + 2) is known a priori from the command and is
   * what every low-route replan will anchor to, so the pitch law descends
   * from the very first poll. ROOT CAUSE (live, 2026-09-19): starting at
   * goal.y + 30 made her climb toward 95 while the route waited at 66, and
   * the ratchet (stale-window scans, corridor aims) kept her at 150+. Without
   * the planner the classic +30 offset stays (open-terrain heuristic trips).
   * The roof cap below still applies when the probe has covered the column.
   * A channel seed skips the band entirely: the client flew the route, and
   * the seeded phase is an approach or a safety landing at her own altitude.
   */
  const plannerOn = options.flightPlanner?.enabled === true
  let cruiseY = channelSeed
    ? channelSeed.state.position.y
    : plannerOn
      ? Math.min(goal.y + 2, goalRoofY ?? Number.POSITIVE_INFINITY)
      : goalRoofY !== undefined
        ? Math.min(goal.y + CRUISE_BAND_ABOVE, goalRoofY)
        : Math.max(goal.y + CRUISE_BAND_ABOVE, state.position.y)
  let lastFireworkAt = 0
  /** CD-E B0: rollout planner for the cruise phase; absent keeps the heuristics. */
  const planner = plannerOn === true ? options.flightPlanner : undefined
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
  // A channel seed enters the loop mid-lifecycle, so its phase owns a fresh
  // deadline from here instead of inheriting a zero that reads as expired.
  if (channelSeed?.phase === 'approach')
    approachDeadline = now() + APPROACH_TIMEOUT_MS
  if (channelSeed?.phase === 'safety-landing')
    safetyDeadline = now() + SAFETY_LANDING_TIMEOUT_MS

  // The landing target resolves once and is then held: an early landing keeps
  // one verified site instead of chasing a new one every poll.
  let landingSite: LandingSite | undefined
  let landingPoint: Vec3 = goal
  let landingResolved = false
  /** True when no verified support area existed; an unverified point is not a site. */
  let noReachableLanding = false
  /**
   * When the route layer last delivered a plan (R3). The historical "has ever
   * flown a route" boolean is gone: the last band steers only inside the
   * bounded hold window below, and expiry returns the band to the forward
   * scan, so a stale plan can never own the vertical response forever.
   */
  let lastRoutePlannedAt = Number.NEGATIVE_INFINITY
  /** The last planned band steers only while its bounded hold is alive. */
  const routeHoldActive = (): boolean => now() - lastRoutePlannedAt < LOW_ROUTE_HOLD_MS
  /** Band of the last successful plan; held through temporary refusals. */
  let lastRouteBand: number | undefined
  let lowRouteReplans = 0
  let lowRouteRefusals = 0
  let lowRouteLastRefusal: 'blocked' | 'read_failed' | 'search_budget' | undefined

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
    // A goal landing prefers the patch at the command target; the ahead scan
    // is the fallback for early landings that are not at the goal.
    if (reason === 'goal') {
      landingSite = (await findGoalLandingSite(port, goal, state, now, debug, goalRoofY))
        ?? (await findLandingSite(port, state, now, debug, goalRoofY))
    }
    else {
      landingSite = await findLandingSite(port, state, now, debug, goalRoofY)
    }
    if (landingSite) {
      landingPoint = {
        x: landingSite.support.x + landingSite.support.width / 2,
        y: landingSite.contactY,
        z: landingSite.support.z + landingSite.support.depth / 2,
      }
      return
    }
    noReachableLanding = reason !== 'goal'
    // Minimal-risk ending: descend where she is instead of flying to an
    // unverified point ahead. R4 cave-diag-05: the unverified aim pointed into
    // the river bank and the host flight ended in a death; a vertical descent
    // cannot clip terrain ahead, and water is a typed splash-down.
    landingPoint = { ...state.position }
    debug?.(`elytra landing target ${landingPoint.x.toFixed(1)},${landingPoint.y},${landingPoint.z.toFixed(1)} (unverified, descending in place)`)
  }
  // A channel-seeded final approach carries the verified aim: the host flare
  // must land where the client was already flying, not re-pick a site.
  if (channelSeed?.landingAim) {
    landingSite = channelSeed.landingSite
    landingPoint = channelSeed.landingAim
    landingResolved = true
  }
  else if (reason !== 'goal') {
    await resolveLanding()
  }
  // A channel seed hands over mid-air with the landing leg ahead: the site is
  // resolved now, not on the cruise path that will never run (R3).
  else if (phase === 'approach') {
    await resolveLanding()
  }

  /** Enters the bounded safety landing that owns cancellation and timeouts. */
  const enterSafetyLanding = async (): Promise<FlightPhase> => {
    safetyDeadline = now() + SAFETY_LANDING_TIMEOUT_MS
    await resolveLanding()
    return 'safety-landing'
  }

  /** Enters a bounded go-around, or falls back to a safety landing. */
  const enterGoAround = async (): Promise<FlightPhase> => {
    // No verified site: a go-around has nowhere better to go. Descending with
    // the bounded safety landing and reporting the limitation is the honest
    // ending; a go-around here only extends the flight over unverified ground
    // (R4 approach-diag-03: the unverified aim led to a go-around and a death).
    if (landingSite === undefined || noReachableLanding)
      return await enterSafetyLanding()
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
      //
      // R4: 80 blocks is only the candidate trigger. The gate also checks
      // alignment, speed, the roof and glide feasibility; a refusal leaves the
      // cruise in control and is named once in the trail.
      const approachGate = evaluateApproachEntry({
        position: state.position,
        yaw: state.yaw,
        horizontalSpeed: horizontalSpeed(state),
        goal,
        aim: landingPoint,
        ...(goalRoofY !== undefined ? { roofY: goalRoofY } : {}),
      })
      if (phase === 'cruise' && reason === 'goal' && approachGate.enter) {
        phase = 'approach'
        approachDeadline = now() + APPROACH_TIMEOUT_MS
        minApproachGap = horizontalDistance(state.position, goal)
      }
      else if (phase === 'cruise' && reason === 'goal' && !approachGate.enter
        && horizontalDistance(state.position, goal) <= APPROACH_DISTANCE
        && lastApproachRefusal !== approachGate.reason) {
        lastApproachRefusal = approachGate.reason
        debug?.(`elytra approach held (${approachGate.reason})`)
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
          const plan = await planLowRoute({
            port,
            self: state.position,
            goal,
            ...(options.mustPass && options.mustPass.length > 0 ? { mustPass: options.mustPass } : {}),
          })
          lowRouteAt = now()
          if (plan.status === 'planned' && plan.waypoint) {
            lowRoute = { waypoint: plan.waypoint, bandY: plan.bandY ?? plan.waypoint.y }
            lastRoutePlannedAt = now()
            lastRouteBand = lowRoute.bandY
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
      // The route band LEADS the descent instead of ratcheting to her
      // altitude. ROOT CAUSE (live, 2026-09-19): the old construction
      // max(bandY + margin, min(cruiseY, y)) glued the band to her current
      // altitude, so the route's low band (66) could never pull her down —
      // she stayed at whatever height the launch and stale-window scans had
      // ratcheted her to (75 → 110 → 139) and arrived at the goal 80 blocks
      // too high. The band is now the route's own altitude; the pitch law
      // converts the gap into a nose-down angle, and the descent-step cap
      // bounds how fast the band itself may drop.
      if (phase === 'cruise' && lowRoute) {
        const routeBand = lowRoute.bandY + LOW_ROUTE_BAND_MARGIN
        cruiseY = Math.max(routeBand, cruiseY - LOW_ROUTE_DESCENT_STEP)
      }
      // A goal under a roof caps the cruise band: the approach must enter the
      // cave mouth, and the band cannot sit above the roof while the glider
      // still needs to descend under it (live 2026-09-19: without the cap the
      // band followed the canyon wall upward and she overflew east 300 blocks).
      if (phase === 'cruise' && goalRoofY !== undefined && reason === 'goal')
        cruiseY = Math.min(cruiseY, goalRoofY)
      // CD-E2: the coarse corridor owns the near-field route hint, but ONLY
      // while the long-route layer has no fresh plan. ROOT CAUSE (live,
      // 2026-09-19): with a fresh route the corridor's internal grid still
      // planned vertical detours (aims at y=137, 165 over a band-66 route) and
      // the rollout chased them up to y=174; the goal-anchored route owns the
      // whole path when it exists. A corridor aim also never commands a climb:
      // it is a lateral avoidance layer and the route band owns altitude.
      const routeFresh = lowRoute !== undefined && now() - lowRouteAt < LOW_ROUTE_TTL_MS
      if (corridor && phase === 'cruise' && !routeFresh) {
        const routeAim = await corridor.step(state.position, goal)
        if (routeAim) {
          target = { x: routeAim.x, y: Math.min(routeAim.y, state.position.y), z: routeAim.z }
          debug?.(`elytra corridor aim ${target.x.toFixed(1)},${target.y.toFixed(1)},${target.z.toFixed(1)}`)
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
      // Band sources, in order: a fresh route leads the descent (it already
      // set the band above); without one, a mission that HAS flown a route
      // holds its last known band — a temporary plan refusal must not rocket
      // her into the canyon ceiling (live 2026-09-19: the TTL replan refused
      // once, the scan raised the band, and she climbed into the wall at t=6s,
      // twice). The scan's raise only applies to flights that never had a
      // route (open-terrain heuristic trips).
      if (!lowRouteFresh) {
        if (lastRouteBand !== undefined && routeHoldActive())
          cruiseY = Math.max(lastRouteBand, cruiseY - LOW_ROUTE_DESCENT_STEP)
        else
          cruiseY = scan.cruiseY
      }
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
        if (planner && planner.rolloutOn) {
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
          // Climb over anything close ahead — but only while the flight has
          // no route contract. ROOT CAUSE (live, 2026-09-19, the extended
          // ceiling fixture): the scan reads the obsidian ceiling at her
          // altitude as "obstacle ahead" and the emergency response climbs
          // OVER it, while the goal-anchored route has already verified air
          // at band 66 through that same ceiling — she must fly UNDER. Once
          // the mission has a route, vertical decisions belong to the route
          // band; the scan keeps its obstacleDistance for the landing path.
          const climbing = state.position.y < cruiseY - 4
            || (emergency && !routeHoldActive())
          // A large surplus is dived away, not waited away: the elytra trades
          // height for speed, and the old 35-degree ceiling made the mover arrive
          // over a goal under a roof with 20-50 blocks it could not lose (live
          // 2026-09-18, the cave fixture). Bounded at DIVE_PITCH.
          const surplus = state.position.y - cruiseY
          const diveCeiling = surplus > 12 ? DIVE_PITCH : 35
          pitch = climbing ? CLIMB_PITCH : clamp(-(cruiseY - state.position.y) * 1.2, -30, diveCeiling)
          wantThrust = (climbing && !routeHoldActive()) || horizontalSpeed(state) < MIN_CRUISE_SPEED
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
      else if (obstacleDistance !== undefined
        && (obstacleDistance <= TERRAIN_GUARD_DISTANCE || state.position.y < cruiseY - 4)) {
        // A wall in the landing path: spend a rocket to clear it. R4 collision
        // diagnostic 2026-09-20: the old condition only climbed when she was
        // already 4 blocks under the band, so an approach at band height flew
        // straight into a close bank (health 20 -> 17.9 during the host-owned
        // landing leg). Terrain this close always wins over the descent aim.
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
    // "Returned" and "safely grounded" are separate facts (R4 review item 5):
    // the receipt records the state the mover actually returned from. A water
    // float is not airborne; it is its own typed outcome.
    channelAirborneAtReturn = isAirborneState(state)
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
        ? { lowRoute: { used: lastRoutePlannedAt > Number.NEGATIVE_INFINITY, replans: lowRouteReplans, refusals: lowRouteRefusals, ...(lowRouteLastRefusal ? { lastRefusal: lowRouteLastRefusal } : {}) } }
        : {}),
      ...(channelCapable ? { channel: channelReceipt() } : {}),
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

/** Why the approach entry was refused; named for the trail and the receipt. */
export type ApproachRefusal = 'too-far' | 'above-roof' | 'not-aligned' | 'too-fast' | 'cannot-reach'

/**
 * Evaluates the approach-entry gate (R4). Pure: the caller supplies the live
 * facts. `enter: true` hands the flight to the approach state machine; a
 * refusal leaves the cruise in control and names the missing condition.
 *
 * @example
 * // Aligned and under the roof, 60 blocks out, gliding speed
 * evaluateApproachEntry({ position: { x: 0, y: 70, z: 0 }, yaw: 0, horizontalSpeed: 0.8,
 *   goal: { x: 0, y: 64, z: 60 }, aim: { x: 0, y: 64, z: 60 }, roofY: 75 })
 * // => { enter: true }
 */
export function evaluateApproachEntry(input: {
  position: Vec3
  yaw: number
  horizontalSpeed: number
  goal: Vec3
  aim: Vec3
  roofY?: number
}): { enter: true } | { enter: false, reason: ApproachRefusal } {
  const gap = horizontalDistance(input.position, input.goal)
  if (gap > APPROACH_DISTANCE)
    return { enter: false, reason: 'too-far' }
  if (input.roofY !== undefined && input.position.y > input.roofY)
    return { enter: false, reason: 'above-roof' }
  // Short final: the flare owns the settling, alignment and speed no longer
  // gate the entry.
  if (gap <= APPROACH_SHORT_FINAL)
    return { enter: true }
  if (Math.abs(angleDelta(input.yaw, yawTo(input.position, input.aim))) > APPROACH_ALIGN_DEG)
    return { enter: false, reason: 'not-aligned' }
  if (input.horizontalSpeed > APPROACH_MAX_SPEED)
    return { enter: false, reason: 'too-fast' }
  const aimGap = horizontalDistance(input.position, input.aim)
  if (aimGap > FLARE_DISTANCE && input.position.y - input.aim.y < aimGap * MIN_GLIDE_RATIO)
    return { enter: false, reason: 'cannot-reach' }
  return { enter: true }
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

/** Still in the air: neither standing nor floating in water. */
function isAirborneState(state: MovementState): boolean {
  return state.onGround !== true && state.inWater !== true
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
 * Builds the best-known state from the last channel sample. Used when a state
 * read fails while the glider is airborne: falling back to the launch state
 * would claim she is on the ground and skip the landing entirely.
 */
function stateOfSample(sample: FlightChannelSample, fallback: MovementState): MovementState {
  return {
    position: { x: sample.x, y: sample.y, z: sample.z },
    yaw: sample.yaw,
    motion: { x: sample.vx, y: sample.vy, z: sample.vz },
    onGround: sample.onGround,
    fallFlying: sample.gliding,
    ...(sample.health !== undefined ? { health: sample.health } : {}),
    inWater: fallback.inWater,
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
  /** Channel exchange participation typed into every terminal outcome (R3). */
  channel?: VehicleMoveResult['channel']
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
  const channelField = input.channel ? { channel: input.channel } : {}
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
    return { status: 'stuck', failure: 'landing_in_water', detail: 'touch-down landed in water', ...lowRouteField, ...channelField }
  }
  if (outcome.kind !== 'landed' && outcome.kind !== 'unsettled') {
    if (outcome.kind === 'still-flying')
      return { status: 'unknown', failure: 'touchdown_unverified', detail: 'the glide was still active at the deadline', ...lowRouteField, ...channelField }
    if (input.noReachableLanding)
      return { status: 'unknown', failure: 'no_reachable_landing', detail: 'no verified landing site on the flight', ...lowRouteField, ...channelField }
    const detail = outcome.kind === 'lost-flight'
      ? 'the glide ended without a confirmed ground contact'
      : outcome.kind === 'unknown' ? outcome.reason : 'the touch-down was never verified'
    return { status: 'unknown', failure: 'touchdown_unverified', detail, ...lowRouteField, ...channelField }
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
      ...channelField,
    }
  }
  if (reason === 'low_supply')
    return { status: 'low_supply', detail: `landed early with ${fireworks} rockets`, ...lowRouteField, ...channelField }
  if (distance <= input.tolerance) {
    // Landing on the roof over the goal is horizontally "at" it but is not
    // arrival: the goal sits under that roof (E-02 canyon gap 1).
    if (input.goalRoofY !== undefined && finalState.position.y > input.goalRoofY) {
      return {
        status: 'stuck',
        failure: 'goal_under_roof',
        detail: `landed on the roof y=${finalState.position.y.toFixed(0)} above goal ceiling y=${input.goalRoofY.toFixed(0)} at ${distance.toFixed(1)} blocks horizontal`,
        ...lowRouteField,
        ...channelField,
      }
    }
    return { status: 'reached', ...lowRouteField, ...channelField }
  }
  return {
    status: 'stuck',
    ...(input.noReachableLanding ? { failure: 'no_reachable_landing' as const } : {}),
    detail: `landing miss: ${distance.toFixed(1)} blocks`,
    ...lowRouteField,
    ...channelField,
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

/**
 * Finds a verified landing patch NEAR THE GOAL (R4): the goal-anchored search.
 *
 * The ahead-scan finds the nearest patch along the heading, which on the river
 * fixture is the bank beside the target pad (pad-runs-01 runs 4/5: the host
 * flared onto a y=80 bank, 8 blocks above the pad). A goal-anchored read makes
 * the command target decide the site; the ahead scan stays as the fallback for
 * landings that are not at the goal.
 */
async function findGoalLandingSite(
  port: MovementControlPort,
  goal: Vec3,
  state: MovementState,
  now: () => number,
  debug?: (message: string) => void,
  /** When set, patches standing at or above this y are roofs, not ways in. */
  maxContactY?: number,
): Promise<LandingSite | undefined> {
  const radius = 8
  const gx = Math.floor(goal.x)
  const gz = Math.floor(goal.z)
  const topY = Math.floor(goal.y) + 6
  const bottomY = Math.floor(goal.y) - 8
  let entries
  try {
    entries = await port.getBlocksRegion(
      { x: gx - radius, y: bottomY, z: gz - radius },
      { x: gx + radius, y: topY, z: gz + radius },
    )
  }
  catch {
    return undefined
  }
  let best: LandingSite | undefined
  let bestDistance = Number.POSITIVE_INFINITY
  for (let x = gx - radius; x <= gx + radius; x++) {
    for (let z = gz - radius; z <= gz + radius; z++) {
      const site = evaluatePatch({
        entries,
        x,
        z,
        from: state.position,
        topY,
        scanDepth: 14,
        now: now(),
      })
      if (!site)
        continue
      if (maxContactY !== undefined && site.contactY >= maxContactY)
        continue
      const distance = Math.hypot(
        site.support.x + site.support.width / 2 - goal.x,
        site.support.z + site.support.depth / 2 - goal.z,
      )
      if (distance < bestDistance) {
        bestDistance = distance
        best = site
      }
    }
  }
  if (best && bestDistance <= radius) {
    debug?.(`elytra goal landing site ${(best.support.x + best.support.width / 2).toFixed(1)},${best.contactY},${(best.support.z + best.support.depth / 2).toFixed(1)} (${bestDistance.toFixed(1)} from the goal)`)
    return best
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
