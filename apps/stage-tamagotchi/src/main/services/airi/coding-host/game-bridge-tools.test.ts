import type { CodeModeTool } from '@proj-airi/coding-harness'

import type { GameDomainResult } from '../../../../shared/eventa'
import type { GameCommandPort } from '../game-host'

import { describe, expect, it, vi } from 'vitest'

import { createGameBridgeTools, GameBridgeError } from './game-bridge-tools'

function domainResult(overrides: Partial<GameDomainResult> = {}): GameDomainResult {
  return {
    status: 'ok',
    checked: false,
    commandId: 'cmd-1',
    endReason: 'succeeded',
    postCondition: { kind: 'none', target: 0, actual: 0, met: true },
    ...overrides,
  }
}

function createFakePort(overrides: Partial<GameCommandPort> = {}): GameCommandPort {
  return {
    isConnected: () => true,
    listTools: () => [
      {
        name: 'game_move_to',
        action: 'move_to',
        description: '',
        parameters: { type: 'object', properties: {}, required: ['x', 'y', 'z'] },
      },
      {
        name: 'game_say',
        action: 'say',
        description: '',
        parameters: { type: 'object', properties: {}, required: ['text'] },
      },
      {
        name: 'game_collect',
        action: 'collect',
        description: '',
        parameters: { type: 'object', properties: {}, required: ['blockId'] },
      },
    ],
    execute: vi.fn(async () => domainResult()),
    cancel: vi.fn(async () => domainResult()),
    ...overrides,
  }
}

function toolNamed(tools: CodeModeTool[], name: string): CodeModeTool {
  const tool = tools.find(candidate => candidate.name === name)
  if (!tool)
    throw new Error(`missing bridge tool: ${name}`)
  return tool
}

const RUN = { runId: 'run-1' }

describe('createGameBridgeTools', () => {
  it('exposes every game action with matching names', () => {
    const tools = createGameBridgeTools({ getPort: () => createFakePort() })
    expect(tools.map(tool => tool.name).sort()).toEqual([
      'game_attack',
      'game_break',
      'game_cancel',
      'game_close_menu',
      'game_collect',
      'game_craft',
      'game_craft_table',
      'game_drop',
      'game_equip',
      'game_follow',
      'game_locate',
      'game_menu_action',
      'game_move_item',
      'game_move_to',
      'game_observe',
      'game_open_container',
      'game_place',
      'game_read_item',
      'game_read_menu',
      'game_read_sign',
      'game_respawn',
      'game_riptide',
      'game_say',
      'game_shoot',
      'game_sleep',
      'game_smelt_load',
      'game_smelt_take',
      'game_status',
      'game_supply',
      'game_use',
    ])
    expect(tools.every(tool => tool.requiresDeclaration === true)).toBe(true)
  })

  it('fails with not_attached before the game host is wired', async () => {
    const tool = toolNamed(createGameBridgeTools({ getPort: () => undefined }), 'game_status')
    await expect(tool.run([], RUN)).rejects.toMatchObject({ code: 'not_attached' })
  })

  it('fails with not_connected while the game host is offline', async () => {
    const port = createFakePort({ isConnected: () => false })
    const tool = toolNamed(createGameBridgeTools({ getPort: () => port }), 'game_status')
    await expect(tool.run([], RUN)).rejects.toMatchObject({ code: 'not_connected' })
    expect(port.execute).not.toHaveBeenCalled()
  })

  it('rejects a call that is not one plain object', async () => {
    const tool = toolNamed(createGameBridgeTools({ getPort: () => createFakePort() }), 'game_status')
    await expect(tool.run(['extra', 'args'], RUN)).rejects.toBeInstanceOf(GameBridgeError)
    await expect(tool.run(['extra', 'args'], RUN)).rejects.toMatchObject({ code: 'invalid_params' })
    await expect(tool.run([42], RUN)).rejects.toMatchObject({ code: 'invalid_params' })
  })

  it('rejects a missing required field before the command is issued', async () => {
    const port = createFakePort()
    const tool = toolNamed(createGameBridgeTools({ getPort: () => port }), 'game_move_to')
    await expect(tool.run([{ x: 1, y: 2 }], RUN)).rejects.toMatchObject({ code: 'invalid_params' })
    await expect(tool.run([{ x: 1, y: 2 }], RUN)).rejects.toThrow('Missing required field(s): z')
    expect(port.execute).not.toHaveBeenCalled()
  })

  it('forwards the action and params and returns the domain result', async () => {
    const port = createFakePort()
    const tool = toolNamed(createGameBridgeTools({ getPort: () => port }), 'game_collect')
    const result = await tool.run([{ blockId: 'minecraft:sand', maxCount: 1 }], RUN)

    expect(port.execute).toHaveBeenCalledTimes(1)
    expect(port.execute).toHaveBeenCalledWith(expect.objectContaining({
      action: 'collect',
      params: { blockId: 'minecraft:sand', maxCount: 1 },
    }))
    expect(result).toEqual(domainResult())
  })

  it('forwards the run signal so an abort cancels the in-flight command', async () => {
    const port = createFakePort()
    const controller = new AbortController()
    const tool = toolNamed(createGameBridgeTools({ getPort: () => port }), 'game_say')
    await tool.run([{ text: 'hi' }], { runId: 'run-2', signal: controller.signal })

    expect(port.execute).toHaveBeenCalledWith(expect.objectContaining({ action: 'say', signal: controller.signal }))
  })

  it('lifts a not_connected result into a typed error', async () => {
    const port = createFakePort({
      execute: vi.fn(async () => domainResult({ status: 'rejected', endReason: 'not_connected' })),
    })
    const tool = toolNamed(createGameBridgeTools({ getPort: () => port }), 'game_say')
    await expect(tool.run([{ text: 'hi' }], RUN)).rejects.toMatchObject({ code: 'not_connected' })
  })

  it('returns failed receipts without rewriting their reason', async () => {
    const failed = domainResult({ status: 'failed', endReason: 'unreachable', checked: false })
    const port = createFakePort({ execute: vi.fn(async () => failed) })
    const tool = toolNamed(createGameBridgeTools({ getPort: () => port }), 'game_move_to')
    await expect(tool.run([{ x: 1, y: 2, z: 3 }], RUN)).resolves.toEqual(failed)
  })

  it('lets a run cancel only the commands it issued', async () => {
    const port = createFakePort()
    const controller = new AbortController()
    const tools = createGameBridgeTools({ getPort: () => port })
    const say = toolNamed(tools, 'game_say')
    const cancel = toolNamed(tools, 'game_cancel')

    // No signal: the run cannot prove ownership of any command.
    await expect(cancel.run([{ commandId: 'cmd-1' }], RUN)).rejects.toMatchObject({ code: 'not_allowed' })

    const context = { runId: 'run-3', signal: controller.signal }
    await expect(cancel.run([{ commandId: 'cmd-1' }], context)).rejects.toMatchObject({ code: 'not_allowed' })

    // `game_say` issued `cmd-1` in this run, so the cancel is allowed.
    await say.run([{ text: 'hello' }], context)
    await expect(cancel.run([{ commandId: 'cmd-1' }], context)).resolves.toEqual(domainResult())
  })
})
