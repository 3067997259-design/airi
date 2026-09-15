/**
 * Movement planning types (MC-3 Phase 1)。
 *
 * Port targets `mineflayer-pathfinder` (MIT) Movements/astar into the
 * main-process game host, adapted to a block snapshot instead of a live bot.
 */
export interface Vec3 {
  x: number
  y: number
  z: number
}

/**
 * One collision box in cell-local coordinates, each axis in `[0, 1]`.
 *
 * The region read may omit collision shapes; the movement view then derives a
 * conservative box from `physical` and `height`. A top slab, an upper door half
 * or a stair step cannot be recovered from the id alone, so a source that knows
 * the shape must send it (CD-G2).
 */
export interface CollisionBox {
  minX: number
  minY: number
  minZ: number
  maxX: number
  maxY: number
  maxZ: number
}

/** Derived per-block facts the movement costs use. */
export interface BlockInfo {
  id: string
  /** Position of the block itself (not the node). */
  x: number
  y: number
  z: number
  /** Solid full cube (blocks walking through). */
  physical: boolean
  /** Walkable space (empty, climbable, carpet). */
  safe: boolean
  /** Can be replaced by placement (air, liquids). */
  replaceable: boolean
  liquid: boolean
  canFall: boolean
  climbable: boolean
  openable: boolean
  /** Open doors and open gates are passable without an interaction. */
  open: boolean
  /** Top surface height (block y + collision height). */
  height: number
  /** Block hardness from the world read; used for dig labor (approximation). */
  hardness: number
  /**
   * Exact collision boxes when the source sent them. Absent means the movement
   * view derives a conservative shape instead.
   */
  collision?: CollisionBox[]
}

/** Read-only block source; unresolved positions are reported to the caller. */
export interface BlockSource {
  getBlock: (x: number, y: number, z: number) => BlockInfo | undefined
}

/** One action the executor must take before entering a successor node. */
export interface MoveAction {
  kind: 'break' | 'place' | 'use'
  x: number
  y: number
  z: number
  /** Pillar placement jumps while placing below the player. */
  jump?: boolean
}

/**
 * How the executor actually moves across one edge (CD-G1 D1).
 *
 * The action flags alone cannot classify an edge: a full-block ascent has no
 * break/place/parkour action but is still a jump, not a plain walk. `walk` and
 * `step-up` are the continuous ground motions; the rest are action boundaries.
 */
export type MovementMotionKind
  = | 'walk'
    | 'step-up'
    | 'jump-up'
    | 'fall'
    | 'swim'
    | 'climb'
    | 'parkour'
    | 'interaction'

/** One A* successor (mineflayer `Move` shape, trimmed). */
export interface MovementNode {
  x: number
  y: number
  z: number
  /** Scaffolding blocks left for the rest of the path. */
  remainingPlaceables: number
  cost: number
  toBreak: Vec3[]
  toPlace: MoveAction[]
  parkour: boolean
  /**
   * Motion kind when the generator knows it (swim, climb). Left unset when the
   * planner cannot prove it, and derived from the support heights instead.
   */
  motion?: MovementMotionKind
  /** Top surface height of the destination support, when the generator knew it. */
  supportHeight?: number
}

export interface MovementConfig {
  canDig: boolean
  /**
   * CD-M1 plan-time dig authorization.
   *
   * A guarded block is never a break edge, so a route cannot treat a wall as
   * cheap when no reachable tool can harvest it. The final break still
   * re-verifies through the runtime harvest evaluation.
   */
  digGuard?: (block: BlockInfo) => boolean
  /** CD-M1 plan-time dig cost, including the tool cost when the caller knows it. */
  digCostOf?: (block: BlockInfo, baseCost: number) => number
  digCost: number
  placeCost: number
  liquidCost: number
  entityCost: number
  dontCreateFlow: boolean
  dontMineUnderFallingBlock: boolean
  allow1by1towers: boolean
  allowParkour: boolean
  allowSprinting: boolean
  canOpenDoors: boolean
  maxDropDown: number
  infiniteLiquidDropdownDistance: boolean
  /** World bottom used by the landing search (upstream `bot.game.minY`). */
  minY: number
}

export const DEFAULT_MOVEMENT_CONFIG: MovementConfig = {
  canDig: false,
  digCost: 1,
  placeCost: 1,
  liquidCost: 1,
  entityCost: 1,
  dontCreateFlow: true,
  dontMineUnderFallingBlock: true,
  allow1by1towers: true,
  allowParkour: true,
  allowSprinting: true,
  canOpenDoors: true,
  maxDropDown: 4,
  infiniteLiquidDropdownDistance: true,
  minY: -64,
}

export interface PathStep extends MovementNode {
  from: Vec3
  /** Top surface height of the source support, when the generator knew it. */
  fromSupportHeight?: number
}

export type PlanFailureReason = 'no_path' | 'no_chunk' | 'cost_limit' | 'timeout' | 'search_budget'

export interface PlanSuccess {
  ok: true
  steps: PathStep[]
  cost: number
  nodes: number
  /** Positions the search stubbed because the snapshot lacked them. */
  missing?: Vec3[]
}

export interface PlanFailure {
  ok: false
  reason: PlanFailureReason
  nodes: number
  /** First position outside the snapshot that the search needed. */
  missing?: Vec3
}
