/**
 * Host port the terrain executor drives (MC-3 Phase 1, increment 2)。
 *
 * The main game host implements this over its private MCP session; tests
 * implement it with a scripted fake. Everything here is per-call IO, so the
 * executor stays free of MCP shapes.
 */
import type { ObservationEnvelope, TerrainReadRequest, TerrainReadResponse } from './observation'
import type { SnapshotEntry } from './snapshot'
import type { Vec3 } from './types'
import type { RidingInfo } from './vehicle-types'

export type { RidingInfo } from './vehicle-types'

/**
 * A player-state read that carried no usable position (CD-0 D4).
 *
 * Raised instead of fabricating zero coordinates, `onGround: true` or
 * `fallFlying: false`. A caller that needs a position must handle this; it
 * must not treat an unreadable state as a landing.
 */
export class UnreadablePlayerStateError extends Error {
  readonly reason: string

  constructor(reason: string) {
    super(`Player state is unreadable: ${reason}`)
    this.name = 'UnreadablePlayerStateError'
    this.reason = reason
  }
}

export interface MovementState {
  position: Vec3
  yaw: number
  /** Head pitch in degrees; omitted when the read did not report it. */
  pitch?: number
  inWater: boolean
  onGround: boolean
  /** Velocity in blocks per tick; the elytra mover uses the horizontal speed. */
  motion?: Vec3
  /** True while gliding with an elytra; omitted when the read did not report it. */
  fallFlying?: boolean
  /** Health from the bridge; the elytra safety net uses it. */
  health?: number
  /** Source, freshness and binding metadata for this read (CD-0 §3.2). */
  observation?: ObservationEnvelope
}

export type BlockFace = 'up' | 'down' | 'north' | 'south' | 'east' | 'west'

/** One block read for aim and verification. */
export interface BlockView {
  id: string
  air: boolean
  properties?: Record<string, string>
  hardness?: number
}

/** One inventory slot the executor can select or inspect. */
export interface InventorySlot {
  slot: number
  id: string
  count: number
  hotbar: boolean
  /** Durability when the bridge reports it (elytra backups). */
  damage?: number
  maxDamage?: number
}

/** One equipped item the port can inspect (armor slots for the elytra mover). */
export interface EquipmentView {
  id: string
  damage?: number
  maxDamage?: number
}

export interface MovementInput {
  forward?: boolean
  back?: boolean
  left?: boolean
  right?: boolean
  jump?: boolean
  sneak?: boolean
  sprint?: boolean
}

/** One planned hop inside a climbing chain (Step 3). */
export interface JumpTaskEdge {
  /** Identity of this edge, echoed in the status and the completion records. */
  edgeId: string
  /** Source stand point of the edge, from the planned path step. */
  from: Vec3
  /** Landing stand point (block center X/Z, foot level Y). */
  target: Vec3
  /** Takeoff line point; the task presses jump once the bot passes it. */
  takeoff: Vec3
  /** Horizontal flight direction (unit or raw; the task normalizes). */
  direction: { x: number, z: number }
  sprint: boolean
  /** Nothing past the landing absorbs the flight overshoot: brake in the air. */
  brake: boolean
}

/** One climbing chain handed to the mod's per-tick jump task (Step 3). */
export interface JumpTask {
  /**
   * The chain in execution order.
   *
   * The host cannot submit edge by edge: every key release between two hops
   * still lets the bot slide, so the mod gets the whole chain and hands over at
   * each real touchdown.
   */
  edges: JumpTaskEdge[]
  /** `stop` settles at the last edge's destination. */
  landingIntent: 'stop' | 'continue'
  /** Absolute deadline in epoch milliseconds. */
  deadlineMs: number
}

/** Result of a per-tick jump task. `landed` is the only success. */
export interface JumpTaskStatus {
  state: 'idle' | 'running' | 'done' | 'failed' | 'cancelled'
  endReason: string
  ticks: number
  position?: Vec3
  onGround?: boolean
  /** Horizontal distance to the landing at the read time. */
  distance?: number
  takeoffPassed?: boolean
  /** Which edge the task is on, and the state machine phase it is in. */
  edgeId?: string
  phase?: string
  /** The key set the task applied this read (nine-input settle names included). */
  effectiveInput?: string
  landingIntent?: string
  nextEdgeId?: string
  /** How many edges of the submitted chain reported a real touchdown. */
  completedCount?: number
  /** Motion at the read time, blocks per tick. */
  motion?: { x: number, z: number }
  /** Block id the player stands on. */
  support?: string
}

/**
 * One flat-ground elytra launch handed to the mod's per-tick macro (OV-5).
 *
 * The host cannot run this sequence itself. The deploy press counts only on a
 * tick that follows a released jump key, and the boost has to leave from the
 * airborne gliding state; both are single ticks, while the host reads the
 * bridge every 150 to 200 ms. A host-side takeoff therefore needs a real drop
 * to fall off, which is why the macro exists.
 */
export interface ElytraLaunchTask {
  /**
   * Aim point for the climb.
   *
   * The macro only turns the bot toward it before the boost: the rocket pulls
   * the velocity toward the look vector, so the goal decides which way the
   * handoff speed points, not where the flight ends.
   */
  goal?: Vec3
  /** Absolute deadline in epoch milliseconds. */
  deadlineMs: number
  /**
   * False when the inventory holds no rocket.
   *
   * The macro then deploys and reports `no_fireworks` instead of pretending it
   * climbed, so the caller can hand over to a glide without thrust.
   */
  withFireworks: boolean
}

/**
 * Result of one elytra launch macro.
 *
 * `launched` is the only success: it means the glider was confirmed open and
 * the boost moved the bot up. Every other reason is typed, so a caller can tell
 * a missing suit (`no_elytra`) from a jump that never left the ground
 * (`grounded`) or a rocket that failed to fire (`no_fireworks`, `no_climb`).
 */
export interface ElytraLaunchStatus {
  state: 'idle' | 'running' | 'done' | 'failed' | 'cancelled'
  endReason: string
  ticks: number
  /** `prepare`, `jump`, `release-jump`, `deploy`, `boost` or `handoff`. */
  phase?: string
  /** The macro saw the bot leave the ground. */
  airborne?: boolean
  /**
   * The glider was confirmed open at least once.
   *
   * A failed macro can still report `true`: the rocket may be the part that
   * failed, and the caller then keeps gliding instead of repeating a takeoff it
   * already completed.
   */
  deployed?: boolean
  onGround?: boolean
  /** Vertical speed at the read time, blocks per tick. */
  verticalSpeed?: number
  /** How far the macro climbed above its start height. */
  climb?: number
  fireworksUsed?: number
  /** Live position at the read time. */
  position?: Vec3
}

/**
 * One ordered waypoint of a flight channel path.
 *
 * The client re-verifies every candidate against its own live world each tick,
 * so the host sends its planned route as-is instead of pre-clearing it.
 */
export interface FlightChannelWaypoint {
  x: number
  y: number
  z: number
}

/**
 * A must-pass opening the route has to fly through, e.g. the wool gap or the
 * space under the obsidian slab (ab-30 plan §1).
 *
 * The rectangle lives in the plane perpendicular to `axis` at coordinate `at`.
 * `lateral` is the other horizontal axis (z for axis 'x', x for axis 'z') and
 * `y` is the vertical extent. Callers must shrink the rectangle by the body
 * size and the safety margin before passing it in: a section the body cannot
 * fit through must be refused at extraction time, never widened here.
 */
export interface FlightCrossSection {
  /** Axis the opening is perpendicular to. */
  axis: 'x' | 'z'
  /** Coordinate of the opening's plane on `axis`. */
  at: number
  /** Horizontal extent on the other axis. */
  lateralMin: number
  lateralMax: number
  /** Vertical extent. */
  yMin: number
  yMax: number
}

/** Submit request for one client flight channel (R3). */
export interface FlightChannelSubmitRequest {
  /** Unique channel id; a repeat submit with the same id is idempotent client-side. */
  sessionId: string
  /** Connection generation; an older value is rejected as stale with the expected one echoed. */
  generation?: number
  /** Channel revision inside this host command; increments on every replan. */
  revision?: number
  /** Absolute wall-clock deadline; the client enforces it in every phase. */
  deadlineMs?: number
  /** Expected dimension; a change terminates the channel client-side. */
  dimension?: string
  /** Input control session this channel belongs to (CD-0 §3.1). */
  controlSessionId?: string
  channel: {
    /** Ordered waypoints, 2+; the client driver advances by `entryReach`. */
    path: FlightChannelWaypoint[]
    /** Waypoint advance radius, blocks. The adopted value is echoed. */
    entryReach?: number
    /** Final 3D arrival radius; the client also uses it for settled landing. */
    terminalReach?: number
    /** Opts a stop channel into bounded client-side terminal sequence search. */
    terminalPlanning?: boolean
    /**
     * What the path's end means (ab-30 plan §2). `stop` ends the trip and may
     * enter the terminal hold; `through` is a handover point the next revision
     * continues from, so the client must keep flying instead of holding.
     * Absent keeps the client's current terminal behaviour.
     */
    kind?: 'through' | 'stop'
  }
}

/** Submit receipt: acceptance is separate from the client having started to apply. */
export interface FlightChannelSubmitReceipt {
  accepted: boolean
  reason?: 'stale_generation' | 'session_active' | 'control_busy' | 'stale_control_session' | string
  expectedGeneration?: number
  activeSessionId?: string
  startedApplying?: boolean
  pathPoints?: number
  entryReach?: number
  terminalReach?: number
}

/** One per-tick sample of the client trajectory ring. */
export interface FlightChannelSample {
  tick: number
  x: number
  y: number
  z: number
  vx: number
  vy: number
  vz: number
  yaw: number
  pitch: number
  gliding: boolean
  onGround: boolean
  boostAttached: boolean
  rocketFiredThisTick: boolean
  /** Who wrote input that tick: none / launch-macro / flight-session. */
  inputOwner: string
  /** Health at that tick; proves where damage happened (R4). */
  health?: number
  /**
   * The player's body is in water. The client's aerodynamic model has no
   * water state, so a gliding flag alone cannot show the model is invalid
   * (R4 client review 3.2).
   */
  inWater?: boolean
  /** Usable rockets in the hands at that tick. */
  rocketsInHands?: number
  /** Rockets in the main inventory (not the hands) at that tick. */
  rocketsInInventory?: number
  /** The session that drove this tick; changes at a handover. */
  sessionId?: string
  /** Revision of the session that drove this tick. */
  revision?: number
  /** The client is in its post-path hold this tick. */
  holding?: boolean
  /** Estimated remaining boost ticks from the attached firework, if any. */
  boostRemainingEstimate?: number
  /** Attached firework entity ids this tick (stacking evidence, ab-17). */
  boostEntityIds?: string
  /** Count of attached firework entities this tick. */
  boostCount?: number
  // --- Per-tick decision telemetry (ab-17 audit 2026-09-21, section 6) -----
  /** The waypoint this tick steered to (the hold target while holding). */
  targetX?: number
  targetY?: number
  targetZ?: number
  /** Global route cursor at decision time. */
  cursor?: number
  /** Ticks the winning candidate's prediction covered. */
  predictedEndTicks?: number
  /** Route cursor at the end of the winning prediction. */
  predictedEndCursor?: number
  predictedEndX?: number
  predictedEndY?: number
  predictedEndZ?: number
  /** `arrived_lookahead` when the terminal was reached inside the horizon. */
  predictedEndReason?: string
  /** Predicted positions after 1/3/5 ticks: "x,y,z;x,y,z;x,y,z". */
  preview?: string
  /** Verified terminal action: hold / land / none. */
  terminalAction?: string
  /** First rejection of the driven tick, with its predicted context. */
  rejectKind?: string
  rejectTick?: number
  rejectX?: number
  rejectY?: number
  rejectZ?: number
  rejectBlock?: string
  /** Collision-shape tag of the rejected cell (full/partial/empty/unknown). */
  rejectShape?: string
  rejectCollisions?: number
  rejectFloor?: number
  rejectSpeed?: number
  rejectTerminal?: number
  /** Offered-but-unadopted handover id. */
  pendingSessionId?: string
  /** Wall clock at the sample, for video/tick alignment. */
  wallMs?: number
  /** Monotonic clock at the sample, for drift-free deltas. */
  nanoMs?: number
  // --- D1 evidence schema (ab-23 repair plan, batch D) ---------------------
  /** Physical control phase and route outcome at the sample. */
  controlPhase?: string
  routeOutcome?: string
  /** Global arc-length progress at the sample and at the prediction end. */
  progress?: number
  predictedEndProgress?: number
  /** The chosen candidate's stable policy id. */
  chosenPolicy?: string
  /** Candidate accounting and simulation cost of the driven tick. */
  evaluated?: number
  feasible?: number
  budgetExhausted?: boolean
  /** True when the bounded candidate search ran to its natural end. */
  searchCompleted?: boolean
  physicsSteps?: number
  blockQueries?: number
  cacheHits?: number
  simMs?: number
  /** Fire cooldown active at the driven tick. */
  cooldownActive?: boolean
  /** Why the phase changed: failure or release reason (typed). */
  transitionReason?: string
  /** Safe-search telemetry of the recovery/undecided takeover (ab-29 review). */
  safeCandidates?: number
  safeVerified?: number
  safeEmergency?: boolean
  safeContactTicks?: number
  /** The client build that produced the sample (D1). */
  build?: string
}

/** Status read of the channel session plus the samples newer than the cursor. */
export interface FlightChannelStatus {
  state: 'none' | 'accepted' | 'running' | 'revoked' | 'terminated' | string
  endReason?: string
  /** The client's terminal decision note (candidate count, eval ms, refusal). */
  endDetail?: string
  applyingStarted?: boolean
  entryReach?: number
  /**
   * The client can adopt a submitted route as a pending handover while the
   * current one still applies (R4 review item 3). Older jars omit it, so the
   * host only submits early when this is true.
   */
  handoverCapable?: boolean
  /** The route waiting to be adopted, when one was accepted early. */
  pendingSessionId?: string
  /** How many handovers this flight task performed; proof the gap was closed. */
  handoverCount?: number
  /**
   * True while the client finished its path but keeps flying a bounded hold
   * instead of releasing input, waiting for the host's next leg (R4 review
   * item 4). The host plans and submits when it sees this.
   */
  holding?: boolean
  /** The session the client is actually flying; changes at a handover. */
  sessionId?: string
  // --- Route outcome vs physical control phase (ab-23 repair plan, A2/A3) ---
  /**
   * Physical control phase: PREPARE / TRACK / HOLD / RECOVER / LAND / SETTLED
   * / RELEASED. Absent on older clients, where a terminal state is the only
   * release signal.
   */
  phase?: string
  /** Route result, separate from the phase: RUNNING / COMPLETED / FAILED / REVOKED. */
  routeOutcome?: string
  /** Why the route failed (the first failure wins); empty while running. */
  recoveryReason?: string
  /** True while the recovery phase owns the aircraft. */
  recovering?: boolean
  /** The client build that answered the status read (D1). */
  build?: string
  /** The last recovery frame passed the full 3D verification (ab-24 audit). */
  recoveryFrameVerified?: boolean
  trajectory: FlightChannelSample[]
  /** Effective radius used by the client's stop and landing checks. */
  terminalReach?: number
  /** Records the ring already overwrote; non-zero means the batch has holes. */
  trajectoryLost?: number
}

/** Revoke receipt; revocation and the confirmed stop are separate facts. */
export interface FlightChannelRevokeReceipt {
  revoked: boolean
  wasActive?: boolean
  endReason?: string
  reason?: string
}

/**
 * A host-selected landing site offered to a recovering client (ab-23 repair
 * plan, C2). The client validates reachability and support from its live
 * state; a refusal names the gap (`landing_unreachable`, `unsafe_support`,
 * `no_headroom`, `not_recovering`, `control_expired`).
 */
export interface FlightLandingSiteRequest {
  sessionId: string
  controlSessionId?: string
  /** Entry point the client should fly to. */
  x: number
  y: number
  z: number
  /** The support surface the host selected (top of the landing block). */
  contactY: number
  dimension?: string
}

export interface FlightLandingSiteReceipt {
  accepted: boolean
  reason?: string
  phase?: string
  siteX?: number
  siteY?: number
  siteZ?: number
  contactY?: number
}

export interface MovementControlPort {
  getState: () => Promise<MovementState>
  getBlocksRegion: (from: Vec3, to: Vec3) => Promise<SnapshotEntry[]>
  /**
   * Region read that also reports whether the source sent exact collision
   * shapes (CD-G2 unlock).
   *
   * Optional: fakes and bridges without shape support keep using
   * `getBlocksRegion`, and the corridor follower stays on the discrete path.
   */
  getBlocksRegionDetailed?: (from: Vec3, to: Vec3) => Promise<{ entries: SnapshotEntry[], exactShapes: boolean }>
  /**
   * Coverage-aware region read (CD-0 §3.2).
   *
   * Optional: a bridge without collision-snapshot capability reports a typed
   * limit through this absence instead of pretending a failed scan was empty.
   */
  readTerrain?: (request: TerrainReadRequest) => Promise<TerrainReadResponse>
  /**
   * Per-tick jump task (Step 3). Optional: a bridge without the jump tools
   * keeps the host-side latch, which cannot time takeoffs or landings.
   */
  startJump?: (task: JumpTask) => Promise<JumpTaskStatus>
  jumpStatus?: () => Promise<JumpTaskStatus>
  cancelJump?: () => Promise<JumpTaskStatus>
  /**
   * Per-tick flat-ground launch macro (OV-5).
   *
   * Optional: a bridge without the launch tools keeps the host-side edge run,
   * which cannot take off from flat ground but still flies a real cliff.
   */
  startLaunch?: (task: ElytraLaunchTask) => Promise<ElytraLaunchStatus>
  launchStatus?: () => Promise<ElytraLaunchStatus>
  cancelLaunch?: () => Promise<ElytraLaunchStatus>
  /**
   * Client flight channel surface (R3). Optional: a bridge without the flight
   * tools keeps the host-driven cruise, so the mover degrades instead of
   * pretending a channel exists.
   */
  flightSubmit?: (request: FlightChannelSubmitRequest) => Promise<FlightChannelSubmitReceipt>
  flightStatus?: (sinceTick?: number) => Promise<FlightChannelStatus>
  flightRevoke?: (sessionId: string) => Promise<FlightChannelRevokeReceipt>
  /**
   * Offers a verified landing site to a recovering client (C2). Optional: a
   * bridge without it keeps the client's own bounded recovery mirror.
   */
  flightLandingSite?: (request: FlightLandingSiteRequest) => Promise<FlightLandingSiteReceipt>
  getBlock: (pos: Vec3) => Promise<BlockView | undefined>
  getInventory: () => Promise<InventorySlot[]>
  look: (yaw: number, pitch: number) => Promise<void>
  setInput: (input: MovementInput) => Promise<void>
  stopMovement: () => Promise<void>
  jumpOnce: () => Promise<void>
  /** Starts a survival mining action; the caller polls `getBlock` to confirm. */
  breakBlock: (pos: Vec3) => Promise<void>
  /** Places the held block against the support position's face. */
  placeBlock: (support: Vec3, face: BlockFace) => Promise<void>
  /** Right-clicks the block under the crosshair (doors, gates, buttons). */
  useBlock: (pos: Vec3) => Promise<void>
  /** Air right-click: boats, buckets, fireworks, food (mc-3b D2). */
  useItem: () => Promise<void>
  selectHotbar: (slot: number) => Promise<void>
  /** Moves an item into a hotbar slot (container click swap). */
  swapSlots: (slotA: number, slotB: number) => Promise<void>
  /** Sneak pulse that leaves boats/horses/minecarts, then release. */
  dismount: () => Promise<void>
  /** Nearest rideable the player sits on, from the bridge's vehicle read. */
  getRiding: () => Promise<RidingInfo | undefined>
  /** Mounts the nearest rideable within radius, optionally of one type id. */
  boardNearestVehicle: (radius?: number, type?: string) => Promise<{ boarded: boolean, info?: RidingInfo }>
  /** Right-clicks one entity by uuid (saddle, tame, villager). */
  useEntity: (uuid: string) => Promise<void>
  /**
   * Reads the equipped chest slot. Optional so older scripted ports keep
   * working; movers that need it fail with `unavailable` when it is missing.
   */
  getEquipment?: () => Promise<{ chest?: EquipmentView } | undefined>
}
