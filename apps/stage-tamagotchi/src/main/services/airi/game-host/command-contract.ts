/**
 * Shared MC-0b command contract: action/params types, digest canonicalization,
 * and computable postconditions.
 *
 * Kept free of registry state so the registry, game-host, and tests share one
 * definition (mc-0b-spec "命令信封" / "终态回执").
 */
import type { AirFollowReceipt } from './movement/air-follow'

/** CD-F: per-follow evidence the receipt carries (air-follow design §6). */
export type GameFollowReceipt = AirFollowReceipt

export type GameCommandAction = 'observe' | 'move_to' | 'status' | 'cancel' | 'collect' | 'say' | 'follow' | 'craft' | 'drop' | 'locate' | 'equip' | 'use' | 'open_container' | 'read_menu' | 'move_item' | 'close_menu' | 'craft_table' | 'smelt_load' | 'smelt_take' | 'supply' | 'sleep' | 'respawn' | 'shoot' | 'riptide' | 'menu_action' | 'read_item' | 'read_sign' | 'place' | 'break' | 'attack'

/** MC-4a equipment slots the `equip` action can target. */
export type EquipTarget = 'main_hand' | 'off_hand' | 'head' | 'chest' | 'legs' | 'feet'

/** MC-4a use modes: one item use, one block use, or one entity interaction. */
export type UseMode = 'item' | 'block' | 'entity'

/** MC-4d ranged weapons the `shoot` action can request; `auto` picks by inventory. */
export type ShootWeapon = 'auto' | 'bow' | 'crossbow' | 'trident'

/** MC-4g break modes: survival starts a tick-driven dig, instant removes in one beat. */
export type BreakMode = 'survival' | 'instant'

/** CD-M1 tool policy for a break: fastest, cheapest (default) or one pinned tool. */
export type BreakToolStrategy = 'fastest' | 'conserve' | 'specified'

/**
 * MC-4g melee weapon categories the `attack` action can request.
 *
 * `auto` picks the best available melee item and falls back to an empty hand;
 * `sword`/`axe`/`trident` require that weapon class and otherwise fail with
 * `weapon_unavailable`; `hand` forces an empty main hand.
 */
export type AttackWeapon = 'auto' | 'hand' | 'sword' | 'axe' | 'trident'

/**
 * MC-4d per-shot record.
 *
 * `shot` is the monotonic sequence the mod assigned to this projectile inside
 * the task, so a receipt can name each fired shot without guessing. `hitEvidence`
 * is only filled when an event can be attributed to this shot window; a missing
 * observation is `'unobserved'`, never a miss.
 */
export interface GameShotRecord {
  shot: number
  projectileUuid?: string
  hitEvidence?: string
}

/** MC-4d shoot receipt: the weapon, fixed target, per-shot records and outcomes. */
export interface GameShotReceipt {
  weapon: string
  targetUuid: string
  shots: GameShotRecord[]
  /** Attributed hits from server events (`entity_death`/damage); absent when unobserved. */
  hits?: number
  /** Attributed kill of the fixed target, from an `entity_death` event. */
  killed?: boolean
  /**
   * R9: the correlation key that made the kill attributable. Absent when the
   * kill was left unobserved because no key could be cross-checked.
   */
  killEvidence?: string
  /**
   * R9: true when the fixed target died but the death event could not be linked
   * to this command. The death is a fact; the kill attribution stays unobserved.
   */
  unobservedTargetDeath?: boolean
  /**
   * R9: the aim point the mod most recently computed from the target's re-read
   * position (plus lead). Present so a caller can see the aim tracked a moving
   * target instead of the coordinates captured at command start.
   */
  aimTarget?: { x: number, y: number, z: number }
  /** R9: why the aim point is where it is: `fresh`, `last_seen`, or `pinned`. */
  aimSource?: string
  /** Trident return observed; a timeout reports `return_pending`/`lost` instead. */
  returned?: boolean
  /**
   * CD-B1/B2: the projectile profile the shot was planned with. Absent when no
   * profile could be resolved (the endReason then names the refusal).
   */
  profileId?: string
  /** CD-B2: revision of the ballistic model that produced the prediction. */
  solutionRevision?: number
  /** CD-B2: age of the target observation the prediction used, in ms. */
  observationAgeMs?: number
  /** CD-B2: flight ticks the simulation predicted for the chosen curve. */
  predictedFlightTicks?: number
  /** CD-B2: smallest predicted distance from the curve to the target box. */
  closestDistance?: number
  /** CD-B2: which arc the solution used; a low arc is preferred. */
  arc?: 'low' | 'high'
  /**
   * CD-B2: why the shot was released. `ballistic_solution` means a predicted
   * curve existed; this is never an actual hit, which stays with the real
   * projectile and death events.
   */
  fireReason?: string
  /** CD-B2: why no shot was released, when one of the pre-flight checks refused. */
  refusalReason?: string
  endReason: string
}

/**
 * MC-4b menu identity.
 *
 * `containerId` is the only stable handle for an open menu: the mod increments
 * it for every opened container, and slot numbers are only meaningful together
 * with the container they belong to (gaps §4.1). Every menu receipt carries it.
 */
export interface GameMenuReceipt {
  containerId: number
  /** Registry id of `menu.getType()`, e.g. `minecraft:generic_9x3`. */
  type: string
  /** `menu.slots.size()` at the moment the menu opened. */
  slots: number
  /** Wall-clock time the open was confirmed. */
  openedAt: number
}

/**
 * MC-4b one menu slot read.
 *
 * `index` is the menu slot. `invSlot` is present only when the slot is backed
 * by the player inventory; a consumer must not reuse `index` across menus
 * without checking the container identity first.
 */
export interface GameMenuSlotReceipt {
  index: number
  /** `slot.container` class name, e.g. `Inventory` or `ChestBlockEntity`. */
  container: string
  /** Player inventory index (0-8 hotbar, 9-35 main, 36-39 armor, 40 offhand). */
  invSlot?: number
  id?: string
  count?: number
  empty?: boolean
  enchantments?: Record<string, number>
}

/**
 * MC-4b furnace progress.
 *
 * `lit` is the flame flag; the two ratios are the vanilla flame and cook-arrow
 * fractions. 1.21.1 does not expose the raw tick counters publicly, so the
 * ratios are the compile-verified reads (see mc-4b-spec D2).
 */
export interface GameFurnaceProgress {
  lit: boolean
  litProgress: number
  cookProgress: number
}

/** MC-4b snapshot of the currently open menu. */
export interface GameMenuSnapshotReceipt {
  containerId: number
  type: string
  slots: GameMenuSlotReceipt[]
  /** Item held by the cursor, when one is carried. */
  carried?: GameMenuSlotReceipt | null
  furnace?: GameFurnaceProgress
  /** True when `slots` exceeded the documented cap and the tail was dropped. */
  truncated?: boolean
}

/** MC-4b verified result of moving items between two slots of one menu. */
export interface GameMovedReceipt {
  containerId: number
  from: number
  to: number
  /** Minimum number of items the caller asked to move. */
  requested: number
  /** Measured source-slot decrease across the command. */
  moved: number
}

/** MC-4b stage receipt for the two-step furnace flow. */
export interface GameSmeltReceipt {
  containerId: number
  stage: 'loaded' | 'cooking' | 'taken'
  /** Input item id for `smelt_load`; omitted on `smelt_take` when nothing is left. */
  inputItemId?: string
  fuelItemId?: string
  /** Requested input count for `smelt_load`, or the observed output for `smelt_take`. */
  requested: number
  /** Input items this command moved into the furnace. */
  loaded?: number
  /** Furnace progress read from the fresh snapshot after loading. */
  cooking?: GameFurnaceProgress
  /** Output items this command moved to the inventory, verified by delta. */
  taken?: { itemId: string, count: number }
  /** Items left in the furnace when the output was taken, recorded but not counted as output. */
  residue?: Array<{ itemId: string, count: number }>
}

export interface GameCommandParams {
  moveTo?: {
    x: number
    y: number
    z: number
    tolerance: number
    /** MC-3: movement may break blocks (default false). */
    allowBreak?: boolean
    /** MC-3: movement may place scaffolding (default true). */
    allowPlace?: boolean
    /** MC-3: maximum allowed fall in blocks (default 4). */
    maxFall?: number
    /** MC-3b: ride a boat/horse/minecart instead of walking. */
    vehicle?: 'boat' | 'horse' | 'minecart' | 'elytra' | 'strider'
    /** MC-3b: walk the same target when the vehicle mover fails. */
    fallbackToFoot?: boolean
    /**
     * CD-V1: acquire strategy. `existing` uses a world vehicle (default);
     * `prepare_owned` places one from the player's materials; `tame` bonds a
     * wild horse and needs `allowTame`.
     */
    vehicleStrategy?: 'existing' | 'prepare_owned' | 'tame'
    /** CD-V1: explicit vehicle UUID; the only non-ambiguous acquisition target. */
    vehicleUuid?: string
    /** CD-V1: explicit permission to tame a wild horse. */
    allowTame?: boolean
  }
  collect?: { blockId: string, itemId?: string, maxCount: number, radius: number, allowPrerequisites?: boolean }
  say?: { text: string }
  follow?: {
    target: string
    keepDistance: number
    timeoutSeconds?: number
    /**
     * CD-F1: `ground` keeps today's terrain follow; `auto` may spend fireworks
     * and switch to the elytra when the target takes off.
     */
    travelMode?: 'ground' | 'auto'
    /**
     * CD-F2: air spacing band in blocks. Separate from the ground
     * `keepDistance`; the debug starting value is 12–24, not a safety constant.
     */
    airSpacing?: { min: number, max: number }
  }
  /** MC-2d: two-beat craft of a known recipe that fits the player's 2x2 grid. */
  craft?: { recipeId: string }
  /** MC-3c: drop a stack of one item; the item must be reachable in the inventory. */
  drop?: { itemId: string, count: number }
  /** MC-3c: read one player's position from the server-side player list. */
  locate?: { name: string }
  /** MC-4a: move one inventory item into an equipment slot. */
  equip?: { itemId: string, target: EquipTarget }
  /**
   * MC-4a: one bounded use. `item` holds the held item for `holdTicks` then
   * releases (`abort` uses the stop path instead of the normal release);
   * `block` right-clicks a block at x/y/z; `entity` right-clicks a uuid.
   */
  use?: { mode: UseMode, holdTicks: number, abort: boolean, x?: number, y?: number, z?: number, uuid?: string }
  /** MC-4b: right-click a block to open its menu. */
  openContainer?: { x: number, y: number, z: number, face?: string }
  /** MC-4b: move a whole stack between two menu slots (whole-stack transfers). */
  moveItem?: { from: number, to: number, count?: number }
  /** MC-4b: place a 3x3 recipe in an open crafting table menu. */
  craftTable?: { x: number, y: number, z: number, recipeId: string, attempts?: number }
  /** MC-4b: load input and fuel into an open furnace menu. */
  smeltLoad?: { x: number, y: number, z: number, inputItemId: string, fuelItemId?: string, count?: number }
  /** MC-4b: take the finished output from an open furnace menu. */
  smeltTake?: { x: number, y: number, z: number }
  /** MC-4c: sleep in the bed block at x/y/z. */
  sleep?: { x: number, y: number, z: number }
  /**
   * MC-4d: fire a ranged weapon at a target. `target` is a name/uuid/type
   * resolved once and pinned for the whole command; `weapon: 'auto'` picks by
   * inventory; `chargeTicks` bounds a bow/trident hold (crossbow ignores it).
   */
  shoot?: { target: string, weapon: ShootWeapon, maxShots: number, chargeTicks?: number, useServerEvents?: boolean }
  /**
   * MC-4e: charge and release a riptide trident to move toward x/y/z. This is a
   * movement action, not a shot: it has no projectile or shot number.
   */
  riptide?: { x: number, y: number, z: number, tolerance: number }
  /**
   * MC-4f: one workstation business primitive on the currently open menu.
   * `id` is used by `button`, `index` by `select_trade`, `text` by `set_name`;
   * `beacon` uses `primary` and an optional `secondary` effect id.
   */
  menuAction?: { action: MenuBusinessAction, id?: number, index?: number, text?: string, primary?: string, secondary?: string }
  /** MC-4f: read a written book/filled map from an inventory slot (default main hand). */
  readItem?: { slot?: number }
  /** MC-4f: read a sign block entity's front/back text. */
  readSign?: { x: number, y: number, z: number }
  /**
   * MC-4f precise placement. x/y/z is the target block; the executor clicks the
   * support behind it on `face`. `count` builds a bounded batch of up to 16
   * blocks along `face`; `sneak`/`yaw` pass through to the mod place primitive.
   */
  place?: { x: number, y: number, z: number, face?: string, itemId?: string, sneak?: boolean, yaw?: number, count?: number, attempts?: number }
  /**
   * MC-4g/CD-M1: break one block at x/y/z. The executor never walks; it fails
   * with `out_of_reach` when the player is farther than the break reach, so the
   * caller walks with `move_to` first. `itemId` makes the product a requirement,
   * `strategy`/`tool` choose the tool policy (default `conserve`).
   */
  breakBlock?: { x: number, y: number, z: number, mode: BreakMode, itemId?: string, strategy?: BreakToolStrategy, tool?: string }
  /**
   * MC-4g: melee-attack one target. `target` is a name/uuid/type resolved once
   * and pinned for the whole command; `maxSwings` bounds the loop; `weapon`
   * selects the melee item from the inventory.
   */
  attack?: { target: string, maxSwings: number, weapon: AttackWeapon }
  observe?: { radius: number }
  status?: { commandId: string }
  cancel?: { commandId: string }
}

export interface GameFinalSnapshot {
  position: { x: number, y: number, z: number }
  health: number
  food: number
  heldItem: string | null
}

export interface GamePostCondition {
  kind: 'distance' | 'collected' | 'observed' | 'crafted' | 'dropped' | 'equipped' | 'moved' | 'fed' | 'placed' | 'broken' | 'hit' | 'none'
  /** Expected value: a distance budget, a count, or a radius. */
  target: number
  /** Measured value from the game, never from the model. */
  actual: number
  met: boolean
  /**
   * MC-4a: equip detail, present only for `kind: 'equipped'`.
   *
   * `expectedItemId` is the requested item; `actualItemId` is what the fresh
   * `get_equipment` read returned for the target slot (null when empty or the
   * read could not name an item).
   */
  equipped?: {
    target: EquipTarget
    expectedItemId: string
    actualItemId: string | null
  }
}

/** Action measurements used to evaluate the postcondition. */
export interface GamePostConditionInput {
  finalSnapshot: GameFinalSnapshot
  finalPosition?: { x: number, y: number, z: number }
  /** Items collected by this command only (not the inventory count). */
  collectedCount?: number
  observedRadius?: number
  /** MC-2d: inventory delta of the crafted output item, measured after the craft. */
  craftedCount?: number
  /** MC-2d: output stack size reported by the claim receipt. */
  craftedExpected?: number
  /** MC-3c: inventory decrease for the dropped item, measured after the drop. */
  droppedCount?: number
  /** MC-4a: item id read from the fresh equipment check after an equip. */
  equippedActualId?: string | null
  /** MC-4b: measured source-slot decrease for a menu move. */
  movedCount?: number
  /** MC-4b: minimum item count the menu move promised. */
  movedExpected?: number
  /** MC-4c: measured food-level increase for one supply command. */
  fedCount?: number
  /** MC-4f: blocks verified by a fresh world read plus inventory decrease. */
  placedCount?: number
  /** MC-4f: blocks the place command asked to build. */
  placedExpected?: number
  /** MC-4g: blocks confirmed broken by the bounded fresh read (0 or 1). */
  brokenCount?: number
  /** MC-4g: hits observed by a fresh target read (health drop or disappearance). */
  hitCount?: number
  /** Executor end reason; some actions derive success from it (follow). */
  endReason?: string
}

/** MC-2d craft receipt carried on the command outcome and terminal receipt. */
export interface GameCraftReceipt {
  recipeId: string
  output: { id: string, count: number }
  attempts: number
  /** Changed items only; negative means consumed. */
  inventoryDelta: Record<string, number>
  /**
   * MC-4b: items cleared from the crafting result slot before this command's
   * placement. They belong to an earlier craft and are never counted as output.
   */
  residue?: Array<{ itemId: string, count: number }>
}

/** MC-4a equip receipt: the item and target slot the action was asked to fill. */
export interface GameEquipReceipt {
  itemId: string
  target: EquipTarget
}

/** MC-4a use receipt: one bounded use and how it ended. */
export interface GameUseReceipt {
  /** Item held during a `mode: 'item'` use, when the state read named one. */
  itemId?: string
  mode: UseMode
  /** Requested hold length in game ticks. */
  heldTicks: number
  /** True when the use ended through the normal release path. */
  released: boolean
  /** True when the use ended through the abort path. */
  aborted: boolean
}

/** MC-4a observe receipt: best-effort snapshots gathered beside the player state. */
export interface GameObservedReceipt {
  inventory?: Record<string, unknown>
  equipment?: Record<string, unknown>
  effects?: Record<string, unknown>
  /** Names of the reads that failed; the observation still succeeds without them. */
  missing?: string[]
  /** True when an inventory list exceeded its documented cap and was trimmed. */
  truncated?: boolean
}

/** MC-4c supply receipt: the food eaten and the hunger change it produced. */
export interface GameFedReceipt {
  itemId: string
  /** Food level read before the use. */
  foodBefore: number
  /** Food level read after a fresh post-use `get_self`. */
  foodAfter: number
  /** Hotbar slot the food was selected from (after a main-inventory move when needed). */
  slot?: number
}

/** MC-4c sleep receipt: the bed position and the observed sleep timer. */
export interface GameSleptReceipt {
  position: { x: number, y: number, z: number }
  sleepTimer: number
}

/** MC-4c respawn receipt: the fresh position read after the client respawn. */
export interface GameRespawnedReceipt {
  position: { x: number, y: number, z: number }
}

/**
 * MC-4e riptide receipt: the measured movement of one launch.
 *
 * `from`/`to` are the pre/post flight reads the mod reported; `distance` is the
 * straight-line displacement. Durability is the trident's damage value before
 * the charge and after the release. There is no projectile or shot field: a
 * riptide launch is player movement, not a shot (gaps §3.2).
 */
/**
 * MC-4e: the water/rain state the mod reported alongside a `riptide_unavailable`
 * refusal.
 *
 * The three fields come from the fork's `riptideStatus` diagnostic surface
 * (mod 0.2.15). A missing field means the mod could not report it and is never
 * fabricated; `rainLevel` of 0 is a real observation, so callers must not treat
 * 0 as "absent".
 */
export interface GameRiptideUnmetDetail {
  inWater?: boolean
  inRain?: boolean
  rainLevel?: number
}

export interface GameRiptideReceipt {
  from?: { x: number, y: number, z: number }
  to?: { x: number, y: number, z: number }
  displacement?: { x: number, y: number, z: number }
  distance?: number
  durabilityBefore?: number
  durabilityAfter?: number
  /** Present only on `riptide_unavailable`, copied from the mod's status fields. */
  unmetDetail?: GameRiptideUnmetDetail
  endReason: string
}

/** MC-4f workstation business primitives that operate on the currently open menu. */
export type MenuBusinessAction = 'button' | 'select_trade' | 'set_name' | 'beacon'

/** MC-4f readable summary of one merchant offer result and its inputs. */
export interface GameTradeOfferReceipt {
  result?: { id?: string, count?: number }
  inputs?: Array<{ id?: string, count?: number }>
  outOfStock?: boolean
}

/**
 * MC-4f result of one menu business primitive.
 *
 * `button` and `beacon` are sent packets without a synchronous server verdict,
 * so they fill `sent` and `applied` (whether a bounded re-read observed the
 * menu change or the requested effect) instead of `accepted`. `select_trade`
 * and `set_name` are public client entry points that return a real value
 * synchronously, so they keep `accepted`.
 */
export interface GameMenuActionReceipt {
  containerId: number
  action: MenuBusinessAction
  accepted?: boolean
  sent?: boolean
  applied?: boolean
  offer?: GameTradeOfferReceipt
  name?: string
}

/**
 * MC-4f read-only item content.
 *
 * This is an observation of untrusted text, never a command: the receipt has no
 * postcondition and the caller must not execute the returned strings. Book pages
 * and map fields are bounded; `truncated` marks a cut read and `unsupported`
 * marks content the client could not provide.
 */
export interface GameItemContentReceipt {
  itemId: string
  title?: string
  author?: string
  pages?: string[]
  map?: { id: number, scale?: number, dimension?: string }
  truncated?: boolean
  unsupported?: boolean
}

/** MC-4f read-only sign text. Lines are bounded; `truncated` marks a cut read. */
export interface GameSignContentReceipt {
  lines: string[]
  back?: string[]
  truncated?: boolean
}

/** MC-4f per-block placement result. */
export interface GamePlacedBlock {
  x: number
  y: number
  z: number
  ok: boolean
  reason?: string
}

/** MC-4f placement receipt: one block or a bounded batch with per-block results. */
export interface GamePlacedReceipt {
  itemId?: string
  /** Blocks the caller asked for (1..16). */
  requested: number
  /** Blocks verified by a fresh world read plus an inventory decrease. */
  placed: number
  blocks: GamePlacedBlock[]
}

/**
 * MC-4g break receipt: the broken block and the id the fresh read first saw.
 *
 * `blockId` is the pre-break id the executor confirmed. On a `not_confirmed`
 * timeout, `lastBlockId` is the last id the bounded poll observed, so a caller
 * can tell "still the same block" from a read that returned nothing.
 */
export interface GameBrokenReceipt {
  x: number
  y: number
  z: number
  blockId: string
  mode: BreakMode
  lastBlockId?: string
  /** CD-M2: correlation id for this break, linking fact, drop and pickup. */
  breakId?: string
  /** CD-M1: the tool actually equipped, or `hand` for a bare-hand break. */
  tool?: string
  /** CD-M1: environmental risks the evaluation named. */
  hazards?: string[]
  /** CD-M1: durability outlook for the chosen tool. */
  durability?: { known: boolean, remaining: number, expectedBlocks: number, riskOfBreak: boolean }
  /** CD-M1: the harvest requirement that stopped the break before mining. */
  rejection?: { reason: string, detail?: string }
  /** CD-M2: graded pickup attribution when a product was required. */
  product?: { itemId: string, count: number, lowerBound: number, fuzzy: number, evidence: string }
}

/**
 * CD-M3: structured prerequisites for a collect that lacks the tool.
 *
 * `craftable` is a plan, not an execution: the recipe and station are still
 * verified on the server before any craft.
 */
export interface GamePrerequisiteReport {
  target: string
  craftable: boolean
  steps: Array<{
    kind: 'craft' | 'smelt'
    itemId: string
    station: string
    outputCount: number
    ingredients: Array<{ itemId: string, count: number }>
    fuel?: { itemId: string, count: number }
  }>
  missing: Array<{ itemId: string, count: number }>
  reason: string
}

/**
 * MC-4g melee receipt: the fixed target, the swings made, and the observed
 * outcome. Only an observed health drop or disappearance counts as a hit; a
 * swing with no observation stays `hitEvidence: 'unobserved'`.
 */
export interface GameAttackedReceipt {
  targetUuid: string
  targetName?: string
  /** Number of `attack_entity` calls this command made. */
  swings: number
  /** Concrete item that swung, or `hand` for an empty main hand. */
  weapon: string
  /** Sum of observed health drops across the swings. */
  damageDealt?: number
  healthBefore?: number
  healthAfter?: number
  hitEvidence?: string
  killed?: boolean
  endReason: string
}

/**
 * Decimal places used before hashing params.
 *
 * Float noise (`0.1 + 0.2`) and `-0` must not look like different commands.
 */
export const DIGEST_FLOAT_DECIMALS = 6

function normalizeDigestValue(value: unknown): unknown {
  if (typeof value === 'number') {
    const rounded = Number(value.toFixed(DIGEST_FLOAT_DECIMALS))
    return rounded === 0 ? 0 : rounded
  }
  if (Array.isArray(value))
    return value.map(normalizeDigestValue)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, entry]) => [key, normalizeDigestValue(entry)]),
    )
  }
  return value
}

/** Canonical, sorted-key JSON of `{ action, params }` with rounded floats. */
export function canonicalizeGameParams(action: GameCommandAction, params: GameCommandParams = {}): string {
  return JSON.stringify(normalizeDigestValue({ action, params }))
}

/**
 * Digest of action + params only.
 *
 * Envelope fields (sessionId, taskId, runId, planVersion, worldId, dimension,
 * playerUuid, connectionGeneration, commandId, deadlineMs, issuedAt) are
 * deliberately excluded: a retry must not look like a new command, and a
 * retry must not extend the lease (M1-D3).
 */
export function commandParamsDigest(action: GameCommandAction, params: GameCommandParams = {}): string {
  const canonical = canonicalizeGameParams(action, params)
  let hash = 0x811C9DC5
  for (let index = 0; index < canonical.length; index++) {
    hash ^= canonical.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

function roundToDigestPrecision(value: number): number {
  return Number(value.toFixed(DIGEST_FLOAT_DECIMALS))
}

/** Builds the postcondition for one action from measured executor data. */
export function evaluateGamePostCondition(
  action: GameCommandAction,
  params: GameCommandParams,
  outcome: GamePostConditionInput,
): GamePostCondition {
  switch (action) {
    case 'move_to': {
      const target = params.moveTo?.tolerance ?? 0
      const final = outcome.finalPosition ?? outcome.finalSnapshot.position
      const moveTo = params.moveTo
      const actual = moveTo
        ? Math.hypot(final.x - moveTo.x, final.y - moveTo.y, final.z - moveTo.z)
        : Number.POSITIVE_INFINITY
      return { kind: 'distance', target, actual: roundToDigestPrecision(actual), met: actual <= target }
    }
    case 'riptide': {
      // MC-4e: a riptide is movement, so arrival is verified by a fresh read
      // exactly like move_to. A capability failure or a cancel never counts as
      // arrival even when the measured distance happens to be inside tolerance.
      const riptide = params.riptide
      const target = riptide?.tolerance ?? 0
      const final = outcome.finalPosition ?? outcome.finalSnapshot.position
      const actual = riptide
        ? Math.hypot(final.x - riptide.x, final.y - riptide.y, final.z - riptide.z)
        : Number.POSITIVE_INFINITY
      const failed = outcome.endReason === 'riptide_unavailable'
        || outcome.endReason === 'cancelled'
        || outcome.endReason === 'not_confirmed'
      return { kind: 'distance', target, actual: roundToDigestPrecision(actual), met: !failed && actual <= target }
    }
    case 'collect': {
      const target = params.collect?.maxCount ?? 0
      const actual = outcome.collectedCount ?? 0
      return { kind: 'collected', target, actual, met: actual >= target }
    }
    case 'observe': {
      const target = params.observe?.radius ?? 0
      const actual = outcome.observedRadius ?? target
      return { kind: 'observed', target, actual, met: actual >= target }
    }
    case 'craft':
    case 'craft_table': {
      // The claim receipt says how many items the craft produced; the measured
      // side is the inventory delta, so a lost pickup never reads as success.
      const target = outcome.craftedExpected ?? 0
      const actual = outcome.craftedCount ?? 0
      return { kind: 'crafted', target, actual, met: target > 0 && actual >= target }
    }
    case 'move_item':
    case 'smelt_take': {
      // A menu move is verified by the source decrease; the request alone is
      // not evidence that the item changed container.
      const target = outcome.movedExpected ?? 0
      const actual = outcome.movedCount ?? 0
      return { kind: 'moved', target, actual, met: target > 0 && actual >= target }
    }
    case 'drop': {
      const target = params.drop?.count ?? 0
      const actual = outcome.droppedCount ?? 0
      return { kind: 'dropped', target, actual, met: target > 0 && actual >= target }
    }
    case 'supply': {
      // The verifiable side is a fresh `get_self` food delta, not the use
      // request; a food item that did not raise hunger never reads as fed.
      const actual = outcome.fedCount ?? 0
      return { kind: 'fed', target: 1, actual, met: actual >= 1 }
    }
    case 'equip': {
      // The verifiable side is a fresh `get_equipment` read, not the swap
      // request; the executor reports the id it actually read.
      const equip = params.equip
      const actualItemId = outcome.equippedActualId ?? null
      const met = !!equip?.itemId && actualItemId === equip.itemId
      return {
        kind: 'equipped',
        target: 1,
        actual: met ? 1 : 0,
        met,
        ...(equip ? { equipped: { target: equip.target, expectedItemId: equip.itemId, actualItemId } } : {}),
      }
    }
    case 'follow': {
      // Following has no countable postcondition, but a lost target, a
      // reflex preemption or a target the terrain planner cannot reach must
      // not read as a clean success (mc-1a, review R5). CD-L2 adds the typed
      // locate outcomes so a target that is offline, in another dimension,
      // unloaded or unlocatable is never reported as a clean follow.
      const failed = outcome.endReason === 'reflex_preempted'
        || outcome.endReason === 'target_lost'
        || outcome.endReason === 'target_not_in_read'
        || outcome.endReason === 'target_unreachable'
        || outcome.endReason === 'target_offline'
        || outcome.endReason === 'target_dimension_changed'
        || outcome.endReason === 'locator_unavailable'
        || outcome.endReason === 'entity_unloaded'
        || outcome.endReason === 'waiting_for_target'
        || outcome.endReason === 'no_progress'
        // CD-F: an air limitation or an unverified touch-down is not a clean
        // follow; `follow_completed` stays the normal duration end.
        || outcome.endReason === 'cannot_air_follow'
        || outcome.endReason === 'launch_unavailable'
        || outcome.endReason === 'low_supply'
        || outcome.endReason === 'low_health'
        || outcome.endReason === 'elytra_worn'
        || outcome.endReason === 'touchdown_unverified'
        || outcome.endReason === 'dead'
        || outcome.endReason === 'connection_lost'
      return { kind: 'none', target: 0, actual: 0, met: !failed }
    }
    case 'shoot': {
      // MC-4d: a shot has no postcondition verifiable by a fresh read (hits are
      // server-event evidence, not a state read). `none` stays honest, but a
      // failed shot must not read as a clean success: preemption, a lost target
      // and a capability limit are failures.
      const failed = outcome.endReason === 'reflex_preempted'
        || outcome.endReason === 'target_lost'
        || outcome.endReason === 'no_ammo'
        || outcome.endReason === 'weapon_unavailable'
        || outcome.endReason === 'unsupported_weapon_feature'
        || outcome.endReason === 'not_confirmed'
        // MC-4e/d: a bystander in the line of fire holds the shot.
        || outcome.endReason === 'friendly_blocked'
        // CD-B1/B2: an unknown projectile or a curve with no valid solution
        // keeps the ammo instead of firing on a guessed speed.
        || outcome.endReason === 'unsupported_projectile_profile'
        || outcome.endReason === 'no_ballistic_solution'
        || outcome.endReason === 'insufficient_charge'
      return { kind: 'none', target: 0, actual: 0, met: !failed }
    }
    case 'place': {
      // MC-4f: a placed block is verified by a fresh world read plus an
      // inventory decrease, so the postcondition is the verified block count,
      // not the request. A capability failure never counts as placement.
      const failed = outcome.endReason === 'not_in_inventory'
        || outcome.endReason === 'blocked'
        || outcome.endReason === 'not_confirmed'
        || outcome.endReason === 'cancelled'
      const target = Math.max(1, outcome.placedExpected ?? params.place?.count ?? 1)
      const actual = outcome.placedCount ?? 0
      return { kind: 'placed', target, actual, met: !failed && actual >= target }
    }
    case 'break': {
      // MC-4g: the block is verified by a bounded fresh read, not the break
      // request. A reach or confirmation failure never counts as broken.
      const failed = outcome.endReason === 'already_air'
        || outcome.endReason === 'out_of_reach'
        || outcome.endReason === 'not_confirmed'
        || outcome.endReason === 'cancelled'
      const actual = outcome.brokenCount ?? 0
      return { kind: 'broken', target: 1, actual, met: !failed && actual >= 1 }
    }
    case 'attack': {
      // MC-4g: only an observed health drop or a disappearance counts as a
      // hit. A lost target, an unreachable one, or an unavailable weapon must
      // not read as success even if an earlier swing was observed.
      const failed = outcome.endReason === 'target_lost'
        || outcome.endReason === 'out_of_reach'
        || outcome.endReason === 'weapon_unavailable'
        || outcome.endReason === 'not_confirmed'
        || outcome.endReason === 'cancelled'
        || outcome.endReason === 'deadline'
      const actual = outcome.hitCount ?? 0
      return { kind: 'hit', target: 1, actual, met: !failed && actual >= 1 }
    }
    default:
      return { kind: 'none', target: 0, actual: 0, met: true }
  }
}
