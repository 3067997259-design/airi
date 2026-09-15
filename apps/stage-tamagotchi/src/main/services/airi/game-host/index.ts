/**
 * Game host service (MC-0a).
 *
 * The Electron main-process owner of the read-only connection to the
 * MCPFabric MCP server. Unlike the generic MCP servers manager, this host
 * keeps a private MCP `Client` session that is never registered in the
 * renderer MCP store and never exposed through `createMcpServersService`,
 * because MCPFabric also exposes operator-level tools that must stay out of
 * every window's tool table (MC-0a M0-D3).
 *
 * The connection uses the Streamable HTTP transport against the MCPFabric
 * Node server and sends the bearer token from `game-host.json` as an
 * `Authorization` header. The token never appears in logs, the journal, or
 * any IPC response (MC-0a invariant 6). Only loopback endpoints are accepted;
 * any other host is rejected before a connection is attempted.
 */
import type { createContext as createMainEventaContext } from '@moeru/eventa/adapters/electron/main'

import type {
  GameCapabilities,
  GameDomainAction,
  GameDomainResult,
  GameDomainTask,
  GameHostChatContextLine,
  GameHostConfig,
  GameHostDomainToolDescriptor,
  GameHostObservationResult,
  GameHostStatus,
  GameWorldIdentity,
} from '../../../../shared/eventa'
import type { EventaWindowBroadcast } from '../../../libs/electron/eventa-window-broadcast'
import type { AttackWeapon, BreakMode, BreakToolStrategy, EquipTarget, GameAttackedReceipt, GameBrokenReceipt, GameItemContentReceipt, GameMenuActionReceipt, GameMenuReceipt, GameMenuSlotReceipt, GameMenuSnapshotReceipt, GamePlacedBlock, GamePlacedReceipt, GamePrerequisiteReport, GameRiptideReceipt, GameRiptideUnmetDetail, GameShotReceipt, GameSignContentReceipt, GameSmeltReceipt } from './command-contract'
import type {
  GameCommandEnvelope,
  GameCommandParams,
  GameCommandReceipt,
  GameExecutionToken,
  GameExecutorOutcome,
  GameFinalSnapshot,
  GamePostCondition,
  StopScope,
} from './command-registry'
import type { MiningPort, MiningSlot } from './mining/session'
import type { BreakFact, GeneratedDrop } from './mining/types'
import type { FailedEdge } from './movement/executor'
import type { TargetObservation, TargetObservationSource } from './movement/target-observation'
import type { MovementConfig } from './movement/types'

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { env } from 'node:process'

import { useLogg } from '@guiiai/logg'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { defineInvokeHandler } from '@moeru/eventa'
import { errorMessageFrom } from '@moeru/std'
import { app } from 'electron'

import {
  gameHostApplyConfig,
  gameHostChatCommandEmitted,
  gameHostExecuteCommand,
  gameHostGetConfig,
  gameHostGetStatus,
  gameHostListDomainTools,
  gameHostObserve,
} from '../../../../shared/eventa'
import { onAppBeforeQuit } from '../../../libs/bootkit/lifecycle'
import { discoverGameCapabilities } from './capabilities'
import { CHAT_COMMAND_MIN_INTERVAL_MS, CHAT_CONTEXT_BUFFER_LINES, chatCommandEventsOf, chatContextOf, classifyChatEvent, isContextEligible, nextChatCursor, parseChatCommandsConfig } from './chat-commands'
import {
  commandParamsDigest,
  createGameCommandRegistry,
  GameCommandConflictError,
  GameWriteBusyError,
  nextStopScope,
  StaleGameBindingError,
  stopScopeFor,
} from './command-registry'
import { parseHarvestEvaluation } from './mining/harvest'
import { MiningSession, nextBreakId } from './mining/session'
import { planToolUpgrade, requiredPickaxeFor } from './mining/upgrade'
import { cellOf } from './movement/coordinates'
import { runTerrainMove, runTerrainRoute, SCAFFOLDING_ITEMS } from './movement/executor'
import { createMcpMovementPort } from './movement/host-port'
import { actionResultPhases, DimensionMismatchError } from './movement/observation'
import { buildTargetObservation, entityListOf, positionOf, selectTargetFromList, TARGET_QUERY_MAX_RESULTS, TARGET_QUERY_RADIUS } from './movement/target-observation'
import { createCoarseLocateGate, createTargetTracker } from './movement/target-tracking'
import { DEFAULT_MOVEMENT_CONFIG } from './movement/types'
import { runVehicleMove } from './movement/vehicle'

const PERSISTED_FILE_NAME = 'game-host.json'
/** Read-only default set used when `allowedTools` is empty (MC-0a M0-D4). */
const DEFAULT_ALLOWED_TOOLS = ['get_status', 'get_self', 'get_inventory', 'get_blocks_region']

/** MC-4f: unit step for each placement face, used to derive targets and supports. */
const PLACE_FACE_STEPS: Record<string, { x: number, y: number, z: number }> = {
  up: { x: 0, y: 1, z: 0 },
  down: { x: 0, y: -1, z: 0 },
  north: { x: 0, y: 0, z: -1 },
  south: { x: 0, y: 0, z: 1 },
  east: { x: 1, y: 0, z: 0 },
  west: { x: -1, y: 0, z: 0 },
}

/**
 * MC-4f: blocks a placement may replace without being reported as `blocked`.
 *
 * This is a conservative set of vanilla air/plants/fluids; a modded
 * replaceable not listed here is reported `blocked` rather than guessed, and
 * the mod's own placement result stays the final authority.
 */
const PLACE_TARGET_REPLACEABLE = new Set([
  'minecraft:air',
  'minecraft:cave_air',
  'minecraft:void_air',
  'minecraft:water',
  'minecraft:lava',
  'minecraft:short_grass',
  'minecraft:grass',
  'minecraft:tall_grass',
  'minecraft:fern',
  'minecraft:large_fern',
  'minecraft:dead_bush',
  'minecraft:snow',
  'minecraft:vine',
  'minecraft:seagrass',
  'minecraft:tall_seagrass',
  'minecraft:fire',
  'minecraft:soul_fire',
  'minecraft:light',
])

/** MC-4g: break reach in blocks from the player to the block center. */
const BREAK_REACH = 4.5

/** MC-4g: default confirmation window for one break, capped by the lease. */
const BREAK_POLL_MS = 10_000

/** MC-4g: melee attack reach in blocks from the player to the target position. */
const ATTACK_REACH = 3.5

/** MC-4g: targets farther than this are not approached; the command fails. */
const ATTACK_APPROACH_MAX = 12

/** MC-4g: minimum server tick-time between two swings (vanilla cooldown). */
const ATTACK_SWING_INTERVAL_MS = 700

/**
 * MC-4g: melee preference, best first.
 *
 * Only swords, axes, and the trident are melee choices; `auto` walks this list
 * and falls back to an empty hand. Swords precede axes and the trident trails
 * both, per the documented preference.
 */
const MELEE_WEAPON_PREFERENCE = [
  'minecraft:netherite_sword',
  'minecraft:diamond_sword',
  'minecraft:iron_sword',
  'minecraft:stone_sword',
  'minecraft:golden_sword',
  'minecraft:wooden_sword',
  'minecraft:netherite_axe',
  'minecraft:diamond_axe',
  'minecraft:iron_axe',
  'minecraft:stone_axe',
  'minecraft:golden_axe',
  'minecraft:wooden_axe',
  'minecraft:trident',
]

/**
 * R9: how old a death event may be and still belong to this command's shot.
 *
 * Used only when an `entity_death` carries neither a projectile uuid nor an
 * attacker uuid, so no direct cross-check exists. The window is long enough for
 * any realistic arrow flight and short enough to exclude a later, unrelated
 * death. It is compared in server game ticks, the unit the event and the mod
 * status both report.
 */
const SHOT_ATTRIBUTION_WINDOW_TICKS = 200
const SHOT_ATTRIBUTION_WINDOW_BEFORE_TICKS = 5

/** MC-4e (§9-4): bounded wait for the server to sync a released trident's durability. */
const RIPTIDE_DURABILITY_POLL_MS = 1_500
/** MC-4e (§9-4): delay between durability sync reads. */
const RIPTIDE_DURABILITY_POLL_INTERVAL_MS = 150

/** MC-4c (§9-6): how close a drop must be for one bounded recovery attempt. */
const STUCK_DROP_RECOVERY_RANGE = 3
/** MC-4c (§9-6): bounded poll after digging the block above a stuck drop. */
const STUCK_DROP_DIG_POLL_MS = 3_000

/** §9-7: upper bound on the fresh-state read attached to a terminal result. */
const FRESH_STATE_TIMEOUT_MS = 2_000

export interface GameHostOptions {
  /** Overrides where the game host config is stored. */
  persistencePath?: string
  /** Capability announcements for the plugin-host registry (CP-1). */
  capabilities?: GameHostCapabilityPort
  /** Main→renderer push channel; plain ipc contexts only echo to a sender. */
  broadcast?: EventaWindowBroadcast
}

/** Narrow port so the game host does not depend on plugin-sdk types (CP-1). */
export interface GameHostCapabilityPort {
  announce: () => void
  ready: () => void
  withdraw: () => void
}

/**
 * Main-process command port for the Code Mode game bridge (MC-1c D1).
 *
 * `setupGameHost` returns this port; the coding host attaches it after both
 * services exist. The port is intentionally narrow: it reuses the same
 * registry and receipt check as the renderer path, so a command issued by a
 * reviewed skill and one issued by a model tool produce identical evidence.
 */
export interface GameCommandPort {
  isConnected: () => boolean
  listTools: () => GameHostDomainToolDescriptor[]
  execute: (input: {
    requestId: string
    action: GameDomainAction
    params?: Record<string, unknown>
    /** Abort cascades to the in-flight game command owned by this request. */
    signal?: AbortSignal
  }) => Promise<GameDomainResult>
  cancel: (commandId: string) => Promise<GameDomainResult>
}

/**
 * Local-only guard for the game bridge endpoint.
 *
 * Throws for any host other than `127.0.0.1`, `::1`, or `localhost`. No
 * connection is attempted after this throws, and no port guessing happens.
 *
 * @example
 * assertLoopbackEndpoint('http://127.0.0.1:25600/mcp') // ok
 * assertLoopbackEndpoint('http://[::1]:25600/mcp') // ok
 * assertLoopbackEndpoint('http://example.com/mcp') // throws
 */
export function assertLoopbackEndpoint(url: string): void {
  // NOTICE:
  // Node returns the hostname of an IPv6 URL with brackets, e.g. `[::1]`.
  // The MC-0a spec compares against the bare `::1`, so brackets are stripped
  // before the loopback check.
  // Source: MC-0a spec "认证与边界" (spec code compares hostname === '::1').
  // Removal condition: none; the normalization is required for IPv6 loopback.
  const host = new URL(url).hostname.replace(/^\[|\]$/g, '')
  if (host !== '127.0.0.1' && host !== '::1' && host !== 'localhost')
    throw new Error(`game bridge endpoint must be loopback, got ${host}`)
}

/**
 * Observation fields the game host reads from an MCP tool result.
 *
 * This is deliberately narrower than the SDK `CallToolResult`, which is a
 * union that also carries a legacy `toolResult`-only variant without `content`.
 */
interface GameHostToolResult {
  content?: Array<{ type?: string, text?: string }>
  structuredContent?: unknown
  isError?: unknown
  toolResult?: unknown
}

/**
 * Extracts the world identity cached after a successful connect.
 *
 * The fork's `get_status` reports the Minecraft version but not the world or
 * player fields, so `get_self` (client-only) fills `dimension` and any
 * player id it can provide. Reads `structuredContent` first, then falls back
 * to JSON parsed from the first text content block. Returns `undefined` when
 * no Minecraft version can be read; the connection stays healthy and only the
 * identity cache is empty.
 *
 * @example
 * gameWorldIdentityFrom({ content: [], structuredContent: { minecraftVersion: '1.21.1' } }, { content: [], structuredContent: { dimension: 'minecraft:overworld' } })
 * // => { minecraftVersion: '1.21.1', worldId: 'connection-scoped', dimension: 'minecraft:overworld', playerUuid: '' }
 */
export function gameWorldIdentityFrom(result: GameHostToolResult, selfResult?: GameHostToolResult): GameWorldIdentity | undefined {
  const record = statusRecordOf(result)
  if (!record)
    return undefined

  const minecraftVersion = String(record.minecraftVersion ?? record.version ?? '').trim()
  if (!minecraftVersion)
    return undefined

  const self = selfResult ? statusRecordOf(selfResult) : undefined
  const worldId = firstText(record.worldId, record.world_id, self?.worldId, self?.world_id) ?? 'connection-scoped'
  const dimension = firstText(record.dimension, self?.dimension) ?? ''
  const playerUuid = firstText(record.playerUuid, record.player_uuid, self?.playerUuid, self?.player_uuid, self?.uuid) ?? ''

  return {
    minecraftVersion,
    worldId,
    dimension,
    playerUuid,
  }
}

/** Returns the first value that is a non-empty string after trimming. */
function firstText(...values: unknown[]): string | undefined {
  for (const value of values) {
    const text = String(value ?? '').trim()
    if (text)
      return text
  }
  return undefined
}

/**
 * Reads the persisted game host config; a missing or malformed file means
 * "not configured" and returns `undefined`.
 */
export async function readGameHostConfig(path: string): Promise<GameHostConfig | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown
    if (typeof parsed !== 'object' || parsed === null)
      return undefined
    const record = parsed as Record<string, unknown>
    if (typeof record.url !== 'string' || !record.url.trim())
      return undefined
    const movementRaw = record.movement && typeof record.movement === 'object' && !Array.isArray(record.movement)
      ? (record.movement as Record<string, unknown>).planner
      : undefined
    const movement: GameHostConfig['movement'] = movementRaw === 'terrain' || movementRaw === 'legacy'
      ? { planner: movementRaw }
      : undefined
    const chatCommands = parseChatCommandsConfig(record.chatCommands)
    return {
      url: record.url.trim(),
      ...(typeof record.token === 'string' && record.token.trim() ? { token: record.token } : {}),
      ...(typeof record.serverUrl === 'string' && record.serverUrl.trim() ? { serverUrl: record.serverUrl.trim() } : {}),
      allowedTools: Array.isArray(record.allowedTools)
        ? record.allowedTools.filter((tool): tool is string => typeof tool === 'string')
        : [],
      ...(movement ? { movement } : {}),
      ...(chatCommands ? { chatCommands } : {}),
    }
  }
  catch {
    return undefined
  }
}

/** Persists the game host config; a failed write never breaks the running connection. */
export async function writeGameHostConfig(path: string, config: GameHostConfig): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify(config, null, 2), 'utf8')
  }
  catch {
    // Persistence is a convenience: a failed write only costs the reconnect
    // on next boot, never the current connection.
  }
}

function statusRecordOf(result: GameHostToolResult): Record<string, unknown> | undefined {
  if (result.structuredContent && typeof result.structuredContent === 'object' && !Array.isArray(result.structuredContent))
    return result.structuredContent as Record<string, unknown>

  const text = (result.content ?? [])
    .filter((item): item is { type: 'text', text: string } => item.type === 'text')
    .map(item => item.text)
    .join('')
  if (!text.trim())
    return undefined

  try {
    const parsed = JSON.parse(text) as unknown
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined
  }
  catch {
    return undefined
  }
}

function normalizeObservation(toolName: string, result: GameHostToolResult): GameHostObservationResult {
  const normalized: GameHostObservationResult = { toolName, observedAt: Date.now() }
  if (Array.isArray(result.content))
    normalized.content = result.content as Array<Record<string, unknown>>
  if (result.structuredContent && typeof result.structuredContent === 'object' && !Array.isArray(result.structuredContent))
    normalized.structuredContent = result.structuredContent as Record<string, unknown>
  if (typeof result.isError === 'boolean')
    normalized.isError = result.isError
  if ('toolResult' in result)
    normalized.toolResult = result.toolResult
  return normalized
}

/** Per-action lease defaults for domain commands (mc-0c-spec; mc-1a adds say/collect/follow). */
const DOMAIN_COMMAND_DEADLINES: Record<GameDomainAction, number> = {
  observe: 8_000,
  move_to: 120_000,
  status: 5_000,
  cancel: 5_000,
  say: 10_000,
  collect: 180_000,
  follow: 300_000,
  craft: 60_000,
  drop: 20_000,
  locate: 8_000,
  equip: 15_000,
  use: 30_000,
  open_container: 15_000,
  read_menu: 15_000,
  close_menu: 15_000,
  move_item: 30_000,
  craft_table: 60_000,
  smelt_load: 120_000,
  smelt_take: 120_000,
  supply: 30_000,
  sleep: 30_000,
  respawn: 20_000,
  shoot: 60_000,
  riptide: 30_000,
  menu_action: 20_000,
  read_item: 10_000,
  read_sign: 10_000,
  place: 60_000,
  break: 30_000,
  attack: 60_000,
}

const DOMAIN_TOOLS: GameHostDomainToolDescriptor[] = [
  {
    name: 'game_observe',
    action: 'observe',
    description: 'Read your own player state (position, health, food, held item) and inventory. Use it before acting in the world.',
    parameters: {
      type: 'object',
      properties: {
        radius: { type: 'number', description: 'Observation radius in blocks (default 16, max 64).' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'game_move_to',
    action: 'move_to',
    description: 'Walk to a position with a bounded lease. Reports the measured final distance; unreachable targets fail with the final position.',
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'number' },
        y: { type: 'number' },
        z: { type: 'number' },
        tolerance: { type: 'number', description: 'Arrival tolerance in blocks (default 1, max 8).' },
        allowBreak: { type: 'boolean', description: 'Allow the walk to break blocks in the way (default false: do not damage buildings).' },
        allowPlace: { type: 'boolean', description: 'Allow the walk to place scaffolding to pillar or bridge (default true).' },
        maxFall: { type: 'number', description: 'Maximum allowed fall in blocks (default 4).' },
        vehicle: { type: 'string', enum: ['boat', 'horse', 'minecart', 'elytra', 'strider'], description: 'Ride this vehicle to the target instead of walking: boat/horse/minecart, elytra (glide; needs fireworks), or strider (lava; needs a saddle and a warped fungus on a stick).' },
        fallbackToFoot: { type: 'boolean', description: 'When the vehicle mover fails, walk the same target instead (default false).' },
      },
      required: ['x', 'y', 'z'],
      additionalProperties: false,
    },
  },
  {
    name: 'game_status',
    action: 'status',
    description: 'Read the current game command state: the active write command and its last terminal receipt.',
    parameters: {
      type: 'object',
      properties: {
        commandId: { type: 'string', description: 'Optional command id; omit to read the active command.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'game_cancel',
    action: 'cancel',
    description: 'Stop the active game command, or one by id. Waits for the executor stop confirmation.',
    parameters: {
      type: 'object',
      properties: {
        commandId: { type: 'string', description: 'Optional command id; omit to stop the active write command.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'game_say',
    action: 'say',
    description: 'Send a chat message as the player. A write action: it cannot run while another game command owns the player.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Message text to send in game chat.' },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'game_collect',
    action: 'collect',
    description: 'Find blocks of one id within a radius, walk to them, break them and pick up the drops. Reports how many target items this command actually collected. Selects the tool by conserve policy and refuses to mine a block no reachable tool can harvest; when the tool is missing it returns structured prerequisites instead. Set allowPrerequisites to let it run the bounded tool-preparation flow.',
    parameters: {
      type: 'object',
      properties: {
        blockId: { type: 'string', description: 'Block id to break, e.g. minecraft:oak_log.' },
        itemId: { type: 'string', description: 'Dropped item id to count; defaults to blockId.' },
        maxCount: { type: 'number', description: 'How many items to collect (default 1, max 16).' },
        radius: { type: 'number', description: 'Search radius in blocks (default 16, max 48).' },
        allowPrerequisites: { type: 'boolean', description: 'Allow the bounded tool-preparation flow when the required tool is missing (default false: report structured prerequisites only).' },
      },
      required: ['blockId'],
      additionalProperties: false,
    },
  },
  {
    name: 'game_follow',
    action: 'follow',
    description: 'Follow a player or entity, keeping a distance, until the lease ends, the target disappears, or a new command stops it. Bounded and interruptible.',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Player name or entity type id to follow.' },
        keepDistance: { type: 'number', description: 'Distance to keep in blocks (default 3, max 16).' },
        timeoutSeconds: { type: 'number', description: 'Optional bound in seconds; capped by the command lease.' },
      },
      required: ['target'],
      additionalProperties: false,
    },
  },
  {
    name: 'game_craft',
    action: 'craft',
    description: 'Craft a known recipe that fits the player\'s own 2x2 grid (two-beat), then read the inventory before and after. Reports the claimed output stack and the measured inventory delta; recipes that need a crafting table fail honestly.',
    parameters: {
      type: 'object',
      properties: {
        recipeId: { type: 'string', description: 'Full recipe id, e.g. farmersdelight:flint_knife.' },
      },
      required: ['recipeId'],
      additionalProperties: false,
    },
  },
  {
    name: 'game_drop',
    action: 'drop',
    description: 'Drop items from the hotbar so another player can pick them up. Reports how many actually left the inventory; an item outside the hotbar fails with not_in_hotbar.',
    parameters: {
      type: 'object',
      properties: {
        itemId: { type: 'string', description: 'Item id to drop, e.g. minecraft:oak_planks.' },
        count: { type: 'number', description: 'How many to drop (default 1, max 16).' },
      },
      required: ['itemId'],
      additionalProperties: false,
    },
  },
  {
    name: 'game_locate',
    action: 'locate',
    description: 'Read another player\'s current position from the server-side player list. Use it before walking to them or reporting coordinates.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Player name to look up.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'game_equip',
    action: 'equip',
    description: 'Move one item from the hotbar or main inventory into an equipment slot (hand, off hand, or armor) and verify it with a fresh equipment read. Fails honestly when the item is not in the inventory or the read cannot confirm the swap.',
    parameters: {
      type: 'object',
      properties: {
        itemId: { type: 'string', description: 'Item id to equip, e.g. minecraft:iron_helmet.' },
        target: { type: 'string', enum: ['main_hand', 'off_hand', 'head', 'chest', 'legs', 'feet'], description: 'Equipment slot to fill.' },
      },
      required: ['itemId', 'target'],
      additionalProperties: false,
    },
  },
  {
    name: 'game_use',
    action: 'use',
    description: 'One bounded use. mode item holds the held item for holdTicks then releases it; set abort to cancel instead of releasing (an abort does not fire bow/crossbow/trident or finish food). mode block right-clicks a block at x/y/z; mode entity right-clicks a uuid.',
    parameters: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['item', 'block', 'entity'], description: 'What to use.' },
        holdTicks: { type: 'number', description: 'Game ticks to hold an item use before ending it (default 0, max 200).' },
        abort: { type: 'boolean', description: 'Abort the item use instead of a normal release (default false).' },
        x: { type: 'number', description: 'Block x for mode block.' },
        y: { type: 'number', description: 'Block y for mode block.' },
        z: { type: 'number', description: 'Block z for mode block.' },
        uuid: { type: 'string', description: 'Entity uuid for mode entity.' },
      },
      required: ['mode'],
      additionalProperties: false,
    },
  },
  {
    name: 'game_open_container',
    action: 'open_container',
    description: 'Right-click a container block (chest, barrel, crafting table, furnace, smoker, blast furnace, hopper, shulker box) to open its menu and report the menu identity. Fails with no_menu when the block opens no menu. The menu stays open for read_menu/move_item; close it with game_close_menu.',
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'number' },
        y: { type: 'number' },
        z: { type: 'number' },
        face: { type: 'string', enum: ['up', 'down', 'north', 'south', 'east', 'west'], description: 'Block face to use (default up).' },
      },
      required: ['x', 'y', 'z'],
      additionalProperties: false,
    },
  },
  {
    name: 'game_read_menu',
    action: 'read_menu',
    description: 'Read the currently open menu: container id, type, carried item, and every slot with its menu index, container, player-inventory index when applicable, and item. Slot numbers belong to that container id and must not be reused after it changes.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'game_move_item',
    action: 'move_item',
    description: 'Move a whole stack between two slots of the currently open menu (from/to are menu slot indices). Verified against a fresh menu snapshot with bounded retries. Fails with menu_mismatch, no_menu, slot_empty, or destination_full. count is the minimum number of items to move.',
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'number', description: 'Source menu slot index.' },
        to: { type: 'number', description: 'Destination menu slot index.' },
        count: { type: 'number', description: 'Minimum items to move (default: the whole source stack).' },
      },
      required: ['from', 'to'],
      additionalProperties: false,
    },
  },
  {
    name: 'game_close_menu',
    action: 'close_menu',
    description: 'Close the currently open container menu. Fails with no_menu when only the player inventory menu is open, so it never reports a fake close.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'game_craft_table',
    action: 'craft_table',
    description: 'Open a crafting table at x/y/z, place one known 3x3 recipe, then claim the output with the two-beat protocol and verify the inventory delta. A leftover result from an earlier craft is cleared first and recorded as residue, never counted as this craft\'s output. Fails honestly with unknown_recipe, menu_not_crafting, or not_confirmed.',
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'number' },
        y: { type: 'number' },
        z: { type: 'number' },
        recipeId: { type: 'string', description: 'Full recipe id, e.g. minecraft:iron_pickaxe.' },
        attempts: { type: 'number', description: 'Maximum claim attempts (default 5, max 10).' },
      },
      required: ['x', 'y', 'z', 'recipeId'],
      additionalProperties: false,
    },
  },
  {
    name: 'game_smelt_load',
    action: 'smelt_load',
    description: 'Open a furnace/smoker/blast furnace at x/y/z and load the input and optional fuel from the inventory. Returns after a bounded cooking check; the furnace keeps cooking without holding the player. Take the result later with game_smelt_take. Fails with no_menu or not_furnace.',
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'number' },
        y: { type: 'number' },
        z: { type: 'number' },
        inputItemId: { type: 'string', description: 'Item id to smelt, e.g. minecraft:raw_iron.' },
        fuelItemId: { type: 'string', description: 'Optional fuel item id, e.g. minecraft:coal.' },
        count: { type: 'number', description: 'Minimum input items to load (default 1).' },
      },
      required: ['x', 'y', 'z', 'inputItemId'],
      additionalProperties: false,
    },
  },
  {
    name: 'game_smelt_take',
    action: 'smelt_take',
    description: 'Open the furnace at x/y/z and move the finished output to the inventory, verified by the fresh inventory delta. Leftover input or fuel is recorded as residue and never counted as output. Fails with no_menu, not_furnace, or slot_empty.',
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'number' },
        y: { type: 'number' },
        z: { type: 'number' },
      },
      required: ['x', 'y', 'z'],
      additionalProperties: false,
    },
  },
  {
    name: 'game_supply',
    action: 'supply',
    description: 'Eat one food item to restore hunger: pick from the hotbar first, then the main inventory (a main stack is moved into an empty hotbar slot), start a real use, then release it. Verified by a fresh food-level delta; fails with no_food when nothing edible is reachable or not_confirmed when hunger did not rise.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'game_sleep',
    action: 'sleep',
    description: 'Sleep in the bed block at x/y/z: aim at the bed and right-click it, then wait for the player to fall asleep. Fails with no_bed when the block is not a bed, interaction_failed when the use is rejected, or not_sleeping when the player never falls asleep in the bounded window.',
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'number' },
        y: { type: 'number' },
        z: { type: 'number' },
      },
      required: ['x', 'y', 'z'],
      additionalProperties: false,
    },
  },
  {
    name: 'game_respawn',
    action: 'respawn',
    description: 'Respawn after death and report the fresh position. Fails with not_dead when the player is still alive, so a respawn is never reported for a living player.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'game_shoot',
    action: 'shoot',
    description: 'Fire a ranged weapon (bow, crossbow, or trident) at one target, pinning its UUID for the whole command. The mod performs the per-tick charge, aim and release; this tool reports the shots that actually left and only claims a hit/kill when a server event can be attributed to it, otherwise hitEvidence is unobserved. Riptide is not a shot: use game_riptide instead.',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Target entity name, type id, or uuid. Resolved once and never re-targeted.' },
        weapon: { type: 'string', enum: ['auto', 'bow', 'crossbow', 'trident'], description: 'Weapon to use; auto picks from the inventory (default auto).' },
        maxShots: { type: 'number', description: 'Maximum shots before the task reports done (default 1, max 16).' },
        chargeTicks: { type: 'number', description: 'Ticks to hold a bow/trident charge (default 20, max 200). Ignored for crossbow.' },
        useServerEvents: { type: 'boolean', description: 'Attribute hits from server events when the server bridge is available (default true).' },
      },
      required: ['target'],
      additionalProperties: false,
    },
  },
  {
    name: 'game_riptide',
    action: 'riptide',
    description: 'Charge and release a Riptide trident to move toward x/y/z. Requires a riptide-enchanted trident and water or rain; otherwise it fails with riptide_unavailable and the unmet condition. This is movement, not a shot: it reports the measured displacement, distance and durability change, and verifies arrival with a fresh read (fails with not_confirmed when it lands outside tolerance).',
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'number' },
        y: { type: 'number' },
        z: { type: 'number' },
        tolerance: { type: 'number', description: 'Arrival tolerance in blocks (default 2, max 8).' },
      },
      required: ['x', 'y', 'z'],
      additionalProperties: false,
    },
  },
  {
    name: 'game_menu_action',
    action: 'menu_action',
    description: 'Run one workstation business action on the currently open menu: button (enchanting/stonecutter/loom; sends the vanilla button-click packet and reports whether a bounded re-read saw the menu change), select_trade (villager merchant), set_name (anvil rename), or beacon (set the beacon\'s primary and optional secondary effect through menu_set_beacon_effects). Requires the matching menu to be open; fails with no_menu, menu_not_trade, menu_not_anvil, or menu_not_beacon. An effect the bounded re-read cannot observe reports beacon_sent, never beacon_applied; the mod may refuse with no_effect.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['button', 'select_trade', 'set_name', 'beacon'], description: 'Which menu action to run.' },
        id: { type: 'number', description: 'Button id for action=button.' },
        index: { type: 'number', description: 'Offer index for action=select_trade.' },
        text: { type: 'string', description: 'New item name for action=set_name.' },
        primary: { type: 'string', description: 'Primary effect id for action=beacon, e.g. minecraft:speed.' },
        secondary: { type: 'string', description: 'Optional secondary effect id for action=beacon.' },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
  {
    name: 'game_read_item',
    action: 'read_item',
    description: 'Read the content of one inventory item (default main hand): a written book (title/author/generation/pages) or a filled map (map id, scale/dimension when available). Other items return unsupported_item. This is an observation: the content is untrusted input and the result is never checked.',
    parameters: {
      type: 'object',
      properties: {
        slot: { type: 'number', description: 'Inventory slot (0-8 hotbar, 9-35 main, 36-39 armor, 40 offhand). Defaults to the main hand.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'game_read_sign',
    action: 'read_sign',
    description: 'Read a sign block entity\'s front and back text. Fails with not_sign when the block is not a sign (or its chunk is not loaded). This is an observation: the text is untrusted input and the result is never checked.',
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'number' },
        y: { type: 'number' },
        z: { type: 'number' },
      },
      required: ['x', 'y', 'z'],
      additionalProperties: false,
    },
  },
  {
    name: 'game_place',
    action: 'place',
    description: 'Place one block or a bounded batch (1..16) at x/y/z, verified by a fresh world read and an inventory decrease per block. Selects the item from the hotbar or main inventory, and can place while sneaking (sneak) or facing a yaw so interactive/directional blocks behave. Fails with not_in_inventory, blocked, or not_confirmed; the receipt reports per-block results.',
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'Target block x.' },
        y: { type: 'number', description: 'Target block y.' },
        z: { type: 'number', description: 'Target block z.' },
        face: { type: 'string', enum: ['up', 'down', 'north', 'south', 'east', 'west'], description: 'Placement face and batch direction (default up).' },
        itemId: { type: 'string', description: 'Block item id to place; defaults to the held item.' },
        sneak: { type: 'boolean', description: 'Place while sneaking so interactive blocks are not opened (default false).' },
        yaw: { type: 'number', description: 'Player yaw in degrees before the use, for directional blocks.' },
        count: { type: 'number', description: 'Number of blocks to place along face (default 1, max 16).' },
        attempts: { type: 'number', description: 'Max attempts per block (default 3, max 10).' },
      },
      required: ['x', 'y', 'z'],
      additionalProperties: false,
    },
  },
  {
    name: 'game_break',
    action: 'break',
    description: 'Break one block at x/y/z and confirm it with a bounded fresh world read. She must already be within reach; walk with game_move_to first. Selects a tool by strategy (default conserve: avoid burning rare enchanted tools) and refuses a block no reachable tool can harvest before mining starts. Fails with already_air, out_of_reach, not_confirmed, or a tool rejection (no_tool, tool_level_too_low, unbreakable, inventory_full, tool_durability_low). The drop is left for the caller unless itemId names a required product, which is then picked up and attributed.',
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'Target block x.' },
        y: { type: 'number', description: 'Target block y.' },
        z: { type: 'number', description: 'Target block z.' },
        mode: { type: 'string', enum: ['survival', 'instant'], description: 'Break mode: survival starts a tick-driven dig, instant removes it in one beat (default survival).' },
        itemId: { type: 'string', description: 'Required product item id; when set the command waits for and attributes the pickup.' },
        strategy: { type: 'string', enum: ['fastest', 'conserve', 'specified'], description: 'Tool policy (default conserve).' },
        tool: { type: 'string', description: 'Item id to pin for strategy=specified.' },
      },
      required: ['x', 'y', 'z'],
      additionalProperties: false,
    },
  },
  {
    name: 'game_attack',
    action: 'attack',
    description: 'Melee-attack one target (name, type id, or uuid) with the best available weapon, up to maxSwings. She walks the target when it is within 12 blocks and stops otherwise. A hit is reported only when a fresh read observed health loss or the entity disappeared; otherwise hitEvidence is unobserved. Fails with target_lost, out_of_reach, weapon_unavailable, or not_confirmed.',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Target entity name, type id, or uuid. Resolved once and pinned for the whole command.' },
        maxSwings: { type: 'number', description: 'Maximum swings before the command reports done (default 1, max 8).' },
        weapon: { type: 'string', enum: ['auto', 'hand', 'sword', 'axe', 'trident'], description: 'Weapon class; auto picks the best melee item from the inventory and falls back to an empty hand (default auto).' },
      },
      required: ['target'],
      additionalProperties: false,
    },
  },
]

/** Maps flat model arguments onto the MC-0b command params shape. */
function toGameCommandParams(action: GameDomainAction, params: Record<string, unknown>): GameCommandParams {
  switch (action) {
    case 'move_to': {
      const tolerance = Math.min(Math.max(Number(params.tolerance ?? 1) || 1, 0.1), 8)
      const maxFall = Number(params.maxFall)
      // MC-3c adds the gliding and lava modes; the union stays explicit so an
      // unknown string never silently becomes a walk.
      const vehicle = params.vehicle === 'boat' || params.vehicle === 'horse' || params.vehicle === 'minecart'
        || params.vehicle === 'elytra' || params.vehicle === 'strider'
        ? params.vehicle
        : undefined
      return {
        moveTo: {
          x: Number(params.x) || 0,
          y: Number(params.y) || 0,
          z: Number(params.z) || 0,
          tolerance,
          ...(params.allowBreak === true ? { allowBreak: true } : {}),
          ...(params.allowPlace === false ? { allowPlace: false } : {}),
          ...(Number.isFinite(maxFall) && maxFall > 0 ? { maxFall: Math.min(Math.max(Math.round(maxFall), 1), 32) } : {}),
          ...(vehicle ? { vehicle } : {}),
          ...(params.fallbackToFoot === true ? { fallbackToFoot: true } : {}),
        },
      }
    }
    case 'observe': {
      const radius = Number(params.radius ?? 16)
      return { observe: { radius: Math.min(Math.max(radius, 1), 64) } }
    }
    case 'status':
      return { status: { commandId: String(params.commandId ?? '') } }
    case 'cancel':
      return { cancel: { commandId: String(params.commandId ?? '') } }
    case 'say':
      return { say: { text: String(params.text ?? '').trim() } }
    case 'collect': {
      const maxCount = Math.min(Math.max(Number(params.maxCount ?? 1) || 1, 1), 16)
      const radius = Math.min(Math.max(Number(params.radius ?? 16) || 16, 4), 48)
      const itemId = typeof params.itemId === 'string' && params.itemId.trim() ? params.itemId.trim() : undefined
      return {
        collect: {
          blockId: String(params.blockId ?? '').trim(),
          ...(itemId ? { itemId } : {}),
          maxCount,
          radius,
          ...(params.allowPrerequisites === true ? { allowPrerequisites: true } : {}),
        },
      }
    }
    case 'follow': {
      const keepDistance = Math.min(Math.max(Number(params.keepDistance ?? 3) || 3, 1), 16)
      const timeoutSeconds = Number(params.timeoutSeconds)
      return {
        follow: {
          target: String(params.target ?? '').trim(),
          keepDistance,
          ...(Number.isFinite(timeoutSeconds) && timeoutSeconds > 0 ? { timeoutSeconds } : {}),
        },
      }
    }
    case 'craft':
      return { craft: { recipeId: String(params.recipeId ?? '').trim() } }
    case 'drop': {
      const count = Math.min(Math.max(Number(params.count ?? 1) || 1, 1), 16)
      return { drop: { itemId: String(params.itemId ?? '').trim(), count } }
    }
    case 'locate':
      return { locate: { name: String(params.name ?? '').trim() } }
    case 'equip': {
      const rawTarget = String(params.target ?? '')
      const target: EquipTarget = rawTarget === 'off_hand' || rawTarget === 'head'
        || rawTarget === 'chest' || rawTarget === 'legs' || rawTarget === 'feet'
        ? rawTarget
        : 'main_hand'
      return { equip: { itemId: String(params.itemId ?? '').trim(), target } }
    }
    case 'use': {
      const rawMode = String(params.mode ?? '')
      const mode = rawMode === 'block' || rawMode === 'entity' ? rawMode : 'item'
      const holdTicks = Math.min(Math.max(Math.round(Number(params.holdTicks ?? 0) || 0), 0), 200)
      const use: NonNullable<GameCommandParams['use']> = { mode, holdTicks, abort: params.abort === true }
      if (mode === 'block') {
        use.x = Number(params.x) || 0
        use.y = Number(params.y) || 0
        use.z = Number(params.z) || 0
      }
      if (mode === 'entity')
        use.uuid = String(params.uuid ?? '').trim()
      return { use }
    }
    case 'open_container': {
      const face = typeof params.face === 'string' && ['up', 'down', 'north', 'south', 'east', 'west'].includes(params.face)
        ? params.face
        : undefined
      return {
        openContainer: {
          x: Number(params.x) || 0,
          y: Number(params.y) || 0,
          z: Number(params.z) || 0,
          ...(face ? { face } : {}),
        },
      }
    }
    case 'read_menu':
    case 'close_menu':
      return {}
    case 'move_item': {
      const from = Math.round(Number(params.from ?? 0) || 0)
      const to = Math.round(Number(params.to ?? 0) || 0)
      const count = Number(params.count)
      return { moveItem: { from: Math.max(0, from), to: Math.max(0, to), ...(Number.isFinite(count) && count > 0 ? { count: Math.round(count) } : {}) } }
    }
    case 'craft_table': {
      const attempts = Number(params.attempts)
      return {
        craftTable: {
          x: Number(params.x) || 0,
          y: Number(params.y) || 0,
          z: Number(params.z) || 0,
          recipeId: String(params.recipeId ?? '').trim(),
          ...(Number.isFinite(attempts) && attempts > 0 ? { attempts: Math.min(Math.max(Math.round(attempts), 1), 10) } : {}),
        },
      }
    }
    case 'smelt_load': {
      const fuelItemId = typeof params.fuelItemId === 'string' && params.fuelItemId.trim() ? params.fuelItemId.trim() : undefined
      const count = Number(params.count)
      return {
        smeltLoad: {
          x: Number(params.x) || 0,
          y: Number(params.y) || 0,
          z: Number(params.z) || 0,
          inputItemId: String(params.inputItemId ?? '').trim(),
          ...(fuelItemId ? { fuelItemId } : {}),
          ...(Number.isFinite(count) && count > 0 ? { count: Math.round(count) } : {}),
        },
      }
    }
    case 'smelt_take':
      return { smeltTake: { x: Number(params.x) || 0, y: Number(params.y) || 0, z: Number(params.z) || 0 } }
    case 'sleep':
      return { sleep: { x: Number(params.x) || 0, y: Number(params.y) || 0, z: Number(params.z) || 0 } }
    case 'shoot': {
      const rawWeapon = String(params.weapon ?? 'auto')
      const weapon = rawWeapon === 'bow' || rawWeapon === 'crossbow' || rawWeapon === 'trident'
        ? rawWeapon
        : 'auto'
      const maxShots = Math.min(Math.max(Math.round(Number(params.maxShots ?? 1) || 1), 1), 16)
      const chargeTicks = Number(params.chargeTicks)
      return {
        shoot: {
          target: String(params.target ?? '').trim(),
          weapon,
          maxShots,
          ...(Number.isFinite(chargeTicks) && chargeTicks > 0 ? { chargeTicks: Math.min(Math.max(Math.round(chargeTicks), 1), 200) } : {}),
          ...(params.useServerEvents === false ? { useServerEvents: false } : {}),
        },
      }
    }
    case 'supply':
    case 'respawn':
      return {}
    case 'riptide': {
      const tolerance = Math.min(Math.max(Number(params.tolerance ?? 2) || 2, 0.5), 8)
      return {
        riptide: {
          x: Number(params.x) || 0,
          y: Number(params.y) || 0,
          z: Number(params.z) || 0,
          tolerance,
        },
      }
    }
    case 'menu_action': {
      const rawAction = String(params.action ?? '')
      const action = rawAction === 'select_trade' || rawAction === 'set_name' || rawAction === 'beacon' ? rawAction : 'button'
      const menuAction: NonNullable<GameCommandParams['menuAction']> = { action }
      const id = Number(params.id)
      if (action === 'button' && Number.isFinite(id))
        menuAction.id = Math.max(0, Math.round(id))
      const index = Number(params.index)
      if (action === 'select_trade' && Number.isFinite(index))
        menuAction.index = Math.max(0, Math.round(index))
      if (action === 'set_name')
        menuAction.text = String(params.text ?? '').slice(0, 50)
      if (action === 'beacon') {
        menuAction.primary = String(params.primary ?? '').trim()
        const secondary = String(params.secondary ?? '').trim()
        if (secondary)
          menuAction.secondary = secondary
      }
      return { menuAction }
    }
    case 'read_item': {
      const slot = Number(params.slot)
      return { readItem: (Number.isFinite(slot) ? { slot: Math.min(Math.max(Math.round(slot), 0), 40) } : {}) }
    }
    case 'read_sign':
      return { readSign: { x: Number(params.x) || 0, y: Number(params.y) || 0, z: Number(params.z) || 0 } }
    case 'place': {
      const face = typeof params.face === 'string' && ['up', 'down', 'north', 'south', 'east', 'west'].includes(params.face)
        ? params.face
        : undefined
      const itemId = typeof params.itemId === 'string' && params.itemId.trim() ? params.itemId.trim() : undefined
      const count = Math.min(Math.max(Math.round(Number(params.count ?? 1) || 1), 1), 16)
      const attempts = Math.min(Math.max(Math.round(Number(params.attempts ?? 3) || 3), 1), 10)
      const yaw = Number(params.yaw)
      return {
        place: {
          x: Number(params.x) || 0,
          y: Number(params.y) || 0,
          z: Number(params.z) || 0,
          ...(face ? { face } : {}),
          ...(itemId ? { itemId } : {}),
          ...(params.sneak === true ? { sneak: true } : {}),
          ...(Number.isFinite(yaw) ? { yaw } : {}),
          count,
          attempts,
        },
      }
    }
    case 'break': {
      const rawMode = String(params.mode ?? 'survival')
      const mode: BreakMode = rawMode === 'instant' ? 'instant' : 'survival'
      const rawStrategy = String(params.strategy ?? '')
      const strategy: BreakToolStrategy = rawStrategy === 'fastest' || rawStrategy === 'specified'
        ? rawStrategy
        : 'conserve'
      const itemId = typeof params.itemId === 'string' && params.itemId.trim() ? params.itemId.trim() : undefined
      const tool = typeof params.tool === 'string' && params.tool.trim() ? params.tool.trim() : undefined
      return {
        breakBlock: {
          x: Number(params.x) || 0,
          y: Number(params.y) || 0,
          z: Number(params.z) || 0,
          mode,
          strategy,
          ...(itemId ? { itemId } : {}),
          ...(tool ? { tool } : {}),
        },
      }
    }
    case 'attack': {
      const rawWeapon = String(params.weapon ?? 'auto')
      const weapon: AttackWeapon = rawWeapon === 'hand' || rawWeapon === 'sword'
        || rawWeapon === 'axe' || rawWeapon === 'trident'
        ? rawWeapon
        : 'auto'
      const maxSwings = Math.min(Math.max(Math.round(Number(params.maxSwings ?? 1) || 1), 1), 8)
      return {
        attack: {
          target: String(params.target ?? '').trim(),
          maxSwings,
          weapon,
        },
      }
    }
  }
}

function gameToolResultError(result: GameHostToolResult): string | undefined {
  if (result.isError !== true)
    return undefined
  const text = (result.content ?? [])
    .filter(item => item.type === 'text' && typeof item.text === 'string')
    .map(item => item.text)
    .join('')
    .trim()
  return text || 'tool_error'
}

function finalPositionOf(record: Record<string, unknown> | undefined): { x: number, y: number, z: number } | undefined {
  const raw = record?.finalPosition
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
    return undefined
  const position = raw as Record<string, unknown>
  const x = Number(position.x)
  const y = Number(position.y)
  const z = Number(position.z)
  return [x, y, z].every(Number.isFinite) ? { x, y, z } : undefined
}

/**
 * Reads the mod's water/rain diagnostic fields for a riptide refusal.
 *
 * Fields the mod does not report are omitted; a reported `rainLevel: 0` is a
 * real value, so it is kept rather than treated as absent.
 */
function riptideUnmetDetailOf(record: Record<string, unknown> | undefined): GameRiptideUnmetDetail | undefined {
  if (!record)
    return undefined
  const detail: GameRiptideUnmetDetail = {}
  if (typeof record.inWater === 'boolean')
    detail.inWater = record.inWater
  if (typeof record.inRain === 'boolean')
    detail.inRain = record.inRain
  const rainLevel = Number(record.rainLevel)
  if (Number.isFinite(rainLevel))
    detail.rainLevel = rainLevel
  return Object.keys(detail).length > 0 ? detail : undefined
}

/** Reads a `{ x, y, z }` record; undefined when any component is not finite. */
function vec3RecordOf(value: unknown): { x: number, y: number, z: number } | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return undefined
  const record = value as Record<string, unknown>
  const x = Number(record.x)
  const y = Number(record.y)
  const z = Number(record.z)
  return [x, y, z].every(Number.isFinite) ? { x, y, z } : undefined
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/**
 * Resolves with the value when `promise` settles in time, otherwise with
 * `undefined`.
 *
 * §9-7: the game host must reply to every command invoke once the command
 * settles. A stalled bridge read after the settlement must not hold the reply
 * open; the caller gets the terminal receipt and an unread fresh state instead.
 */
function settleWithin<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise<T | undefined>((resolve) => {
    const timer = setTimeout(resolve, ms, undefined)
    timer.unref?.()
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      () => {
        clearTimeout(timer)
        resolve(undefined)
      },
    )
  })
}

export async function setupGameHost(
  context: ReturnType<typeof createMainEventaContext>['context'],
  options: GameHostOptions = {},
  userDataDir: string,
): Promise<GameCommandPort> {
  const log = useLogg('main/game-host').useGlobalConfig()
  const persistencePath = options.persistencePath ?? join(userDataDir, PERSISTED_FILE_NAME)

  let config: GameHostConfig | undefined
  let client: Client | undefined
  /**
   * MC-3c dual endpoint: on a dedicated server, world/entity/player-admin
   * tools route here instead of the client bridge, which answers `no_server`.
   */
  let serverClient: Client | undefined
  let worldIdentity: GameWorldIdentity | undefined
  /**
   * Last successfully parsed `get_status` record.
   *
   * Keeps the Minecraft version for a late identity repair (§9-1): the app can
   * connect before a player is in the world, so the connect-time build has no
   * dimension, or fails entirely when `get_status` was unavailable. A later
   * fresh player read uses this record plus that read to build the binding.
   */
  let lastStatusRecord: Record<string, unknown> | undefined
  /** Per-connect scope id; regenerated on every successful connect (mc-1b). */
  let connectionId = ''
  let lastError: string | undefined
  /** Increments on every successful (re)connect; invalidates old commands (M1-D2). */
  let connectionGeneration = 0
  /** Last terminal receipt, so `game_status` can answer without an active command. */
  let lastReceipt: GameCommandReceipt | undefined
  /** CD-0 §3.3: capabilities discovered from the bridge at connect. */
  let capabilities: GameCapabilities | undefined

  function allowedToolsOf(): string[] {
    return config?.allowedTools?.length ? config.allowedTools : DEFAULT_ALLOWED_TOOLS
  }

  /**
   * Exact server-side tool names. The server MCP tool names differ from the
   * client group (`list_players` vs `players_list`), so this is a set of names,
   * not prefixes. Tools outside the set prefer the client bridge.
   */
  const SERVER_FIRST_TOOLS = new Set([
    'apply_effect',
    'fill_blocks',
    'find_blocks',
    'get_block',
    'get_blocks_region',
    'get_entity',
    'get_player',
    'get_time_and_weather',
    'give_item',
    'kick_player',
    'list_dimensions',
    'list_players',
    'message_player',
    'mine_break_evidence',
    'poll_server_events',
    'query_entities',
    'raycast',
    'remove_entity',
    'run_command',
    'set_block',
    'set_gamemode',
    'set_time',
    'set_weather',
    'summon_entity',
    'teleport_player',
  ])

  function serverFirstTool(name: string): boolean {
    return SERVER_FIRST_TOOLS.has(name)
  }

  async function callGameTool(name: string, args: Record<string, unknown> = {}): Promise<GameHostToolResult> {
    const active = serverFirstTool(name) && serverClient ? serverClient : client
    if (!active)
      throw new Error('Game host is not connected')
    return await active.callTool({ name, arguments: args }) as GameHostToolResult
  }

  function snapshotFrom(state: Record<string, unknown>, inventory?: Record<string, unknown>): GameFinalSnapshot {
    const selectedSlot = Number(inventory?.selectedSlot ?? state.selectedSlot ?? 0)
    const hotbar = Array.isArray(inventory?.hotbar) ? inventory.hotbar as Array<Record<string, unknown>> : []
    const held = hotbar.find(item => Number(item.slot) === selectedSlot)
    return {
      position: { x: Number(state.x) || 0, y: Number(state.y) || 0, z: Number(state.z) || 0 },
      health: Number(state.health) || 0,
      food: Number(state.food) || 0,
      heldItem: typeof held?.id === 'string' ? held.id : null,
    }
  }

  async function readFreshSnapshot(timeoutMs?: number): Promise<GameFinalSnapshot | undefined> {
    const read = (async (): Promise<GameFinalSnapshot | undefined> => {
      try {
        const self = statusRecordOf(await callGameTool('get_self'))
        if (!self)
          return undefined
        await noteLiveDimension(self)
        let inventory: Record<string, unknown> | undefined
        try {
          inventory = statusRecordOf(await callGameTool('get_inventory'))
        }
        catch {
          // The player state alone still gives a usable snapshot.
        }
        return snapshotFrom(self, inventory)
      }
      catch {
        return undefined
      }
    })()
    if (timeoutMs === undefined)
      return await read
    return await settleWithin(read, timeoutMs)
  }

  /** Zero snapshot used when an executor fails before any read succeeded. */
  const ZERO_SNAPSHOT: GameFinalSnapshot = Object.freeze({
    position: Object.freeze({ x: 0, y: 0, z: 0 }),
    health: 0,
    food: 0,
    heldItem: null,
  })

  // Stop scope of the running write command (collect/follow/...): the registry
  // calls `stop` while the command runs, and the loops must notice it. A read
  // command must not clear a running write's stop flag (review R7). CD-0 D8:
  // the scope carries the control-session identity, so a late callback from an
  // older command cannot stop the session a newer command now owns.
  let writeStopScope: StopScope = { stopped: false }
  // The executor promise in flight, tagged with its fixed token. `stopGameAction`
  // joins it so a cancel receipt keeps the facts the executor already observed
  // (MC-4d shot list) instead of racing to a generic terminal receipt. The tag
  // keeps an old command's stop from joining a newer command's run (CD-0 D8).
  let inFlightExecution: Promise<void> | undefined
  let inFlightToken: GameExecutionToken | undefined
  // Monotonic cursor for reflex-event polling; never reset, so a preemption
  // that arrives during a later command is still observed.
  let lastEventId = 0

  /** Sums inventory item counts across hotbar/main/armor/offhand. */
  function inventoryItemCounts(record: Record<string, unknown>): Record<string, number> {
    const counts: Record<string, number> = {}
    const add = (item: unknown) => {
      if (!item || typeof item !== 'object')
        return
      const entry = item as { id?: unknown, count?: unknown }
      const id = typeof entry.id === 'string' ? entry.id : undefined
      const count = Number(entry.count ?? 0)
      if (!id || !Number.isFinite(count) || count <= 0)
        return
      counts[id] = (counts[id] ?? 0) + count
    }
    for (const key of ['hotbar', 'main', 'armor']) {
      const list = record[key]
      if (Array.isArray(list))
        list.forEach(add)
    }
    add(record.offhand)
    return counts
  }

  async function readInventoryCounts(): Promise<Record<string, number> | undefined> {
    try {
      const record = statusRecordOf(await callGameTool('get_inventory'))
      return record ? inventoryItemCounts(record) : undefined
    }
    catch {
      return undefined
    }
  }

  /** Changed items only, sorted by id; negative means consumed. */
  function inventoryDeltaOf(before: Record<string, number>, after: Record<string, number>): Record<string, number> {
    const delta: Record<string, number> = {}
    for (const id of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
      const difference = (after[id] ?? 0) - (before[id] ?? 0)
      if (difference !== 0)
        delta[id] = difference
    }
    return delta
  }

  /** Hotbar/main stacks for actions that select or swap before acting. */
  async function readInventorySlots(): Promise<{
    hotbar: Array<{ slot: number, id: string, count: number, food?: boolean }>
    main: Array<{ containerSlot: number, id: string, count: number, food?: boolean }>
  } | undefined> {
    try {
      const record = statusRecordOf(await callGameTool('get_inventory'))
      if (!record)
        return undefined
      const readEntries = (list: unknown, toSlot: (slot: number) => number) => Array.isArray(list)
        ? list.flatMap((entry) => {
            const item = entry as { slot?: unknown, id?: unknown, count?: unknown, food?: unknown }
            return typeof item.id === 'string' && Number.isFinite(Number(item.slot))
              ? [{ slot: toSlot(Number(item.slot)), id: item.id, count: Number(item.count) || 1, ...(item.food === true ? { food: true } : {}) }]
              : []
          })
        : []
      const hotbar = readEntries(record.hotbar, slot => slot)
      // Container slots: 0-8 hotbar, 9-35 main. A main entry that already
      // reports a container index (< 9 means an index inside the main list)
      // keeps its value; the defensive shift only covers index-style slots.
      const main = readEntries(record.main, slot => slot < 9 ? slot + 9 : slot)
        .map(entry => ({ containerSlot: entry.slot, id: entry.id, count: entry.count, ...(entry.food === true ? { food: true } : {}) }))
      return { hotbar, main }
    }
    catch {
      return undefined
    }
  }

  /**
   * MC-4b: cap on one menu snapshot's slot list.
   *
   * A large chest menu plus the player inventory can reach ~90 slots; a much
   * longer list means a modded or malformed read, so the tail is dropped and
   * the snapshot is marked `truncated` instead of forwarded unbounded.
   */
  const MENU_SLOTS_CAP = 100

  function parseMenuSlot(raw: Record<string, unknown>, index: number): GameMenuSlotReceipt {
    const id = typeof raw.id === 'string' && raw.id ? raw.id : undefined
    const count = Number(raw.count)
    const invSlot = Number(raw.invSlot)
    const entry: GameMenuSlotReceipt = {
      index,
      container: typeof raw.container === 'string' ? raw.container : '',
      ...(Number.isFinite(invSlot) ? { invSlot } : {}),
      ...(id ? { id } : {}),
      ...(Number.isFinite(count) ? { count } : {}),
      ...(raw.empty === true || !id ? { empty: true } : {}),
      ...(raw.enchantments && typeof raw.enchantments === 'object' && !Array.isArray(raw.enchantments)
        ? { enchantments: raw.enchantments as Record<string, number> }
        : {}),
    }
    return entry
  }

  /**
   * True when a container or workstation menu is open.
   *
   * The vanilla client silently drops world interactions while a screen is
   * open (live MC-4f: `game_place` reported `not_confirmed` with the anvil
   * menu open and succeeded as soon as it closed). Unreadable snapshots count
   * as "no menu" so a bridge without menu support does not block placement.
   */
  async function hasOpenMenu(): Promise<boolean> {
    const result = await callGameTool('menu_snapshot', {})
    if (gameToolResultError(result))
      return false
    const record = statusRecordOf(result)
    if (!record || record.error === 'no_menu')
      return false
    return Number.isFinite(Number(record.containerId))
  }

  /** Stable text of a menu snapshot used to detect any visible change. */
  function menuSnapshotKey(snapshot: GameMenuSnapshotReceipt): string {
    return `${JSON.stringify(snapshot.slots)}${JSON.stringify(snapshot.carried ?? null)}`
  }

  /**
   * Polls the open menu until it differs from the given key, bounded.
   *
   * Used after a generic button click, where the server settles the click on
   * its own menu and the only evidence is a later sync. A closed or replaced
   * menu ends the wait as "no change".
   */
  async function waitForMenuChange(beforeKey: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      await sleep(200)
      try {
        if (menuSnapshotKey(await readMenuSnapshot()) !== beforeKey)
          return true
      }
      catch {
        return false
      }
    }
    return false
  }

  /**
   * Polls the fresh status-effect read until the named effect appears, bounded.
   *
   * The beacon primitive sends a packet and the server applies the effect on its
   * own schedule, so the only honest evidence is a later fresh `get_status_effects`
   * read. A read failure ends the wait as "not observed" instead of claiming the
   * effect was applied.
   */
  async function waitForStatusEffect(effectId: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      try {
        const record = statusRecordOf(await callGameTool('get_status_effects'))
        const effects = record && Array.isArray(record.effects) ? record.effects as Array<Record<string, unknown>> : []
        if (effects.some(effect => String(effect.id ?? '') === effectId))
          return true
      }
      catch {
        return false
      }
      await sleep(200)
    }
    return false
  }

  /**
   * Reads the currently open menu through `menu_snapshot`.
   *
   * The registry scopes this read to one command, so it is always a fresh
   * server-synced view. Throws `no_menu` when the bridge reports none.
   */
  async function readMenuSnapshot(): Promise<GameMenuSnapshotReceipt> {
    const result = await callGameTool('menu_snapshot', {})
    const error = gameToolResultError(result)
    if (error)
      throw new Error(error)
    const record = statusRecordOf(result)
    if (!record)
      throw new Error('no_menu: menu snapshot returned no data')
    if (record.error === 'no_menu')
      throw new Error('no_menu')
    const containerId = Number(record.containerId)
    if (!Number.isFinite(containerId))
      throw new Error('no_menu: menu snapshot had no container id')
    const rawSlots = Array.isArray(record.slots) ? record.slots as Array<Record<string, unknown>> : []
    const truncated = rawSlots.length > MENU_SLOTS_CAP
    const snapshot: GameMenuSnapshotReceipt = {
      containerId,
      type: typeof record.type === 'string' ? record.type : '',
      slots: rawSlots.slice(0, MENU_SLOTS_CAP).map((raw, index) => parseMenuSlot(raw, Number(raw.index ?? index))),
      ...(truncated ? { truncated: true } : {}),
    }
    if (record.carried && typeof record.carried === 'object' && !Array.isArray(record.carried))
      snapshot.carried = parseMenuSlot(record.carried as Record<string, unknown>, -1)
    const furnaceRaw = record.furnace
    if (furnaceRaw && typeof furnaceRaw === 'object' && !Array.isArray(furnaceRaw)) {
      const furnace = furnaceRaw as Record<string, unknown>
      snapshot.furnace = {
        lit: furnace.lit === true,
        litProgress: Number(furnace.litProgress) || 0,
        cookProgress: Number(furnace.cookProgress) || 0,
      }
    }
    return snapshot
  }

  /** One menu click; surfaces the typed `menu_mismatch` rejection as a throw. */
  async function menuClick(containerId: number, slot: number, quickMove = false): Promise<{ slot?: GameMenuSlotReceipt, carried?: GameMenuSlotReceipt }> {
    const result = await callGameTool('menu_click', { containerId, slot, ...(quickMove ? { quickMove: true } : {}) })
    const error = gameToolResultError(result)
    if (error)
      throw new Error(error)
    const record = statusRecordOf(result)
    if (!record)
      throw new Error('menu_click returned no data')
    if (record.error === 'menu_mismatch')
      throw new Error('menu_mismatch')
    if (record.accepted === false)
      throw new Error(typeof record.error === 'string' ? record.error : 'menu_click_failed')
    const outcome: { slot?: GameMenuSlotReceipt, carried?: GameMenuSlotReceipt } = {}
    if (record.slot && typeof record.slot === 'object' && !Array.isArray(record.slot))
      outcome.slot = parseMenuSlot(record.slot as Record<string, unknown>, slot)
    if (record.carried && typeof record.carried === 'object' && !Array.isArray(record.carried))
      outcome.carried = parseMenuSlot(record.carried as Record<string, unknown>, -1)
    return outcome
  }

  /** Right-clicks a block and waits (outside the render thread) for its menu. */
  async function openMenuAt(x: number, y: number, z: number, face?: string): Promise<GameMenuReceipt> {
    const result = await callGameTool('menu_open', { x, y, z, ...(face ? { face } : {}) })
    const error = gameToolResultError(result)
    if (error)
      throw new Error(error)
    const record = statusRecordOf(result)
    if (!record)
      throw new Error('no_menu')
    if (record.error === 'no_menu' || record.opened === false)
      throw new Error('no_menu')
    const containerId = Number(record.containerId)
    if (!Number.isFinite(containerId))
      throw new Error('no_menu: menu open returned no container id')
    return {
      containerId,
      type: typeof record.type === 'string' ? record.type : '',
      slots: Number(record.slots) || 0,
      openedAt: Date.now(),
    }
  }

  /**
   * Moves whole stacks between two slots of one menu with the two-click pickup
   * protocol and reports the measured source decrease.
   *
   * `move_item` and the smelt loaders deliberately transfer whole stacks: the
   * mod primitive is a single left click, so partial-stack precision would need
   * right-click intents the MC-4b contract does not expose. `requested` is the
   * minimum target; `moved` is the verified delta.
   */
  async function transferMenuStack(containerId: number, from: number, to: number, requested: number, shouldStop: () => boolean): Promise<number> {
    let moved = 0
    for (let attempt = 0; attempt < 12 && moved < requested; attempt++) {
      if (shouldStop())
        break
      const before = await readMenuSnapshot()
      if (before.containerId !== containerId)
        throw new Error('menu_mismatch')
      const source = before.slots.find(slot => slot.index === from)
      if (!source || source.empty || !source.id)
        break
      const sourceCount = source.count ?? 1
      await menuClick(containerId, from)
      const placed = await menuClick(containerId, to)
      if (placed.carried && (placed.carried.count ?? 0) > 0) {
        // The destination refused the stack; return it so the cursor is clear.
        await menuClick(containerId, from)
        throw new Error('destination_full')
      }
      const after = await readMenuSnapshot()
      const afterSource = after.slots.find(slot => slot.index === from)
      const afterCount = afterSource && !afterSource.empty ? (afterSource.count ?? 0) : 0
      const delta = Math.max(0, sourceCount - afterCount)
      moved += delta
      if (delta === 0)
        break
    }
    return moved
  }

  /** Container slot for every non-hand equipment target (armor 36-39, offhand 40). */
  const EQUIP_TARGET_CONTAINER: Record<Exclude<EquipTarget, 'main_hand'>, number> = {
    off_hand: 40,
    head: 36,
    chest: 37,
    legs: 38,
    feet: 39,
  }

  /**
   * Finds one inventory stack and returns its address in the `swap_slots`
   * space: hotbar entries keep their 0-8 index, main entries their 9-35 one.
   */
  function findEquipSource(
    slots: { hotbar: Array<{ slot: number, id: string, count: number }>, main: Array<{ containerSlot: number, id: string, count: number }> },
    itemId: string,
  ): { invIndex: number, hotbar: boolean } | undefined {
    const hotbar = slots.hotbar.find(entry => entry.id === itemId && entry.count > 0)
    if (hotbar)
      return { invIndex: hotbar.slot, hotbar: true }
    const main = slots.main.find(entry => entry.id === itemId && entry.count > 0)
    if (main)
      return { invIndex: main.containerSlot, hotbar: false }
    return undefined
  }

  /** Bridge field name for each equipment target in the `get_equipment` read. */
  const EQUIP_TARGET_FIELD: Record<EquipTarget, string> = {
    main_hand: 'mainHand',
    off_hand: 'offHand',
    head: 'helmet',
    chest: 'chest',
    legs: 'legs',
    feet: 'boots',
  }

  /** Reads the item id the bridge reports for one equipment slot, or null. */
  function equipmentItemIdOf(record: Record<string, unknown>, target: EquipTarget): string | null {
    const entry = record[EQUIP_TARGET_FIELD[target]]
    if (!entry || typeof entry !== 'object' || Array.isArray(entry))
      return null
    const item = entry as { id?: unknown, empty?: unknown }
    if (item.empty === true)
      return null
    return typeof item.id === 'string' ? item.id : null
  }

  async function readEquipment(): Promise<Record<string, unknown> | undefined> {
    try {
      return statusRecordOf(await callGameTool('get_equipment'))
    }
    catch {
      return undefined
    }
  }

  /** Reads one world block id through `get_block`; undefined when the read fails. */
  async function readBlockIdAt(position: { x: number, y: number, z: number }): Promise<string | undefined> {
    try {
      const record = statusRecordOf(await callGameTool('get_block', { x: position.x, y: position.y, z: position.z }))
      return typeof record?.id === 'string' ? record.id : undefined
    }
    catch {
      return undefined
    }
  }

  /**
   * Makes the requested item the held item.
   *
   * Uses the same hotbar-then-main path as drop/supply; a main stack moves into
   * an empty hotbar slot and no other item is displaced. Throws the typed
   * `not_in_inventory` failure when the item is unreachable.
   */
  async function ensureItemSelected(itemId: string): Promise<void> {
    const slots = await readInventorySlots()
    if (!slots)
      throw new Error('mcp_unavailable: inventory slots unavailable')
    const hotbar = slots.hotbar.find(entry => entry.id === itemId && entry.count > 0)
    if (hotbar) {
      const select = await callGameTool('select_hotbar_slot', { slot: hotbar.slot })
      const selectError = gameToolResultError(select)
      if (selectError)
        throw new Error(selectError)
      return
    }
    const main = slots.main.find(entry => entry.id === itemId && entry.count > 0)
    if (!main)
      throw new Error(`not_in_inventory: ${itemId} is in neither the hotbar nor the main inventory`)
    const emptyHotbar = [0, 1, 2, 3, 4, 5, 6, 7, 8].find(index => !slots.hotbar.some(entry => entry.slot === index))
    if (emptyHotbar === undefined)
      throw new Error(`not_in_inventory: no empty hotbar slot to move ${itemId} into`)
    const swap = await callGameTool('swap_slots', { slotA: main.containerSlot, slotB: emptyHotbar })
    const swapError = gameToolResultError(swap)
    if (swapError)
      throw new Error(swapError)
    const select = await callGameTool('select_hotbar_slot', { slot: emptyHotbar })
    const selectError = gameToolResultError(select)
    if (selectError)
      throw new Error(selectError)
  }

  /**
   * Selects an empty hotbar slot so the main hand is empty for `weapon: 'hand'`.
   *
   * A full hotbar is left as-is: the swing still uses `attack_entity`, and the
   * receipt labels the weapon `hand` only because no item was selected.
   */
  async function ensureHandSelected(): Promise<void> {
    const slots = await readInventorySlots()
    if (!slots)
      return
    const emptyHotbar = [0, 1, 2, 3, 4, 5, 6, 7, 8].find(index => !slots.hotbar.some(entry => entry.slot === index))
    if (emptyHotbar === undefined)
      return
    const select = await callGameTool('select_hotbar_slot', { slot: emptyHotbar })
    const selectError = gameToolResultError(select)
    if (selectError)
      throw new Error(selectError)
  }

  /**
   * Parses one `get_inventory` item record into the mining slot shape.
   *
   * The mining module needs damage/maxDamage to estimate durability; the
   * movement port's slot shape does not carry them.
   */
  function miningSlotOf(entry: Record<string, unknown>, hotbar: boolean, fallbackSlot: number): MiningSlot | undefined {
    const itemId = typeof entry.id === 'string' ? entry.id : undefined
    if (!itemId)
      return undefined
    const damage = Number(entry.damage)
    const maxDamage = Number(entry.maxDamage)
    return {
      slot: Number.isFinite(Number(entry.slot)) ? Number(entry.slot) : fallbackSlot,
      hotbar,
      itemId,
      count: Number(entry.count) || 1,
      ...(Number.isFinite(damage) ? { damage } : {}),
      ...(Number.isFinite(maxDamage) ? { maxDamage } : {}),
    }
  }

  /**
   * Builds one mining session for a command.
   *
   * `shouldStop` is the command's fixed stop scope (CD-0 D8), so a cancelled
   * command's session cannot be resumed by a later one.
   */
  function createMiningSession(shouldStop: () => boolean): MiningSession {
    const port: MiningPort = {
      evaluate: async (pos) => {
        try {
          const record = statusRecordOf(await callGameTool('mine_evaluate_harvest', {
            x: pos.x,
            y: pos.y,
            z: pos.z,
            ...(worldIdentity?.dimension ? { dimension: worldIdentity.dimension } : {}),
          }))
          return record ? parseHarvestEvaluation(record) : undefined
        }
        catch {
          return undefined
        }
      },
      equip: async (itemId) => {
        try {
          await ensureItemSelected(itemId)
        }
        catch {
          return undefined
        }
        const equipment = await readEquipment()
        const entry = equipment?.mainHand
        if (!entry || typeof entry !== 'object' || Array.isArray(entry))
          return undefined
        const item = entry as { id?: unknown, empty?: unknown }
        if (item.empty === true)
          return undefined
        return typeof item.id === 'string' ? item.id : undefined
      },
      hand: async () => {
        await ensureHandSelected()
      },
      aim: async (pos) => {
        // Fixed aim ages out; the caller re-aims during the break poll. A bridge
        // without look_at degrades to the mod's own face computation.
        try {
          await callGameTool('look_at', { x: pos.x + 0.5, y: pos.y + 0.5, z: pos.z + 0.5 })
        }
        catch {
          // Best-effort aim.
        }
      },
      startBreak: async (pos, mode) => {
        const result = await callGameTool('break_block', { x: pos.x, y: pos.y, z: pos.z, mode })
        const error = gameToolResultError(result)
        if (error)
          throw new Error(error)
      },
      readBlock: pos => readBlockIdAt(pos),
      countItem: async itemId => (await readInventoryCounts())?.[itemId],
      readSlots: async () => {
        try {
          const record = statusRecordOf(await callGameTool('get_inventory'))
          if (!record)
            return undefined
          const hotbar = Array.isArray(record.hotbar) ? record.hotbar as Array<Record<string, unknown>> : []
          const main = Array.isArray(record.main) ? record.main as Array<Record<string, unknown>> : []
          const slots: MiningSlot[] = []
          hotbar.forEach((entry, index) => {
            const slot = miningSlotOf(entry, true, index)
            if (slot)
              slots.push(slot)
          })
          main.forEach((entry, index) => {
            const slot = miningSlotOf(entry, false, index + 9)
            if (slot)
              slots.push(slot)
          })
          return slots
        }
        catch {
          return undefined
        }
      },
      readDropEvidence: async (fact: BreakFact) => {
        try {
          // The server-game-tick and the client Date clocks are different
          // domains (CD-0 §3.2): match by player, position and dimension only,
          // and take the most recent record the server still holds.
          const record = statusRecordOf(await callGameTool('mine_break_evidence', {
            x: fact.x,
            y: fact.y,
            z: fact.z,
            ...(fact.dimension ? { dimension: fact.dimension } : {}),
            ...(fact.playerUuid ? { playerUuid: fact.playerUuid } : {}),
          }))
          const records = record && Array.isArray(record.records) ? record.records as Array<Record<string, unknown>> : []
          const newest = records[0]
          const drops = newest && Array.isArray(newest.drops) ? newest.drops as Array<Record<string, unknown>> : undefined
          if (!drops)
            return undefined
          return drops.flatMap((entry): GeneratedDrop[] => {
            const itemId = typeof entry.itemId === 'string' ? entry.itemId : undefined
            const count = Number(entry.count)
            if (!itemId || !Number.isFinite(count) || count <= 0)
              return []
            const entityUuids = Array.isArray(entry.entityUuids)
              ? entry.entityUuids.filter((value): value is string => typeof value === 'string')
              : undefined
            return [{ itemId, count, ...(entityUuids && entityUuids.length > 0 ? { entityUuids } : {}) }]
          })
        }
        catch {
          return undefined
        }
      },
      playerPosition: async () => {
        try {
          const self = statusRecordOf(await callGameTool('get_self'))
          if (!self)
            return undefined
          const x = Number(self.x)
          const y = Number(self.y)
          const z = Number(self.z)
          return [x, y, z].every(Number.isFinite) ? { x, y, z } : undefined
        }
        catch {
          return undefined
        }
      },
      now: () => Date.now(),
      sleep,
      shouldStop,
    }
    return new MiningSession(port)
  }

  /** Maps the mod's raw offer record onto the receipt shape; undefined when unreadable. */
  function parseTradeOffer(raw: unknown): GameMenuActionReceipt['offer'] | undefined {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      return undefined
    const record = raw as Record<string, unknown>
    const offer: NonNullable<GameMenuActionReceipt['offer']> = {}
    const result = record.result
    if (result && typeof result === 'object' && !Array.isArray(result)) {
      const item = result as Record<string, unknown>
      if (typeof item.id === 'string')
        offer.result = { id: item.id, ...(Number.isFinite(Number(item.count)) ? { count: Number(item.count) } : {}) }
    }
    if (Array.isArray(record.inputs)) {
      const inputs = record.inputs.flatMap((entry) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry))
          return []
        const item = entry as Record<string, unknown>
        return typeof item.id === 'string'
          ? [{ id: item.id, ...(Number.isFinite(Number(item.count)) ? { count: Number(item.count) } : {}) }]
          : []
      })
      if (inputs.length > 0)
        offer.inputs = inputs
    }
    if (typeof record.outOfStock === 'boolean')
      offer.outOfStock = record.outOfStock
    return offer
  }

  /**
   * Vanilla per-list capacities. A longer list means a modded or malformed
   * read, so the tail is dropped and the observation is marked `truncated`.
   */
  const OBSERVED_INVENTORY_CAPS: Record<string, number> = { hotbar: 9, main: 27, armor: 4 }

  function capObservedInventory(record: Record<string, unknown>): { inventory: Record<string, unknown>, truncated: boolean } {
    const inventory: Record<string, unknown> = { ...record }
    let truncated = false
    for (const [key, cap] of Object.entries(OBSERVED_INVENTORY_CAPS)) {
      const list = inventory[key]
      if (Array.isArray(list) && list.length > cap) {
        inventory[key] = list.slice(0, cap)
        truncated = true
      }
    }
    return { inventory, truncated }
  }

  function blockMatchesOf(record: Record<string, unknown> | undefined): Array<{ x: number, y: number, z: number, id?: string }> {
    const list = record?.matches
    if (!Array.isArray(list))
      return []
    return list
      .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
      .map(item => ({
        x: Number(item.x) || 0,
        y: Number(item.y) || 0,
        z: Number(item.z) || 0,
        // The id from the search is the pre-break state; the manual break path
        // needs it without an extra `get_block` read that could race the dig.
        ...(typeof item.id === 'string' ? { id: item.id } : {}),
      }))
  }

  /** Reads one entity's position from a query result entry, or undefined when unnamed. */
  function entityPositionOf(entity: Record<string, unknown>): { x: number, y: number, z: number } | undefined {
    const nested = entity.position && typeof entity.position === 'object' ? entity.position as Record<string, unknown> : entity
    const x = Number(nested.x)
    const y = Number(nested.y)
    const z = Number(nested.z)
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z))
      return undefined
    return { x, y, z }
  }

  /** One resolved follow/shoot/attack target; identity is fixed by uuid. */
  type FollowTargetResolution
    = | {
      status: 'resolved'
      uuid: string
      x: number
      y: number
      z: number
      entityType?: string
      isPlayer?: boolean
      dimension: string
      /** True when the entity list hit its cap, so another entity was not read. */
      truncated: boolean
      source: TargetObservationSource
    }
    | {
      status: 'not-found'
      /** True when the list dropped a tail; the target may be outside the read. */
      truncated: boolean
    }

  /**
   * Resolves a follow target once. Accepts an exact uuid, an exact entity name
   * or an entity type id.
   *
   * The entity query is centered on the player and passes the binding
   * dimension explicitly (D12). A truncated list is reported and falls back to
   * the server player list, so truncation is not reported as `target_lost`
   * (CD-L1). A resolved target keeps its uuid for the rest of the command.
   */
  async function resolveFollowTarget(target: string): Promise<FollowTargetResolution> {
    // The query must be centered on the player: the server-side default is the
    // world spawn, so an omitted center misses targets only tens of blocks away.
    const self = await readFreshSnapshot()
    const center = self?.position ?? ZERO_SNAPSHOT.position
    const dimension = worldIdentity?.dimension ?? ''
    const result = await callGameTool('query_entities', {
      center,
      radius: TARGET_QUERY_RADIUS,
      includePlayers: true,
      maxResults: TARGET_QUERY_MAX_RESULTS,
      ...(dimension ? { dimension } : {}),
    })
    const { list, total, returned } = entityListOf(statusRecordOf(result))
    const truncated = total !== undefined ? total > returned : returned >= TARGET_QUERY_MAX_RESULTS
    const selection = selectTargetFromList(list, target, { ...(total !== undefined ? { total } : {}), maxResults: TARGET_QUERY_MAX_RESULTS })
    if (selection.match?.position) {
      return {
        status: 'resolved',
        uuid: selection.match.uuid,
        x: selection.match.position.x,
        y: selection.match.position.y,
        z: selection.match.position.z,
        ...(selection.match.entityType ? { entityType: selection.match.entityType } : {}),
        ...(selection.match.isPlayer !== undefined ? { isPlayer: selection.match.isPlayer } : {}),
        dimension,
        truncated: selection.truncated,
        source: 'server-entity',
      }
    }
    // A truncated entity list may hide the target: fall back to the server
    // player list by name or uuid so truncation is not read as a lost target.
    if (truncated) {
      const player = await locatePlayerFromList(target)
      if (player)
        return { ...player, status: 'resolved', truncated: true, source: 'server-player-locate' }
    }
    return { status: 'not-found', truncated }
  }

  /** Reads one server player by name or uuid from the player list. */
  async function locatePlayerFromList(target: string): Promise<{ uuid: string, x: number, y: number, z: number, entityType: string, isPlayer: true, dimension: string } | undefined> {
    const result = await callGameTool('list_players', {})
    const record = statusRecordOf(result)
    const players = Array.isArray(record?.players) ? record.players as Array<Record<string, unknown>> : []
    const match = players.find(player => player.uuid === target || (typeof player.name === 'string' && player.name === target))
    if (!match || typeof match.uuid !== 'string')
      return undefined
    const position = positionOf(match)
    if (!position)
      return undefined
    return {
      uuid: match.uuid,
      x: position.x,
      y: position.y,
      z: position.z,
      entityType: 'minecraft:player',
      isPlayer: true,
      dimension: typeof match.dimension === 'string' ? match.dimension : '',
    }
  }

  /**
   * Reads one target observation by uuid from the server entity query (CD-L1).
   *
   * Always returns an observation, even when the target is not in the read:
   * the visibility carries `out-of-range` or `list-truncated` and the position
   * stays absent. A mismatched dimension is rejected by the builder (D12).
   */
  async function readTargetObservationByUuid(uuid: string, source: TargetObservationSource = 'server-entity'): Promise<TargetObservation> {
    const dimension = worldIdentity?.dimension ?? ''
    const worldId = worldIdentity?.worldId ?? 'connection-scoped'
    const startedAt = Date.now()
    const request = {
      targetUuid: uuid,
      dimension,
      worldId,
      connectionGeneration,
      source,
      radius: TARGET_QUERY_RADIUS,
      maxResults: TARGET_QUERY_MAX_RESULTS,
      startedAt,
    }

    // CD-L3: prefer the loaded-entity detail read when the bridge exposes it.
    // It carries pose fields (fallFlying, riding, bounds) and a source tick.
    // It lives on the server endpoint, so a host without that endpoint falls
    // back to the list read below.
    const preferDetail = serverClient !== undefined && capabilities?.['target-observation']?.tools.includes('get_entity') === true
    if (preferDetail) {
      try {
        const detail = statusRecordOf(await callGameTool('get_entity', { uuid }))
        if (detail && detail.uuid === uuid) {
          const receivedAt = Date.now()
          const receivedDimension = typeof detail.dimension === 'string' ? detail.dimension : undefined
          const sourceTick = Number(detail.sourceTick)
          return buildTargetObservation(request, {
            uuid,
            ...(receivedDimension ? { dimension: receivedDimension } : {}),
            ...(Number.isFinite(sourceTick) ? { sourceTick } : {}),
            entity: detail,
            receivedAt,
            endedAt: receivedAt,
          })
        }
      }
      catch (error) {
        // A dimension mismatch is a real rejection (D12); any other failure of
        // the detail read is not a lost target, so the list read still runs.
        if (error instanceof DimensionMismatchError)
          throw error
      }
    }

    const self = await readFreshSnapshot()
    const center = self?.position ?? ZERO_SNAPSHOT.position
    const result = await callGameTool('query_entities', {
      center,
      radius: TARGET_QUERY_RADIUS,
      includePlayers: true,
      maxResults: TARGET_QUERY_MAX_RESULTS,
      ...(dimension ? { dimension } : {}),
    })
    const receivedAt = Date.now()
    const record = statusRecordOf(result)
    const { list, total, returned } = entityListOf(record)
    const receivedDimension = typeof record?.dimension === 'string' ? record.dimension : undefined
    const truncated = total !== undefined ? total > returned : returned >= TARGET_QUERY_MAX_RESULTS
    const match = list.find(entry => entry.uuid === uuid)
    return buildTargetObservation(
      { ...request, receiveTime: receivedAt },
      match
        ? { uuid, ...(receivedDimension ? { dimension: receivedDimension } : {}), entity: match, listTruncated: truncated, receivedAt, endedAt: receivedAt }
        : { uuid, ...(receivedDimension ? { dimension: receivedDimension } : {}), absence: 'out-of-range', listTruncated: truncated, receivedAt, endedAt: receivedAt },
    )
  }

  /** One coarse locate result for a target that fine tracking cannot see. */
  type CoarseReadResult
    = | { kind: 'sample', observation: TargetObservation }
      | { kind: 'offline' }
      | { kind: 'dimension-changed' }
      | { kind: 'unavailable' }
      | { kind: 'unloaded' }

  /**
   * Coarse locate for a target outside fine range (CD-L2).
   *
   * A player is read from the server player list (`list_players`), a non-player
   * from the server entity query. The two results carry distinct sources. A
   * read failure is `unavailable`, not an offline target.
   */
  async function readCoarseTargetObservation(uuid: string, isPlayer: boolean | undefined): Promise<CoarseReadResult> {
    if (!isPlayer) {
      try {
        const observation = await readTargetObservationByUuid(uuid, 'server-entity')
        return observation.position ? { kind: 'sample', observation } : { kind: 'unloaded' }
      }
      catch (error) {
        if (error instanceof DimensionMismatchError)
          return { kind: 'dimension-changed' }
        return { kind: 'unavailable' }
      }
    }
    let record: Record<string, unknown> | undefined
    try {
      record = statusRecordOf(await callGameTool('list_players', {}))
    }
    catch {
      return { kind: 'unavailable' }
    }
    const players = Array.isArray(record?.players) ? record.players as Array<Record<string, unknown>> : []
    const match = players.find(player => player.uuid === uuid)
    if (!match)
      return { kind: 'offline' }
    const position = positionOf(match)
    if (!position)
      return { kind: 'unloaded' }
    const receivedAt = Date.now()
    const dimension = typeof match.dimension === 'string' ? match.dimension : ''
    const bindingDimension = worldIdentity?.dimension ?? ''
    if (dimension && bindingDimension && dimension !== bindingDimension)
      return { kind: 'dimension-changed' }
    return {
      kind: 'sample',
      observation: buildTargetObservation(
        {
          targetUuid: uuid,
          dimension: bindingDimension || dimension,
          worldId: worldIdentity?.worldId ?? 'connection-scoped',
          connectionGeneration,
          source: 'server-player-locate',
          startedAt: receivedAt,
          receiveTime: receivedAt,
        },
        {
          uuid,
          ...(dimension ? { dimension } : {}),
          entity: { ...match, isPlayer: true, type: 'minecraft:player' },
          receivedAt,
          endedAt: receivedAt,
        },
      ),
    }
  }

  /**
   * MC-4g: re-reads one entity by uuid and returns its position and health.
   *
   * The query is centered on the player because the server-side default center
   * is the world spawn. `undefined` means the entity is no longer in range,
   * which the attack executor treats as a disappearance.
   */
  async function readEntityByUuid(uuid: string): Promise<{ x: number, y: number, z: number, health?: number } | undefined> {
    const self = await readFreshSnapshot()
    const center = self?.position ?? ZERO_SNAPSHOT.position
    const result = await callGameTool('query_entities', { center, radius: TARGET_QUERY_RADIUS, includePlayers: true, maxResults: TARGET_QUERY_MAX_RESULTS, ...(worldIdentity?.dimension ? { dimension: worldIdentity.dimension } : {}) })
    const record = statusRecordOf(result)
    const list = Array.isArray(record?.entities) ? record.entities as Array<Record<string, unknown>> : []
    const match = list.find(entity => entity.uuid === uuid)
    if (!match)
      return undefined
    const position = entityPositionOf(match)
    if (!position)
      return undefined
    const health = Number(match.health)
    return { ...position, ...(Number.isFinite(health) ? { health } : {}) }
  }

  /**
   * MC-4g: picks the melee item for the requested weapon class.
   *
   * `auto` walks the full preference list and returns undefined when no melee
   * item exists (the caller then swings with an empty hand). A concrete class
   * restricts the list, so an absent class is the caller's `weapon_unavailable`.
   */
  function chooseMeleeWeapon(weapon: AttackWeapon, slots: {
    hotbar: Array<{ slot: number, id: string, count: number }>
    main: Array<{ containerSlot: number, id: string, count: number }>
  }): string | undefined {
    if (weapon === 'hand')
      return undefined
    const owned = new Set<string>([
      ...slots.hotbar.filter(entry => entry.count > 0).map(entry => entry.id),
      ...slots.main.filter(entry => entry.count > 0).map(entry => entry.id),
    ])
    const matchesClass = (itemId: string) => weapon === 'auto'
      || (weapon === 'sword' && itemId.endsWith('_sword'))
      || (weapon === 'axe' && itemId.endsWith('_axe'))
      || (weapon === 'trident' && itemId === 'minecraft:trident')
    return MELEE_WEAPON_PREFERENCE.find(itemId => matchesClass(itemId) && owned.has(itemId))
  }

  /**
   * Picks a concrete ranged weapon for `weapon: 'auto'` from the inventory.
   *
   * Order is bow, then crossbow, then trident. Returns undefined when none is
   * present, which the executor reports as `weapon_unavailable`.
   */
  async function chooseAutoWeapon(): Promise<string | undefined> {
    const slots = await readInventorySlots()
    if (!slots)
      return undefined
    const has = (itemId: string) => slots.hotbar.some(entry => entry.id === itemId)
      || slots.main.some(entry => entry.id === itemId)
    if (has('minecraft:bow'))
      return 'bow'
    if (has('minecraft:crossbow'))
      return 'crossbow'
    if (has('minecraft:trident'))
      return 'trident'
    return undefined
  }

  /** True when the held trident carries the Riptide enchantment. */
  async function isRiptideTrident(): Promise<boolean> {
    const equipment = await readEquipment()
    if (!equipment)
      return false
    const mainHand = equipment.mainHand
    if (!mainHand || typeof mainHand !== 'object' || Array.isArray(mainHand))
      return false
    const enchantments = (mainHand as Record<string, unknown>).enchantments
    if (!enchantments || typeof enchantments !== 'object' || Array.isArray(enchantments))
      return false
    return 'minecraft:riptide' in (enchantments as Record<string, unknown>)
  }

  /** True when a reflex event reports this command as preempted (mc-0d). */
  async function reflexPreemptedFor(commandId: string): Promise<boolean> {
    try {
      const record = statusRecordOf(await callGameTool('poll_events', { limit: 50, sinceId: lastEventId }))
      const events = Array.isArray(record?.events) ? record.events as Array<Record<string, unknown>> : []
      for (const event of events) {
        const id = Number(event.id)
        if (Number.isFinite(id) && id > lastEventId)
          lastEventId = id
        const data = event.data && typeof event.data === 'object' ? event.data as Record<string, unknown> : event
        if (typeof data.preemptedCommandId === 'string' && data.preemptedCommandId === commandId)
          return true
      }
    }
    catch {
      // Best-effort: navigation status still reports preemption on its own.
    }
    return false
  }

  /**
   * MC-3 planner selection.
   *
   * As of increment 3 the break/place/use executor actions are implemented,
   * so the terrain planner is the default; the legacy flag stays available as
   * the explicit rollback.
   */
  function movementPlannerOf(): 'terrain' | 'legacy' {
    return config?.movement?.planner ?? 'terrain'
  }

  /** Counts placeable scaffolding blocks in the local player's inventory. */
  async function countScaffolding(): Promise<number> {
    try {
      const record = statusRecordOf(await callGameTool('get_inventory'))
      let count = 0
      for (const key of ['hotbar', 'main']) {
        const list = Array.isArray(record?.[key]) ? record[key] as Array<Record<string, unknown>> : []
        for (const item of list) {
          if (typeof item.id === 'string' && SCAFFOLDING_ITEMS.has(item.id))
            count += Number(item.count) || 0
        }
      }
      return count
    }
    catch {
      return 0
    }
  }

  /** Pickaxe material tier; a higher number can harvest strictly more blocks. */
  function pickaxeTierOf(itemId: string): number | undefined {
    const name = itemId.slice(itemId.indexOf(':') + 1)
    const material = /^(wooden|stone|iron|golden|diamond|netherite)_pickaxe$/.exec(name)?.[1]
    if (!material)
      return undefined
    return { wooden: 1, stone: 2, golden: 2, iron: 3, diamond: 4, netherite: 5 }[material]
  }

  /**
   * Best pickaxe tier reachable in the inventory, read once per route.
   *
   * This is a plan-time estimate only: the final break re-verifies through
   * `mine_evaluate_harvest` (CD-M1 §5).
   */
  async function bestPickaxeTier(): Promise<number> {
    const slots = await readInventorySlots()
    let best = 0
    for (const entry of [...(slots?.hotbar ?? []), ...(slots?.main ?? [])]) {
      const tier = pickaxeTierOf(entry.id)
      if (tier !== undefined)
        best = Math.max(best, tier)
    }
    return best
  }

  /**
   * Plan-time dig authorization and cost for a route (CD-M1).
   *
   * A block whose required pickaxe tier exceeds the inventory is not a break
   * edge, so a wall is never treated as cheap when it cannot be harvested. A
   * block with no tool is costed much higher so the route prefers another way.
   */
  function digOptionsOf(bestTier: number): Pick<MovementConfig, 'digGuard' | 'digCostOf'> {
    return {
      digGuard: (block) => {
        const required = requiredPickaxeFor(block.id)
        if (!required)
          return true
        return bestTier >= (pickaxeTierOf(required) ?? Number.POSITIVE_INFINITY)
      },
      digCostOf: (block, base) => requiredPickaxeFor(block.id) && bestTier === 0 ? base * 4 : base,
    }
  }

  /**
   * Movement port over the private MCP session (MC-3 increment 2).
   *
   * CD-0 §3.2: the port receives the live world binding so a read for another
   * dimension is rejected and every fact can carry its source and generation.
   */
  function createTerrainPort() {
    return createMcpMovementPort(
      async (name, args) => statusRecordOf(await callGameTool(name, args)),
      {
        worldId: () => worldIdentity?.worldId,
        dimension: () => worldIdentity?.dimension,
        connectionGeneration: () => connectionGeneration,
      },
    )
  }

  /**
   * One terrain-planned move_to; lease, cancel and receipts stay in the registry.
   *
   * This function is the `move_to` mover dispatch. It is not split into a
   * separate registry: `runVehicleMove` is already the vehicle switch
   * (`boat|horse|minecart|elytra|strider`), and the only other branch is foot
   * walking. Every mover takes the same `{x,y,z,tolerance}` target, so a second
   * registry keyed by mover would wrap the same switch without hiding a new
   * decision. `fallbackToFoot` is the one explicit policy this layer owns.
   * Riptide is a distinct movement action (`riptide`), not a mover here.
   */
  async function executeTerrainMoveTo(
    envelope: GameCommandEnvelope,
    moveTo: NonNullable<GameCommandParams['moveTo']>,
    fallback: GameFinalSnapshot,
    shouldStop: () => boolean,
  ): Promise<GameExecutorOutcome> {
    if (moveTo.vehicle) {
      const vehicleResult = await runVehicleMove(moveTo.vehicle, {
        port: createTerrainPort(),
        goal: { x: moveTo.x, y: moveTo.y, z: moveTo.z },
        tolerance: moveTo.tolerance,
        shouldStop,
        debug: env.AIRI_TERRAIN_DEBUG ? (message: string) => log.warn(`terrain: ${message}`) : undefined,
      })
      if (vehicleResult.status !== 'reached' && moveTo.fallbackToFoot) {
        // Fall through to the foot mover with the same target.
      }
      else {
        const fresh = await readFreshSnapshot() ?? fallback
        if (vehicleResult.status === 'reached')
          return { endReason: 'reached', finalSnapshot: fresh, finalPosition: fresh.position }
        const endReason = vehicleResult.status === 'unavailable'
          ? 'vehicle_unavailable'
          : vehicleResult.status === 'low_supply' ? 'elytra_low_supply' : vehicleResult.status
        return { endReason, finalSnapshot: fresh }
      }
    }

    const allowPlace = moveTo.allowPlace !== false
    // One failed-edge map per write command: the long-route legs share it, so
    // an edge that failed in one leg is not retried in the next (review R5).
    const failedEdges = new Map<string, FailedEdge>()
    // CD-M1: when the walk may dig, authorize each break edge and price the
    // tool cost from the best pickaxe the inventory currently holds.
    const digOptions = moveTo.allowBreak === true ? digOptionsOf(await bestPickaxeTier()) : {}
    const result = await runTerrainRoute({
      port: createTerrainPort(),
      // Planner nodes are integer cells; a fractional goal never matches them
      // (review R4). `runTerrainLeg` floors the same way.
      goal: cellOf({ x: moveTo.x, y: moveTo.y, z: moveTo.z }),
      tolerance: moveTo.tolerance,
      config: {
        ...DEFAULT_MOVEMENT_CONFIG,
        canDig: moveTo.allowBreak === true,
        maxDropDown: moveTo.maxFall ?? DEFAULT_MOVEMENT_CONFIG.maxDropDown,
        ...digOptions,
      },
      remainingPlaceables: allowPlace ? await countScaffolding() : 0,
      shouldStop,
      failedEdges,
      // Trace only when explicitly asked for; a normal move must stay quiet.
      debug: env.AIRI_TERRAIN_DEBUG ? (message: string) => log.warn(`terrain: ${message}`) : undefined,
    })
    // The envelope is part of the contract even when the terrain port drives
    // the walk; keep it referenced so a future reflex correlation can use it.
    void envelope
    const fresh = await readFreshSnapshot() ?? fallback
    if (result.status === 'reached')
      return { endReason: 'reached', finalSnapshot: fresh, finalPosition: fresh.position }
    return { endReason: result.status === 'no_path' ? 'unreachable' : result.status, finalSnapshot: fresh }
  }

  /**
   * One terrain-planned leg shared by follow and collect (MC-4c D5).
   *
   * Follow and collect never fall back to the mod-side `navigate_to`; the
   * `movement.planner === 'legacy'` escape applies to `move_to` only. The
   * caller owns `failedEdges` so every leg of one write command shares the
   * failed-edge memory.
   */
  async function runTerrainLeg(
    goal: { x: number, y: number, z: number },
    tolerance: number,
    shouldStop: () => boolean,
    goalCells?: Array<{ x: number, y: number, z: number }>,
    failedEdges?: Map<string, FailedEdge>,
  ) {
    return await runTerrainMove({
      port: createTerrainPort(),
      // Entity positions are fractional but planner nodes are integer cells:
      // an unfloored goal never matches and every leg ends `no_path` (live
      // MC-4c: follow never moved). Block goals are already integers.
      goal: { x: Math.floor(goal.x), y: Math.floor(goal.y), z: Math.floor(goal.z) },
      // Region goal: one search over every candidate stand, cheapest wins.
      ...(goalCells && goalCells.length > 0
        ? { goalCells: goalCells.map(cell => ({ x: Math.floor(cell.x), y: Math.floor(cell.y), z: Math.floor(cell.z) })) }
        : {}),
      tolerance,
      config: DEFAULT_MOVEMENT_CONFIG,
      remainingPlaceables: await countScaffolding(),
      shouldStop,
      ...(failedEdges ? { failedEdges } : {}),
      debug: env.AIRI_TERRAIN_DEBUG ? (message: string) => log.warn(`terrain: ${message}`) : undefined,
    })
  }

  /** Maps domain actions to MCP calls (mc-0c-spec 执行器映射；mc-1a 扩展). */
  async function executeGameAction(envelope: GameCommandEnvelope, params: GameCommandParams, token: GameExecutionToken): Promise<GameExecutorOutcome> {
    // CD-0 D8: capture this command's fixed scope and identity at the entry.
    // Later code must use the captured binding, never a re-read global token.
    const writeStop = nextStopScope(envelope.action, writeStopScope, token)
    writeStopScope = writeStop
    const shouldStop = () => writeStop.stopped

    if (envelope.action === 'say') {
      const text = params.say?.text?.trim()
      if (!text)
        throw new Error('say requires text')
      const result = await callGameTool('send_chat', { message: text })
      const error = gameToolResultError(result)
      if (error)
        throw new Error(error)
      return { endReason: 'said', finalSnapshot: await readFreshSnapshot() ?? ZERO_SNAPSHOT }
    }

    if (envelope.action === 'craft') {
      const recipeId = params.craft?.recipeId?.trim()
      if (!recipeId)
        throw new Error('craft requires recipeId')
      const before = await readInventoryCounts()
      if (!before)
        throw new Error('mcp_unavailable: inventory read failed before craft')

      // Two-beat contract: each call either starts a placement or claims a
      // filled result slot, so a bounded retry loop is the whole protocol.
      const deadline = Date.now() + envelope.deadlineMs
      const maxAttempts = 5
      let attempts = 0
      let claimedOutput: { id: string, count: number } | undefined
      // Starts as the success reason and is overwritten by the first failure;
      // an exhausted retry loop must not report "crafted" as the failure.
      let endReason = 'not_confirmed'
      for (attempts = 1; attempts <= maxAttempts; attempts++) {
        if (writeStop.stopped) {
          endReason = 'cancelled'
          break
        }
        if (Date.now() > deadline) {
          endReason = 'deadline'
          break
        }
        const record = statusRecordOf(await callGameTool('craft_by_recipe', { recipeId }))
        if (!record) {
          endReason = 'executor_error'
          break
        }
        if (typeof record.error === 'string') {
          endReason = record.error
          break
        }
        if (record.claimed === true && record.output && typeof record.output === 'object') {
          const output = record.output as { id?: unknown, count?: unknown }
          if (typeof output.id === 'string') {
            claimedOutput = { id: output.id, count: Math.max(1, Number(output.count) || 1) }
            break
          }
        }
        await sleep(400)
      }
      if (!claimedOutput)
        throw new Error(`craft failed: ${endReason}`)

      const after = await readInventoryCounts()
      if (!after)
        throw new Error('mcp_unavailable: inventory read failed after craft')
      const inventoryDelta = inventoryDeltaOf(before, after)
      return {
        endReason: 'crafted',
        finalSnapshot: await readFreshSnapshot() ?? ZERO_SNAPSHOT,
        craftedCount: Math.max(0, inventoryDelta[claimedOutput.id] ?? 0),
        craftedExpected: claimedOutput.count,
        crafted: { recipeId, output: claimedOutput, attempts, inventoryDelta },
      }
    }

    if (envelope.action === 'collect') {
      const collect = params.collect
      if (!collect?.blockId)
        throw new Error('collect requires blockId')
      const itemId = collect.itemId ?? collect.blockId
      const maxCount = Math.max(1, Math.min(collect.maxCount || 1, 16))
      const radius = Math.max(4, Math.min(collect.radius || 16, 48))
      const deadline = Date.now() + envelope.deadlineMs
      // MC-4c: attribution is per break. Only the target item's delta inside
      // the bounded window after one break counts, so inventory growth with no
      // break (another player's drops) never becomes this command's
      // `collected` (gaps §4.2).
      let collected = 0
      let endReason = 'collected'
      // Consecutive candidate rounds that could not break anything; one failed
      // round (for example while the previous mining task still runs) must not
      // end the whole command.
      let emptyRounds = 0
      // One failed-edge map for the whole collect: every candidate leg shares
      // it, so a blocked approach is not retried for the next candidate.
      const failedEdges = new Map<string, FailedEdge>()
      // CD-M1: one mining session per collect command owns tool evaluation,
      // selection and the break poll, shared with `game_break`.
      const miningSession = createMiningSession(shouldStop)
      // CD-M3: a missing tool is reported as structured prerequisites unless the
      // caller explicitly allows the bounded preparation flow.
      const allowPrerequisites = collect.allowPrerequisites === true
      let prerequisiteReport: GamePrerequisiteReport | undefined

      /**
       * Walks to the candidate, or to a neighbor, as a region goal: the target
       * block itself and its four horizontal neighbors plus the cells above
       * and below. One planner search returns the cheapest standable cell
       * instead of probing the fixed directions one by one (review R5). Used
       * for both the break approach and stepping onto the drop.
       */
      const walkNear = async (candidate: { x: number, y: number, z: number }, tolerance: number) => {
        if (writeStop.stopped)
          return { status: 'cancelled' as const }
        const goals = [
          candidate,
          { x: candidate.x + 1, y: candidate.y, z: candidate.z },
          { x: candidate.x - 1, y: candidate.y, z: candidate.z },
          { x: candidate.x, y: candidate.y, z: candidate.z + 1 },
          { x: candidate.x, y: candidate.y, z: candidate.z - 1 },
          { x: candidate.x, y: candidate.y + 1, z: candidate.z },
          { x: candidate.x, y: candidate.y - 1, z: candidate.z },
        ]
        return await runTerrainLeg(candidate, tolerance, shouldStop, goals, failedEdges)
      }

      const countOfItem = async (): Promise<number | undefined> => (await readInventoryCounts())?.[itemId]

      /**
       * Builds the structured tool prerequisite report (CD-M3).
       *
       * The plan is a candidate chain (wood -> stone -> iron pickaxe) whose
       * recipe and station are still verified on the server before any craft.
       */
      const prepareToolPrerequisites = async (blockId: string): Promise<GamePrerequisiteReport | undefined> => {
        const target = requiredPickaxeFor(blockId)
        if (!target)
          return undefined
        const inventory = await readInventoryCounts() ?? {}
        const plan = planToolUpgrade(inventory, target, {
          maxCrafts: 8,
          maxMissingPrerequisites: 3,
          allowedStations: ['inventory', 'crafting_table'],
        })
        return {
          target,
          craftable: plan.craftable,
          steps: plan.steps.map(step => ({
            kind: step.kind,
            itemId: step.itemId,
            station: step.station,
            outputCount: step.outputCount,
            ingredients: step.ingredients,
            ...(step.fuel ? { fuel: step.fuel } : {}),
          })),
          missing: plan.missing,
          reason: plan.reason,
        }
      }

      /**
       * Runs the inventory-grid steps of a tool plan through the two-beat
       * `craft_by_recipe` primitive.
       *
       * A crafting-table or furnace step is left for the caller: this command
       * has no station position, so the flow stays bounded and reports the
       * remaining steps instead of guessing a station.
       */
      const runInventoryUpgradeSteps = async (plan: GamePrerequisiteReport): Promise<{
        completed: string[]
        remaining: Array<{ itemId: string, station: string }>
      }> => {
        const completed: string[] = []
        const remaining: Array<{ itemId: string, station: string }> = []
        for (const step of plan.steps) {
          if (writeStop.stopped || step.station !== 'inventory') {
            remaining.push({ itemId: step.itemId, station: step.station })
            continue
          }
          let crafted = false
          for (let attempt = 0; attempt < 4 && !crafted; attempt++) {
            try {
              const result = await callGameTool('craft_by_recipe', { recipeId: step.itemId })
              if (gameToolResultError(result))
                break
              const record = statusRecordOf(result)
              if (record && typeof record.error === 'string')
                break
              if (record?.claimed === true)
                crafted = true
            }
            catch {
              break
            }
          }
          if (crafted)
            completed.push(step.itemId)
          else
            remaining.push({ itemId: step.itemId, station: step.station })
        }
        return { completed, remaining }
      }

      /**
       * Bounded pickup window for one break, delegated to the mining session.
       *
       * Only the increase measured inside the window is attributed to this
       * break, and the session ledger grades it: a delta without server drop
       * evidence is indirect, never a precise claim.
       */
      const waitForPickup = async (breakId: string, before: number): Promise<number> => {
        const window = Math.max(0, Math.min(deadline - Date.now(), 5_000))
        const picked = await miningSession.waitForPickup(breakId, itemId, before, window)
        if (picked === 0) {
          if (writeStop.stopped)
            endReason = 'cancelled'
          else if (await reflexPreemptedFor(envelope.commandId))
            endReason = 'reflex_preempted'
        }
        return picked
      }

      /** The last broken block whose drop could not be picked up. */
      let lastDropPosition: { x: number, y: number, z: number } | undefined
      // §9-6: one bounded recovery per command; a stuck drop must not turn the
      // collect loop into an endless dig.
      let stuckDropRecoveryAttempted = false

      /**
       * One bounded recovery when a broken block's drop cannot be walked to.
       *
       * A drop that fell into a pit the terrain planner cannot enter is either
       * blocked by a ceiling (dig the block above it) or sits below the
       * player's feet (cover its cell with one carried scaffolding block so
       * the drop rises to the surface). The caller retries the pickup once;
       * a failed attempt reports the drop position instead of digging forever.
       */
      const recoverStuckDrop = async (
        drop: { x: number, y: number, z: number },
        player: { x: number, y: number, z: number },
      ): Promise<boolean> => {
        const above = { x: drop.x, y: drop.y + 1, z: drop.z }
        const aboveId = await readBlockIdAt(above)
        if (aboveId !== undefined && aboveId !== '' && !aboveId.endsWith('air')) {
          try {
            await callGameTool('break_block', { x: above.x, y: above.y, z: above.z, mode: 'survival' })
          }
          catch {
            return false
          }
          const digUntil = Date.now() + STUCK_DROP_DIG_POLL_MS
          while (Date.now() < digUntil) {
            await sleep(300)
            if (writeStop.stopped)
              break
            const id = await readBlockIdAt(above)
            if (id !== undefined && id.endsWith('air'))
              break
          }
          return true
        }
        if (drop.y < player.y - 0.5) {
          const slots = await readInventorySlots()
          const support = slots
            ? [...slots.hotbar, ...slots.main].find(entry => entry.count > 0 && SCAFFOLDING_ITEMS.has(entry.id))
            : undefined
          if (!support)
            return false
          try {
            await ensureItemSelected(support.id)
            await callGameTool('place_block', {
              x: drop.x,
              y: drop.y - 1,
              z: drop.z,
              face: 'up',
              expectBlockId: support.id,
            })
          }
          catch {
            return false
          }
          return true
        }
        return false
      }

      // `collected` changes inside the candidate loop, so the guard is checked
      // explicitly instead of in the loop condition.
      for (;;) {
        if (collected >= maxCount) {
          endReason = 'collected'
          break
        }
        if (writeStop.stopped) {
          endReason = 'cancelled'
          break
        }
        if (Date.now() > deadline) {
          endReason = 'deadline'
          break
        }
        if (await reflexPreemptedFor(envelope.commandId)) {
          endReason = 'reflex_preempted'
          break
        }

        const center = (await readFreshSnapshot())?.position ?? ZERO_SNAPSHOT.position
        let candidates: Array<{ x: number, y: number, z: number, id?: string }> = []
        try {
          candidates = blockMatchesOf(statusRecordOf(await callGameTool('find_blocks', {
            center,
            radius,
            blockIds: [collect.blockId],
            maxResults: 8,
          })))
        }
        catch {
          endReason = 'executor_error'
          break
        }
        if (env.AIRI_TERRAIN_DEBUG)
          log.warn(`collect: ${candidates.length} candidates ${candidates.map(entry => `${entry.x},${entry.y},${entry.z}`).join(' ')}`)
        if (candidates.length === 0) {
          endReason = collected > 0 ? 'collected' : 'no_target'
          break
        }

        let brokeAny = false
        for (const candidate of candidates.slice(0, 3)) {
          if (writeStop.stopped) {
            endReason = 'cancelled'
            break
          }
          if (Date.now() > deadline) {
            endReason = 'deadline'
            break
          }
          // Blocks within breaking reach need no walk: the A* target is a
          // standable position, and a block under the feet has none, so nearby
          // targets used to fail with `unreachable` (live smoke 2026-09-12).
          const position = (await readFreshSnapshot())?.position ?? ZERO_SNAPSHOT.position
          const distance = Math.hypot(
            candidate.x + 0.5 - position.x,
            candidate.y + 0.5 - position.y,
            candidate.z + 0.5 - position.z,
          )
          if (distance > 4) {
            const leg = await walkNear(candidate, 3)
            if (leg.status === 'cancelled') {
              endReason = 'cancelled'
              break
            }
            if (await reflexPreemptedFor(envelope.commandId)) {
              endReason = 'reflex_preempted'
              break
            }
            if (leg.status !== 'reached')
              continue
          }

          // The pre-break count for this break only.
          const beforeBreak = await countOfItem()
          const breakId = nextBreakId(envelope.commandId)
          const plannedBlocks = Math.max(1, maxCount - collected)

          // CD-M1: evaluate, select and equip through the shared session. A
          // rejection stops before mining; a missing tool becomes structured
          // prerequisites instead of a slow bare-hand dig.
          const prepared = await miningSession.prepare(candidate, {
            strategy: 'conserve',
            expectedItemId: itemId,
            plannedBlocks,
          })
          if (prepared.status === 'rejected') {
            if (prepared.rejection.reason === 'no_tool' || prepared.rejection.reason === 'tool_level_too_low') {
              let report = await prepareToolPrerequisites(collect.blockId)
              // Only an explicit caller permission runs the bounded preparation
              // flow; by default the plan is returned as structured data.
              if (report && allowPrerequisites && report.craftable) {
                const run = await runInventoryUpgradeSteps(report)
                report = {
                  ...report,
                  craftable: run.remaining.length === 0,
                  reason: run.remaining.length === 0 ? 'upgrade_ready' : 'upgrade_incomplete',
                  steps: report.steps.filter(step => run.remaining.some(entry => entry.itemId === step.itemId)),
                }
              }
              prerequisiteReport = report
            }
            endReason = prerequisiteReport ? 'missing_tool' : prepared.rejection.reason
            break
          }
          if (prepared.status === 'ready' && prepared.durabilityRisk) {
            endReason = 'tool_durability_low'
            break
          }

          const candidateId = prepared.status === 'ready'
            ? prepared.evaluation.blockStateId
            : candidate.id ?? collect.blockId
          const pollMs = Math.min(deadline - Date.now(), 15_000)
          const breakOutcome = prepared.status === 'ready'
            ? await miningSession.runBreak(prepared, { breakId, commandId: envelope.commandId, mode: 'survival', pollMs })
            : await miningSession.runManualBreak({ breakId, commandId: envelope.commandId, pos: candidate, blockIdBefore: candidateId, mode: 'survival', pollMs })
          if (env.AIRI_TERRAIN_DEBUG)
            log.warn(`collect: break ${candidate.x},${candidate.y},${candidate.z} distance=${distance.toFixed(1)} status=${breakOutcome.status}`)
          if (breakOutcome.status === 'cancelled') {
            endReason = 'cancelled'
            break
          }
          if (breakOutcome.status !== 'broken')
            continue
          brokeAny = true

          // The drop lands where the block was; step onto it (bounded) so the
          // pickup range covers it before the attribution window starts.
          const pickupLeg = await walkNear({ x: candidate.x, y: candidate.y, z: candidate.z }, 1)
          if (env.AIRI_TERRAIN_DEBUG)
            log.warn(`collect: pickup leg to ${candidate.x},${candidate.y},${candidate.z} -> ${pickupLeg.status}`)
          if (pickupLeg.status === 'cancelled') {
            endReason = 'cancelled'
            break
          }
          if (await reflexPreemptedFor(envelope.commandId)) {
            endReason = 'reflex_preempted'
            break
          }

          const before = beforeBreak ?? 0
          const pickedUp = await waitForPickup(breakId, before)
          if (pickedUp > 0) {
            collected += pickedUp
            if (collected >= maxCount)
              break
            continue
          }
          if (endReason !== 'collected')
            break

          // §9-6: the drop stays behind (a pit the walker cannot enter). Record
          // where it fell and make one bounded recovery attempt before moving
          // on; a failed recovery is reported honestly, not dug forever.
          lastDropPosition = { x: candidate.x, y: candidate.y, z: candidate.z }
          const player = (await readFreshSnapshot())?.position ?? position
          const dropDistance = Math.hypot(
            candidate.x + 0.5 - player.x,
            candidate.y + 0.5 - player.y,
            candidate.z + 0.5 - player.z,
          )
          if (!stuckDropRecoveryAttempted && dropDistance <= STUCK_DROP_RECOVERY_RANGE) {
            stuckDropRecoveryAttempted = true
            if (await recoverStuckDrop(candidate, player)) {
              const retryLeg = await walkNear(candidate, 1)
              if (retryLeg.status === 'cancelled') {
                endReason = 'cancelled'
                break
              }
              if (await reflexPreemptedFor(envelope.commandId)) {
                endReason = 'reflex_preempted'
                break
              }
              const retried = await waitForPickup(breakId, before)
              if (retried > 0) {
                collected += retried
                lastDropPosition = undefined
              }
            }
          }
          if (endReason !== 'collected')
            break
          if (collected >= maxCount)
            break
        }
        if (endReason !== 'collected')
          break
        if (!brokeAny) {
          emptyRounds += 1
          if (emptyRounds >= 3) {
            endReason = 'no_progress'
            break
          }
          await sleep(700)
          continue
        }
        emptyRounds = 0
      }

      return {
        endReason,
        finalSnapshot: await readFreshSnapshot() ?? ZERO_SNAPSHOT,
        collectedCount: collected,
        ...(lastDropPosition ? { dropPosition: lastDropPosition } : {}),
        ...(prerequisiteReport ? { prerequisites: prerequisiteReport } : {}),
      }
    }

    if (envelope.action === 'follow') {
      const follow = params.follow
      if (!follow?.target)
        throw new Error('follow requires target')
      const keepDistance = Math.max(1, Math.min(follow.keepDistance || 3, 16))
      const deadline = follow.timeoutSeconds
        ? Math.min(Date.now() + envelope.deadlineMs, Date.now() + follow.timeoutSeconds * 1000)
        : Date.now() + envelope.deadlineMs
      let endReason = 'timeout'

      // Resolve once, then keep the target uuid fixed: a later re-query that
      // matches the same name must not silently switch to another entity.
      let targetUuid: string | undefined
      let targetIsPlayer: boolean | undefined
      let target: { x: number, y: number, z: number } | undefined
      // The position of the target the last leg was planned against, and
      // whether that leg reached. A leg is only replanned when the target
      // moved past this threshold or the previous leg failed (review R5).
      let anchor: { x: number, y: number, z: number } | undefined
      let previousReached = true
      let consecutiveFailures = 0
      // One failed-edge map for the whole follow: later legs reuse the failed
      // edges of earlier legs instead of planning them again (review R5).
      const failedEdges = new Map<string, FailedEdge>()

      // CD-L2: one tracker and one coarse gate per follow command. The gate
      // caps coarse locates at one per second and never overlaps them.
      const tracker = createTargetTracker()
      const coarseGate = createCoarseLocateGate()

      while (Date.now() < deadline) {
        if (writeStop.stopped) {
          endReason = 'cancelled'
          break
        }
        if (await reflexPreemptedFor(envelope.commandId)) {
          endReason = 'reflex_preempted'
          break
        }
        const now = Date.now()

        if (!targetUuid) {
          const resolved = await resolveFollowTarget(follow.target)
          if (resolved.status !== 'resolved') {
            // A truncated read reports the miss honestly instead of claiming
            // the target no longer exists (CD-L1).
            endReason = resolved.truncated ? 'target_not_in_read' : 'target_lost'
            break
          }
          targetUuid = resolved.uuid
          targetIsPlayer = resolved.isPlayer
          target = { x: resolved.x, y: resolved.y, z: resolved.z }
        }

        const outcome = tracker.outcome(now)
        if (outcome === 'fine') {
          let observation: TargetObservation | undefined
          try {
            observation = await readTargetObservationByUuid(targetUuid)
          }
          catch (error) {
            if (error instanceof DimensionMismatchError)
              tracker.forceOutcome('target_dimension_changed')
            observation = undefined
          }
          if (observation?.position) {
            if (tracker.acceptFine(observation, Date.now()))
              target = observation.position
          }
          else {
            tracker.missFine(Date.now())
            await sleep(200)
            continue
          }
        }
        else {
          // Coarse: a bounded locate at most once per second. A coarse sample
          // that stays stale past the start window is `waiting_for_target`.
          if (outcome === 'waiting_for_target' && tracker.waitingBudgetExceeded(now)) {
            endReason = tracker.snapshot().forced ?? 'waiting_for_target'
            break
          }
          if (coarseGate.tryAcquire(now)) {
            let coarse: CoarseReadResult
            try {
              coarse = await readCoarseTargetObservation(targetUuid, targetIsPlayer)
            }
            catch {
              coarse = { kind: 'unavailable' }
            }
            if (coarse.kind === 'sample') {
              coarseGate.release('success')
              tracker.acceptCoarse(coarse.observation, Date.now())
              if (coarse.observation.position)
                target = coarse.observation.position
            }
            else {
              coarseGate.release('failure')
              if (coarse.kind === 'offline') {
                endReason = 'target_offline'
                break
              }
              if (coarse.kind === 'dimension-changed') {
                endReason = 'target_dimension_changed'
                break
              }
              // `unloaded` and `unavailable` keep the last observation age and
              // let the waiting budget decide; they do not claim the target is
              // offline or gone.
              tracker.forceOutcome(coarse.kind === 'unloaded' ? 'entity_unloaded' : 'locator_unavailable')
            }
          }
          if (!target || tracker.outcome(Date.now()) !== 'coarse') {
            await sleep(200)
            continue
          }
        }

        if (!target) {
          await sleep(200)
          continue
        }

        const self = (await readFreshSnapshot())?.position ?? ZERO_SNAPSHOT.position
        // Coarse tracking walks to a rendezvous, not into the target: a wide
        // coarse position must not become a close-follow leg.
        const activeKeepDistance = tracker.snapshot().mode === 'coarse' ? Math.max(keepDistance, 8) : keepDistance
        const distance = Math.hypot(target.x - self.x, target.z - self.z)
        if (distance <= activeKeepDistance) {
          // Already within the keep distance: a leg would only jitter.
          await sleep(500)
          continue
        }
        const moved = !anchor || Math.hypot(target.x - anchor.x, target.z - anchor.z) > 1.5
        if (!moved && previousReached) {
          // The target barely moved since the last leg reached; wait for it to
          // move or for the leg to have failed before planning again.
          await sleep(500)
          continue
        }

        const leg = await runTerrainLeg(target, activeKeepDistance, shouldStop, undefined, failedEdges)
        if (env.AIRI_TERRAIN_DEBUG)
          log.warn(`follow: leg to ${target.x.toFixed(1)},${target.y.toFixed(1)},${target.z.toFixed(1)} -> ${leg.status}${leg.detail ? ` (${leg.detail})` : ''}`)
        if (leg.status === 'cancelled') {
          endReason = 'cancelled'
          break
        }
        if (leg.status === 'reached') {
          previousReached = true
          consecutiveFailures = 0
          anchor = { x: target.x, y: target.y, z: target.z }
        }
        else {
          // A non-reached, non-cancelled leg is a failure: after three in a row
          // the target is treated as unreachable instead of spinning.
          previousReached = false
          consecutiveFailures += 1
          if (consecutiveFailures >= 3) {
            endReason = 'target_unreachable'
            break
          }
        }
        await sleep(500)
      }
      return { endReason, finalSnapshot: await readFreshSnapshot() ?? ZERO_SNAPSHOT }
    }

    if (envelope.action === 'drop') {
      const drop = params.drop
      if (!drop?.itemId)
        throw new Error('drop requires itemId')
      const before = await readInventoryCounts()
      if (!before)
        throw new Error('mcp_unavailable: inventory read failed before drop')
      const slots = await readInventorySlots()
      if (!slots)
        throw new Error('mcp_unavailable: inventory slots unavailable')
      let slot = slots.hotbar.find(entry => entry.id === drop.itemId && entry.count > 0)?.slot
      if (slot === undefined) {
        // A crafted stack can land in the main inventory; move it to an empty
        // hotbar slot so the drop path stays one protocol.
        const mainEntry = slots.main.find(entry => entry.id === drop.itemId && entry.count > 0)
        if (!mainEntry)
          throw new Error(`not_in_inventory: ${drop.itemId} is in neither the hotbar nor the main inventory`)
        const emptyHotbar = [0, 1, 2, 3, 4, 5, 6, 7, 8].find(index => !slots.hotbar.some(entry => entry.slot === index))
        if (emptyHotbar === undefined)
          throw new Error(`no_hotbar_space: no empty hotbar slot to move ${drop.itemId} into`)
        const swap = await callGameTool('swap_slots', { slotA: mainEntry.containerSlot, slotB: emptyHotbar })
        const swapError = gameToolResultError(swap)
        if (swapError)
          throw new Error(swapError)
        slot = emptyHotbar
      }

      const select = await callGameTool('select_hotbar_slot', { slot })
      const selectError = gameToolResultError(select)
      if (selectError)
        throw new Error(selectError)

      let acceptedThrows = 0
      for (let index = 0; index < drop.count; index++) {
        if (writeStop.stopped)
          break
        const dropResult = await callGameTool('drop_held_item')
        if (gameToolResultError(dropResult))
          break
        acceptedThrows += 1
        await sleep(150)
      }

      // NOTICE: an unfocused or busy client can reflect the throw clicks in the
      // inventory late (observed live 2026-09-13: the planks were already on
      // the ground and picked up while the receipt still measured zero). Poll a
      // bounded window first, then fall back to the emptied target slot plus the
      // accepted throw count, and record which check verified the receipt.
      let droppedCount = 0
      let verifiedBy: 'inventory-delta' | 'slot-empty' = 'inventory-delta'
      for (let attempt = 0; attempt < 4; attempt++) {
        const counts = await readInventoryCounts()
        droppedCount = Math.max(0, (before[drop.itemId] ?? 0) - (counts?.[drop.itemId] ?? before[drop.itemId] ?? 0))
        if (droppedCount > 0)
          break
        await sleep(700)
      }
      if (droppedCount === 0 && acceptedThrows > 0) {
        const afterSlots = await readInventorySlots()
        const stillThere = afterSlots?.hotbar.some(entry => entry.slot === slot && entry.id === drop.itemId && entry.count > 0)
        if (!stillThere) {
          droppedCount = Math.min(acceptedThrows, before[drop.itemId] ?? acceptedThrows)
          verifiedBy = 'slot-empty'
        }
      }
      return {
        endReason: writeStop.stopped ? 'cancelled' : 'dropped',
        finalSnapshot: await readFreshSnapshot() ?? ZERO_SNAPSHOT,
        droppedCount,
        dropped: { itemId: drop.itemId, count: droppedCount, slot, verifiedBy },
      }
    }

    if (envelope.action === 'locate') {
      const name = params.locate?.name?.trim()
      if (!name)
        throw new Error('locate requires name')
      const result = await callGameTool('list_players', {})
      const record = statusRecordOf(result)
      const players = Array.isArray(record?.players) ? record.players as Array<Record<string, unknown>> : []
      const match = players.find(player => typeof player.name === 'string' && player.name.toLowerCase() === name.toLowerCase())
      if (!match)
        throw new Error(`player_not_online: ${name}`)
      const x = Number(match.x)
      const y = Number(match.y)
      const z = Number(match.z)
      if (![x, y, z].every(Number.isFinite))
        throw new Error('locate returned no position')
      return {
        endReason: 'located',
        finalSnapshot: await readFreshSnapshot() ?? ZERO_SNAPSHOT,
        located: {
          name: String(match.name),
          // The player list already carries the uuid; passing it through keeps
          // the locate identity stable for a later follow (CD-L1).
          ...(typeof match.uuid === 'string' ? { uuid: match.uuid } : {}),
          position: { x, y, z },
          ...(typeof match.dimension === 'string' ? { dimension: match.dimension } : {}),
        },
      }
    }

    if (envelope.action === 'equip') {
      const equip = params.equip
      if (!equip?.itemId)
        throw new Error('equip requires itemId')
      const slots = await readInventorySlots()
      if (!slots)
        throw new Error('mcp_unavailable: inventory slots unavailable')
      const source = findEquipSource(slots, equip.itemId)
      if (!source)
        throw new Error(`not_in_inventory: ${equip.itemId} is in neither the hotbar nor the main inventory`)

      if (equip.target === 'main_hand') {
        if (source.hotbar) {
          const select = await callGameTool('select_hotbar_slot', { slot: source.invIndex })
          const selectError = gameToolResultError(select)
          if (selectError)
            throw new Error(selectError)
        }
        else {
          // A main-inventory stack moves into the hotbar first. The first
          // empty slot is preferred; when none is free the selected slot is
          // used, which displaces the current hand item instead of failing.
          const emptyHotbar = [0, 1, 2, 3, 4, 5, 6, 7, 8].find(index => !slots.hotbar.some(entry => entry.slot === index))
          const targetHotbar = emptyHotbar ?? 0
          const swap = await callGameTool('swap_slots', { slotA: source.invIndex, slotB: targetHotbar })
          const swapError = gameToolResultError(swap)
          if (swapError)
            throw new Error(swapError)
          const select = await callGameTool('select_hotbar_slot', { slot: targetHotbar })
          const selectError = gameToolResultError(select)
          if (selectError)
            throw new Error(selectError)
        }
      }
      else {
        const targetContainer = EQUIP_TARGET_CONTAINER[equip.target]
        if (source.invIndex !== targetContainer) {
          const swap = await callGameTool('swap_slots', { slotA: source.invIndex, slotB: targetContainer })
          const swapError = gameToolResultError(swap)
          if (swapError)
            throw new Error(swapError)
        }
      }

      // The swap request is not evidence; a fresh equipment read is.
      const equipment = await readEquipment()
      if (!equipment)
        throw new Error('equipment_read_failed: get_equipment returned no data')
      const actualItemId = equipmentItemIdOf(equipment, equip.target)
      if (actualItemId !== equip.itemId)
        throw new Error(`not_confirmed: expected ${equip.itemId} in ${equip.target}, read ${actualItemId ?? 'empty'}`)

      return {
        endReason: 'equipped',
        finalSnapshot: await readFreshSnapshot() ?? ZERO_SNAPSHOT,
        equipped: { itemId: equip.itemId, target: equip.target },
        equippedActualId: actualItemId,
      }
    }

    if (envelope.action === 'use') {
      const use = params.use
      if (!use)
        throw new Error('use requires params')

      if (use.mode === 'block') {
        if (![use.x, use.y, use.z].every(value => Number.isFinite(value)))
          throw new Error('use block requires x, y, z')
        const result = await callGameTool('place_block', { x: use.x, y: use.y, z: use.z })
        const error = gameToolResultError(result)
        if (error)
          throw new Error(error)
        return {
          endReason: 'used',
          finalSnapshot: await readFreshSnapshot() ?? ZERO_SNAPSHOT,
          used: { mode: 'block', heldTicks: 0, released: false, aborted: false },
        }
      }

      if (use.mode === 'entity') {
        const uuid = use.uuid?.trim()
        if (!uuid)
          throw new Error('use entity requires uuid')
        const result = await callGameTool('use_entity', { uuid })
        const error = gameToolResultError(result)
        if (error)
          throw new Error(error)
        return {
          endReason: 'used',
          finalSnapshot: await readFreshSnapshot() ?? ZERO_SNAPSHOT,
          used: { mode: 'entity', heldTicks: 0, released: false, aborted: false },
        }
      }

      // mode 'item': start a real use, hold it, then end it through the normal
      // release path (fires chargeables) or the abort path.
      const start = await callGameTool('start_using')
      const startError = gameToolResultError(start)
      if (startError)
        throw new Error(startError)
      const startRecord = statusRecordOf(start)
      let itemId = typeof startRecord?.usingItemId === 'string' && startRecord.usingItemId ? startRecord.usingItemId : undefined

      // One fresh read always runs, so the receipt names the held item even
      // when holdTicks is zero.
      const readSelf = async (): Promise<void> => {
        const record = statusRecordOf(await callGameTool('get_self'))
        if (typeof record?.usingItemId === 'string' && record.usingItemId)
          itemId = record.usingItemId
      }
      await readSelf()

      const holdTicks = Math.max(0, use.holdTicks || 0)
      const holdUntil = Math.min(Date.now() + envelope.deadlineMs, Date.now() + holdTicks * 50 + 2_500)
      for (;;) {
        if (holdTicks <= 0 || Date.now() >= holdUntil || writeStop.stopped)
          break
        await sleep(50)
        if (writeStop.stopped)
          break
        await readSelf()
      }

      const aborted = use.abort === true || writeStop.stopped
      const endResult = await callGameTool(aborted ? 'stop_using' : 'release_using')
      const endError = gameToolResultError(endResult)
      if (endError)
        throw new Error(endError)
      return {
        endReason: aborted ? 'aborted' : 'used',
        finalSnapshot: await readFreshSnapshot() ?? ZERO_SNAPSHOT,
        used: { ...(itemId ? { itemId } : {}), mode: 'item', heldTicks: holdTicks, released: !aborted, aborted },
      }
    }

    if (envelope.action === 'supply') {
      const selfBefore = statusRecordOf(await callGameTool('get_self'))
      const foodBefore = Number(selfBefore?.food)
      if (!Number.isFinite(foodBefore))
        throw new Error('mcp_unavailable: get_self returned no food level')
      // Eating at full hunger wastes the item and cannot be verified: refuse
      // before any use starts. The vanilla food cap is 20.
      if (foodBefore >= 20)
        throw new Error('already_full: hunger is full')
      const slots = await readInventorySlots()
      if (!slots)
        throw new Error('mcp_unavailable: inventory slots unavailable')

      const hotbarFood = slots.hotbar.find(entry => entry.food === true && entry.count > 0)
      let slot: number
      let itemId: string
      if (hotbarFood) {
        slot = hotbarFood.slot
        itemId = hotbarFood.id
      }
      else {
        // A main-inventory stack is moved into an empty hotbar slot first; the
        // hand item is never displaced when no slot is free (no_food instead).
        const mainFood = slots.main.find(entry => entry.food === true && entry.count > 0)
        if (!mainFood)
          throw new Error('no_food: no edible item in the hotbar or main inventory')
        const emptyHotbar = [0, 1, 2, 3, 4, 5, 6, 7, 8].find(index => !slots.hotbar.some(entry => entry.slot === index))
        if (emptyHotbar === undefined)
          throw new Error('no_food: no empty hotbar slot to move the food into')
        const swap = await callGameTool('swap_slots', { slotA: mainFood.containerSlot, slotB: emptyHotbar })
        const swapError = gameToolResultError(swap)
        if (swapError)
          throw new Error(swapError)
        slot = emptyHotbar
        itemId = mainFood.id
      }

      const select = await callGameTool('select_hotbar_slot', { slot })
      const selectError = gameToolResultError(select)
      if (selectError)
        throw new Error(selectError)
      const start = await callGameTool('start_using')
      const startError = gameToolResultError(start)
      if (startError)
        throw new Error(startError)

      // Poll the fresh food level in a bounded window, then finish the use
      // through the normal release path so the food is actually consumed.
      let foodAfter = foodBefore
      const holdUntil = Math.min(Date.now() + envelope.deadlineMs, Date.now() + 8_000)
      while (Date.now() < holdUntil) {
        await sleep(200)
        if (writeStop.stopped)
          break
        const record = statusRecordOf(await callGameTool('get_self'))
        const current = Number(record?.food)
        if (Number.isFinite(current)) {
          foodAfter = current
          if (current > foodBefore)
            break
        }
      }
      const release = await callGameTool('release_using')
      const releaseError = gameToolResultError(release)
      if (releaseError)
        throw new Error(releaseError)
      // One fresh read after the release is the verified delta.
      const selfAfter = statusRecordOf(await callGameTool('get_self'))
      const readAfter = Number(selfAfter?.food)
      if (Number.isFinite(readAfter))
        foodAfter = readAfter

      const fedCount = Math.max(0, foodAfter - foodBefore)
      return {
        endReason: fedCount >= 1 ? 'fed' : 'not_confirmed',
        finalSnapshot: await readFreshSnapshot() ?? ZERO_SNAPSHOT,
        fedCount,
        fed: { itemId, foodBefore, foodAfter, slot },
      }
    }

    if (envelope.action === 'sleep') {
      const sleep = params.sleep
      if (!sleep)
        throw new Error('sleep requires x, y, z')
      const result = await callGameTool('sleep', { x: sleep.x, y: sleep.y, z: sleep.z })
      const error = gameToolResultError(result)
      if (error)
        throw new Error(error)
      const record = statusRecordOf(result)
      if (!record)
        throw new Error('interaction_failed: sleep returned no data')
      if (typeof record.error === 'string' && record.error)
        throw new Error(record.error)
      if (record.sleeping !== true)
        throw new Error('not_sleeping')
      const bed = record.bedPosition && typeof record.bedPosition === 'object' && !Array.isArray(record.bedPosition)
        ? record.bedPosition as Record<string, unknown>
        : undefined
      const position = bed
        ? { x: Number(bed.x) || sleep.x, y: Number(bed.y) || sleep.y, z: Number(bed.z) || sleep.z }
        : { x: sleep.x, y: sleep.y, z: sleep.z }
      return {
        endReason: 'slept',
        finalSnapshot: await readFreshSnapshot() ?? ZERO_SNAPSHOT,
        slept: { position, sleepTimer: Number(record.sleepTimer) || 0 },
      }
    }

    if (envelope.action === 'respawn') {
      const result = await callGameTool('respawn', {})
      const error = gameToolResultError(result)
      if (error)
        throw new Error(error)
      const record = statusRecordOf(result)
      if (!record)
        throw new Error('not_confirmed: respawn returned no data')
      if (typeof record.error === 'string' && record.error)
        throw new Error(record.error)
      if (record.respawned !== true)
        throw new Error('not_confirmed')
      const raw = record.position && typeof record.position === 'object' && !Array.isArray(record.position)
        ? record.position as Record<string, unknown>
        : undefined
      const position = raw
        ? { x: Number(raw.x) || 0, y: Number(raw.y) || 0, z: Number(raw.z) || 0 }
        : ZERO_SNAPSHOT.position
      return {
        endReason: 'respawned',
        finalSnapshot: await readFreshSnapshot() ?? ZERO_SNAPSHOT,
        respawned: { position },
      }
    }

    if (envelope.action === 'shoot') {
      const shoot = params.shoot
      if (!shoot?.target)
        throw new Error('shoot requires target')

      // Resolve once, then pin the UUID for the whole command. A later query
      // that matches the same name must never silently switch to another entity
      // (gaps §3.3). The executable mod path is chosen from the resolved weapon.
      const resolved = await resolveFollowTarget(shoot.target)
      if (resolved.status !== 'resolved') {
        // Target gone before any shot: no phantom shots.
        return {
          endReason: 'target_lost',
          finalSnapshot: await readFreshSnapshot() ?? ZERO_SNAPSHOT,
          shot: { weapon: shoot.weapon, targetUuid: '', shots: [], endReason: 'target_lost' },
        }
      }
      const targetUuid = resolved.uuid
      const target = { x: resolved.x, y: resolved.y, z: resolved.z }

      // Choose the concrete weapon. `auto` prefers bow, then crossbow, then trident.
      const weapon = shoot.weapon === 'auto' ? await chooseAutoWeapon() : shoot.weapon
      if (!weapon) {
        return {
          endReason: 'weapon_unavailable',
          finalSnapshot: await readFreshSnapshot() ?? ZERO_SNAPSHOT,
          shot: { weapon: 'auto', targetUuid, shots: [], endReason: 'weapon_unavailable' },
        }
      }
      if (weapon === 'trident' && await isRiptideTrident()) {
        // Riptide is player movement (gaps §3.2), not a projectile shot. The
        // capability limit is returned without starting a combat task.
        return {
          endReason: 'unsupported_weapon_feature',
          finalSnapshot: await readFreshSnapshot() ?? ZERO_SNAPSHOT,
          shot: { weapon, targetUuid, shots: [], endReason: 'unsupported_weapon_feature' },
        }
      }

      const statusRecordOfCall = async (name: string, args: Record<string, unknown> = {}) => statusRecordOf(await callGameTool(name, args))

      const start = statusRecordOf(await callGameTool('combat_start', {
        weapon,
        targetX: target.x,
        targetY: target.y,
        targetZ: target.z,
        targetUuid,
        maxShots: shoot.maxShots,
        ...(shoot.chargeTicks ? { chargeTicks: shoot.chargeTicks } : {}),
      }))
      if (!start) {
        throw new Error('not_confirmed: combat_start returned no data')
      }
      // The mod runs its pre-flight check before any use; a terminal reason in
      // the start response is a typed failure with zero shots.
      const startEnd = String(start.endReason ?? start.state ?? '')
      if (start.state !== 'running') {
        const reason = startEnd === 'no_ammo' || startEnd === 'weapon_unavailable'
          ? startEnd
          : 'not_confirmed'
        return {
          endReason: reason,
          finalSnapshot: await readFreshSnapshot() ?? ZERO_SNAPSHOT,
          shot: { weapon, targetUuid, shots: [], endReason: reason },
        }
      }

      // Poll the weapon task; in parallel poll server events to attribute hits.
      const wantEvents = shoot.useServerEvents !== false
      const deadline = Date.now() + envelope.deadlineMs
      const shots: Array<{ shot: number, projectileUuid?: string, verifiedBy?: string, hitEvidence?: string }> = []
      const attributedShots = new Set<number>()
      const selfUuid = worldIdentity?.playerUuid ?? ''
      let killed = false
      let killEvidence: string | undefined
      let returned: boolean | undefined
      let endReason = 'not_confirmed'
      let cancelSent = false
      /** Game tick of the latest shot, from the mod; bounds the fallback window. */
      let shotGameTime: number | undefined
      /** Latest aim point the mod reported for the moving target. */
      let aimTarget: { x: number, y: number, z: number } | undefined
      let aimSource: string | undefined

      /**
       * Rebuilds per-shot records from the mod status. The mod reports one
       * verification per shot ("projectile" catches the arrow, "ammo" covers a
       * fast arrow that hit before the scan); only projectile-verified shots
       * consume a uuid, and the pointer must continue across poll cycles.
       */
      /** Marks the newest shot as the kill shot once `killed` is known. */
      const markKillShot = () => {
        for (let index = shots.length - 1; index >= 0; index--) {
          if (!attributedShots.has(shots[index].shot)) {
            attributedShots.add(shots[index].shot)
            shots[index].hitEvidence = 'entity_death'
            return
          }
        }
      }

      const appendShots = (status: Record<string, unknown>) => {
        const rawUuids = Array.isArray(status.projectileUuids) ? status.projectileUuids as unknown[] : []
        const rawVerified = Array.isArray(status.shotVerifiedBy) ? status.shotVerifiedBy as unknown[] : []
        const shotCount = Number(status.shotsFired) || 0
        let uuidPointer = shots.reduce((count, entry) => count + (entry.projectileUuid ? 1 : 0), 0)
        for (let index = shots.length; index < shotCount; index++) {
          const verifiedBy = typeof rawVerified[index] === 'string' ? rawVerified[index] as string : undefined
          let uuid: string | undefined
          if (verifiedBy !== 'ammo') {
            uuid = typeof rawUuids[uuidPointer] === 'string' ? rawUuids[uuidPointer] as string : undefined
            if (uuid)
              uuidPointer += 1
          }
          shots.push({
            shot: index + 1,
            ...(uuid ? { projectileUuid: uuid } : {}),
            ...(verifiedBy ? { verifiedBy } : {}),
            hitEvidence: 'unobserved',
          })
        }
        // A kill event can arrive before the mod reports the shot; when the
        // shot is later accounted, carry the kill attribution onto it.
        if (killed)
          markKillShot()
      }

      /** Records the mod's latest shot tick and aim point across poll cycles. */
      const noteCombatTracking = (status: Record<string, unknown>) => {
        const rawShotTick = Number(status.lastShotTick)
        if (Number.isFinite(rawShotTick) && rawShotTick > 0)
          shotGameTime = rawShotTick
        const rawAim = vec3RecordOf(status.aimTarget)
        if (rawAim)
          aimTarget = rawAim
        if (typeof status.aimSource === 'string' && status.aimSource)
          aimSource = status.aimSource
      }

      /**
       * R9: returns the correlation key for a death event, or undefined when the
       * event cannot be linked to this command's fire.
       *
       * A pinned target that dies is not automatically this command's kill: any
       * player's arrow can land the blow. The target uuid must match and one key
       * must also cross-check — the projectile uuid this task launched, our own
       * attacker uuid, or, only when the event names neither, a shot-time window.
       */
      const killCorrelation = (data: Record<string, unknown>, eventGameTime: number | undefined): string | undefined => {
        const projectileUuid = typeof data.projectileUuid === 'string' ? data.projectileUuid : ''
        if (projectileUuid)
          return shots.some(shot => shot.projectileUuid === projectileUuid) ? 'projectile' : undefined
        const attackerUuid = typeof data.attackerUuid === 'string' ? data.attackerUuid : ''
        if (attackerUuid)
          return selfUuid && attackerUuid === selfUuid ? 'attacker' : undefined
        if (eventGameTime !== undefined && shotGameTime !== undefined
          && eventGameTime >= shotGameTime - SHOT_ATTRIBUTION_WINDOW_BEFORE_TICKS
          && eventGameTime <= shotGameTime + SHOT_ATTRIBUTION_WINDOW_TICKS) {
          return 'window'
        }
        return undefined
      }

      /**
       * Death events that matched the pinned target but could not be linked yet.
       *
       * The event can arrive before the mod reports the shot that fired its
       * projectile, so a link is retried on later polls. A death left pending
       * when the command ends stays unobserved instead of being claimed.
       */
      const pendingDeaths: Array<{ id: number, data: Record<string, unknown>, gameTime: number | undefined }> = []

      const resolveDeath = (data: Record<string, unknown>, eventGameTime: number | undefined): boolean => {
        const correlation = killCorrelation(data, eventGameTime)
        if (!correlation)
          return false
        const firstKill = !killed
        killed = true
        killEvidence = correlation
        markKillShot()
        // The target is dead: stop the task instead of spending the remaining
        // shots on the corpse. A trident still needs its return window: the mod
        // tracks the fired projectile and reports `returned`, and cancelling
        // here loses the loyalty return (live 2026-09-14: `returned:false`
        // while the trident was already back in the hotbar).
        if (firstKill && weapon !== 'trident') {
          void callGameTool('combat_cancel').catch(() => {
            // Best-effort: the task stops at maxShots anyway.
          })
        }
        return true
      }

      /**
       * Attributes a kill from server events. Only an `entity_death` for the
       * pinned uuid with an arrow/trident cause and a correlation key counts;
       * polling is best-effort and a missing observation stays `unobserved`,
       * never a miss. A matching death with no key keeps the death fact and
       * leaves the kill unobserved.
       */
      const attributeShotEvents = async () => {
        if (!wantEvents)
          return
        try {
          // Retry pending deaths first: a projectile link needs the mod to have
          // reported the shot, which can happen after the event arrived.
          for (let index = pendingDeaths.length - 1; index >= 0; index--) {
            if (resolveDeath(pendingDeaths[index].data, pendingDeaths[index].gameTime))
              pendingDeaths.splice(index, 1)
          }
          // Server-authoritative event ring: `entity_death` exists only on the
          // dedicated-server bridge (the client ring carries chat and reflex
          // events). This routes to the server endpoint when it is configured.
          const eventsRecord = await statusRecordOfCall('poll_server_events', { limit: 50, sinceId: lastEventId })
          const events = Array.isArray(eventsRecord?.events) ? eventsRecord.events as Array<Record<string, unknown>> : []
          for (const event of events) {
            const id = Number(event.id)
            if (Number.isFinite(id) && id > lastEventId)
              lastEventId = id
            const data = event.data && typeof event.data === 'object' ? event.data as Record<string, unknown> : event
            const type = typeof event.type === 'string' ? event.type : ''
            const uuid = typeof data.uuid === 'string' ? data.uuid : ''
            const cause = typeof data.cause === 'string' ? data.cause : ''
            const isProjectileCause = cause === 'arrow' || cause === 'trident'
            if (type !== 'entity_death' || uuid !== targetUuid || !isProjectileCause)
              continue
            const rawGameTime = Number(event.gameTime)
            const eventGameTime = Number.isFinite(rawGameTime) ? rawGameTime : undefined
            if (!resolveDeath(data, eventGameTime))
              pendingDeaths.push({ id: Number.isFinite(id) ? id : 0, data, gameTime: eventGameTime })
          }
        }
        catch {
          // Event polling is best-effort; a miss stays unobserved.
        }
      }

      for (;;) {
        if (writeStop.stopped) {
          endReason = 'cancelled'
          if (!cancelSent) {
            cancelSent = true
            // A state-aware abort: no new shots; an already-fired projectile is
            // kept and never claimed to be recalled (gaps §3.5).
            try {
              await callGameTool('combat_cancel')
            }
            catch {
              // Best-effort: the task is stopping anyway.
            }
          }
        }
        if (Date.now() > deadline) {
          endReason = 'deadline'
          if (!cancelSent) {
            cancelSent = true
            try {
              await callGameTool('combat_cancel')
            }
            catch {
              // Best-effort stop.
            }
          }
        }
        if (await reflexPreemptedFor(envelope.commandId))
          endReason = 'reflex_preempted'

        const status = await statusRecordOfCall('combat_status')
        if (status) {
          appendShots(status)
          noteCombatTracking(status)
          const modEnd = String(status.endReason ?? '')
          if (status.state === 'done' || status.state === 'cancelled' || status.state === 'idle') {
            if (endReason === 'not_confirmed')
              endReason = modEnd === 'running' || !modEnd ? 'done' : modEnd
            if (typeof status.returned === 'boolean' && weapon === 'trident')
              returned = status.returned
            // A kill event can land with the task's terminal report; one grace
            // read catches it before the loop ends.
            await sleep(400)
            await attributeShotEvents()
            break
          }
        }

        await attributeShotEvents()

        await sleep(200)
      }

      // One final status read pins the shot list even when the loop ended on a
      // deadline/preemption before the terminal state was observed.
      const finalStatus = await statusRecordOfCall('combat_status').catch(() => undefined)
      if (finalStatus) {
        appendShots(finalStatus)
        noteCombatTracking(finalStatus)
        if (typeof finalStatus.returned === 'boolean' && weapon === 'trident')
          returned = finalStatus.returned
      }

      const shotReceipt: GameShotReceipt = {
        weapon,
        targetUuid,
        shots,
        ...(killed ? { killed: true } : {}),
        ...(killEvidence ? { killEvidence } : {}),
        ...(pendingDeaths.length > 0 ? { unobservedTargetDeath: true } : {}),
        ...(returned !== undefined ? { returned } : {}),
        ...(aimTarget ? { aimTarget } : {}),
        ...(aimSource ? { aimSource } : {}),
        endReason,
      }
      return {
        endReason,
        finalSnapshot: await readFreshSnapshot() ?? ZERO_SNAPSHOT,
        shot: shotReceipt,
      }
    }

    if (envelope.action === 'attack') {
      const attack = params.attack
      if (!attack?.target)
        throw new Error('attack requires target')
      const maxSwings = Math.max(1, Math.min(attack.maxSwings || 1, 8))

      // Resolve once, then pin the uuid: a later query that matches the same
      // name must never silently switch to another entity.
      const resolved = await resolveFollowTarget(attack.target)
      if (resolved.status !== 'resolved') {
        return {
          endReason: 'target_lost',
          finalSnapshot: await readFreshSnapshot() ?? ZERO_SNAPSHOT,
          attacked: { targetUuid: '', swings: 0, weapon: attack.weapon, hitEvidence: 'unobserved', endReason: 'target_lost' },
        }
      }
      const targetUuid = resolved.uuid

      // Weapon resolution: auto falls back to an empty hand; an explicit class
      // must exist in the inventory. An unavailable class is the typed failure
      // before any swing.
      const slots = await readInventorySlots()
      const weaponItemId = slots ? chooseMeleeWeapon(attack.weapon, slots) : undefined
      const requiresWeapon = attack.weapon === 'sword' || attack.weapon === 'axe' || attack.weapon === 'trident'
      if (requiresWeapon && !weaponItemId) {
        return {
          endReason: 'weapon_unavailable',
          finalSnapshot: await readFreshSnapshot() ?? ZERO_SNAPSHOT,
          attacked: { targetUuid, swings: 0, weapon: attack.weapon, hitEvidence: 'unobserved', endReason: 'weapon_unavailable' },
        }
      }
      const weapon = weaponItemId ?? 'hand'
      try {
        if (weaponItemId)
          await ensureItemSelected(weaponItemId)
        else
          await ensureHandSelected()
      }
      catch {
        return {
          endReason: 'weapon_unavailable',
          finalSnapshot: await readFreshSnapshot() ?? ZERO_SNAPSHOT,
          attacked: { targetUuid, swings: 0, weapon, hitEvidence: 'unobserved', endReason: 'weapon_unavailable' },
        }
      }

      const deadline = Date.now() + envelope.deadlineMs
      let swings = 0
      let hitCount = 0
      let damageDealt = 0
      let healthBefore: number | undefined
      let healthAfter: number | undefined
      let observedKill = false
      let observedEvidence: string | undefined
      let endReason = 'not_confirmed'
      let stopReason: string | undefined

      /** Distance between the player's and the target's feet. */
      const distanceTo = (from: { x: number, y: number, z: number }, to: { x: number, y: number, z: number }) =>
        Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z)
      // One failed-edge map for the whole attack: each approach leg shares it.
      const failedEdges = new Map<string, FailedEdge>()

      for (let index = 0; index < maxSwings; index++) {
        if (writeStop.stopped) {
          stopReason = 'cancelled'
          break
        }
        if (Date.now() > deadline) {
          stopReason = 'deadline'
          break
        }

        const before = await readEntityByUuid(targetUuid)
        if (!before) {
          // A target that vanished after our observed damage is our kill: the
          // removal is the death evidence (live MC-4g: the killing blow's own
          // read still showed health 0, and the next iteration saw it gone).
          // Without prior hits the disappearance is a plain `target_lost`.
          if (hitCount > 0) {
            observedKill = true
            observedEvidence = 'entity_death'
            endReason = 'killed'
          }
          else {
            stopReason = 'target_lost'
          }
          break
        }
        if (healthBefore === undefined && before.health !== undefined)
          healthBefore = before.health
        healthAfter = before.health ?? healthAfter

        let targetPosition = { x: before.x, y: before.y, z: before.z }
        let self = await readFreshSnapshot()
        let distance = self ? distanceTo(self.position, targetPosition) : Number.POSITIVE_INFINITY

        // Approach when the target is close but out of reach. Beyond
        // ATTACK_APPROACH_MAX the command fails instead of walking forever.
        if (distance > ATTACK_REACH) {
          if (distance <= ATTACK_APPROACH_MAX) {
            for (let leg = 0; leg < 2 && distance > ATTACK_REACH; leg++) {
              if (writeStop.stopped)
                break
              const legResult = await runTerrainLeg(targetPosition, 2, shouldStop, undefined, failedEdges)
              if (legResult.status === 'cancelled')
                break
              const requery = await readEntityByUuid(targetUuid)
              if (!requery) {
                stopReason = 'target_lost'
                break
              }
              targetPosition = { x: requery.x, y: requery.y, z: requery.z }
              self = await readFreshSnapshot()
              distance = self ? distanceTo(self.position, targetPosition) : Number.POSITIVE_INFINITY
            }
          }
          if (stopReason)
            break
          if (distance > ATTACK_REACH) {
            stopReason = 'out_of_reach'
            break
          }
        }

        // Aim at the target's chest height, then swing once. `attack_entity`
        // performs one attack with the held item.
        const eye = self
          ? { x: self.position.x, y: self.position.y + 1.62, z: self.position.z }
          : { x: targetPosition.x, y: targetPosition.y + 1.62, z: targetPosition.z }
        const aim = { x: targetPosition.x, y: targetPosition.y + 1.0, z: targetPosition.z }
        const horizontal = Math.hypot(aim.x - eye.x, aim.z - eye.z)
        const yaw = Math.atan2(-(aim.x - eye.x), aim.z - eye.z) * 180 / Math.PI
        const pitch = Math.atan2(-(aim.y - eye.y), horizontal) * 180 / Math.PI
        await callGameTool('look', { yaw, pitch })
        await sleep(120)

        const swing = await callGameTool('attack_entity', { uuid: targetUuid })
        const swingError = gameToolResultError(swing)
        if (swingError)
          throw new Error(swingError)
        swings += 1

        // A fresh read is the only evidence: a health drop or a disappearance.
        // Anything else keeps the swing unobserved, never a miss.
        await sleep(180)
        const after = await readEntityByUuid(targetUuid)
        if (!after) {
          observedKill = true
          hitCount += 1
          observedEvidence = 'entity_death'
          endReason = 'killed'
          break
        }
        healthAfter = after.health ?? healthAfter
        if (before.health !== undefined && after.health !== undefined && after.health < before.health) {
          hitCount += 1
          damageDealt += before.health - after.health
          observedEvidence = 'health_delta'
          endReason = 'hit'
        }

        // Enforce the vanilla attack cooldown between swings.
        if (index < maxSwings - 1)
          await sleep(ATTACK_SWING_INTERVAL_MS)
      }

      if (stopReason)
        endReason = stopReason
      else if (endReason === 'not_confirmed' && hitCount > 0)
        endReason = observedKill ? 'killed' : 'hit'

      const attacked: GameAttackedReceipt = {
        targetUuid,
        swings,
        weapon,
        ...(damageDealt > 0 ? { damageDealt } : {}),
        ...(healthBefore !== undefined ? { healthBefore } : {}),
        ...(healthAfter !== undefined ? { healthAfter } : {}),
        hitEvidence: observedEvidence ?? 'unobserved',
        ...(observedKill ? { killed: true } : {}),
        endReason,
      }
      return {
        endReason,
        finalSnapshot: await readFreshSnapshot() ?? ZERO_SNAPSHOT,
        hitCount,
        attacked,
      }
    }

    if (envelope.action === 'riptide') {
      const riptide = params.riptide
      if (!riptide)
        throw new Error('riptide requires x, y, z')

      // Charge and release a riptide trident; the mod checks the water/rain and
      // enchantment conditions before any use, so an unmet condition is a typed
      // failure with zero charge.
      const start = statusRecordOf(await callGameTool('riptide', {
        targetX: riptide.x,
        targetY: riptide.y,
        targetZ: riptide.z,
      }))
      const startState = String(start?.state ?? '')
      if (startState !== 'running') {
        const reason = String(start?.endReason ?? startState) === 'riptide_unavailable'
          ? 'riptide_unavailable'
          : 'not_confirmed'
        // §9-3: the mod 0.2.15 water/rain diagnostics live only in
        // `riptide_status`, not in the start response, so a refusal reads the
        // status once. The read is best-effort: a failure leaves `unmetDetail`
        // off the receipt instead of holding the reply.
        let unmetDetail: GameRiptideUnmetDetail | undefined
        if (reason === 'riptide_unavailable') {
          try {
            unmetDetail = riptideUnmetDetailOf(statusRecordOf(await callGameTool('riptide_status')))
          }
          catch {
            unmetDetail = undefined
          }
        }
        return {
          endReason: reason,
          finalSnapshot: await readFreshSnapshot() ?? ZERO_SNAPSHOT,
          riptide: { endReason: reason, ...(unmetDetail ? { unmetDetail } : {}) },
        }
      }

      const deadline = Date.now() + envelope.deadlineMs
      let cancelSent = false
      let endReason = 'not_confirmed'
      let lastStatus: Record<string, unknown> | undefined = start
      for (;;) {
        if (writeStop.stopped && !cancelSent) {
          cancelSent = true
          endReason = 'cancelled'
          // The abort path stops the charge without the release that propels
          // the player; `combat_cancel` covers the same task on the bridge.
          try {
            await callGameTool('riptide_cancel')
          }
          catch {
            // Best-effort: the task is stopping anyway.
          }
          try {
            await callGameTool('combat_cancel')
          }
          catch {
            // Best-effort stop.
          }
        }
        if (Date.now() > deadline && !cancelSent) {
          cancelSent = true
          endReason = 'deadline'
          try {
            await callGameTool('riptide_cancel')
          }
          catch {
            // Best-effort stop.
          }
        }
        const status = statusRecordOf(await callGameTool('riptide_status'))
        if (status) {
          lastStatus = status
          const state = String(status.state ?? '')
          if (state === 'done' || state === 'cancelled' || state === 'idle') {
            if (endReason !== 'cancelled' && endReason !== 'deadline') {
              const modEnd = String(status.endReason ?? '')
              endReason = state === 'cancelled' ? 'cancelled' : (modEnd || 'launched')
            }
            break
          }
        }
        await sleep(150)
      }

      const fresh = await readFreshSnapshot() ?? ZERO_SNAPSHOT
      // Arrival is verified against a fresh read, the same postcondition as
      // move_to; a launch that stopped outside tolerance is `not_confirmed`,
      // never a success. A capability failure or a cancel also never counts.
      if (endReason !== 'cancelled' && endReason !== 'deadline' && endReason !== 'riptide_unavailable') {
        const distance = Math.hypot(
          fresh.position.x - riptide.x,
          fresh.position.y - riptide.y,
          fresh.position.z - riptide.z,
        )
        endReason = distance <= riptide.tolerance ? 'launched' : 'not_confirmed'
      }

      /**
       * Bounded wait for the server to sync a released trident's durability.
       *
       * The mod records `durabilityAfter` at release, before the server
       * round-trip, so it can still equal `durabilityBefore`. Poll the status
       * until it changes or the window closes; when it never changes the
       * release-time value is kept (read honestly, never fabricated).
       */
      const syncRiptideDurability = async (status: Record<string, unknown> | undefined, reason: string): Promise<number> => {
        const initial = Number(status?.durabilityAfter)
        if (reason === 'cancelled' || reason === 'deadline' || reason === 'riptide_unavailable')
          return initial
        const before = Number(status?.durabilityBefore)
        if (!Number.isFinite(initial) || !Number.isFinite(before) || initial !== before)
          return initial
        const until = Date.now() + RIPTIDE_DURABILITY_POLL_MS
        while (Date.now() < until) {
          await sleep(RIPTIDE_DURABILITY_POLL_INTERVAL_MS)
          if (writeStop.stopped)
            break
          try {
            const next = statusRecordOf(await callGameTool('riptide_status'))
            const candidate = Number(next?.durabilityAfter)
            if (Number.isFinite(candidate) && candidate !== initial) {
              lastStatus = next
              return candidate
            }
          }
          catch {
            // A failed read only means "not synced yet"; keep polling.
          }
        }
        return initial
      }

      const from = vec3RecordOf(lastStatus?.from)
      const to = vec3RecordOf(lastStatus?.to)
      const displacement = vec3RecordOf(lastStatus?.displacement)
      const modDistance = Number(lastStatus?.distance)
      const durabilityBefore = Number(lastStatus?.durabilityBefore)
      const durabilityAfter = await syncRiptideDurability(lastStatus, endReason)
      const riptideReceipt: GameRiptideReceipt = {
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
        ...(displacement ? { displacement } : {}),
        ...(Number.isFinite(modDistance) ? { distance: modDistance } : {}),
        ...(Number.isFinite(durabilityBefore) ? { durabilityBefore } : {}),
        ...(Number.isFinite(durabilityAfter) ? { durabilityAfter } : {}),
        endReason,
      }
      return {
        endReason,
        finalSnapshot: fresh,
        finalPosition: fresh.position,
        riptide: riptideReceipt,
      }
    }

    if (envelope.action === 'open_container') {
      const open = params.openContainer
      if (!open)
        throw new Error('open_container requires x, y, z')
      const menu = await openMenuAt(open.x, open.y, open.z, open.face)
      return { endReason: 'opened', finalSnapshot: await readFreshSnapshot() ?? ZERO_SNAPSHOT, menu }
    }

    if (envelope.action === 'read_menu') {
      const menuSnapshot = await readMenuSnapshot()
      return { endReason: 'menu_read', finalSnapshot: await readFreshSnapshot() ?? ZERO_SNAPSHOT, menuSnapshot }
    }

    if (envelope.action === 'close_menu') {
      const result = await callGameTool('menu_close', {})
      const error = gameToolResultError(result)
      if (error)
        throw new Error(error)
      const record = statusRecordOf(result)
      if (record?.error === 'no_menu' || record?.closed === false)
        throw new Error('no_menu')
      return { endReason: 'closed', finalSnapshot: await readFreshSnapshot() ?? ZERO_SNAPSHOT }
    }

    if (envelope.action === 'move_item') {
      const move = params.moveItem
      if (!move)
        throw new Error('move_item requires from and to')
      const before = await readMenuSnapshot()
      const source = before.slots.find(slot => slot.index === move.from)
      if (!source || source.empty || !source.id)
        throw new Error('slot_empty')
      const requested = Math.max(1, move.count ?? source.count ?? 1)
      const moved = await transferMenuStack(before.containerId, move.from, move.to, requested, shouldStop)
      return {
        endReason: moved >= requested ? 'moved' : 'not_confirmed',
        finalSnapshot: await readFreshSnapshot() ?? ZERO_SNAPSHOT,
        movedCount: moved,
        movedExpected: requested,
        moved: { containerId: before.containerId, from: move.from, to: move.to, requested, moved },
      }
    }

    if (envelope.action === 'craft_table') {
      const craft = params.craftTable
      if (!craft?.recipeId)
        throw new Error('craft_table requires recipeId')
      const menu = await openMenuAt(craft.x, craft.y, craft.z)
      if (menu.type !== 'minecraft:crafting')
        throw new Error('menu_not_crafting')
      // Clear a result left by an earlier craft before the baseline is read;
      // residue must never read as this command's output (gaps §4.1).
      const residue: Array<{ itemId: string, count: number }> = []
      const pre = await readMenuSnapshot()
      if (pre.containerId !== menu.containerId)
        throw new Error('menu_mismatch')
      const leftover = pre.slots.find(slot => slot.index === 0)
      if (leftover && !leftover.empty && leftover.id) {
        residue.push({ itemId: leftover.id, count: leftover.count ?? 1 })
        await menuClick(menu.containerId, 0, true)
      }
      const before = await readInventoryCounts()
      if (!before)
        throw new Error('mcp_unavailable: inventory read failed before craft_table')
      const placed = statusRecordOf(await callGameTool('menu_craft', { recipeId: craft.recipeId }))
      if (!placed)
        throw new Error('not_confirmed')
      if (typeof placed.error === 'string')
        throw new Error(placed.error)
      const expected = placed.expected && typeof placed.expected === 'object'
        ? placed.expected as { id?: unknown, count?: unknown }
        : undefined
      const outputItemId = expected && typeof expected.id === 'string' ? expected.id : craft.recipeId
      const expectedCount = Math.max(1, Number(expected?.count) || 1)
      const maxAttempts = Math.max(1, Math.min(craft.attempts ?? 5, 10))
      const deadline = Date.now() + envelope.deadlineMs
      let claimed = false
      let attempts = 0
      for (attempts = 1; attempts <= maxAttempts; attempts++) {
        if (writeStop.stopped)
          break
        if (Date.now() > deadline)
          break
        const snapshot = await readMenuSnapshot()
        if (snapshot.containerId !== menu.containerId)
          throw new Error('menu_mismatch')
        const output = snapshot.slots.find(slot => slot.index === 0)
        if (output && !output.empty && output.id) {
          await menuClick(menu.containerId, 0, true)
          claimed = true
          break
        }
        await sleep(400)
      }
      if (!claimed)
        throw new Error('not_confirmed')
      const after = await readInventoryCounts()
      if (!after)
        throw new Error('mcp_unavailable: inventory read failed after craft_table')
      const inventoryDelta = inventoryDeltaOf(before, after)
      return {
        endReason: 'crafted',
        finalSnapshot: await readFreshSnapshot() ?? ZERO_SNAPSHOT,
        craftedCount: Math.max(0, inventoryDelta[outputItemId] ?? 0),
        craftedExpected: expectedCount,
        crafted: {
          recipeId: craft.recipeId,
          output: { id: outputItemId, count: expectedCount },
          attempts,
          inventoryDelta,
          ...(residue.length > 0 ? { residue } : {}),
        },
      }
    }

    if (envelope.action === 'smelt_load') {
      const smelt = params.smeltLoad
      if (!smelt?.inputItemId)
        throw new Error('smelt_load requires inputItemId')
      const menu = await openMenuAt(smelt.x, smelt.y, smelt.z)
      const snapshot = await readMenuSnapshot()
      if (snapshot.containerId !== menu.containerId)
        throw new Error('menu_mismatch')
      if (!snapshot.furnace)
        throw new Error('not_furnace')
      const requested = Math.max(1, smelt.count ?? 1)
      const inputSlot = snapshot.slots.find(slot => slot.id === smelt.inputItemId && !slot.empty && typeof slot.invSlot === 'number')
      if (!inputSlot)
        throw new Error(`slot_empty: ${smelt.inputItemId} is not in the open menu`)
      const loaded = await transferMenuStack(menu.containerId, inputSlot.index, 0, requested, shouldStop)
      let fuelItemId: string | undefined
      if (smelt.fuelItemId) {
        fuelItemId = smelt.fuelItemId
        const fuelSlot = (await readMenuSnapshot()).slots.find(slot => slot.id === smelt.fuelItemId && !slot.empty && typeof slot.invSlot === 'number')
        if (fuelSlot)
          await transferMenuStack(menu.containerId, fuelSlot.index, 1, 1, shouldStop)
      }
      // Bounded cooking check: report the observed progress and return; the
      // furnace keeps working without holding the player's input (gaps §4.1).
      let cooking = snapshot.furnace
      const checkUntil = Math.min(Date.now() + envelope.deadlineMs, Date.now() + 3_000)
      while (Date.now() < checkUntil) {
        if (writeStop.stopped)
          break
        await sleep(500)
        const next = await readMenuSnapshot()
        if (next.containerId !== menu.containerId)
          throw new Error('menu_mismatch')
        if (next.furnace) {
          cooking = next.furnace
          if (next.furnace.lit || next.furnace.cookProgress > 0)
            break
        }
      }
      const stage: GameSmeltReceipt['stage'] = cooking.lit || cooking.cookProgress > 0 ? 'cooking' : 'loaded'
      return {
        endReason: stage,
        finalSnapshot: await readFreshSnapshot() ?? ZERO_SNAPSHOT,
        smelt: {
          containerId: menu.containerId,
          stage,
          inputItemId: smelt.inputItemId,
          ...(fuelItemId ? { fuelItemId } : {}),
          requested,
          loaded,
          cooking,
        },
      }
    }

    if (envelope.action === 'smelt_take') {
      const smelt = params.smeltTake
      if (!smelt)
        throw new Error('smelt_take requires x, y, z')
      const menu = await openMenuAt(smelt.x, smelt.y, smelt.z)
      const snapshot = await readMenuSnapshot()
      if (snapshot.containerId !== menu.containerId)
        throw new Error('menu_mismatch')
      if (!snapshot.furnace)
        throw new Error('not_furnace')
      const output = snapshot.slots.find(slot => slot.index === 2)
      if (!output || output.empty || !output.id)
        throw new Error('slot_empty')
      const before = await readInventoryCounts()
      if (!before)
        throw new Error('mcp_unavailable: inventory read failed before smelt_take')
      const outputCount = output.count ?? 1
      await menuClick(menu.containerId, 2, true)
      const after = await readInventoryCounts()
      if (!after)
        throw new Error('mcp_unavailable: inventory read failed after smelt_take')
      const delta = Math.max(0, (after[output.id] ?? 0) - (before[output.id] ?? 0))
      // Leftover input/fuel stay in the furnace. Record them, but the output
      // claim stays scoped to the measured output delta.
      const residue: Array<{ itemId: string, count: number }> = []
      const post = await readMenuSnapshot()
      for (const index of [0, 1]) {
        const slot = post.slots.find(item => item.index === index)
        if (slot && !slot.empty && slot.id)
          residue.push({ itemId: slot.id, count: slot.count ?? 1 })
      }
      const inputItemId = residue.find(item => item.itemId !== output.id)?.itemId
      return {
        endReason: 'taken',
        finalSnapshot: await readFreshSnapshot() ?? ZERO_SNAPSHOT,
        movedCount: delta,
        movedExpected: outputCount,
        smelt: {
          containerId: menu.containerId,
          stage: 'taken',
          ...(inputItemId ? { inputItemId } : {}),
          requested: outputCount,
          taken: { itemId: output.id, count: delta },
          ...(residue.length > 0 ? { residue } : {}),
        },
      }
    }

    if (envelope.action === 'menu_action') {
      const menuAction = params.menuAction
      if (!menuAction)
        throw new Error('menu_action requires action')
      // Read the open menu first: `no_menu` comes from this read, and the type
      // gates select_trade/set_name before any mod primitive is called.
      const snapshot = await readMenuSnapshot()
      const containerId = snapshot.containerId
      if (menuAction.action === 'select_trade') {
        if (snapshot.type !== 'minecraft:merchant')
          throw new Error('menu_not_trade')
        if (typeof menuAction.index !== 'number')
          throw new Error('menu_action select_trade requires index')
        const result = await callGameTool('menu_select_trade', { index: menuAction.index })
        const error = gameToolResultError(result)
        if (error)
          throw new Error(error)
        const record = statusRecordOf(result)
        if (record?.error === 'menu_mismatch')
          throw new Error('menu_mismatch')
        if (!record || record.accepted !== true)
          throw new Error(typeof record?.error === 'string' ? record.error : 'not_confirmed')
        const offer = parseTradeOffer(record.offer)
        return {
          endReason: 'trade_selected',
          finalSnapshot: await readFreshSnapshot() ?? ZERO_SNAPSHOT,
          menuAction: { containerId, action: 'select_trade', accepted: true, ...(offer ? { offer } : {}) },
        }
      }
      if (menuAction.action === 'set_name') {
        if (snapshot.type !== 'minecraft:anvil')
          throw new Error('menu_not_anvil')
        const result = await callGameTool('menu_set_name', { text: menuAction.text ?? '' })
        const error = gameToolResultError(result)
        if (error)
          throw new Error(error)
        const record = statusRecordOf(result)
        if (record?.error === 'menu_mismatch')
          throw new Error('menu_mismatch')
        if (!record || record.accepted !== true)
          throw new Error(typeof record?.error === 'string' ? record.error : 'not_confirmed')
        const name = typeof record.name === 'string' ? record.name : undefined
        return {
          endReason: 'renamed',
          finalSnapshot: await readFreshSnapshot() ?? ZERO_SNAPSHOT,
          menuAction: { containerId, action: 'set_name', accepted: true, ...(name !== undefined ? { name } : {}) },
        }
      }
      if (menuAction.action === 'beacon') {
        if (snapshot.type !== 'minecraft:beacon')
          throw new Error('menu_not_beacon')
        const primary = typeof menuAction.primary === 'string' ? menuAction.primary.trim() : ''
        if (!primary)
          throw new Error('beacon requires primary')
        const secondary = typeof menuAction.secondary === 'string' && menuAction.secondary.trim() ? menuAction.secondary.trim() : undefined
        // Live MC-4f: BeaconMenu does not implement clickMenuButton, so the
        // generic button path cannot settle a beacon. The mod sends the vanilla
        // `ServerboundSetBeaconPacket`; there is no synchronous verdict, so the
        // receipt reports the packet was sent and whether a bounded fresh
        // status-effect read observed the requested primary effect.
        const result = await callGameTool('menu_set_beacon_effects', { primary, ...(secondary ? { secondary } : {}) })
        const error = gameToolResultError(result)
        if (error)
          throw new Error(error)
        const record = statusRecordOf(result)
        if (!record || record.sent !== true)
          throw new Error(typeof record?.error === 'string' ? record.error : 'not_confirmed')
        // Live MC-4f: a beacon effect can lag the packet by more than two
        // seconds on a real server, so the read window is four seconds.
        const applied = await waitForStatusEffect(primary, 4_000)
        return {
          endReason: applied ? 'beacon_applied' : 'beacon_sent',
          finalSnapshot: await readFreshSnapshot() ?? ZERO_SNAPSHOT,
          menuAction: { containerId, action: 'beacon', sent: true, applied },
        }
      }
      if (typeof menuAction.id !== 'number')
        throw new Error('menu_action button requires id')
      // Live MC-4f: the mod used to call the client menu's clickMenuButton,
      // which only mutated the local copy (enchanting reported accepted while
      // the server consumed nothing). The mod now sends the vanilla
      // button-click packet, so there is no synchronous verdict: the receipt
      // reports that the click was sent and whether a bounded re-read saw the
      // menu change. An idempotent button legitimately shows applied:false.
      const beforeKey = menuSnapshotKey(snapshot)
      const result = await callGameTool('menu_button', { id: menuAction.id })
      const error = gameToolResultError(result)
      if (error)
        throw new Error(error)
      const record = statusRecordOf(result)
      if (record?.error === 'no_menu')
        throw new Error('no_menu')
      if (!record || record.sent !== true)
        throw new Error('not_confirmed')
      if (Number(record.containerId) !== containerId)
        throw new Error('menu_mismatch')
      const applied = await waitForMenuChange(beforeKey, 1_500)
      return {
        endReason: applied ? 'button_applied' : 'button_sent',
        finalSnapshot: await readFreshSnapshot() ?? ZERO_SNAPSHOT,
        menuAction: { containerId, action: 'button', sent: true, applied },
      }
    }

    if (envelope.action === 'read_item') {
      const read = params.readItem
      const result = await callGameTool('read_item', read?.slot !== undefined ? { slot: read.slot } : {})
      const error = gameToolResultError(result)
      if (error)
        throw new Error(error)
      const record = statusRecordOf(result)
      if (!record)
        throw new Error('read_item returned no data')
      const itemId = typeof record.itemId === 'string' ? record.itemId : ''
      const unsupported = record.unsupported === true || record.error === 'unsupported_item' || !itemId
      const content: GameItemContentReceipt = { itemId, ...(unsupported ? { unsupported: true } : {}) }
      if (typeof record.title === 'string')
        content.title = record.title
      if (typeof record.author === 'string')
        content.author = record.author
      if (Array.isArray(record.pages))
        content.pages = record.pages.filter((page): page is string => typeof page === 'string')
      const mapRaw = record.map
      if (mapRaw && typeof mapRaw === 'object' && !Array.isArray(mapRaw)) {
        const map = mapRaw as Record<string, unknown>
        const id = Number(map.id)
        if (Number.isFinite(id)) {
          content.map = {
            id,
            ...(Number.isFinite(Number(map.scale)) ? { scale: Number(map.scale) } : {}),
            ...(typeof map.dimension === 'string' ? { dimension: map.dimension } : {}),
          }
        }
      }
      if (record.truncated === true)
        content.truncated = true
      // Observation only: `none` postcondition keeps `checked=false`, so untrusted
      // book text can never satisfy a completion gate.
      return {
        endReason: unsupported ? 'unsupported_item' : 'read',
        finalSnapshot: await readFreshSnapshot() ?? ZERO_SNAPSHOT,
        itemContent: content,
      }
    }

    if (envelope.action === 'read_sign') {
      const sign = params.readSign
      if (!sign)
        throw new Error('read_sign requires x, y, z')
      const result = await callGameTool('read_sign', { x: sign.x, y: sign.y, z: sign.z })
      const error = gameToolResultError(result)
      if (error)
        throw new Error(error)
      const record = statusRecordOf(result)
      if (!record || record.error === 'not_sign')
        throw new Error('not_sign')
      const lines = Array.isArray(record.lines)
        ? record.lines.filter((line): line is string => typeof line === 'string')
        : []
      const content: GameSignContentReceipt = { lines }
      if (Array.isArray(record.back)) {
        const back = record.back.filter((line): line is string => typeof line === 'string')
        if (back.some(line => line.length > 0))
          content.back = back
      }
      if (record.truncated === true)
        content.truncated = true
      return {
        endReason: 'read',
        finalSnapshot: await readFreshSnapshot() ?? ZERO_SNAPSHOT,
        signContent: content,
      }
    }

    if (envelope.action === 'place') {
      const place = params.place
      if (!place)
        throw new Error('place requires x, y, z')
      const faceName = place.face && PLACE_FACE_STEPS[place.face] ? place.face : 'up'
      const step = PLACE_FACE_STEPS[faceName]
      const count = Math.max(1, Math.min(place.count ?? 1, 16))
      const attempts = Math.max(1, Math.min(place.attempts ?? 3, 10))

      // A world placement with a screen open is dropped by the client; fail
      // typed before any inventory shuffle instead of a bare not_confirmed.
      if (await hasOpenMenu())
        throw new Error('menu_open: close the open menu before placing')

      // Item resolution: explicit id, else the held item. An empty hand or an
      // unreachable item is the typed `not_in_inventory` failure.
      let resolvedItemId = place.itemId
      if (!resolvedItemId) {
        const equipment = await readEquipment()
        resolvedItemId = equipment ? equipmentItemIdOf(equipment, 'main_hand') ?? undefined : undefined
        if (!resolvedItemId)
          throw new Error('not_in_inventory: no held item to place')
      }
      const itemId: string = resolvedItemId
      await ensureItemSelected(itemId)

      const blocks: GamePlacedBlock[] = []
      let placedCount = 0
      let endReason = 'placed'
      const countOfItem = async (): Promise<number> => (await readInventoryCounts())?.[itemId] ?? 0

      for (let index = 0; index < count; index++) {
        if (writeStop.stopped) {
          endReason = 'cancelled'
          break
        }
        const target = {
          x: place.x + step.x * index,
          y: place.y + step.y * index,
          z: place.z + step.z * index,
        }
        // Re-select each block: a stack can run out while the same item remains
        // in another hotbar/main slot. No material means the block is reported.
        let held = await countOfItem()
        try {
          await ensureItemSelected(itemId)
          held = await countOfItem()
        }
        catch {
          blocks.push({ ...target, ok: false, reason: 'not_in_inventory' })
          endReason = 'not_in_inventory'
          break
        }
        if (held <= 0) {
          blocks.push({ ...target, ok: false, reason: 'not_in_inventory' })
          endReason = 'not_in_inventory'
          break
        }

        const existing = await readBlockIdAt(target)
        if (existing === undefined) {
          blocks.push({ ...target, ok: false, reason: 'not_confirmed' })
          endReason = 'not_confirmed'
          break
        }
        if (existing !== '' && !PLACE_TARGET_REPLACEABLE.has(existing)) {
          blocks.push({ ...target, ok: false, reason: 'blocked' })
          endReason = 'blocked'
          break
        }

        const support = { x: target.x - step.x, y: target.y - step.y, z: target.z - step.z }
        let ok = false
        let reason: string | undefined
        for (let attempt = 0; attempt < attempts; attempt++) {
          if (writeStop.stopped) {
            reason = 'cancelled'
            break
          }
          const before = held
          const result = await callGameTool('place_block', {
            x: support.x,
            y: support.y,
            z: support.z,
            face: faceName,
            ...(place.sneak === true ? { sneak: true } : {}),
            ...(typeof place.yaw === 'number' ? { yaw: place.yaw } : {}),
            expectBlockId: itemId,
          })
          const error = gameToolResultError(result)
          if (error) {
            reason = error
            continue
          }
          // Verification is a fresh world read plus an inventory decrease, not
          // the mod's own claim (mc-0c completion discipline).
          const after = await readBlockIdAt(target)
          const afterCount = await countOfItem()
          if (after === itemId && afterCount < before) {
            ok = true
            break
          }
          reason = after !== undefined && after !== itemId && !PLACE_TARGET_REPLACEABLE.has(after)
            ? 'blocked'
            : 'not_confirmed'
          await sleep(250)
        }
        blocks.push(ok ? { ...target, ok: true } : { ...target, ok: false, reason: reason ?? 'not_confirmed' })
        if (ok) {
          placedCount += 1
        }
        else {
          endReason = reason ?? 'not_confirmed'
          break
        }
      }

      const placedReceipt: GamePlacedReceipt = { itemId, requested: count, placed: placedCount, blocks }
      return {
        endReason: placedCount >= count ? 'placed' : endReason,
        finalSnapshot: await readFreshSnapshot() ?? ZERO_SNAPSHOT,
        placedCount,
        placedExpected: count,
        placed: placedReceipt,
      }
    }

    if (envelope.action === 'break') {
      const breakBlock = params.breakBlock
      if (!breakBlock)
        throw new Error('break requires x, y, z')
      const target = { x: breakBlock.x, y: breakBlock.y, z: breakBlock.z }
      const mode = breakBlock.mode

      // Fresh read first: a target that is already air is a typed failure, not
      // a break. An unreadable read is a confirmation failure.
      const existingId = await readBlockIdAt(target)
      if (existingId === undefined) {
        return {
          endReason: 'not_confirmed',
          finalSnapshot: await readFreshSnapshot() ?? ZERO_SNAPSHOT,
          broken: { ...target, blockId: '', mode },
        }
      }
      if (existingId === '' || existingId.endsWith('air')) {
        return {
          endReason: 'already_air',
          finalSnapshot: await readFreshSnapshot() ?? ZERO_SNAPSHOT,
          broken: { ...target, blockId: existingId, mode },
        }
      }

      // The executor never walks: an out-of-reach block is a typed failure and
      // the caller walks with move_to first.
      const self = await readFreshSnapshot()
      const position = self?.position
      if (!position)
        throw new Error('not_confirmed: player position unavailable')
      const distance = Math.hypot(target.x + 0.5 - position.x, target.y + 0.5 - position.y, target.z + 0.5 - position.z)
      if (distance > BREAK_REACH) {
        return {
          endReason: 'out_of_reach',
          finalSnapshot: self ?? ZERO_SNAPSHOT,
          broken: { ...target, blockId: existingId, mode },
        }
      }

      // CD-M1: one mining session owns evaluation, tool selection, equip and
      // the break poll. An unavailable evaluation keeps the explicit manual
      // break; a rejection stops before any mining instead of lowering the
      // harvest requirement.
      const session = createMiningSession(shouldStop)
      const breakId = nextBreakId(envelope.commandId)
      const prepared = await session.prepare(target, {
        strategy: breakBlock.strategy ?? 'conserve',
        ...(breakBlock.itemId ? { expectedItemId: breakBlock.itemId } : {}),
        ...(breakBlock.tool ? { toolItemId: breakBlock.tool } : {}),
        plannedBlocks: 1,
      })

      if (prepared.status === 'rejected') {
        return {
          endReason: prepared.rejection.reason,
          finalSnapshot: await readFreshSnapshot() ?? ZERO_SNAPSHOT,
          broken: {
            ...target,
            blockId: existingId,
            mode,
            breakId,
            rejection: {
              reason: prepared.rejection.reason,
              ...(prepared.rejection.detail ? { detail: prepared.rejection.detail } : {}),
            },
          },
        }
      }

      const tool = prepared.status === 'ready' ? prepared.equipped : undefined
      const hazards = prepared.status === 'ready' ? prepared.hazards : []
      const durability = prepared.status === 'ready' ? prepared.selection?.durability : undefined
      const baseReceipt: GameBrokenReceipt = {
        ...target,
        blockId: existingId,
        mode,
        breakId,
        ...(tool ? { tool } : {}),
        ...(hazards.length > 0 ? { hazards } : {}),
        ...(durability
          ? { durability: { known: durability.known, remaining: durability.remaining, expectedBlocks: durability.expectedBlocks, riskOfBreak: durability.riskOfBreak } }
          : {}),
      }

      // A tool that may run out before the block is refused, not consumed.
      if (prepared.status === 'ready' && prepared.durabilityRisk) {
        return {
          endReason: 'tool_durability_low',
          finalSnapshot: await readFreshSnapshot() ?? ZERO_SNAPSHOT,
          broken: baseReceipt,
        }
      }

      const pollMs = Math.min(envelope.deadlineMs, BREAK_POLL_MS)
      // The pickup baseline is read before the break so only the increase the
      // break caused is attributed to it.
      const productBaseline = breakBlock.itemId ? ((await readInventoryCounts())?.[breakBlock.itemId] ?? 0) : 0
      const outcome = prepared.status === 'ready'
        ? await session.runBreak(prepared, { breakId, commandId: envelope.commandId, mode, pollMs })
        : await session.runManualBreak({ breakId, commandId: envelope.commandId, pos: target, blockIdBefore: existingId, mode, pollMs })

      if (outcome.status === 'cancelled') {
        return {
          endReason: 'cancelled',
          finalSnapshot: await readFreshSnapshot() ?? ZERO_SNAPSHOT,
          broken: baseReceipt,
        }
      }
      if (outcome.status !== 'broken') {
        return {
          endReason: outcome.status === 'refused' ? 'refused' : 'not_confirmed',
          finalSnapshot: await readFreshSnapshot() ?? ZERO_SNAPSHOT,
          broken: {
            ...baseReceipt,
            ...(outcome.blockIdAfter !== undefined ? { lastBlockId: outcome.blockIdAfter } : {}),
          },
        }
      }

      // A required product makes the block disappearance insufficient: wait for
      // the pickup in a bounded window and report the graded attribution.
      if (breakBlock.itemId) {
        await session.waitForPickup(breakId, breakBlock.itemId, productBaseline, 5_000)
        const attribution = session.attribution(breakId, breakBlock.itemId)
        const met = attribution.lowerBound >= 1
        return {
          endReason: met ? 'broken' : 'broken_no_product',
          finalSnapshot: await readFreshSnapshot() ?? ZERO_SNAPSHOT,
          brokenCount: met ? 1 : 0,
          broken: {
            ...baseReceipt,
            product: {
              itemId: breakBlock.itemId,
              count: attribution.lowerBound,
              lowerBound: attribution.lowerBound,
              fuzzy: attribution.fuzzy,
              evidence: attribution.evidence,
            },
          },
        }
      }

      return {
        endReason: 'broken',
        finalSnapshot: await readFreshSnapshot() ?? ZERO_SNAPSHOT,
        brokenCount: 1,
        broken: baseReceipt,
      }
    }

    if (envelope.action === 'observe') {
      const selfResult = await callGameTool('get_self')
      const selfError = gameToolResultError(selfResult)
      if (selfError)
        throw new Error(selfError)
      const self = statusRecordOf(selfResult)
      if (!self)
        throw new Error('get_self returned no player state')

      // MC-4a: gather the surrounding reads beside the player state. Each read
      // is best-effort; a failure is named in `missing` and never fails the
      // observation.
      const missing: string[] = []
      let truncated = false
      let inventory: Record<string, unknown> | undefined
      try {
        const read = statusRecordOf(await callGameTool('get_inventory'))
        if (read) {
          const capped = capObservedInventory(read)
          inventory = capped.inventory
          truncated = capped.truncated
        }
        else {
          missing.push('inventory')
        }
      }
      catch {
        missing.push('inventory')
      }

      let equipment: Record<string, unknown> | undefined
      try {
        equipment = statusRecordOf(await callGameTool('get_equipment'))
        if (!equipment)
          missing.push('equipment')
      }
      catch {
        missing.push('equipment')
      }

      let effects: Record<string, unknown> | undefined
      try {
        effects = statusRecordOf(await callGameTool('get_status_effects'))
        if (!effects)
          missing.push('effects')
      }
      catch {
        missing.push('effects')
      }

      // Best-effort region read for endpoints that expose the world-read group.
      try {
        const from = { x: Math.floor(Number(self.x) || 0) - 2, y: Math.floor(Number(self.y) || 0) - 1, z: Math.floor(Number(self.z) || 0) - 2 }
        const to = { x: Math.floor(Number(self.x) || 0) + 2, y: Math.floor(Number(self.y) || 0) + 1, z: Math.floor(Number(self.z) || 0) + 2 }
        await callGameTool('get_blocks_region', { from, to, includeAir: false })
      }
      catch {
        // Region read is optional for MC-0c.
      }
      return {
        endReason: 'observed',
        finalSnapshot: snapshotFrom(self, inventory),
        observedRadius: params.observe?.radius ?? 16,
        observed: {
          ...(inventory ? { inventory } : {}),
          ...(equipment ? { equipment } : {}),
          ...(effects ? { effects } : {}),
          ...(missing.length > 0 ? { missing } : {}),
          ...(truncated ? { truncated: true } : {}),
        },
      }
    }

    const moveTo = params.moveTo
    if (!moveTo)
      throw new Error('move_to requires a target')
    const fallback = await readFreshSnapshot() ?? { position: { x: 0, y: 0, z: 0 }, health: 0, food: 0, heldItem: null }
    if (movementPlannerOf() === 'terrain')
      return await executeTerrainMoveTo(envelope, moveTo, fallback, shouldStop)
    // MCP tool names, not bridge method names: the private session talks to
    // the Node MCP server (mc-0c executor mapping).
    const pathResult = await callGameTool('navigate_to', {
      x: moveTo.x,
      y: moveTo.y,
      z: moveTo.z,
      reachRadius: moveTo.tolerance,
      timeoutSeconds: Math.max(1, Math.round(envelope.deadlineMs / 1000)),
      // Reflex events echo this id when they preempt the walk (mc-0d).
      commandId: envelope.commandId,
    })
    const pathError = gameToolResultError(pathResult)
    if (pathError) {
      return {
        endReason: pathError.toLowerCase().includes('unreachable') ? 'unreachable' : 'executor_error',
        finalSnapshot: fallback,
      }
    }

    const pollUntil = Date.now() + envelope.deadlineMs + 5_000
    let status: Record<string, unknown> | undefined
    while (Date.now() < pollUntil) {
      await sleep(500)
      try {
        status = statusRecordOf(await callGameTool('navigation_status'))
      }
      catch {
        break
      }
      if (status && status.active === false && status.endReason !== 'navigating')
        break
    }
    const fresh = await readFreshSnapshot() ?? fallback
    return {
      endReason: String(status?.endReason ?? 'executor_error'),
      finalSnapshot: fresh,
      finalPosition: finalPositionOf(status) ?? fresh.position,
    }
  }

  /**
   * Asks the game side to release input for one captured session.
   *
   * CD-0 D8: only the scope that the token owns is marked stopped. A late
   * `finally` or async callback from an older command still passes its old
   * token and must not stop the session a newer command now owns.
   */
  async function stopGameAction(input: { envelope: GameCommandEnvelope, token: GameExecutionToken }): Promise<boolean> {
    // Signal the multi-step loops first, then release the game-side controls.
    writeStopScope = stopScopeFor(writeStopScope, input.token)
    let confirmed = false
    try {
      await callGameTool('stop_navigation')
      confirmed = true
    }
    catch {
      // Navigation may not be active; the control stop below still counts.
    }
    try {
      await callGameTool('stop_movement')
      confirmed = true
    }
    catch {
      // Movement control may not be active either.
    }
    // MC-4d: a weapon task aborts through its state-aware path here; the
    // executor loop also calls it, so this covers a stop that lands between
    // polls. Best-effort: an already-finished task reports its own terminal.
    try {
      await callGameTool('combat_cancel')
      confirmed = true
    }
    catch {
      // No weapon task, or the bridge is already gone.
    }
    // MC-4e: a riptide charge is aborted with `stopUsingItem` so the release
    // that would propel the player never fires.
    try {
      await callGameTool('riptide_cancel')
      confirmed = true
    }
    catch {
      // No riptide task, or the bridge is already gone.
    }
    // Join the executor so the cancel receipt carries the facts it observed.
    // Only this session's run is joined; a late stop for an old command must
    // not wait on (or confirm against) a newer command's run.
    if (inFlightExecution && inFlightToken?.controlSessionId === input.token.controlSessionId) {
      try {
        await Promise.race([
          inFlightExecution,
          sleep(1_500),
        ])
        confirmed = true
      }
      catch {
        // The executor already settled; the registry keeps that receipt.
      }
    }
    return confirmed
  }

  const registry = createGameCommandRegistry({
    executor: {
      execute: (input) => {
        const run = executeGameAction(input.envelope, input.params, input.token)
        // Track the in-flight run so a cancel can join it and keep the facts it
        // observed; clear only when this same run finishes.
        const tracked = run.then(() => undefined, () => undefined)
        inFlightExecution = tracked
        inFlightToken = input.token
        void tracked.finally(() => {
          if (inFlightExecution === tracked) {
            inFlightExecution = undefined
            inFlightToken = undefined
          }
        })
        return run
      },
      stop: stopGameAction,
    },
    getBinding: () => ({
      connectionGeneration,
      worldId: worldIdentity?.worldId ?? 'connection-scoped',
      dimension: worldIdentity?.dimension ?? '',
    }),
  })

  /**
   * Detects a live dimension change from a fresh `get_self` record (MC-4e).
   *
   * `worldIdentity.dimension` is the binding dimension the current commands
   * were minted with. A player who crosses a portal reports a new dimension on
   * the next read, and the old commands must not continue. The connection
   * generation is deliberately not bumped: the same connection now owns a new
   * world binding, and new commands bind to the refreshed dimension. The last
   * terminal receipt is dropped so `game_status` never presents a pre-change
   * world as current, and the active write command is stopped with
   * `dimension_changed` (its terminal receipt keeps the dimension it was
   * issued for).
   *
   * Runs after every fresh player read, so the movement/world caches below are
   * always read from the connection the caller currently owns.
   */
  async function noteLiveDimension(self: Record<string, unknown>): Promise<void> {
    const dimension = firstText(self.dimension)
    if (!dimension)
      return
    if (!worldIdentity) {
      // §9-1: a connection established with no player in the world has no
      // binding to compare against. The first fresh read that carries a
      // dimension repairs the binding instead of leaving commands unbound.
      worldIdentity = await buildWorldIdentityFromLive(self)
      if (!worldIdentity)
        return
      lastReceipt = undefined
      return
    }
    // A connection that came up before a player joined can already own a
    // version/world with an empty dimension. The first live read fills the
    // dimension and any player id that was missing.
    const playerUuid = firstText(self.playerUuid, self.player_uuid, self.uuid)
    const dimensionChanged = dimension !== worldIdentity.dimension
    const uuidFilled = !worldIdentity.playerUuid && !!playerUuid
    if (!dimensionChanged && !uuidFilled)
      return
    worldIdentity = {
      ...worldIdentity,
      dimension,
      ...(uuidFilled && playerUuid ? { playerUuid } : {}),
    }
    lastReceipt = undefined
    if (!dimensionChanged)
      return

    // The registry owns the terminal receipt; stopActive ends the active write
    // command with the typed reason and asks the executor to release input.
    void registry.stopActive('dimension_changed').catch(() => {})
  }

  /**
   * Builds the world identity from the cached `get_status` record and one fresh
   * `get_self` read.
   *
   * Reads `get_status` once more when the connect-time read failed, so a bridge
   * that came up without a player can still bind when a player joins. Returns
   * undefined when no Minecraft version can be read; the connection stays
   * healthy and a later fresh read retries.
   */
  async function buildWorldIdentityFromLive(self: Record<string, unknown>): Promise<GameWorldIdentity | undefined> {
    if (!lastStatusRecord) {
      try {
        lastStatusRecord = statusRecordOf(await callGameTool('get_status'))
      }
      catch {
        return undefined
      }
    }
    return gameWorldIdentityFrom({ structuredContent: lastStatusRecord ?? {} }, { structuredContent: self })
  }

  function currentStatus(): GameHostStatus {
    if (client) {
      return {
        status: 'connected',
        ...(worldIdentity ? { identity: worldIdentity } : {}),
        ...(capabilities ? { capabilities } : {}),
      }
    }

    return lastError
      ? { status: 'error', error: lastError }
      : { status: 'unconfigured' }
  }

  // MC-3c X-10: bounded chat-command ingestion. A cursor over the bridge event
  // ring buffer plus a rate limit keeps a busy server chat from flooding turns.
  let chatCommandTimer: ReturnType<typeof setInterval> | undefined
  let chatCommandCursor = 0
  let chatCommandInFlight = false
  let chatCommandReady = false
  let lastChatCommandAt = 0
  let lastChatPollWarnAt = 0
  /** Recent chat lines for delivery context; blocked and own lines never enter. */
  const chatContextBuffer: GameHostChatContextLine[] = []

  function stopChatCommandPolling(): void {
    if (chatCommandTimer) {
      clearInterval(chatCommandTimer)
      chatCommandTimer = undefined
    }
    chatCommandReady = false
    // Context is per connection: a reconnect can switch worlds and servers.
    chatContextBuffer.length = 0
  }

  function startChatCommandPolling(): void {
    stopChatCommandPolling()
    if (!client || !config?.chatCommands?.enabled)
      return
    log.withFields({
      admins: config.chatCommands.admins,
      blocked: config.chatCommands.blocked,
      mentionlessSampleRate: config.chatCommands.mentionlessSampleRate,
      contextLines: config.chatCommands.contextLines,
    }).log('chat command polling started')
    void seedChatCommandCursor()
    chatCommandTimer = setInterval(() => void pollChatCommands(), 1_000)
    chatCommandTimer.unref?.()
  }

  /**
   * Skips history: only messages that arrive after this connection become
   * commands, so a restart cannot replay earlier owner chat.
   */
  async function seedChatCommandCursor(): Promise<void> {
    try {
      const record = statusRecordOf(await callGameTool('poll_events', { limit: 50, sinceId: 0, types: ['chat'] }))
      const { events, lastId } = chatCommandEventsOf(record)
      for (const event of events)
        chatCommandCursor = Math.max(chatCommandCursor, event.id)
      if (lastId !== undefined) {
        // A ring below the previous cursor means a new client session: the
        // helper reseeds so the seed itself cannot leave the link deaf.
        const seeded = nextChatCursor(chatCommandCursor, lastId)
        if (seeded < chatCommandCursor)
          log.withFields({ cursor: chatCommandCursor, lastId }).log('chat event ring restarted while seeding; cursor reseeded')
        chatCommandCursor = seeded
      }
      log.withFields({ cursor: chatCommandCursor }).log('chat command cursor seeded')
    }
    catch (error) {
      // Seeding is best-effort; the owner filter still guards ingestion.
      log.withError(error).warn('chat command cursor seed failed')
    }
    finally {
      chatCommandReady = true
    }
  }

  async function pollChatCommands(): Promise<void> {
    if (chatCommandInFlight || !client || !chatCommandReady)
      return
    chatCommandInFlight = true
    try {
      // The MCP tool name is `poll_events` (its RPC method is events.getRecent).
      const record = statusRecordOf(await callGameTool('poll_events', { limit: 50, sinceId: chatCommandCursor, types: ['chat'] }))
      const { events, lastId } = chatCommandEventsOf(record)
      // A game client restart resets the event ring, so its ids can fall below
      // the cursor. Without a reseed every new message stays below the cursor
      // and the chat link goes deaf (live 2026-09-14).
      if (lastId !== undefined && lastId < chatCommandCursor) {
        log.withFields({ cursor: chatCommandCursor, lastId }).log('chat event ring restarted; cursor reseeded')
        chatCommandCursor = nextChatCursor(chatCommandCursor, lastId)
      }
      const self = { uuid: worldIdentity?.playerUuid }
      for (const event of events) {
        if (event.id <= chatCommandCursor)
          continue
        chatCommandCursor = event.id
        const verdict = classifyChatEvent(event, config?.chatCommands, self)
        const now = Date.now()
        // Admins deliver every message. Mention and sampled deliveries share a
        // 2-second gate so a busy chat cannot flood turns; admin deliveries do
        // not consume that window.
        if (verdict.eligible && (verdict.trigger === 'admin' || now - lastChatCommandAt >= CHAT_COMMAND_MIN_INTERVAL_MS)) {
          if (verdict.trigger !== 'admin')
            lastChatCommandAt = now
          log.withFields({ messageId: event.id, sender: event.sender, trigger: verdict.trigger }).log('accepted MC chat command')
          const chatContext = chatContextOf(chatContextBuffer, config?.chatCommands?.contextLines ?? 5)
          // The plain context cannot reach renderers on its own; the broadcast
          // hub is the same path life-mode ticks use.
          ;(options.broadcast?.broadcast ?? context.emit)(gameHostChatCommandEmitted, {
            messageId: event.id,
            sender: event.sender,
            senderUuid: event.senderUuid,
            text: verdict.text,
            trigger: verdict.trigger,
            context: chatContext,
            receivedAt: now,
            ...(worldIdentity && connectionId
              ? {
                  world: {
                    worldId: worldIdentity.worldId,
                    dimension: worldIdentity.dimension,
                    connectionGeneration,
                    connectionId,
                  },
                }
              : {}),
          })
        }
        // The context buffer follows the whole conversation, minus the
        // blocklist and her own echo, including lines that never became turns.
        if (isContextEligible(event, config?.chatCommands, self)) {
          chatContextBuffer.push({ sender: event.sender, text: event.text })
          if (chatContextBuffer.length > CHAT_CONTEXT_BUFFER_LINES)
            chatContextBuffer.splice(0, chatContextBuffer.length - CHAT_CONTEXT_BUFFER_LINES)
        }
      }
      // Advance past non-chat events too, so the scanned window stays small.
      if (lastId !== undefined && lastId > chatCommandCursor)
        chatCommandCursor = lastId
    }
    catch (error) {
      // A polling failure only costs this tick; the next tick retries. Warn at
      // most once per 30s so a persistent failure stays visible without spam.
      const now = Date.now()
      if (now - lastChatPollWarnAt > 30_000) {
        lastChatPollWarnAt = now
        log.withError(error).warn('chat command poll failed')
      }
    }
    finally {
      chatCommandInFlight = false
    }
  }

  async function disconnect(): Promise<void> {
    stopChatCommandPolling()
    // Invalidate every in-flight command before the connection goes away; the
    // executor's stop fails fast once the client is gone.
    for (const commandId of registry.listActive())
      await registry.cancel(commandId).catch(() => {})
    // A container menu outlives the command that opened it, so close it here
    // rather than silently leaving it open across a reconnect. Best-effort: an
    // already-dead bridge has closed the menu on its side.
    try {
      await callGameTool('menu_close')
    }
    catch {
      // No open container, or the bridge is already gone.
    }
    const previous = client
    const previousServer = serverClient
    client = undefined
    serverClient = undefined
    worldIdentity = undefined
    lastStatusRecord = undefined
    capabilities = undefined
    connectionId = ''
    void previousServer?.close().catch(() => {})
    // Withdraw only a published capability. `connect()` calls this before
    // every (re)connect, and the plugin-host rejects withdrawing twice
    // (`withdrawn -> withdrawn`), which broke disconnect-then-reconnect.
    if (previous) {
      options.capabilities?.withdraw()
      await previous.close().catch(() => {})
    }
  }

  async function connect(): Promise<GameHostStatus> {
    if (!config) {
      lastError = undefined
      return { status: 'unconfigured' }
    }

    // MC-0a rule: only loopback endpoints are reachable. A non-loopback host
    // throws before any connection is attempted; no port guessing happens.
    try {
      assertLoopbackEndpoint(config.url)
    }
    catch (error) {
      lastError = errorMessageFrom(error) ?? 'Failed to validate game bridge endpoint'
      return { status: 'error', error: lastError }
    }

    await disconnect()

    let nextClient: Client | undefined
    try {
      const headers: Record<string, string> = {}
      if (config.token)
        headers.Authorization = `Bearer ${config.token}`
      const nextTransport = new StreamableHTTPClientTransport(new URL(config.url), {
        requestInit: { headers },
      })
      nextClient = new Client({
        name: 'proj-airi:stage-tamagotchi:game-host',
        version: app.getVersion(),
      })
      await nextClient.connect(nextTransport)
      client = nextClient
      connectionGeneration += 1
      // CD-0 §3.3: discover which capabilities the bridge actually exposes.
      // Listing failure leaves capabilities undefined rather than assuming any.
      try {
        const listed = await nextClient.listTools()
        const names = Array.isArray(listed?.tools) ? listed.tools.map(tool => tool.name) : []
        capabilities = discoverGameCapabilities(names)
      }
      catch {
        capabilities = undefined
      }
      // Per-connect scope id (mc-1b): the generation counter restarts with
      // the app process, so world-scoped memory needs an id that is unique
      // for every connection.
      connectionId = randomUUID()
      options.capabilities?.announce()
      options.capabilities?.ready()

      // Identity caching is best-effort in MC-0a: the connection stays healthy
      // even when the bridge returns a shape we cannot parse. `get_status`
      // carries the version; `get_self` (client-only) carries the dimension.
      try {
        const status = await nextClient.callTool({ name: 'get_status', arguments: {} })
        lastStatusRecord = statusRecordOf(status)
        let self: GameHostToolResult | undefined
        try {
          self = await nextClient.callTool({ name: 'get_self', arguments: {} })
        }
        catch (error) {
          log.withError(error).warn('failed to read local player state after connect')
        }
        worldIdentity = gameWorldIdentityFrom(status, self)
        if (!worldIdentity) {
          log.withFields({ url: config.url }).warn('game bridge get_status returned no world identity')
        }
      }
      catch (error) {
        log.withError(error).warn('failed to read game world identity after connect')
      }

      lastError = undefined

      // MC-3c: the optional server endpoint carries server-authoritative tool
      // groups. A failure here degrades to client-only (server tools then
      // return `no_server`) instead of failing the whole connection.
      if (config.serverUrl) {
        try {
          assertLoopbackEndpoint(config.serverUrl)
          const serverTransport = new StreamableHTTPClientTransport(new URL(config.serverUrl))
          const nextServerClient = new Client({
            name: 'proj-airi:stage-tamagotchi:game-host:server',
            version: app.getVersion(),
          })
          await nextServerClient.connect(serverTransport)
          serverClient = nextServerClient
          log.withFields({ url: config.serverUrl }).log('server bridge endpoint connected')
        }
        catch (error) {
          log.withError(error).warn('server bridge endpoint unavailable; server tools degrade to the client bridge')
        }
      }

      startChatCommandPolling()
      return currentStatus()
    }
    catch (error) {
      lastError = errorMessageFrom(error) ?? 'Failed to connect game bridge'
      await nextClient?.close().catch(() => {})
      return { status: 'error', error: lastError }
    }
  }

  defineInvokeHandler(context, gameHostGetStatus, () => currentStatus())

  defineInvokeHandler(context, gameHostGetConfig, () => ({
    // The token is deliberately stripped from IPC responses (MC-0a invariant 6).
    url: config?.url ?? '',
    hasToken: Boolean(config?.token),
    ...(config?.serverUrl ? { serverUrl: config.serverUrl } : {}),
    allowedTools: allowedToolsOf(),
    movement: { planner: movementPlannerOf() },
    ...(config?.chatCommands
      ? { chatCommands: { ...config.chatCommands, admins: [...config.chatCommands.admins], blocked: [...config.chatCommands.blocked] } }
      : {}),
  }))

  defineInvokeHandler(context, gameHostApplyConfig, async (next) => {
    const url = next.url.trim()
    const requestedMovement = next.movement?.planner === 'terrain' || next.movement?.planner === 'legacy'
      ? { planner: next.movement.planner }
      : config?.movement
    // MC-3c D4: chat commands are optional config; an omitted field keeps the
    // stored setting so a plain re-apply cannot silently disable ingestion.
    const requestedChatCommands = next.chatCommands ? parseChatCommandsConfig(next.chatCommands) : config?.chatCommands

    // Empty URL is the explicit "disconnect" instruction: drop the
    // connection, forget the last error, and persist an intentionally empty
    // config so `readGameHostConfig` treats the next boot as unconfigured.
    if (!url) {
      await disconnect()
      config = undefined
      lastError = undefined
      await writeGameHostConfig(persistencePath, { url: '', allowedTools: next.allowedTools ?? [], ...(requestedMovement ? { movement: requestedMovement } : {}), ...(requestedChatCommands ? { chatCommands: requestedChatCommands } : {}) })
      return { status: 'unconfigured' } satisfies GameHostStatus
    }

    // The renderer never receives the stored token (MC-0a invariant 6). An
    // omitted token therefore keeps the stored one; an empty string clears it.
    const token = next.token === undefined
      ? config?.token
      : (next.token.trim() ? next.token : undefined)
    // MC-3c: the optional server endpoint follows the same keep/clear rule.
    const serverUrl = next.serverUrl === undefined
      ? config?.serverUrl
      : (next.serverUrl.trim() ? next.serverUrl.trim() : undefined)

    config = {
      url,
      ...(token ? { token } : {}),
      ...(serverUrl ? { serverUrl } : {}),
      allowedTools: Array.isArray(next.allowedTools) ? next.allowedTools : [],
      ...(requestedMovement ? { movement: requestedMovement } : {}),
      ...(requestedChatCommands ? { chatCommands: requestedChatCommands } : {}),
    }
    await writeGameHostConfig(persistencePath, config)
    return connect()
  })

  defineInvokeHandler(context, gameHostObserve, async ({ toolName, arguments: args }) => {
    if (!client)
      throw new Error('Game host is not connected')

    // `allowedTools` is a whitelist, not a blacklist: MC-0a exposes only read
    // tools, and a write/admin tool may never be invoked through this host.
    const allowed = allowedToolsOf()
    if (!allowed.includes(toolName))
      throw new Error(`game tool is not allowed: ${toolName}`)

    const result = await client.callTool({ name: toolName, arguments: args ?? {} })
    return normalizeObservation(toolName, result)
  })

  defineInvokeHandler(context, gameHostListDomainTools, () => DOMAIN_TOOLS)

  async function executeDomainCommand(payload: { requestId: string, action: GameDomainAction, params?: Record<string, unknown>, task?: GameDomainTask }): Promise<GameDomainResult> {
    const none: GamePostCondition = { kind: 'none', target: 0, actual: 0, met: true }
    const worldFields = (world: GameDomainResult['world']) => world ? { world } : {}
    // MC-1b: results carry the binding they belong to. Receipt-based results
    // keep the command's own world; status/idle answers use the live
    // connection. On disconnect both are empty, so a stale world never leaks
    // into current facts.
    const currentWorldFields = () => worldIdentity && connectionId
      ? worldFields({
          worldId: worldIdentity.worldId,
          dimension: worldIdentity.dimension,
          connectionGeneration,
          connectionId,
        })
      : {}
    const receiptWorldFields = (receipt: GameCommandReceipt) => worldFields({
      worldId: receipt.worldId,
      dimension: receipt.dimension,
      connectionGeneration: receipt.connectionGeneration,
      connectionId: receipt.connectionId,
    })
    const rejected = (endReason: string): GameDomainResult => ({ status: 'rejected', checked: false, commandId: null, endReason, postCondition: none, ...currentWorldFields() })
    if (!client)
      return rejected('not_connected')

    const params = toGameCommandParams(payload.action, payload.params ?? {})

    if (payload.action === 'status') {
      const requested = params.status?.commandId
      const activeCommandId = requested || registry.listActive().at(-1)
      const receipt = activeCommandId ? registry.getReceipt(activeCommandId) : undefined
      // A requested/active command without a receipt yet is still running;
      // only fall back to the last terminal receipt when nothing is pending.
      const state = activeCommandId ? registry.getState(activeCommandId) : undefined
      const isPending = state === 'accepted' || state === 'running' || state === 'cancel_requested'
      const latest = receipt ?? (isPending ? undefined : lastReceipt)
      return {
        status: 'ok',
        checked: false,
        commandId: latest?.commandId ?? (isPending ? activeCommandId ?? null : null),
        endReason: latest?.endReason ?? (isPending ? 'running' : 'idle'),
        ...(latest?.finalSnapshot ? { finalSnapshot: latest.finalSnapshot } : {}),
        postCondition: latest?.postCondition ?? none,
        ...(latest ? receiptWorldFields(latest) : currentWorldFields()),
      }
    }

    if (payload.action === 'cancel') {
      const requested = params.cancel?.commandId
      const commandId = requested || registry.listActive().at(-1)
      if (!commandId)
        return { status: 'ok', checked: false, commandId: null, endReason: 'idle', postCondition: none, ...currentWorldFields() }
      const receipt = await registry.cancel(commandId)
      if (!receipt)
        return rejected('unknown_command')
      lastReceipt = receipt
      return {
        status: receipt.state === 'cancelled' ? 'cancelled' : receipt.state === 'expired' ? 'expired' : 'failed',
        checked: false,
        commandId: receipt.commandId,
        endReason: receipt.endReason,
        finalSnapshot: receipt.finalSnapshot,
        postCondition: receipt.postCondition,
        ...receiptWorldFields(receipt),
      }
    }

    const task = payload.task
    const envelope: GameCommandEnvelope = {
      sessionId: task?.sessionId ?? '',
      taskId: task?.taskId ?? null,
      runId: task?.runId ?? '',
      planVersion: task?.planVersion ?? null,
      worldId: worldIdentity?.worldId ?? 'connection-scoped',
      dimension: worldIdentity?.dimension ?? '',
      playerUuid: worldIdentity?.playerUuid ?? '',
      connectionGeneration,
      connectionId,
      commandId: payload.requestId,
      action: payload.action,
      paramsDigest: commandParamsDigest(payload.action, params),
      deadlineMs: DOMAIN_COMMAND_DEADLINES[payload.action],
      issuedAt: Date.now(),
    }

    // MC-4c: collect attribution is measured by the executor per break; the
    // whole-command inventory delta is deliberately not used as the
    // postcondition (gaps §4.2).

    let receipt: GameCommandReceipt
    try {
      receipt = await registry.submit({ envelope, params })
      lastReceipt = receipt
    }
    catch (error) {
      if (error instanceof GameWriteBusyError)
        return { status: 'busy', checked: false, commandId: null, endReason: `busy: ${error.holderCommandId}`, postCondition: none, ...currentWorldFields() }
      if (error instanceof GameCommandConflictError)
        return rejected('conflict')
      if (error instanceof StaleGameBindingError)
        return rejected('stale_binding')
      return rejected(errorMessageFrom(error) ?? 'submit_failed')
    }

    // Receipt check (mc-0c C1-D4): the command identity and source are
    // structural (it came through this registry and this private session);
    // binding stability and one fresh player read complete the check. §9-7: the
    // read is bounded so a stalled bridge cannot leave the caller's invoke
    // unanswered after the command already settled.
    const freshSnapshot = await readFreshSnapshot(FRESH_STATE_TIMEOUT_MS)
    if (freshSnapshot === undefined) {
      return {
        status: 'failed',
        checked: false,
        commandId: receipt.commandId,
        endReason: 'check_failed: fresh_state',
        postCondition: receipt.postCondition,
        ...receiptWorldFields(receipt),
      }
    }
    if (connectionGeneration !== envelope.connectionGeneration) {
      return {
        status: 'failed',
        checked: false,
        commandId: receipt.commandId,
        endReason: 'check_failed: stale_binding',
        postCondition: receipt.postCondition,
        ...receiptWorldFields(receipt),
      }
    }

    // The distance postcondition uses the fresh read, not the executor's own
    // report (mc-0c C1-D4). Riptide is movement, so it shares the move_to rule.
    const distanceTarget = payload.action === 'move_to'
      ? params.moveTo
      : payload.action === 'riptide' ? params.riptide : undefined
    let postCondition = receipt.postCondition
    if (receipt.state === 'succeeded' && distanceTarget) {
      const actual = Math.hypot(
        freshSnapshot.position.x - distanceTarget.x,
        freshSnapshot.position.y - distanceTarget.y,
        freshSnapshot.position.z - distanceTarget.z,
      )
      postCondition = { kind: 'distance', target: distanceTarget.tolerance, actual, met: actual <= distanceTarget.tolerance }
    }

    const status: GameDomainResult['status'] = receipt.state === 'succeeded'
      ? (postCondition.kind === 'none' || postCondition.met ? 'ok' : 'failed')
      : receipt.state === 'cancelled' ? 'cancelled' : receipt.state === 'expired' ? 'expired' : 'failed'
    return {
      status,
      // Only a verified terminal receipt from a work action is checked; status
      // and cancel answers never satisfy a gate.
      checked: postCondition.kind !== 'none' && receipt.state !== 'expired',
      commandId: receipt.commandId,
      endReason: receipt.endReason,
      // CD-0 §3.3: name each observed phase separately; a phase the receipt
      // did not confirm stays unobserved instead of being inferred.
      resultPhases: actionResultPhases({
        requested: true,
        accepted: receipt.state !== 'expired',
        clientExecuted: receipt.state === 'succeeded' || receipt.state === 'failed',
        serverSettled: postCondition.kind !== 'none' && postCondition.met,
      }),
      finalSnapshot: freshSnapshot,
      postCondition,
      ...(receipt.crafted ? { crafted: receipt.crafted } : {}),
      ...(receipt.dropped ? { dropped: receipt.dropped } : {}),
      ...(receipt.located ? { located: receipt.located } : {}),
      ...(receipt.equipped ? { equipped: receipt.equipped } : {}),
      ...(receipt.used ? { used: receipt.used } : {}),
      ...(receipt.observed ? { observed: receipt.observed } : {}),
      ...(receipt.menu ? { menu: receipt.menu } : {}),
      ...(receipt.menuSnapshot ? { menuSnapshot: receipt.menuSnapshot } : {}),
      ...(receipt.moved ? { moved: receipt.moved } : {}),
      ...(receipt.smelt ? { smelt: receipt.smelt } : {}),
      ...(receipt.fed ? { fed: receipt.fed } : {}),
      ...(receipt.slept ? { slept: receipt.slept } : {}),
      ...(receipt.respawned ? { respawned: receipt.respawned } : {}),
      ...(receipt.shot ? { shot: receipt.shot } : {}),
      ...(receipt.riptide ? { riptide: receipt.riptide } : {}),
      ...(receipt.menuAction ? { menuAction: receipt.menuAction } : {}),
      ...(receipt.itemContent ? { itemContent: receipt.itemContent } : {}),
      ...(receipt.signContent ? { signContent: receipt.signContent } : {}),
      ...(receipt.placed ? { placed: receipt.placed } : {}),
      ...(receipt.broken ? { broken: receipt.broken } : {}),
      ...(receipt.attacked ? { attacked: receipt.attacked } : {}),
      ...(receipt.dropPosition ? { dropPosition: receipt.dropPosition } : {}),
      ...(receipt.prerequisites ? { prerequisites: receipt.prerequisites } : {}),
      ...receiptWorldFields(receipt),
    }
  }

  defineInvokeHandler(context, gameHostExecuteCommand, payload => executeDomainCommand(payload))

  // MC-1c D1: the same function backs the renderer invoke and the main-side
  // game bridge. The port never mints a result of its own; it forwards to the
  // registry path above, so `checked` keeps a single producer.
  const port: GameCommandPort = {
    isConnected: () => client !== undefined,
    listTools: () => DOMAIN_TOOLS,
    execute: async (input) => {
      const payload = { requestId: input.requestId, action: input.action, params: input.params ?? {} }
      if (!input.signal)
        return executeDomainCommand(payload)
      // A revoke may land before the command is submitted; report cancellation
      // without creating a registry entry that would need cleanup.
      if (input.signal.aborted)
        return { status: 'cancelled', checked: false, commandId: null, endReason: 'cancelled', postCondition: { kind: 'none', target: 0, actual: 0, met: true } }

      const onAbort = () => {
        // The request id is the command id; the registry ignores unknown ids.
        void registry.cancel(input.requestId)
      }
      input.signal.addEventListener('abort', onAbort, { once: true })
      try {
        return await executeDomainCommand(payload)
      }
      finally {
        input.signal.removeEventListener('abort', onAbort)
      }
    },
    cancel: (commandId) => {
      if (commandId.length === 0)
        return Promise.resolve({ status: 'rejected' as const, checked: false, commandId: null, endReason: 'unknown_command', postCondition: { kind: 'none' as const, target: 0, actual: 0, met: true } })
      return executeDomainCommand({ requestId: commandId, action: 'cancel', params: { commandId } })
    },
  }

  onAppBeforeQuit(async () => {
    await disconnect()
  })

  // Boot: apply the persisted config (if any). Failures degrade to 'error'
  // status; the app works without the game bridge and a later apply heals it.
  const persisted = await readGameHostConfig(persistencePath)
  if (persisted) {
    config = persisted
    await connect()
  }

  return port
}
