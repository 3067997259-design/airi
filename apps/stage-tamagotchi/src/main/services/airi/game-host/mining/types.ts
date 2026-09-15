/**
 * Mining contracts (CD-M1..M3).
 *
 * The game rules decide whether a tool can harvest a block; the domain layer
 * decides whether spending that tool is worth it. This module owns both
 * decisions for one block and is shared by `game_break`, `game_collect` and the
 * terrain dig path. Everything here is side-effect free; IO lives behind
 * {@link MiningPort}.
 */
/** Coarse position key shared by the movement types. */
export interface MiningVec3 {
  x: number
  y: number
  z: number
}

/** Tool policy requested by the caller. */
export type ToolStrategy = 'fastest' | 'conserve' | 'specified'

/**
 * Which drop rule the candidate is expected to use.
 *
 * This is an expectation, not a guarantee: a modded loot table can still
 * produce a different product. `unknown` is emitted instead of a guess.
 */
export type ExpectedDropMode = 'normal' | 'silk-touch' | 'fortune' | 'unknown'

/** How trustworthy the tick estimate is. */
export type EstimateQuality = 'exact' | 'approximate' | 'unknown'

/**
 * Machine-readable reason an evaluation cannot satisfy a harvest request.
 *
 * A caller must not lower the requirement silently when one of these is set;
 * it either reports the unmet condition or picks an explicit manual path.
 */
export type HarvestUnmet
  = | 'no_tool'
    | 'tool_level_too_low'
    | 'unbreakable'
    | 'inventory_full'
    | 'data_unavailable'

/** Environmental risks that change the cost or safety of breaking the block. */
export type HarvestHazard
  = | 'falling-sand'
    | 'fluids'
    | 'self-support'
    | 'ceiling-collapse'
    | 'nearby-danger'

/** One inventory stack the evaluation considered as a tool. */
export interface ToolCandidate {
  /** Player inventory index (0-8 hotbar, 9-35 main, 40 offhand). */
  slot: number
  hotbar: boolean
  itemId: string
  count: number
  /** Current damage when the bridge reports it. */
  damage?: number
  /** Maximum damage when the bridge reports it. */
  maxDamage?: number
  enchantments: Record<string, number>
  /** `isCorrectToolForDrops` for the block, from the item's components. */
  harvestEligible: boolean
  /** `getDestroySpeed` for the block, from the item's components. */
  destroySpeed: number
  /** Expected ticks for the real player to break the block with this item. */
  estimatedTicks?: number
  expectedDropMode: ExpectedDropMode
}

/**
 * One no-side-effect harvest evaluation bound to a world state.
 *
 * `blockStateId` plus position plus dimension must match before the result is
 * used: a block that changed after evaluation invalidates the choice.
 */
export interface HarvestEvaluation {
  blockStateId: string
  x: number
  y: number
  z: number
  dimension: string
  worldId?: string
  playerUuid?: string
  candidates: ToolCandidate[]
  /** Tool requirement is met, which does not guarantee a specific random drop. */
  harvestEligible: boolean
  expectedDropMode: ExpectedDropMode
  estimatedTicks?: number
  estimateQuality: EstimateQuality
  hazards: HarvestHazard[]
  unmet: HarvestUnmet[]
  /** True when the block only drops with a correct tool. */
  requiresTool: boolean
}

/** Durability outlook for one candidate over a planned number of blocks. */
export interface DurabilityEstimate {
  /** False when the bridge reported no damage/maxDamage. */
  known: boolean
  remaining: number
  /** Expected blocks with unbreaking treated as an expectation, never a promise. */
  expectedBlocks: number
  /** Blocks with no unbreaking savings; the pessimistic bound. */
  worstCaseBlocks: number
  /**
   * True when the tool may break before the planned block count completes.
   *
   * Unbreaking only improves the expectation, so a tool whose raw remaining
   * durability is below the plan is flagged even when its expected blocks are
   * enough.
   */
  riskOfBreak: boolean
}

export interface ToolSelection {
  candidate: ToolCandidate
  strategy: ToolStrategy
  reason: string
  durability: DurabilityEstimate
}

export interface HarvestRejection {
  reason: HarvestUnmet
  detail?: string
}

export type HarvestDecision
  = | {
    ok: true
    /** Present when a candidate was chosen; absent for a bare-hand break. */
    selection?: ToolSelection
    /** True when the block drops without a tool and none was chosen. */
    bareHand: boolean
  }
  | { ok: false, rejection: HarvestRejection }

/** What the caller wants to do with one block. */
export interface MiningRequest {
  pos: MiningVec3
  /** Required product; undefined means the block only has to be cleared. */
  expectedItemId?: string
  strategy: ToolStrategy
  /** Candidate the caller pinned for `strategy: 'specified'`. */
  toolItemId?: string
  /** Planned blocks, used to estimate durability risk. */
  plannedBlocks?: number
  /** Tools that must not be consumed for this request. */
  keep?: string[]
  /** Maximum acceptable estimated ticks for one block; excess is a rejection. */
  maxTicks?: number
}

/** Evidence class for one attribution result. */
export type EvidenceGrade = 'server-attributed' | 'inventory-delta' | 'unobserved'

/**
 * Correlation record for one break.
 *
 * `breakId` links the command, the player, the dimension and the original
 * block state. It never stands in for observation: the fact, the drop and the
 * pickup are recorded separately.
 */
export interface BreakFact {
  breakId: string
  commandId?: string
  playerUuid?: string
  dimension?: string
  x: number
  y: number
  z: number
  blockStateId: string
  startTick?: number
  endTick?: number
  confirmations?: string[]
}

/** One item id the server attributed to a break's generated entities. */
export interface GeneratedDrop {
  itemId: string
  count: number
  entityUuids?: string[]
}

/** A source-quantity ledger entry for one item, kept per break. */
export interface DropLedgerEntry {
  itemId: string
  /** Items the server attributed to this break's ItemEntity(ies). */
  generated: number
  /** Items that entered the inventory and are provably this break's. */
  attributed: number
  /**
   * Items that cannot be proven this break's: merged, split, stolen, spilled or
   * unloaded. Reported instead of being folded into an exact claim.
   */
  fuzzy: number
}

/** Pickup attribution for one break and one item. */
export interface PickupAttribution {
  breakId: string
  itemId: string
  /** Provable lower bound of items this break added to the inventory. */
  lowerBound: number
  /** Unprovable part, reported separately. */
  fuzzy: number
  generated: number
  evidence: EvidenceGrade
  note?: string
}

/** Station a recipe needs. `furnace` steps also consume fuel. */
export type CraftStation = 'inventory' | 'crafting_table' | 'furnace'

/** A bounded tool-upgrade candidate derived from a traceable recipe. */
export interface ToolRecipe {
  itemId: string
  outputCount: number
  station: CraftStation
  ingredients: Array<{ itemId: string, count: number }>
  /** Fuel ids accepted by a furnace recipe, consumed one per operation. */
  fuel?: string[]
  /** Tools the recipe consumes, so the plan never requires the target tool. */
  consumesTools?: string[]
}

/** Budget and stop conditions for one upgrade plan. */
export interface UpgradeBudget {
  maxCrafts: number
  maxMissingPrerequisites: number
  /** Materials that must remain after the plan. */
  keep?: Array<{ itemId: string, count: number }>
  /** Fuel available for smelting steps, keyed by item id. */
  fuel?: Record<string, number>
  /** Which stations the caller is allowed to use. */
  allowedStations?: CraftStation[]
}

export interface UpgradeStep {
  kind: 'craft' | 'smelt'
  itemId: string
  station: CraftStation
  outputCount: number
  ingredients: Array<{ itemId: string, count: number }>
  /** Consumed fuel for a smelt step. */
  fuel?: { itemId: string, count: number }
}

export interface UpgradePlan {
  target: string
  craftable: boolean
  steps: UpgradeStep[]
  /** Missing prerequisites after the plan, one level deep. */
  missing: Array<{ itemId: string, count: number }>
  reason: string
}
