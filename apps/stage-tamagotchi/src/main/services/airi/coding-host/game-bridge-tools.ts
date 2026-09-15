/**
 * Code Mode game bridge tools (MC-1c D1).
 *
 * The sandbox program calls these through `bridge('game_collect', [{…}])`.
 * Each tool forwards to the main-side `GameCommandPort`, so the command
 * registry, receipts and `checked` evidence keep a single producer. The bridge
 * validates only the call shape (single object argument, required fields from
 * the domain descriptor); the game host still normalizes and validates the
 * actual command params.
 */
import type { CodeModeTool } from '@proj-airi/coding-harness'

import type { GameDomainAction } from '../../../../shared/eventa'
import type { GameCommandPort } from '../game-host'

import { randomUUID } from 'node:crypto'

export type GameBridgeErrorCode
  = | 'not_connected'
    | 'not_attached'
    | 'invalid_params'
    | 'not_allowed'

/** Typed bridge failure; the sandbox receives the code in `error.code`. */
export class GameBridgeError extends Error {
  readonly code: GameBridgeErrorCode

  constructor(code: GameBridgeErrorCode, message: string) {
    super(message)
    this.name = 'GameBridgeError'
    this.code = code
  }
}

interface GameBridgeToolSpec {
  name: string
  action: GameDomainAction
}

const GAME_BRIDGE_TOOLS: GameBridgeToolSpec[] = [
  { name: 'game_observe', action: 'observe' },
  { name: 'game_status', action: 'status' },
  { name: 'game_move_to', action: 'move_to' },
  { name: 'game_say', action: 'say' },
  { name: 'game_collect', action: 'collect' },
  { name: 'game_follow', action: 'follow' },
  { name: 'game_craft', action: 'craft' },
  { name: 'game_drop', action: 'drop' },
  { name: 'game_locate', action: 'locate' },
  { name: 'game_equip', action: 'equip' },
  { name: 'game_use', action: 'use' },
  { name: 'game_open_container', action: 'open_container' },
  { name: 'game_read_menu', action: 'read_menu' },
  { name: 'game_move_item', action: 'move_item' },
  { name: 'game_close_menu', action: 'close_menu' },
  { name: 'game_craft_table', action: 'craft_table' },
  { name: 'game_smelt_load', action: 'smelt_load' },
  { name: 'game_smelt_take', action: 'smelt_take' },
  { name: 'game_supply', action: 'supply' },
  { name: 'game_sleep', action: 'sleep' },
  { name: 'game_respawn', action: 'respawn' },
  { name: 'game_shoot', action: 'shoot' },
  { name: 'game_riptide', action: 'riptide' },
  { name: 'game_menu_action', action: 'menu_action' },
  { name: 'game_read_item', action: 'read_item' },
  { name: 'game_read_sign', action: 'read_sign' },
  { name: 'game_place', action: 'place' },
  { name: 'game_break', action: 'break' },
  { name: 'game_attack', action: 'attack' },
  { name: 'game_cancel', action: 'cancel' },
]

export interface GameBridgeToolOptions {
  /** Resolves the port per call; attach happens after both hosts exist. */
  getPort: () => GameCommandPort | undefined
}

/**
 * Reads the single object argument of a bridge call.
 *
 * Code Mode passes the second argument of `bridge(name, args)` as an array, so
 * game tools accept exactly one plain object (or none).
 */
function readParams(args: unknown[]): Record<string, unknown> {
  if (args.length === 0)
    return {}
  if (args.length === 1 && typeof args[0] === 'object' && args[0] !== null && !Array.isArray(args[0]))
    return args[0] as Record<string, unknown>
  throw new GameBridgeError('invalid_params', `Expected a single object argument, got ${args.length} arguments.`)
}

function requiredFieldsOf(port: GameCommandPort, action: GameDomainAction): string[] {
  const descriptor = port.listTools().find(tool => tool.action === action)
  const required = descriptor?.parameters.required
  return Array.isArray(required) ? required.filter((field): field is string => typeof field === 'string') : []
}

export function createGameBridgeTools(options: GameBridgeToolOptions): CodeModeTool[] {
  // Command ids issued by one run, keyed by the run's abort signal. The
  // signal lives exactly as long as the run, so entries are collected with it.
  const issuedByRun = new WeakMap<AbortSignal, Set<string>>()

  function issuedFor(signal: AbortSignal | undefined): Set<string> | undefined {
    if (!signal)
      return undefined
    let issued = issuedByRun.get(signal)
    if (!issued) {
      issued = new Set()
      issuedByRun.set(signal, issued)
    }
    return issued
  }

  return GAME_BRIDGE_TOOLS.map(({ name, action }) => ({
    name,
    description: `Game bridge for the "${action}" domain action. Calls the same main-side game host as the model tool face.`,
    requiresDeclaration: true,
    run: async (args, context) => {
      const port = options.getPort()
      if (!port)
        throw new GameBridgeError('not_attached', 'The game bridge is not attached yet.')
      if (!port.isConnected())
        throw new GameBridgeError('not_connected', 'The game host is not connected.')

      const params = readParams(args)
      const missing = requiredFieldsOf(port, action).filter((field) => {
        const value = params[field]
        return value === undefined || value === null || value === ''
      })
      if (missing.length > 0)
        throw new GameBridgeError('invalid_params', `Missing required field(s): ${missing.join(', ')}.`)

      if (action === 'cancel') {
        // A skill may only stop commands this run issued; the runtime cancels
        // the rest automatically when the run aborts.
        const commandId = typeof params.commandId === 'string' ? params.commandId : ''
        if (!commandId || !issuedFor(context.signal)?.has(commandId))
          throw new GameBridgeError('not_allowed', 'A skill can only cancel a command issued by the same run.')
      }

      const result = await port.execute({
        requestId: randomUUID(),
        action,
        params,
        ...(context.signal ? { signal: context.signal } : {}),
      })
      if (result.commandId)
        issuedFor(context.signal)?.add(result.commandId)
      // A losing connection surfaces as a rejected result; lift it to a typed
      // error so the program cannot mistake it for a completed command.
      if (result.status === 'rejected' && result.endReason === 'not_connected')
        throw new GameBridgeError('not_connected', 'The game host is not connected.')
      return result
    },
  }))
}
