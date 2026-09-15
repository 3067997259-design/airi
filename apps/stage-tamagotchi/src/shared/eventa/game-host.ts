import { defineEventa, defineInvokeEventa } from '@moeru/eventa'

/**
 * Persisted at `<userData>/game-host.json`.
 *
 * The token never leaves the main process: it is sent as an `Authorization`
 * header and must not appear in logs, the journal, or any IPC response.
 */
/**
 * Movement planner selection (MC-3 Phase 1).
 *
 * `terrain` runs the ported movements/A* planner; `legacy` keeps the mod-side
 * `nav.pathTo` navigation. The default stays `legacy` until increment 3
 * implements the break/place/use executor actions, then flips to `terrain`.
 */
export interface GameHostMovementConfig {
  planner: 'terrain' | 'legacy'
}

/**
 * MC-3c X-10: MC chat trigger policy. Admins deliver every message (a leading
 * `\` opts out), the blocklist delivers nothing and stays out of context, and
 * everyone else delivers on a mention or on a sampled fraction of the rest.
 */
export interface GameHostChatCommandConfig {
  enabled: boolean
  admins: string[]
  blocked: string[]
  mentionlessSampleRate: number
  contextLines: number
}

/** MC-3c X-10: why one chat message was delivered. */
export type GameHostChatTrigger = 'admin' | 'mention' | 'mentionless-sample'

/** One recent chat line attached to a delivered message as context. */
export interface GameHostChatContextLine {
  sender: string
  text: string
}

/** One delivered chat message, with its trigger, context, and world binding. */
export interface GameHostChatCommandPayload {
  /** Bridge event id; stable for dedup and journal correlation. */
  messageId: number
  sender: string
  senderUuid: string
  text: string
  trigger: GameHostChatTrigger
  context: GameHostChatContextLine[]
  receivedAt: number
  world?: {
    worldId: string
    dimension: string
    connectionGeneration: number
    connectionId: string
  }
}

export interface GameHostConfig {
  /** MCP endpoint of the MCPFabric Node server. Loopback only. */
  url: string
  /** Bearer token for the mod bridge. Optional only if the server disables auth. */
  token?: string
  /**
   * MC-3c: MCP endpoint of the second (dedicated-server) bridge.
   *
   * On a dedicated server the client bridge cannot run server-authoritative
   * reads (`entities.*`, `world.*`, `players.*`); those tools route to this
   * endpoint when it is configured.
   */
  serverUrl?: string
  /** Client control-group tools to expose; empty means "read-only default set". */
  allowedTools: string[]
  /** MC-3 movement planner selection. */
  movement?: GameHostMovementConfig
  /** MC-3c D4: MC chat command ingestion; disabled unless configured. */
  chatCommands?: GameHostChatCommandConfig
}

/**
 * Renderer-safe view of the game host config. The token is stripped so IPC
 * responses can never leak it (MC-0a invariant 6).
 */
export interface GameHostConfigView {
  url: string
  hasToken: boolean
  serverUrl?: string
  allowedTools: string[]
  movement?: GameHostMovementConfig
  chatCommands?: GameHostChatCommandConfig
}

/** Cached at connect; feeds the version-transplantation smoke and later contracts. */
export interface GameWorldIdentity {
  /** Minecraft version string reported by the mod, e.g. '1.21.1'. */
  minecraftVersion: string
  /** World identifier; falls back to a connection-scoped id when unavailable. */
  worldId: string
  dimension: string
  playerUuid: string
}

/**
 * Capabilities discovered at connect (CD-0 §3.3).
 *
 * A capability is only announced when the bridge actually exposes the tools
 * that back it. An unavailable capability carries a typed limit instead of a
 * silent fallback or a fabricated result.
 */
export type GameCapabilityName = 'target-observation' | 'collision-snapshot' | 'control-session' | 'ballistic-profiles' | 'break-evidence' | 'vehicle-observation'

export interface GameCapabilityStatus {
  available: boolean
  /** Typed reason the capability is unavailable; absent when available. */
  limit?: string
  /** Tool names that satisfied the capability. */
  tools: string[]
}

export type GameCapabilities = Record<GameCapabilityName, GameCapabilityStatus>

export interface GameHostStatus {
  status: 'unconfigured' | 'connecting' | 'connected' | 'error'
  error?: string
  identity?: GameWorldIdentity
  /** Discovered bridge capabilities; present once connected (CD-0 §3.3). */
  capabilities?: GameCapabilities
}

export interface GameHostObservationResult {
  toolName: string
  content?: Array<Record<string, unknown>>
  structuredContent?: Record<string, unknown>
  toolResult?: unknown
  isError?: boolean
  observedAt: number
}

/** Domain actions MC-0c registers on the model tool face; MC-1a adds say/collect/follow; MC-4a adds equip/use; MC-4b adds menu/workstation actions; MC-4d adds shoot; MC-4e adds riptide; MC-4f adds menu_action/read_item/read_sign/place; MC-4g adds break/attack. */
export type GameDomainAction = 'observe' | 'move_to' | 'status' | 'cancel' | 'say' | 'collect' | 'follow' | 'craft' | 'drop' | 'locate' | 'equip' | 'use' | 'open_container' | 'read_menu' | 'move_item' | 'close_menu' | 'craft_table' | 'smelt_load' | 'smelt_take' | 'supply' | 'sleep' | 'respawn' | 'shoot' | 'riptide' | 'menu_action' | 'read_item' | 'read_sign' | 'place' | 'break' | 'attack'

/** Host-bound task identity the renderer passes with one command. */
export interface GameDomainTask {
  sessionId: string
  taskId?: string | null
  runId?: string | null
  planVersion?: number | null
}

export interface GameDomainPostCondition {
  kind: 'distance' | 'collected' | 'observed' | 'crafted' | 'dropped' | 'equipped' | 'moved' | 'fed' | 'placed' | 'broken' | 'hit' | 'none'
  target: number
  actual: number
  met: boolean
  /** MC-4a: equip detail when `kind: 'equipped'`. */
  equipped?: {
    target: 'main_hand' | 'off_hand' | 'head' | 'chest' | 'legs' | 'feet'
    expectedItemId: string
    actualItemId: string | null
  }
}

/**
 * Result envelope returned by every `game_*` domain tool.
 *
 * `checked` is true only after the main-process receipt check passed; the
 * runtime turns that flag into the `game_checked` evidence bucket.
 */
export interface GameDomainResult {
  status: 'ok' | 'failed' | 'cancelled' | 'expired' | 'busy' | 'rejected'
  checked: boolean
  commandId: string | null
  endReason: string
  /**
   * CD-0 §3.3: which result phases were actually observed.
   *
   * Requested, accepted, client-executed and server-settled are separate
   * facts; a phase stays false until observed, and `unobserved` names the
   * phases that could not be confirmed.
   */
  resultPhases?: {
    requested: boolean
    accepted: boolean
    clientExecuted: boolean
    serverSettled: boolean
    unobserved: string[]
  }
  finalSnapshot?: {
    position: { x: number, y: number, z: number }
    health: number
    food: number
    heldItem: string | null
  }
  /**
   * World binding the result belongs to (mc-1b D1).
   *
   * Terminal receipts carry the world they were issued for; status answers
   * fall back to the live connection. A missing field means no connection
   * identity was available, never "same as before".
   */
  world?: {
    worldId: string
    dimension: string
    connectionGeneration: number
    /**
     * Per-connect unique id. The generation counter restarts with the app
     * process, so world-scoped memory uses this id as the scope key whenever
     * the fork reports no stable world name.
     */
    connectionId: string
  }
  postCondition: GameDomainPostCondition
  /**
   * MC-2d craft receipt: which recipe ran, the claimed output stack, and the
   * measured inventory delta (changed items only, negative means consumed).
   * Only the `craft` action fills it.
   */
  crafted?: {
    recipeId: string
    output: { id: string, count: number }
    attempts: number
    inventoryDelta: Record<string, number>
    /** MC-4b: earlier-craft residue cleared from the result slot, not counted as output. */
    residue?: Array<{ itemId: string, count: number }>
  }
  /** MC-3c drop receipt: the item stack left the inventory by this path. */
  dropped?: {
    itemId: string
    count: number
    slot: number
    /** How the drop was verified: inventory decrease or an emptied target slot. */
    verifiedBy?: 'inventory-delta' | 'slot-empty'
  }
  /** MC-3c locate receipt: where a player was when the read ran. */
  located?: {
    name: string
    /** CD-L1: the uuid the player list already carries, kept for follow identity. */
    uuid?: string
    position: { x: number, y: number, z: number }
    dimension?: string
  }
  /** MC-4a equip receipt: the item and target slot the action filled. */
  equipped?: {
    itemId: string
    target: 'main_hand' | 'off_hand' | 'head' | 'chest' | 'legs' | 'feet'
  }
  /** MC-4a use receipt: one bounded use and how it ended. */
  used?: {
    itemId?: string
    mode: 'item' | 'block' | 'entity'
    heldTicks: number
    released: boolean
    aborted: boolean
  }
  /**
   * MC-4a observe receipt: best-effort snapshots gathered with the player
   * state. Each read is optional; `missing` names the ones that failed.
   */
  observed?: {
    inventory?: Record<string, unknown>
    equipment?: Record<string, unknown>
    effects?: Record<string, unknown>
    missing?: string[]
    truncated?: boolean
  }
  /** MC-4b: identity of a container menu opened by `open_container`. */
  menu?: {
    containerId: number
    type: string
    slots: number
    openedAt: number
  }
  /** MC-4b: snapshot of the currently open menu, bounded per the spec rule. */
  menuSnapshot?: {
    containerId: number
    type: string
    slots: Array<{
      index: number
      container: string
      invSlot?: number
      id?: string
      count?: number
      empty?: boolean
      enchantments?: Record<string, number>
    }>
    carried?: { index: number, container: string, id?: string, count?: number, empty?: boolean } | null
    furnace?: { lit: boolean, litProgress: number, cookProgress: number }
    truncated?: boolean
  }
  /** MC-4b: verified whole-stack menu move. */
  moved?: {
    containerId: number
    from: number
    to: number
    requested: number
    moved: number
  }
  /** MC-4b: furnace stage receipt for the two-step smelt flow. */
  smelt?: {
    containerId: number
    stage: 'loaded' | 'cooking' | 'taken'
    inputItemId?: string
    fuelItemId?: string
    requested: number
    loaded?: number
    cooking?: { lit: boolean, litProgress: number, cookProgress: number }
    taken?: { itemId: string, count: number }
    residue?: Array<{ itemId: string, count: number }>
  }
  /** MC-4c supply receipt: the food eaten and the measured hunger change. */
  fed?: {
    itemId: string
    foodBefore: number
    foodAfter: number
    slot?: number
  }
  /** MC-4c sleep receipt: the bed position and the observed sleep timer. */
  slept?: {
    position: { x: number, y: number, z: number }
    sleepTimer: number
  }
  /** MC-4c respawn receipt: the fresh position read after the client respawn. */
  respawned?: {
    position: { x: number, y: number, z: number }
  }
  /**
   * MC-4d shoot receipt: the weapon, the pinned target UUID, the per-shot
   * records (with the mod's monotonic shot number and projectile UUID), and any
   * server-event-attributed hits/kill or trident return. A missing observation
   * is `hitEvidence: 'unobserved'`, never a miss.
   */
  shot?: {
    weapon: string
    targetUuid: string
    shots: Array<{ shot: number, projectileUuid?: string, hitEvidence?: string }>
    hits?: number
    killed?: boolean
    returned?: boolean
    /**
     * Kill attribution evidence (R9): `projectile` for our fired projectile,
     * `attacker` for our own attack source, `window` for a same-target death in
     * the shot window. Absent means unobserved.
     */
    killEvidence?: string
    /** The target died while the kill could not be attributed to this shot. */
    unobservedTargetDeath?: boolean
    /** Current target position the mod aimed at (fresh read, not the pin). */
    aimTarget?: { x: number, y: number, z: number }
    /** Where the aim came from: `fresh` re-read or `pin` fallback. */
    aimSource?: string
    /**
     * CD-B1/B2 ballistic prediction. `profileId`/`solutionRevision` name the
     * model, the remaining fields are the predicted curve. A prediction is not
     * a hit; hits and kills stay with the real projectile and server events.
     */
    profileId?: string
    solutionRevision?: number
    observationAgeMs?: number
    predictedFlightTicks?: number
    closestDistance?: number
    arc?: 'low' | 'high'
    /** Why the shot was released, e.g. a solved ballistics curve. */
    fireReason?: string
    /** Why no shot was released, when a pre-flight check refused. */
    refusalReason?: string
    endReason: string
  }
  /**
   * MC-4e riptide receipt: the measured movement of one launch and the trident
   * durability change. This is movement, not a shot: it carries no projectile
   * UUID and no shot number.
   */
  riptide?: {
    from?: { x: number, y: number, z: number }
    to?: { x: number, y: number, z: number }
    displacement?: { x: number, y: number, z: number }
    distance?: number
    durabilityBefore?: number
    durabilityAfter?: number
    /**
     * MC-4e: mod-reported water/rain state attached to a `riptide_unavailable`
     * refusal (mod 0.2.15). Fields are omitted when the mod cannot report them;
     * `rainLevel: 0` is a real value and is not "absent".
     */
    unmetDetail?: { inWater?: boolean, inRain?: boolean, rainLevel?: number }
    endReason: string
  }
  /**
   * MC-4f: result of a menu business primitive (button / select_trade /
   * set_name / beacon).
   *
   * `button` and `beacon` send a packet and have no synchronous server verdict,
   * so they report `sent` and `applied` (a bounded re-read saw the menu change
   * or the requested effect). `select_trade` / `set_name` return `accepted`
   * directly.
   */
  menuAction?: {
    containerId: number
    action: 'button' | 'select_trade' | 'set_name' | 'beacon'
    accepted?: boolean
    sent?: boolean
    applied?: boolean
    offer?: {
      result?: { id?: string, count?: number }
      inputs?: Array<{ id?: string, count?: number }>
      outOfStock?: boolean
    }
    name?: string
  }
  /**
   * MC-4f read-only item content (written book / filled map). This is an
   * observation of untrusted text: the result is never `checked` and the caller
   * must not execute the strings.
   */
  itemContent?: {
    itemId: string
    title?: string
    author?: string
    pages?: string[]
    map?: { id: number, scale?: number, dimension?: string }
    truncated?: boolean
    unsupported?: boolean
  }
  /** MC-4f read-only sign text (untrusted). Never `checked`. */
  signContent?: {
    lines: string[]
    back?: string[]
    truncated?: boolean
  }
  /** MC-4f placement receipt: requested/verified counts and per-block results. */
  placed?: {
    itemId?: string
    requested: number
    placed: number
    blocks: Array<{ x: number, y: number, z: number, ok: boolean, reason?: string }>
  }
  /**
   * MC-4g break receipt: the broken block and the mode. On a `not_confirmed`
   * timeout, `lastBlockId` is the last id the bounded poll observed.
   */
  broken?: {
    x: number
    y: number
    z: number
    blockId: string
    mode: 'survival' | 'instant'
    lastBlockId?: string
    /** CD-M2: correlation id linking the break fact, drop and pickup. */
    breakId?: string
    /** CD-M1: the equipped tool, or `hand` for a bare-hand break. */
    tool?: string
    /** CD-M1: environmental risks the evaluation named. */
    hazards?: string[]
    /** CD-M1: durability outlook for the chosen tool. */
    durability?: { known: boolean, remaining: number, expectedBlocks: number, riskOfBreak: boolean }
    /** CD-M1: the harvest requirement that stopped the break before mining. */
    rejection?: { reason: string, detail?: string }
    /** CD-M2: graded product attribution when a product was required. */
    product?: { itemId: string, count: number, lowerBound: number, fuzzy: number, evidence: string }
  }
  /**
   * MC-4g melee receipt: the fixed target, swings made, and only observed
   * evidence. A swing with no observation is `hitEvidence: 'unobserved'`,
   * never a miss.
   */
  attacked?: {
    targetUuid: string
    targetName?: string
    swings: number
    weapon: string
    damageDealt?: number
    healthBefore?: number
    healthAfter?: number
    hitEvidence?: string
    killed?: boolean
    endReason: string
  }
  /**
   * MC-4c: last broken block whose drop could not be collected.
   *
   * Present only when a collect broke a block but could not pick its drop up
   * (for example a drop that fell into a pit the walker cannot enter). The
   * coordinates are the broken block cell the drop came from, an approximation
   * of the drop's position, and are reported so a caller can return to it.
   */
  dropPosition?: { x: number, y: number, z: number }
  /**
   * CD-M3: structured tool prerequisites for a collect that lacks the tool.
   *
   * `craftable` is a plan, not an execution; the server verifies the recipe and
   * station before any craft.
   */
  prerequisites?: {
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
}

export interface GameHostDomainToolDescriptor {
  /** Model-facing name, for example `game_observe`. */
  name: string
  action: GameDomainAction
  description: string
  /** Provider-compliant JSON Schema object. */
  parameters: Record<string, unknown>
}

export const gameHostGetStatus = defineInvokeEventa<GameHostStatus, void>('eventa:invoke:electron:game-host:status')
export const gameHostGetConfig = defineInvokeEventa<GameHostConfigView, void>('eventa:invoke:electron:game-host:config')
export const gameHostApplyConfig = defineInvokeEventa<GameHostStatus, GameHostConfig>('eventa:invoke:electron:game-host:config:apply')
export const gameHostObserve = defineInvokeEventa<GameHostObservationResult, { toolName: string, arguments?: Record<string, unknown> }>('eventa:invoke:electron:game-host:observe')
export const gameHostListDomainTools = defineInvokeEventa<GameHostDomainToolDescriptor[]>('eventa:invoke:electron:game-host:domain-tools')
export const gameHostExecuteCommand = defineInvokeEventa<GameDomainResult, {
  /** Renderer-minted correlation id; becomes the command id for dedup. */
  requestId: string
  action: GameDomainAction
  params: Record<string, unknown>
  task?: GameDomainTask
}>('eventa:invoke:electron:game-host:execute')

/** MC-3c D4: one owner chat message accepted as a command (main → renderer). */
export const gameHostChatCommandEmitted = defineEventa<GameHostChatCommandPayload>('eventa:event:electron:game-host:chat-command')
