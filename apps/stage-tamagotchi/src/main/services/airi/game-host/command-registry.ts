import type { GameAttackedReceipt, GameBrokenReceipt, GameCommandAction, GameCommandParams, GameCraftReceipt, GameEquipReceipt, GameFedReceipt, GameFinalSnapshot, GameItemContentReceipt, GameMenuActionReceipt, GameMenuReceipt, GameMenuSnapshotReceipt, GameMovedReceipt, GameObservedReceipt, GamePlacedReceipt, GamePostCondition, GamePostConditionInput, GamePrerequisiteReport, GameRespawnedReceipt, GameRiptideReceipt, GameShotReceipt, GameSignContentReceipt, GameSleptReceipt, GameSmeltReceipt, GameUseReceipt } from './command-contract'

/**
 * MC-0b command registry (TS side).
 *
 * Owns command identity, dedup, the lease watchdog, the single-writer gate,
 * terminal receipts, and the computable postconditions for game work. The
 * game executor is injected, so the whole state machine runs without a game
 * (mc-0b-spec work items 1-3, M1-D1).
 */
import { errorMessageFrom } from '@moeru/std'

import { commandParamsDigest, evaluateGamePostCondition } from './command-contract'

export type {
  GameCommandAction,
  GameCommandParams,
  GameFinalSnapshot,
  GamePostCondition,
} from './command-contract'
export {
  canonicalizeGameParams,
  commandParamsDigest,
  evaluateGamePostCondition,
} from './command-contract'

/** Envelope identity bound by game-host before a command reaches the mod. */
export interface GameCommandEnvelope {
  sessionId: string
  taskId: string | null
  runId: string
  planVersion: number | null
  worldId: string
  dimension: string
  playerUuid: string
  /** Increments on every (re)connect; makes old-world commands invalid. */
  connectionGeneration: number
  /** Per-connect unique id; world-memory scope key when worldId is generic. */
  connectionId?: string
  commandId: string
  action: GameCommandAction
  /** Digest of action + params only; see `commandParamsDigest`. */
  paramsDigest: string
  /** Lease length in ms, not an absolute time. */
  deadlineMs: number
  issuedAt: number
  /**
   * Client input-ownership id (CD-0 §3.1).
   *
   * Minted by the registry per write session when absent. It stays stable
   * across a mover switch inside one domain action, so an old revoke can never
   * target a later session.
   */
  controlSessionId?: string
  /** Monotonic generation of the input session; a higher number is newer. */
  controlSessionGeneration?: number
  /** Monotonic within one control session; an older value is dropped. */
  sequence?: number
  /** Monotonic goal revision within one control session; older is dropped. */
  goalRevision?: number
  /**
   * Short lease on the client's own tick clock.
   *
   * The registry cannot compare a client tick with main-process ms, so it
   * carries the value opaquely to the executor and never converts it.
   */
  validUntilTick?: number
}

/**
 * Fixed identity captured when a write command starts (CD-0 §3.1, D8).
 *
 * The execution entry reads this once. Loops and stop hooks must use the
 * captured token and must not re-read a global "current token", so a late
 * callback from an old command cannot touch a new session.
 */
export interface GameExecutionToken {
  commandId: string
  connectionGeneration: number
  controlSessionId: string
  controlSessionGeneration: number
  /** Monotonic within the control session; an older update is dropped. */
  sequence: number
  /** Monotonic goal revision within the control session; older is dropped. */
  goalRevision: number
  /** Opaque client-tick lease carried from the envelope. */
  validUntilTick?: number
}

/** Lifecycle of one command. Terminal states never transition further. */
export type GameCommandState
  = | 'accepted'
    | 'running'
    | 'cancel_requested'
    | 'succeeded'
    | 'failed'
    | 'cancelled'
    | 'expired'

/**
 * Coarse execution lifecycle (CD-0 §3.1).
 *
 * `revoking` is the input-revocation request; `cleanup` is the window where
 * the client confirms the revoke and the executor exits; `terminated` means no
 * input ownership remains. It is derived from {@link GameCommandState} and
 * never replaces it.
 */
export type GameCommandPhase = 'running' | 'revoking' | 'cleanup' | 'terminated'

/**
 * Maps the fine state onto the CD-0 execution lifecycle.
 *
 * @example
 * gameCommandPhaseOf('cancel_requested', { stopping: true })
 * // => 'cleanup'
 */
export function gameCommandPhaseOf(state: GameCommandState, options: { stopping?: boolean } = {}): GameCommandPhase {
  switch (state) {
    case 'accepted':
    case 'running':
      return 'running'
    case 'cancel_requested':
      return options.stopping ? 'cleanup' : 'revoking'
    case 'succeeded':
    case 'failed':
    case 'cancelled':
    case 'expired':
      return 'terminated'
  }
}

export interface GameCommandReceipt {
  commandId: string
  connectionGeneration: number
  /**
   * World binding the command was issued for. Carried on the receipt (not
   * read from the live connection) so a late receipt from another world stays
   * distinguishable from current facts (mc-1b D1).
   */
  worldId: string
  dimension: string
  connectionId: string
  state: GameCommandState
  /** Coarse execution lifecycle derived from `state` (CD-0 §3.1). */
  phase: GameCommandPhase
  /** Input session this command owned; '' for read commands (CD-0 §3.1). */
  controlSessionId: string
  controlSessionGeneration: number
  finalSnapshot: GameFinalSnapshot
  /** Machine-readable end reason, for example 'reached' | 'path_exhausted' | 'deadline' | 'cancelled'. */
  endReason: string
  postCondition: GamePostCondition
  issuedAt: number
  endedAt: number
  /** MC-2d: present only for craft commands. */
  crafted?: GameCraftReceipt
  /** MC-3c: present only for drop commands. */
  dropped?: { itemId: string, count: number, slot: number, verifiedBy?: 'inventory-delta' | 'slot-empty' }
  /** MC-3c: present only for locate commands. */
  located?: { name: string, uuid?: string, position: { x: number, y: number, z: number }, dimension?: string }
  /** MC-4a: present only for equip commands. */
  equipped?: GameEquipReceipt
  /** MC-4a: present only for use commands. */
  used?: GameUseReceipt
  /** MC-4a: present only for observe commands. */
  observed?: GameObservedReceipt
  /** MC-4b: present only for open_container commands. */
  menu?: GameMenuReceipt
  /** MC-4b: present only for read_menu commands (and after menu mutations). */
  menuSnapshot?: GameMenuSnapshotReceipt
  /** MC-4b: present only for move_item and smelt_take commands. */
  moved?: GameMovedReceipt
  /** MC-4b: present only for the two-step smelt commands. */
  smelt?: GameSmeltReceipt
  /** MC-4c: present only for supply commands. */
  fed?: GameFedReceipt
  /** MC-4c: present only for sleep commands. */
  slept?: GameSleptReceipt
  /** MC-4c: present only for respawn commands. */
  respawned?: GameRespawnedReceipt
  /** MC-4d: present only for shoot commands. */
  shot?: GameShotReceipt
  /** MC-4e: present only for riptide commands. */
  riptide?: GameRiptideReceipt
  /** MC-4f: present only for menu_action commands. */
  menuAction?: GameMenuActionReceipt
  /** MC-4f: present only for read_item commands (read-only observation). */
  itemContent?: GameItemContentReceipt
  /** MC-4f: present only for read_sign commands (read-only observation). */
  signContent?: GameSignContentReceipt
  /** MC-4f: present only for place commands. */
  placed?: GamePlacedReceipt
  /** MC-4g: present only for break commands. */
  broken?: GameBrokenReceipt
  /** MC-4g: present only for attack commands. */
  attacked?: GameAttackedReceipt
  /** MC-4c: last broken block whose drop could not be collected. */
  dropPosition?: { x: number, y: number, z: number }
  /** CD-M3: structured tool prerequisites for a collect that lacks the tool. */
  prerequisites?: GamePrerequisiteReport
}

/** Raised when a command id is reused with different params. */
export class GameCommandConflictError extends Error {
  readonly commandId: string
  readonly connectionGeneration: number

  constructor(commandId: string, connectionGeneration: number) {
    super(`Game command "${commandId}" already exists with different params (generation ${connectionGeneration}).`)
    this.name = 'GameCommandConflictError'
    this.commandId = commandId
    this.connectionGeneration = connectionGeneration
  }
}

/** Raised when a command targets a world, dimension, or connection the adapter no longer owns. */
export class StaleGameBindingError extends Error {
  readonly requiredGeneration: number
  readonly currentGeneration: number
  readonly requiredWorldId: string
  readonly currentWorldId: string
  /** MC-4e: dimension the command was issued for; empty when the binding carries none. */
  readonly requiredDimension: string
  /** MC-4e: dimension the adapter currently owns; empty when unknown. */
  readonly currentDimension: string

  constructor(input: { requiredGeneration: number, currentGeneration: number, requiredWorldId: string, currentWorldId: string, requiredDimension?: string, currentDimension?: string }) {
    super(`Game command targets generation ${input.requiredGeneration}/${input.requiredWorldId}, but the adapter owns ${input.currentGeneration}/${input.currentWorldId}.`)
    this.name = 'StaleGameBindingError'
    this.requiredGeneration = input.requiredGeneration
    this.currentGeneration = input.currentGeneration
    this.requiredWorldId = input.requiredWorldId
    this.currentWorldId = input.currentWorldId
    this.requiredDimension = input.requiredDimension ?? ''
    this.currentDimension = input.currentDimension ?? ''
  }
}

/** Raised when a write action is requested while another holds the player. */
export class GameWriteBusyError extends Error {
  readonly holderCommandId: string

  constructor(holderCommandId: string) {
    super(`Another write command is in flight: ${holderCommandId}.`)
    this.name = 'GameWriteBusyError'
    this.holderCommandId = holderCommandId
  }
}

/**
 * Raised when a goal update carries an older sequence or goal revision
 * (CD-0 §3.1). The update is dropped; the running session is not disturbed.
 */
export class GameStaleUpdateError extends Error {
  readonly commandId: string
  readonly field: 'sequence' | 'goalRevision'
  readonly offered: number
  readonly current: number

  constructor(commandId: string, field: 'sequence' | 'goalRevision', offered: number, current: number) {
    super(`Game command "${commandId}" received a stale ${field}: offered ${offered}, current ${current}.`)
    this.name = 'GameStaleUpdateError'
    this.commandId = commandId
    this.field = field
    this.offered = offered
    this.current = current
  }
}

/**
 * Result of an explicit input revocation (CD-0 §3.1).
 *
 * `verified` is true only when the client confirmed the stop and the executor
 * exited. An unverified revoke reports `expired`/`stop_unverified`; it must not
 * be reported as stopped, and input ownership is never handed to a second
 * writer (mc-0b invariant 6).
 */
export interface GameStopResult {
  commandId: string
  state: GameCommandState
  phase: GameCommandPhase
  endReason: string
  verified: boolean
}

export interface GameExecutorOutcome extends GamePostConditionInput {
  endReason: string
  /** MC-2d: craft details the executor measured; copied onto the receipt. */
  crafted?: GameCraftReceipt
  /** MC-3c: drop and locate details copied onto the receipt. */
  dropped?: { itemId: string, count: number, slot: number, verifiedBy?: 'inventory-delta' | 'slot-empty' }
  located?: { name: string, uuid?: string, position: { x: number, y: number, z: number }, dimension?: string }
  /** MC-4a: equip and use details, and the observe snapshot, copied onto the receipt. */
  equipped?: GameEquipReceipt
  used?: GameUseReceipt
  observed?: GameObservedReceipt
  /** MC-4b: menu details, the menu snapshot, the move result, and the smelt stage. */
  menu?: GameMenuReceipt
  menuSnapshot?: GameMenuSnapshotReceipt
  moved?: GameMovedReceipt
  smelt?: GameSmeltReceipt
  /** MC-4c: supply, sleep and respawn details copied onto the receipt. */
  fed?: GameFedReceipt
  slept?: GameSleptReceipt
  respawned?: GameRespawnedReceipt
  /** MC-4d: ranged shot details copied onto the receipt. */
  shot?: GameShotReceipt
  /** MC-4e: riptide movement details copied onto the receipt. */
  riptide?: GameRiptideReceipt
  /** MC-4f: menu business result, content observations and placement details. */
  menuAction?: GameMenuActionReceipt
  itemContent?: GameItemContentReceipt
  signContent?: GameSignContentReceipt
  placed?: GamePlacedReceipt
  /** MC-4g: break and melee details copied onto the receipt. */
  broken?: GameBrokenReceipt
  attacked?: GameAttackedReceipt
  /** MC-4c: last broken block whose drop could not be collected. */
  dropPosition?: { x: number, y: number, z: number }
  /** CD-M3: structured tool prerequisites for a collect that lacks the tool. */
  prerequisites?: GamePrerequisiteReport
}

export interface GameCommandExecutor {
  execute: (input: { envelope: GameCommandEnvelope, params: GameCommandParams, token: GameExecutionToken }) => Promise<GameExecutorOutcome>
  /**
   * Asks the executor to stop the session named by the token.
   *
   * The token is the fixed identity captured when the command started, so a
   * stop for an old command cannot reach a newer session (D8). Resolves true
   * when the executor confirmed the stop.
   */
  stop: (input: { envelope: GameCommandEnvelope, token: GameExecutionToken }) => Promise<boolean>
}

export interface GameBinding {
  connectionGeneration: number
  worldId: string
  /**
   * MC-4e: current dimension. Compared when present; a command issued for a
   * different dimension is stale even when the connection and world id match.
   * Optional so a binding that cannot read the dimension keeps working.
   */
  dimension?: string
}

export interface GameCommandRegistryOptions {
  executor: GameCommandExecutor
  getBinding: () => GameBinding
  /** How long an unconfirmed stop may take before the lease expires. */
  stopGraceMs?: number
  /** Snapshot used when the executor fails before returning one. */
  fallbackSnapshot?: GameFinalSnapshot
  now?: () => number
}

interface CommandRecord {
  envelope: GameCommandEnvelope
  params: GameCommandParams
  state: GameCommandState
  /** Fixed identity captured when the command was accepted (CD-0 §3.1, D8). */
  token: GameExecutionToken
  receipt?: GameCommandReceipt
  timer?: ReturnType<typeof setTimeout>
  settled: Promise<GameCommandReceipt>
  resolveSettled: (receipt: GameCommandReceipt) => void
  stopInFlight?: Promise<boolean>
  /**
   * Typed reason of a binding-change stop (`stopActive`). Kept on the record so
   * the reason survives whichever settles first: an executor that returns on
   * its own must not relabel a `dimension_changed` stop as a plain cancel.
   */
  stopReason?: string
}

const DEFAULT_STOP_GRACE_MS = 2_000

export const WRITE_ACTIONS: ReadonlySet<GameCommandAction> = new Set(['move_to', 'collect', 'say', 'follow', 'craft', 'drop', 'equip', 'use', 'open_container', 'move_item', 'close_menu', 'craft_table', 'smelt_load', 'smelt_take', 'supply', 'sleep', 'respawn', 'shoot', 'riptide', 'menu_action', 'place', 'break', 'attack'])

/**
 * Stop scope of the running write command (review R7).
 *
 * A boolean is shared by the multi-step executors and the stop hook. Only a
 * write command opens a fresh scope: a read command that finishes in between
 * must not clear a running write command's stop flag.
 */
export interface StopScope {
  stopped: boolean
  /** Identity of the write session that owns this scope. */
  controlSessionId?: string
  controlSessionGeneration?: number
  commandId?: string
}

/**
 * The next stop scope after a command begins.
 *
 * A write command opens a fresh scope bound to its captured token; a read
 * command keeps the running write scope (review R7). The identity fields are
 * only added when a token is supplied, so a caller without one keeps the
 * previous shape.
 *
 * @example
 * nextStopScope('move_to', { stopped: true })
 * // => { stopped: false }
 */
export function nextStopScope(action: GameCommandAction, current: StopScope, token?: GameExecutionToken): StopScope {
  if (!WRITE_ACTIONS.has(action))
    return current
  if (!token)
    return { stopped: false }
  return {
    stopped: false,
    controlSessionId: token.controlSessionId,
    controlSessionGeneration: token.controlSessionGeneration,
    commandId: token.commandId,
  }
}

/**
 * Stops a scope only when the token owns it (CD-0 D8).
 *
 * A late `finally` or async callback from an old command still passes the old
 * token; it must not stop the scope a newer command now owns.
 *
 * The mark is written in place: the running executor holds this exact scope
 * object in its `shouldStop` closure, so replacing it would hide the stop.
 *
 * @example
 * stopScopeFor({ stopped: false, controlSessionId: 'a' }, { controlSessionId: 'b', ... }).stopped
 * // => false
 */
export function stopScopeFor(scope: StopScope, token: GameExecutionToken): StopScope {
  if (scope.controlSessionId === undefined || scope.controlSessionId !== token.controlSessionId)
    return scope
  scope.stopped = true
  return scope
}

const ZERO_SNAPSHOT: GameFinalSnapshot = Object.freeze({
  position: Object.freeze({ x: 0, y: 0, z: 0 }),
  health: 0,
  food: 0,
  heldItem: null,
})

export interface GameCommandRegistry {
  submit: (input: { envelope: GameCommandEnvelope, params?: GameCommandParams }) => Promise<GameCommandReceipt>
  cancel: (commandId: string) => Promise<GameCommandReceipt | undefined>
  /**
   * Revokes input ownership and reports whether the stop was verified.
   *
   * Waits for the client revoke confirmation and executor exit. An unverified
   * stop is reported as `expired`/`stop_unverified` and is never reported as
   * stopped; input ownership is never handed to a second writer.
   */
  revoke: (commandId: string) => Promise<GameStopResult | undefined>
  /**
   * Applies a goal update; an older sequence or goal revision is dropped.
   *
   * A drop never touches the running session; only the registry-side record
   * advances, because the executor owns the live goal.
   */
  applyGoalUpdate: (input: { commandId: string, sequence: number, goalRevision: number, params?: GameCommandParams }) => 'applied' | 'dropped'
  getReceipt: (commandId: string) => GameCommandReceipt | undefined
  getState: (commandId: string) => GameCommandState | undefined
  getPhase: (commandId: string) => GameCommandPhase | undefined
  /** Expired commands whose final state could not be confirmed (M1-D4). */
  listUnverified: () => GameCommandReceipt[]
  listActive: () => string[]
  /**
   * Stops the active write command with a typed end reason (MC-4e binding change).
   *
   * Used when the world binding changes under a running command (a dimension
   * change): the executor is asked to stop, the command ends as `cancelled`
   * with the given reason, and no success is claimed. The lease is not extended
   * and no command is replayed.
   */
  stopActive: (endReason: string) => Promise<void>
  dispose: () => void
}

/**
 * Creates the command registry for one game binding.
 *
 * Dedup key is `${connectionGeneration}:${commandId}`; the same key with the
 * same digest returns the existing receipt, a different digest is rejected.
 * Read-only commands (observe/status/cancel) may run concurrently; at most
 * one write command owns the player.
 */
export function createGameCommandRegistry(options: GameCommandRegistryOptions): GameCommandRegistry {
  const now = options.now ?? (() => Date.now())
  const stopGraceMs = options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS
  const fallbackSnapshot = options.fallbackSnapshot ?? ZERO_SNAPSHOT
  const records = new Map<string, CommandRecord>()
  /** Monotonic control-session generation; only ever increases (CD-0 §3.1). */
  let controlSessionCounter = 0
  /** Highest sequence/goal revision each control session has accepted. */
  const sessionHighWater = new Map<string, { sequence: number, goalRevision: number }>()

  function keyOf(envelope: GameCommandEnvelope): string {
    return `${envelope.connectionGeneration}:${envelope.commandId}`
  }

  /**
   * Mints the fixed execution token for one command.
   *
   * The control session id comes from the envelope when the caller already
   * owns one (a mover switch inside one domain action keeps it), otherwise the
   * registry mints a fresh monotonic one.
   */
  function mintToken(envelope: GameCommandEnvelope): GameExecutionToken {
    controlSessionCounter += 1
    return {
      commandId: envelope.commandId,
      connectionGeneration: envelope.connectionGeneration,
      controlSessionId: envelope.controlSessionId ?? `control-${envelope.connectionGeneration}-${controlSessionCounter}`,
      controlSessionGeneration: envelope.controlSessionGeneration ?? controlSessionCounter,
      sequence: envelope.sequence ?? 0,
      goalRevision: envelope.goalRevision ?? 0,
      ...(envelope.validUntilTick !== undefined ? { validUntilTick: envelope.validUntilTick } : {}),
    }
  }

  /**
   * Drops an update whose sequence or revision is older than the session's
   * high-water mark (CD-0 §3.1). First update of a session always wins.
   */
  function assertFreshUpdate(token: GameExecutionToken): void {
    const previous = sessionHighWater.get(token.controlSessionId)
    if (!previous) {
      sessionHighWater.set(token.controlSessionId, { sequence: token.sequence, goalRevision: token.goalRevision })
      return
    }
    if (token.sequence < previous.sequence)
      throw new GameStaleUpdateError(token.commandId, 'sequence', token.sequence, previous.sequence)
    if (token.goalRevision < previous.goalRevision)
      throw new GameStaleUpdateError(token.commandId, 'goalRevision', token.goalRevision, previous.goalRevision)
    sessionHighWater.set(token.controlSessionId, { sequence: token.sequence, goalRevision: token.goalRevision })
  }

  function assertCurrentBinding(envelope: GameCommandEnvelope): void {
    const binding = options.getBinding()
    // A dimension change keeps the connection (and generation) but changes the
    // world binding, so a command issued for the old dimension is stale
    // (mc-4e D3). The dimension is only compared when the binding reports one.
    const dimensionMismatch = !!binding.dimension && envelope.dimension !== binding.dimension
    if (envelope.connectionGeneration !== binding.connectionGeneration
      || (binding.worldId && envelope.worldId !== binding.worldId)
      || dimensionMismatch) {
      throw new StaleGameBindingError({
        requiredGeneration: envelope.connectionGeneration,
        currentGeneration: binding.connectionGeneration,
        requiredWorldId: envelope.worldId,
        currentWorldId: binding.worldId,
        requiredDimension: envelope.dimension,
        currentDimension: binding.dimension ?? '',
      })
    }
  }

  /** The active write command, if one owns the player. */
  function activeWriteRecord(): CommandRecord | undefined {
    for (const record of records.values()) {
      if (WRITE_ACTIONS.has(record.envelope.action)
        && (record.state === 'accepted' || record.state === 'running' || record.state === 'cancel_requested')) {
        return record
      }
    }
    return undefined
  }

  function activeWriteHolder(action: GameCommandAction): CommandRecord | undefined {
    if (!WRITE_ACTIONS.has(action))
      return undefined
    return activeWriteRecord()
  }

  function settle(record: CommandRecord, input: {
    state: GameCommandState
    endReason: string
    postCondition: GamePostCondition
    finalSnapshot?: GameFinalSnapshot
    endedAt?: number
    crafted?: GameCraftReceipt
    dropped?: { itemId: string, count: number, slot: number, verifiedBy?: 'inventory-delta' | 'slot-empty' }
    located?: { name: string, uuid?: string, position: { x: number, y: number, z: number }, dimension?: string }
    equipped?: GameEquipReceipt
    used?: GameUseReceipt
    observed?: GameObservedReceipt
    menu?: GameMenuReceipt
    menuSnapshot?: GameMenuSnapshotReceipt
    moved?: GameMovedReceipt
    smelt?: GameSmeltReceipt
    fed?: GameFedReceipt
    slept?: GameSleptReceipt
    respawned?: GameRespawnedReceipt
    shot?: GameShotReceipt
    riptide?: GameRiptideReceipt
    menuAction?: GameMenuActionReceipt
    itemContent?: GameItemContentReceipt
    signContent?: GameSignContentReceipt
    placed?: GamePlacedReceipt
    broken?: GameBrokenReceipt
    attacked?: GameAttackedReceipt
    dropPosition?: { x: number, y: number, z: number }
    prerequisites?: GamePrerequisiteReport
  }): GameCommandReceipt {
    if (record.timer) {
      clearTimeout(record.timer)
      record.timer = undefined
    }
    record.state = input.state
    const receipt: GameCommandReceipt = {
      commandId: record.envelope.commandId,
      connectionGeneration: record.envelope.connectionGeneration,
      worldId: record.envelope.worldId,
      dimension: record.envelope.dimension,
      connectionId: record.envelope.connectionId ?? '',
      state: input.state,
      phase: gameCommandPhaseOf(input.state),
      controlSessionId: WRITE_ACTIONS.has(record.envelope.action) ? record.token.controlSessionId : '',
      controlSessionGeneration: record.token.controlSessionGeneration,
      finalSnapshot: input.finalSnapshot ?? record.receipt?.finalSnapshot ?? fallbackSnapshot,
      endReason: input.endReason,
      postCondition: input.postCondition,
      issuedAt: record.envelope.issuedAt,
      endedAt: input.endedAt ?? now(),
      ...(input.crafted ? { crafted: input.crafted } : {}),
      ...(input.dropped ? { dropped: input.dropped } : {}),
      ...(input.located ? { located: input.located } : {}),
      ...(input.equipped ? { equipped: input.equipped } : {}),
      ...(input.used ? { used: input.used } : {}),
      ...(input.observed ? { observed: input.observed } : {}),
      ...(input.menu ? { menu: input.menu } : {}),
      ...(input.menuSnapshot ? { menuSnapshot: input.menuSnapshot } : {}),
      ...(input.moved ? { moved: input.moved } : {}),
      ...(input.smelt ? { smelt: input.smelt } : {}),
      ...(input.fed ? { fed: input.fed } : {}),
      ...(input.slept ? { slept: input.slept } : {}),
      ...(input.respawned ? { respawned: input.respawned } : {}),
      ...(input.shot ? { shot: input.shot } : {}),
      ...(input.riptide ? { riptide: input.riptide } : {}),
      ...(input.menuAction ? { menuAction: input.menuAction } : {}),
      ...(input.itemContent ? { itemContent: input.itemContent } : {}),
      ...(input.signContent ? { signContent: input.signContent } : {}),
      ...(input.placed ? { placed: input.placed } : {}),
      ...(input.broken ? { broken: input.broken } : {}),
      ...(input.attacked ? { attacked: input.attacked } : {}),
      ...(input.dropPosition ? { dropPosition: input.dropPosition } : {}),
      ...(input.prerequisites ? { prerequisites: input.prerequisites } : {}),
    }
    record.receipt = receipt
    record.resolveSettled(receipt)
    return receipt
  }

  /** Optional executor details copied onto a receipt (kept on cancellation too). */
  function outcomeDetailsOf(outcome: GameExecutorOutcome) {
    return {
      ...(outcome.crafted ? { crafted: outcome.crafted } : {}),
      ...(outcome.dropped ? { dropped: outcome.dropped } : {}),
      ...(outcome.located ? { located: outcome.located } : {}),
      ...(outcome.equipped ? { equipped: outcome.equipped } : {}),
      ...(outcome.used ? { used: outcome.used } : {}),
      ...(outcome.observed ? { observed: outcome.observed } : {}),
      ...(outcome.menu ? { menu: outcome.menu } : {}),
      ...(outcome.menuSnapshot ? { menuSnapshot: outcome.menuSnapshot } : {}),
      ...(outcome.moved ? { moved: outcome.moved } : {}),
      ...(outcome.smelt ? { smelt: outcome.smelt } : {}),
      ...(outcome.fed ? { fed: outcome.fed } : {}),
      ...(outcome.slept ? { slept: outcome.slept } : {}),
      ...(outcome.respawned ? { respawned: outcome.respawned } : {}),
      ...(outcome.shot ? { shot: outcome.shot } : {}),
      ...(outcome.riptide ? { riptide: outcome.riptide } : {}),
      ...(outcome.menuAction ? { menuAction: outcome.menuAction } : {}),
      ...(outcome.itemContent ? { itemContent: outcome.itemContent } : {}),
      ...(outcome.signContent ? { signContent: outcome.signContent } : {}),
      ...(outcome.placed ? { placed: outcome.placed } : {}),
      ...(outcome.broken ? { broken: outcome.broken } : {}),
      ...(outcome.attacked ? { attacked: outcome.attacked } : {}),
      ...(outcome.dropPosition ? { dropPosition: outcome.dropPosition } : {}),
      ...(outcome.prerequisites ? { prerequisites: outcome.prerequisites } : {}),
    }
  }

  /** Waits up to `ms` for the record to settle; used before a cancel receipt. */
  function waitSettled(record: CommandRecord, ms: number): Promise<void> {
    return Promise.race([
      record.settled.then(() => undefined),
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms)
      }),
    ])
  }

  /** Asks the executor to stop and waits at most `stopGraceMs` for confirmation. */
  function requestStop(record: CommandRecord): Promise<boolean> {
    record.stopInFlight ??= (async () => {
      let timeout: ReturnType<typeof setTimeout> | undefined
      try {
        return await Promise.race([
          Promise.resolve(options.executor.stop({ envelope: record.envelope, token: record.token })).catch(() => false),
          new Promise<boolean>((resolve) => {
            timeout = setTimeout(resolve, stopGraceMs, false)
          }),
        ])
      }
      finally {
        if (timeout)
          clearTimeout(timeout)
      }
    })()
    return record.stopInFlight
  }

  function beginExecution(record: CommandRecord): void {
    const onLeaseExpired = (expired: CommandRecord): void => {
      if (expired.state !== 'running')
        return
      expired.state = 'cancel_requested'
      void requestStop(expired).then((confirmed) => {
        if (expired.state !== 'cancel_requested')
          return
        settle(expired, {
          state: confirmed ? 'cancelled' : 'expired',
          endReason: confirmed ? 'cancelled' : 'deadline',
          // Expiry means the final condition was never confirmed; the
          // postcondition records what the action promised, measured 0.
          postCondition: { kind: 'none', target: 0, actual: 0, met: false },
        })
      })
    }

    record.state = 'running'
    record.timer = setTimeout(onLeaseExpired, record.envelope.deadlineMs, record)

    void options.executor.execute({ envelope: record.envelope, params: record.params, token: record.token })
      .then((outcome) => {
        if (record.receipt)
          return
        if (record.state === 'cancel_requested') {
          // Cancelled while the executor was returning: keep whatever the
          // executor observed (shots fired, moved counts, ...) on the cancelled
          // receipt instead of dropping it. A binding-change stop keeps its
          // typed reason.
          settle(record, {
            state: 'cancelled',
            endReason: record.stopReason ?? 'cancelled',
            postCondition: { kind: 'none', target: 0, actual: 0, met: false },
            ...(outcome.finalSnapshot ? { finalSnapshot: outcome.finalSnapshot } : {}),
            ...outcomeDetailsOf(outcome),
          })
          return
        }
        if (record.state !== 'running')
          return
        const postCondition = evaluateGamePostCondition(record.envelope.action, record.params, outcome)
        settle(record, {
          state: postCondition.met ? 'succeeded' : 'failed',
          endReason: outcome.endReason,
          postCondition,
          finalSnapshot: outcome.finalSnapshot,
          ...outcomeDetailsOf(outcome),
        })
      })
      .catch((error: unknown) => {
        if (record.receipt)
          return
        if (record.state === 'cancel_requested') {
          // A stop is already under way. The executor rejected instead of
          // returning, so it cannot settle itself; the stop owns the reason
          // (`dimension_changed` or `cancelled`) and must not be relabeled by a
          // plain executor error. Settling here keeps the caller's promise from
          // waiting on the stop-grace window when nothing else will.
          settle(record, {
            state: 'cancelled',
            endReason: record.stopReason ?? 'cancelled',
            postCondition: { kind: 'none', target: 0, actual: 0, met: false },
          })
          return
        }
        if (record.state !== 'running')
          return
        const message = errorMessageFrom(error) ?? 'unknown executor error'
        settle(record, {
          state: 'failed',
          endReason: `executor_error: ${message}`,
          postCondition: { kind: 'none', target: 0, actual: 0, met: false },
        })
      })
  }

  /**
   * Stops the active write command with a typed end reason (MC-4e binding change).
   *
   * The state moves to `cancel_requested` before the executor is asked to stop,
   * so a late executor outcome cannot overwrite the binding-change reason. The
   * receipt stays unmet; the caller must not continue the old command.
   */
  async function stopActive(endReason: string): Promise<void> {
    const record = activeWriteRecord()
    if (!record || record.receipt)
      return
    record.state = 'cancel_requested'
    record.stopReason = endReason
    await requestStop(record)
    if (!record.receipt)
      await waitSettled(record, 400)
    if (record.receipt)
      return
    settle(record, {
      state: 'cancelled',
      endReason,
      postCondition: { kind: 'none', target: 0, actual: 0, met: false },
    })
  }

  function submit(input: { envelope: GameCommandEnvelope, params?: GameCommandParams }): Promise<GameCommandReceipt> {
    const { envelope } = input
    const params = input.params ?? {}
    const digest = commandParamsDigest(envelope.action, params)
    if (envelope.paramsDigest !== digest)
      throw new Error(`paramsDigest does not match the command action and params: ${envelope.paramsDigest} != ${digest}`)

    assertCurrentBinding(envelope)

    const existing = records.get(keyOf(envelope))
    if (existing) {
      if (existing.envelope.paramsDigest !== envelope.paramsDigest)
        throw new GameCommandConflictError(envelope.commandId, envelope.connectionGeneration)
      return existing.settled
    }

    const holder = activeWriteHolder(envelope.action)
    if (holder)
      throw new GameWriteBusyError(holder.envelope.commandId)

    // The update gate runs last: a duplicate or a busy rejection must not
    // consume a sequence number.
    const token = mintToken(envelope)
    assertFreshUpdate(token)

    let resolveSettled: (receipt: GameCommandReceipt) => void = () => {}
    const settled = new Promise<GameCommandReceipt>((resolve) => {
      resolveSettled = resolve
    })
    const record: CommandRecord = {
      envelope,
      params,
      state: 'accepted',
      token,
      settled,
      resolveSettled,
    }
    records.set(keyOf(envelope), record)
    beginExecution(record)
    return settled
  }

  /**
   * Applies a goal update to a running command (CD-0 §3.1).
   *
   * An update with an older sequence or goal revision is dropped and never
   * touches the running session. A terminal or unknown command also drops it.
   */
  function applyGoalUpdate(input: { commandId: string, sequence: number, goalRevision: number, params?: GameCommandParams }): 'applied' | 'dropped' {
    const record = [...records.values()].find(item => item.envelope.commandId === input.commandId)
    if (!record || record.receipt || record.state === 'cancel_requested')
      return 'dropped'
    const previous = sessionHighWater.get(record.token.controlSessionId)
    if (previous && (input.sequence < previous.sequence || input.goalRevision < previous.goalRevision))
      return 'dropped'
    record.token = { ...record.token, sequence: input.sequence, goalRevision: input.goalRevision }
    if (input.params)
      record.params = input.params
    sessionHighWater.set(record.token.controlSessionId, { sequence: input.sequence, goalRevision: input.goalRevision })
    return 'applied'
  }

  async function cancel(commandId: string): Promise<GameCommandReceipt | undefined> {
    const record = [...records.values()].find(item => item.envelope.commandId === commandId)
    if (!record)
      return undefined
    if (record.receipt)
      return record.receipt

    record.state = 'cancel_requested'
    const confirmed = await requestStop(record)
    if (record.receipt)
      return record.receipt
    // The executor outcome (with the facts it already observed) can arrive just
    // after the stop confirmation; give it a bounded window to settle.
    if (confirmed)
      await waitSettled(record, 400)
    if (record.receipt)
      return record.receipt
    // An unconfirmed stop is never reported as stopped (mc-0b invariant 6).
    return settle(record, {
      state: confirmed ? 'cancelled' : 'expired',
      endReason: confirmed ? 'cancelled' : 'cancel_unconfirmed',
      postCondition: { kind: 'none', target: 0, actual: 0, met: false },
    })
  }

  async function revoke(commandId: string): Promise<GameStopResult | undefined> {
    const receipt = await cancel(commandId)
    if (!receipt)
      return undefined
    const verified = receipt.state === 'cancelled'
    return {
      commandId: receipt.commandId,
      state: receipt.state,
      phase: gameCommandPhaseOf(receipt.state),
      endReason: verified ? receipt.endReason : 'stop_unverified',
      verified,
    }
  }

  return {
    submit,
    cancel,
    revoke,
    applyGoalUpdate,
    getReceipt: commandId => [...records.values()].find(item => item.envelope.commandId === commandId)?.receipt,
    getState: commandId => [...records.values()].find(item => item.envelope.commandId === commandId)?.state,
    getPhase: (commandId) => {
      const record = [...records.values()].find(item => item.envelope.commandId === commandId)
      if (!record)
        return undefined
      return gameCommandPhaseOf(record.state, { stopping: record.stopInFlight !== undefined })
    },
    listUnverified: () => [...records.values()]
      .map(item => item.receipt)
      .filter((receipt): receipt is GameCommandReceipt => receipt?.state === 'expired'),
    listActive: () => [...records.values()]
      .filter(item => item.state === 'accepted' || item.state === 'running' || item.state === 'cancel_requested')
      .map(item => item.envelope.commandId),
    stopActive,
    dispose: () => {
      for (const record of records.values()) {
        if (record.timer)
          clearTimeout(record.timer)
      }
    },
  }
}
