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
