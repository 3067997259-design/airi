import type { ElectronMainContextExtensions, ElectronMainEmitOptions } from '@moeru/eventa/adapters/electron/main'

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createContext, defineInvoke } from '@moeru/eventa'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  gameHostApplyConfig,
  gameHostExecuteCommand,
  gameHostGetConfig,
  gameHostGetStatus,
  gameHostListDomainTools,
  gameHostObserve,
} from '../../../../shared/eventa'
import {
  assertLoopbackEndpoint,
  gameWorldIdentityFrom,
  readGameHostConfig,
  setupGameHost,
  writeGameHostConfig,
} from './index'

const appMock = vi.hoisted(() => ({
  getVersion: vi.fn(),
}))

const clientInstances = vi.hoisted(() => ({
  items: [] as Array<{
    connect: ReturnType<typeof vi.fn>
    callTool: ReturnType<typeof vi.fn>
    close: ReturnType<typeof vi.fn>
  }>,
}))

const transportInstances = vi.hoisted(() => ({
  items: [] as Array<{ url: string, requestInit?: { headers?: Record<string, string> } }>,
}))

vi.mock('electron', () => ({
  app: appMock,
}))

vi.mock('@guiiai/logg', () => ({
  useLogg: vi.fn(() => ({
    useGlobalConfig: () => ({
      warn: vi.fn(),
      withError: vi.fn(() => ({ warn: vi.fn() })),
      withFields: vi.fn(() => ({ warn: vi.fn() })),
    }),
  })),
}))

vi.mock('../../../libs/bootkit/lifecycle', () => ({
  onAppBeforeQuit: vi.fn(),
}))

const clientMocks = vi.hoisted(() => ({
  connect: vi.fn(async () => undefined),
  callTool: vi.fn(async (_args: { name: string }) => ({ content: [] as Array<Record<string, unknown>> })),
  close: vi.fn(async () => undefined),
}))

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    connect = clientMocks.connect
    callTool = clientMocks.callTool
    close = clientMocks.close

    constructor() {
      clientInstances.items.push(this)
    }
  },
}))

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: class {
    constructor(url: URL, opts?: { requestInit?: { headers?: Record<string, string> } }) {
      transportInstances.items.push({ url: url.toString(), requestInit: opts?.requestInit })
    }
  },
}))

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(directory)
  return directory
}

function createHostContext() {
  return createContext<ElectronMainContextExtensions, ElectronMainEmitOptions>()
}

describe('assertLoopbackEndpoint', () => {
  it('accepts loopback hosts', () => {
    expect(() => assertLoopbackEndpoint('http://127.0.0.1:25600/mcp')).not.toThrow()
    expect(() => assertLoopbackEndpoint('http://[::1]:25600/mcp')).not.toThrow()
    expect(() => assertLoopbackEndpoint('http://localhost:25600/mcp')).not.toThrow()
  })

  it('throws for non-loopback hosts', () => {
    expect(() => assertLoopbackEndpoint('http://example.com/mcp')).toThrow('game bridge endpoint must be loopback, got example.com')
    expect(() => assertLoopbackEndpoint('http://192.168.1.5:25600/mcp')).toThrow('game bridge endpoint must be loopback, got 192.168.1.5')
  })

  it('throws for a URL that cannot be parsed', () => {
    expect(() => assertLoopbackEndpoint('not a url')).toThrow()
  })
})

describe('gameWorldIdentityFrom', () => {
  it('reads identity fields from structuredContent', () => {
    expect(gameWorldIdentityFrom({
      content: [],
      structuredContent: {
        minecraftVersion: '1.21.1',
        worldId: 'world-1',
        dimension: 'overworld',
        playerUuid: 'uuid-1',
      },
    })).toEqual({
      minecraftVersion: '1.21.1',
      worldId: 'world-1',
      dimension: 'overworld',
      playerUuid: 'uuid-1',
    })
  })

  it('accepts snake_case fields and falls back to a connection-scoped world id', () => {
    expect(gameWorldIdentityFrom({
      content: [],
      structuredContent: { minecraftVersion: '1.21.11', world_id: 'w', player_uuid: 'p' },
    })).toEqual({
      minecraftVersion: '1.21.11',
      worldId: 'w',
      dimension: '',
      playerUuid: 'p',
    })

    expect(gameWorldIdentityFrom({
      content: [],
      structuredContent: { minecraftVersion: '1.21.1' },
    })).toMatchObject({ worldId: 'connection-scoped' })
  })

  it('parses identity fields from JSON text content as a fallback', () => {
    expect(gameWorldIdentityFrom({
      content: [{ type: 'text', text: '{"minecraftVersion":"1.21.1","worldId":"world-text"}' }],
    })).toMatchObject({ minecraftVersion: '1.21.1', worldId: 'world-text' })
  })

  it('merges the local player state into the identity', () => {
    // The fork's get_status reports the version only; the dimension comes
    // from get_self (player.getState).
    expect(gameWorldIdentityFrom(
      { content: [], structuredContent: { minecraftVersion: '1.21.1' } },
      { content: [], structuredContent: { dimension: 'minecraft:overworld', uuid: 'player-uuid' } },
    )).toEqual({
      minecraftVersion: '1.21.1',
      worldId: 'connection-scoped',
      dimension: 'minecraft:overworld',
      playerUuid: 'player-uuid',
    })
  })

  it('returns undefined when no Minecraft version can be read', () => {
    expect(gameWorldIdentityFrom({ content: [], structuredContent: { dimension: 'overworld' } })).toBeUndefined()
    expect(gameWorldIdentityFrom({ content: [] })).toBeUndefined()
    expect(gameWorldIdentityFrom({ content: [{ type: 'text', text: 'not json' }] })).toBeUndefined()
  })
})

describe('game host config persistence', () => {
  it('round-trips a config including the token', async () => {
    const directory = await temporaryDirectory('airi-game-host-config-')
    const path = join(directory, 'game-host.json')

    await writeGameHostConfig(path, {
      url: 'http://127.0.0.1:25600/mcp',
      token: 'secret-token',
      allowedTools: ['get_status', 'get_self'],
    })

    expect(await readGameHostConfig(path)).toEqual({
      url: 'http://127.0.0.1:25600/mcp',
      token: 'secret-token',
      allowedTools: ['get_status', 'get_self'],
    })
  })

  it('returns undefined for a missing or malformed config', async () => {
    const directory = await temporaryDirectory('airi-game-host-missing-')
    expect(await readGameHostConfig(join(directory, 'nope.json'))).toBeUndefined()
  })

  it('round-trips the movement planner selection', async () => {
    const directory = await temporaryDirectory('airi-game-host-movement-')
    const path = join(directory, 'game-host.json')
    await writeGameHostConfig(path, {
      url: 'http://127.0.0.1:25600/mcp',
      allowedTools: [],
      movement: { planner: 'terrain' },
    })
    expect(await readGameHostConfig(path)).toMatchObject({ movement: { planner: 'terrain' } })

    // An unknown planner value is dropped rather than trusted.
    await writeGameHostConfig(path, {
      url: 'http://127.0.0.1:25600/mcp',
      allowedTools: [],
      movement: { planner: 'warp' as never },
    })
    expect((await readGameHostConfig(path))?.movement).toBeUndefined()
  })
})

describe('setupGameHost', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    appMock.getVersion.mockReturnValue('0.10.0')
    clientInstances.items.length = 0
    transportInstances.items.length = 0
    clientMocks.connect.mockResolvedValue(undefined)
    clientMocks.callTool.mockResolvedValue({ content: [] })
    clientMocks.close.mockResolvedValue(undefined)
  })

  it('connects with a loopback URL and sends the bearer token as a header', async () => {
    const directory = await temporaryDirectory('airi-game-host-connect-')
    const context = createHostContext()
    await setupGameHost(context, { persistencePath: join(directory, 'game-host.json') }, directory)

    expect(await defineInvoke(context, gameHostGetStatus)()).toEqual({ status: 'unconfigured' })

    const status = await defineInvoke(context, gameHostApplyConfig)({
      url: 'http://127.0.0.1:25600/mcp',
      token: 'secret-token',
      allowedTools: [],
    })

    expect(status.status).toBe('connected')
    expect(transportInstances.items[0]?.url).toBe('http://127.0.0.1:25600/mcp')
    expect(transportInstances.items[0]?.requestInit?.headers).toEqual({ Authorization: 'Bearer secret-token' })
    expect(clientMocks.callTool).toHaveBeenCalledWith({ name: 'get_status', arguments: {} })
    expect(clientMocks.callTool).toHaveBeenCalledWith({ name: 'get_self', arguments: {} })
  })

  it('caches the world identity from get_status and get_self', async () => {
    clientMocks.callTool.mockImplementation(async ({ name }: { name: string }) => {
      if (name === 'get_status')
        return { content: [], structuredContent: { minecraftVersion: '1.21.1' } }
      return { content: [], structuredContent: { dimension: 'minecraft:overworld', uuid: 'player-uuid' } }
    })

    const directory = await temporaryDirectory('airi-game-host-identity-')
    const context = createHostContext()
    await setupGameHost(context, { persistencePath: join(directory, 'game-host.json') }, directory)

    const status = await defineInvoke(context, gameHostApplyConfig)({
      url: 'http://127.0.0.1:25600/mcp',
      token: 'secret-token',
      allowedTools: [],
    })

    expect(status.status).toBe('connected')
    expect(status.identity).toEqual({
      minecraftVersion: '1.21.1',
      worldId: 'connection-scoped',
      dimension: 'minecraft:overworld',
      playerUuid: 'player-uuid',
    })
  })

  it('rejects a non-loopback url before any connection is attempted', async () => {
    const directory = await temporaryDirectory('airi-game-host-loopback-')
    const context = createHostContext()
    await setupGameHost(context, { persistencePath: join(directory, 'game-host.json') }, directory)

    const status = await defineInvoke(context, gameHostApplyConfig)({
      url: 'http://example.com/mcp',
      token: 'secret-token',
      allowedTools: [],
    })

    expect(status.status).toBe('error')
    expect(status.error).toContain('game bridge endpoint must be loopback, got example.com')
    expect(clientInstances.items).toHaveLength(0)
    expect(transportInstances.items).toHaveLength(0)
  })

  it('strips the token from the config view exposed over IPC', async () => {
    const directory = await temporaryDirectory('airi-game-host-view-')
    const context = createHostContext()
    await setupGameHost(context, { persistencePath: join(directory, 'game-host.json') }, directory)

    await defineInvoke(context, gameHostApplyConfig)({
      url: 'http://127.0.0.1:25600/mcp',
      token: 'secret-token',
      allowedTools: ['get_status'],
    })

    expect(await defineInvoke(context, gameHostGetConfig)()).toEqual({
      url: 'http://127.0.0.1:25600/mcp',
      hasToken: true,
      allowedTools: ['get_status'],
      movement: { planner: 'terrain' },
    })
  })

  it('keeps the stored token when an apply omits it', async () => {
    const directory = await temporaryDirectory('airi-game-host-token-keep-')
    const context = createHostContext()
    await setupGameHost(context, { persistencePath: join(directory, 'game-host.json') }, directory)

    await defineInvoke(context, gameHostApplyConfig)({
      url: 'http://127.0.0.1:25600/mcp',
      token: 'secret-token',
      allowedTools: ['get_status'],
    })
    clientInstances.items.length = 0
    transportInstances.items.length = 0

    await defineInvoke(context, gameHostApplyConfig)({
      url: 'http://127.0.0.1:25600/mcp',
      allowedTools: ['get_status'],
    })

    expect(transportInstances.items[0]?.requestInit?.headers).toEqual({ Authorization: 'Bearer secret-token' })
    expect((await defineInvoke(context, gameHostGetConfig)()).hasToken).toBe(true)
  })

  it('disconnects and persists an empty url when the bridge is disabled', async () => {
    const directory = await temporaryDirectory('airi-game-host-clear-')
    const path = join(directory, 'game-host.json')
    const context = createHostContext()
    await setupGameHost(context, { persistencePath: path }, directory)

    await defineInvoke(context, gameHostApplyConfig)({
      url: 'http://127.0.0.1:25600/mcp',
      token: 'secret-token',
      allowedTools: ['get_status'],
    })
    expect((await defineInvoke(context, gameHostGetStatus)()).status).toBe('connected')

    const cleared = await defineInvoke(context, gameHostApplyConfig)({ url: '', allowedTools: [] })

    expect(cleared).toEqual({ status: 'unconfigured' })
    expect((await defineInvoke(context, gameHostGetStatus)()).status).toBe('unconfigured')
    expect(clientMocks.close).toHaveBeenCalled()
    // The next boot must not silently reconnect to the previous bridge.
    expect(await readGameHostConfig(path)).toBeUndefined()
  })

  it('reconnects after an empty-url disconnect without a duplicate capability withdrawal', async () => {
    // ROOT CAUSE:
    // `connect()` calls `disconnect()` before every attempt, and the empty-url
    // flow already withdrew the capability. The plugin-host rejects a second
    // `withdraw` (`withdrawn -> withdrawn`), so the reconnect threw before
    // dialing the bridge.
    let capability: 'none' | 'announced' | 'ready' | 'withdrawn' = 'none'
    const capabilities = {
      announce: vi.fn(() => {
        if (capability !== 'none' && capability !== 'withdrawn')
          throw new Error(`Illegal capability state transition: ${capability} -> announced`)
        capability = 'announced'
      }),
      ready: vi.fn(() => {
        if (capability !== 'announced')
          throw new Error(`Illegal capability state transition: ${capability} -> ready`)
        capability = 'ready'
      }),
      withdraw: vi.fn(() => {
        if (capability !== 'ready' && capability !== 'announced')
          throw new Error(`Illegal capability state transition: ${capability} -> withdrawn`)
        capability = 'withdrawn'
      }),
    }
    const directory = await temporaryDirectory('airi-game-host-reconnect-')
    const context = createHostContext()
    await setupGameHost(context, { persistencePath: join(directory, 'game-host.json'), capabilities }, directory)

    await defineInvoke(context, gameHostApplyConfig)({ url: 'http://127.0.0.1:25600/mcp', token: 'secret-token', allowedTools: [] })
    await defineInvoke(context, gameHostApplyConfig)({ url: '', allowedTools: [] })
    const reconnected = await defineInvoke(context, gameHostApplyConfig)({ url: 'http://127.0.0.1:25600/mcp', allowedTools: [] })

    expect(reconnected.status).toBe('connected')
    expect(capabilities.withdraw).toHaveBeenCalledTimes(1)
    expect(capabilities.announce).toHaveBeenCalledTimes(2)
    expect(capability).toBe('ready')
  })

  it('observes only tools on the allowed whitelist', async () => {
    const directory = await temporaryDirectory('airi-game-host-whitelist-')
    const context = createHostContext()
    await setupGameHost(context, { persistencePath: join(directory, 'game-host.json') }, directory)

    await defineInvoke(context, gameHostApplyConfig)({
      url: 'http://127.0.0.1:25600/mcp',
      allowedTools: ['get_status'],
    })

    const result = await defineInvoke(context, gameHostObserve)({ toolName: 'get_status', arguments: {} })
    expect(result.toolName).toBe('get_status')
    expect(result.content).toEqual([])

    await expect(defineInvoke(context, gameHostObserve)({ toolName: 'give', arguments: {} }))
      .rejects
      .toThrow('game tool is not allowed: give')
  })

  it('applies the persisted config at boot', async () => {
    const directory = await temporaryDirectory('airi-game-host-boot-')
    const path = join(directory, 'game-host.json')
    await writeGameHostConfig(path, {
      url: 'http://127.0.0.1:25600/mcp',
      token: 'boot-token',
      allowedTools: [],
    })

    const context = createHostContext()
    await setupGameHost(context, { persistencePath: path }, directory)

    expect((await defineInvoke(context, gameHostGetStatus)()).status).toBe('connected')
    expect(transportInstances.items[0]?.requestInit?.headers?.Authorization).toBe('Bearer boot-token')
  })

  it('exposes the MC-0c/MC-1a/MC-2d domain tools', async () => {
    const directory = await temporaryDirectory('airi-game-host-domain-tools-')
    const context = createHostContext()
    await setupGameHost(context, { persistencePath: join(directory, 'game-host.json') }, directory)

    const tools = await defineInvoke(context, gameHostListDomainTools)()
    expect(tools.map(tool => tool.name)).toEqual([
      'game_observe',
      'game_move_to',
      'game_status',
      'game_cancel',
      'game_say',
      'game_collect',
      'game_follow',
      'game_craft',
      'game_drop',
      'game_locate',
      'game_equip',
      'game_use',
      'game_open_container',
      'game_read_menu',
      'game_move_item',
      'game_close_menu',
      'game_craft_table',
      'game_smelt_load',
      'game_smelt_take',
      'game_supply',
      'game_sleep',
      'game_respawn',
      'game_shoot',
      'game_riptide',
      'game_menu_action',
      'game_read_item',
      'game_read_sign',
      'game_place',
      'game_break',
      'game_attack',
    ])
    expect(tools.every(tool => tool.parameters.type === 'object')).toBe(true)
  })

  it('rejects a domain command while the host is not connected', async () => {
    const directory = await temporaryDirectory('airi-game-host-not-connected-')
    const context = createHostContext()
    await setupGameHost(context, { persistencePath: join(directory, 'game-host.json') }, directory)

    const result = await defineInvoke(context, gameHostExecuteCommand)({ requestId: 'req-1', action: 'observe', params: {} })
    expect(result).toMatchObject({ status: 'rejected', checked: false, commandId: null, endReason: 'not_connected' })
  })

  it('observes through the registry and grades the receipt checked', async () => {
    clientMocks.callTool.mockImplementation(async ({ name }: { name: string }) => {
      if (name === 'get_status')
        return { content: [], structuredContent: { minecraftVersion: '1.21.1', worldId: 'world-1', dimension: 'minecraft:overworld' } }
      if (name === 'get_self')
        return { content: [], structuredContent: { x: 10, y: 64, z: 10, health: 20, food: 18, selectedSlot: 0, dimension: 'minecraft:overworld' } }
      if (name === 'get_inventory')
        return { content: [], structuredContent: { selectedSlot: 0, hotbar: [{ slot: 0, id: 'minecraft:bread', count: 1 }], main: [], armor: [], offhand: { empty: true } } }
      if (name === 'get_blocks_region')
        return { content: [], structuredContent: { count: 1, blocks: [] } }
      return { content: [] }
    })

    const directory = await temporaryDirectory('airi-game-host-observe-')
    const context = createHostContext()
    await setupGameHost(context, { persistencePath: join(directory, 'game-host.json') }, directory)
    await defineInvoke(context, gameHostApplyConfig)({ url: 'http://127.0.0.1:25600/mcp', allowedTools: [] })

    const result = await defineInvoke(context, gameHostExecuteCommand)({ requestId: 'req-observe', action: 'observe', params: { radius: 12 } })

    expect(result).toMatchObject({
      status: 'ok',
      checked: true,
      commandId: 'req-observe',
      postCondition: { kind: 'observed', target: 12, actual: 12, met: true },
      finalSnapshot: { position: { x: 10, y: 64, z: 10 }, health: 20, food: 18, heldItem: 'minecraft:bread' },
      // MC-1b D1: the result names the world the receipt was issued for.
      world: { worldId: 'world-1', dimension: 'minecraft:overworld', connectionGeneration: 1, connectionId: expect.any(String) },
    })
  })

  it('dedups a retried move command by request id', async () => {
    let selfCalls = 0
    clientMocks.callTool.mockImplementation(async ({ name }: { name: string }) => {
      if (name === 'get_self') {
        selfCalls++
        return { content: [], structuredContent: { x: selfCalls === 1 ? 0 : 4, y: 64, z: 0, health: 20, food: 20 } }
      }
      if (name === 'navigate_to')
        return { content: [], structuredContent: { started: true, pathLength: 5 } }
      if (name === 'navigation_status')
        return { content: [], structuredContent: { active: false, endReason: 'reached', finalDistance: 0.5, finalPosition: { x: 4, y: 64, z: 0 } } }
      return { content: [] }
    })

    const directory = await temporaryDirectory('airi-game-host-dedup-')
    const context = createHostContext()
    await setupGameHost(context, { persistencePath: join(directory, 'game-host.json') }, directory)
    await defineInvoke(context, gameHostApplyConfig)({ url: 'http://127.0.0.1:25600/mcp', allowedTools: [], movement: { planner: 'legacy' } })

    const first = await defineInvoke(context, gameHostExecuteCommand)({ requestId: 'req-move', action: 'move_to', params: { x: 4, y: 64, z: 0, tolerance: 1 } })
    const second = await defineInvoke(context, gameHostExecuteCommand)({ requestId: 'req-move', action: 'move_to', params: { x: 4, y: 64, z: 0, tolerance: 1 } })

    expect(second.commandId).toBe(first.commandId)
    expect(first).toMatchObject({ status: 'ok', checked: true, postCondition: { kind: 'distance', target: 1, met: true } })
    const pathCalls = clientMocks.callTool.mock.calls.filter(([args]: [{ name: string }]) => args.name === 'navigate_to')
    const statusCalls = clientMocks.callTool.mock.calls.filter(([args]: [{ name: string }]) => args.name === 'navigation_status')
    expect(pathCalls).toHaveLength(1)
    expect(statusCalls).toHaveLength(1)
  })

  it('rejects a second write while one is in flight', async () => {
    let releasePath: (() => void) | undefined
    clientMocks.callTool.mockImplementation(async ({ name }: { name: string }) => {
      if (name === 'get_self')
        return { content: [], structuredContent: { x: 0, y: 64, z: 0, health: 20, food: 20 } }
      if (name === 'navigate_to') {
        await new Promise<void>((resolve) => {
          releasePath = resolve
        })
        return { content: [], structuredContent: { started: true } }
      }
      if (name === 'navigation_status')
        return { content: [], structuredContent: { active: false, endReason: 'reached', finalPosition: { x: 0, y: 64, z: 0 } } }
      return { content: [] }
    })

    const directory = await temporaryDirectory('airi-game-host-busy-')
    const context = createHostContext()
    await setupGameHost(context, { persistencePath: join(directory, 'game-host.json') }, directory)
    await defineInvoke(context, gameHostApplyConfig)({ url: 'http://127.0.0.1:25600/mcp', allowedTools: [], movement: { planner: 'legacy' } })

    const inFlight = defineInvoke(context, gameHostExecuteCommand)({ requestId: 'req-a', action: 'move_to', params: { x: 1, y: 64, z: 0 } })
    await vi.waitFor(() => expect(releasePath).toBeDefined())
    const busy = await defineInvoke(context, gameHostExecuteCommand)({ requestId: 'req-b', action: 'move_to', params: { x: 2, y: 64, z: 0 } })

    expect(busy).toMatchObject({ status: 'busy', checked: false, commandId: null })
    expect(busy.endReason).toContain('busy: req-a')
    releasePath!()
    await inFlight
  })

  // 2026-09-12 live smoke: game_status reported the previous terminal receipt
  // while a new write command was still running, so the caller believed the
  // old command was active and never saw the new one.
  it('reports the running command from game_status while one is in flight', async () => {
    let releasePath: (() => void) | undefined
    clientMocks.callTool.mockImplementation(async ({ name }: { name: string }) => {
      if (name === 'get_self')
        return { content: [], structuredContent: { x: 0, y: 64, z: 0, health: 20, food: 20 } }
      if (name === 'navigate_to') {
        await new Promise<void>((resolve) => {
          releasePath = resolve
        })
        return { content: [], structuredContent: { started: true } }
      }
      if (name === 'navigation_status')
        return { content: [], structuredContent: { active: false, endReason: 'reached', finalPosition: { x: 0, y: 64, z: 0 } } }
      return { content: [] }
    })

    const directory = await temporaryDirectory('airi-game-host-status-')
    const context = createHostContext()
    await setupGameHost(context, { persistencePath: join(directory, 'game-host.json') }, directory)
    await defineInvoke(context, gameHostApplyConfig)({ url: 'http://127.0.0.1:25600/mcp', allowedTools: [], movement: { planner: 'legacy' } })

    const inFlight = defineInvoke(context, gameHostExecuteCommand)({ requestId: 'req-a', action: 'move_to', params: { x: 1, y: 64, z: 0 } })
    await vi.waitFor(() => expect(releasePath).toBeDefined())

    const status = await defineInvoke(context, gameHostExecuteCommand)({ requestId: 'req-status', action: 'status', params: {} })
    expect(status).toMatchObject({ commandId: 'req-a', endReason: 'running', checked: false })

    const byId = await defineInvoke(context, gameHostExecuteCommand)({ requestId: 'req-status-2', action: 'status', params: { commandId: 'req-a' } })
    expect(byId).toMatchObject({ commandId: 'req-a', endReason: 'running', checked: false })

    releasePath!()
    await inFlight
  })

  it('says through the registry without claiming change evidence', async () => {
    clientMocks.callTool.mockImplementation(async ({ name }: { name: string }) => {
      if (name === 'get_self')
        return { content: [], structuredContent: { x: 0, y: 64, z: 0, health: 20, food: 20 } }
      if (name === 'get_inventory')
        return { content: [], structuredContent: { selectedSlot: 0, hotbar: [], main: [], armor: [], offhand: { empty: true } } }
      if (name === 'send_chat')
        return { content: [], structuredContent: { sent: true } }
      return { content: [] }
    })

    const directory = await temporaryDirectory('airi-game-host-say-')
    const context = createHostContext()
    await setupGameHost(context, { persistencePath: join(directory, 'game-host.json') }, directory)
    await defineInvoke(context, gameHostApplyConfig)({ url: 'http://127.0.0.1:25600/mcp', allowedTools: [] })

    const result = await defineInvoke(context, gameHostExecuteCommand)({
      requestId: 'req-say',
      action: 'say',
      params: { text: 'hello world' },
    })

    expect(result).toMatchObject({
      status: 'ok',
      checked: false,
      commandId: 'req-say',
      endReason: 'said',
      postCondition: { kind: 'none', met: true },
    })
    expect(clientMocks.callTool).toHaveBeenCalledWith({ name: 'send_chat', arguments: { message: 'hello world' } })
  })

  it('collects the requested count with a per-break attribution', async () => {
    // The four logs appear only once the break starts, so the pickup is
    // attributed to this break's window.
    let broken = false
    clientMocks.callTool.mockImplementation(async ({ name }: { name: string }) => {
      if (name === 'get_self')
        return { content: [], structuredContent: { x: 0, y: 64, z: 0, health: 20, food: 20 } }
      if (name === 'get_inventory') {
        return {
          content: [],
          structuredContent: {
            selectedSlot: 0,
            hotbar: broken ? [{ slot: 0, id: 'minecraft:oak_log', count: 4 }] : [],
            main: [],
            armor: [],
            offhand: { empty: true },
          },
        }
      }
      if (name === 'find_blocks')
        return { content: [], structuredContent: { matches: [{ x: 2, y: 64, z: 0, id: 'minecraft:oak_log', distance: 2 }], truncated: false } }
      if (name === 'navigate_to')
        return { content: [], structuredContent: { started: true } }
      if (name === 'navigation_status')
        return { content: [], structuredContent: { active: false, endReason: 'reached' } }
      if (name === 'break_block') {
        broken = true
        return { content: [], structuredContent: { broken: true } }
      }
      if (name === 'get_block')
        return { content: [], structuredContent: { id: 'minecraft:air' } }
      if (name === 'poll_events')
        return { content: [], structuredContent: { events: [] } }
      return { content: [] }
    })

    const directory = await temporaryDirectory('airi-game-host-collect-')
    const context = createHostContext()
    await setupGameHost(context, { persistencePath: join(directory, 'game-host.json') }, directory)
    await defineInvoke(context, gameHostApplyConfig)({ url: 'http://127.0.0.1:25600/mcp', allowedTools: [] })

    const result = await defineInvoke(context, gameHostExecuteCommand)({
      requestId: 'req-collect',
      action: 'collect',
      params: { blockId: 'minecraft:oak_log', maxCount: 4, radius: 16 },
    })

    expect(result).toMatchObject({
      status: 'ok',
      checked: true,
      commandId: 'req-collect',
      endReason: 'collected',
      postCondition: { kind: 'collected', target: 4, actual: 4, met: true },
    })
    // The candidate sits next to the player, so the executor must break it
    // directly instead of walking (a block under the feet has no standable
    // A* target and used to fail with `unreachable`).
    const navCalls = clientMocks.callTool.mock.calls.filter(([args]: [{ name: string }]) => args.name === 'navigate_to')
    expect(navCalls).toHaveLength(0)
  })

  // §9-6: a drop that fell one block into a pit was unreachable, so the item
  // stayed on the ground. The executor now covers the cell with one scaffolding
  // block (the drop rises to the surface) and retries the pickup once.
  it('recovers a drop in a one-block pit with one scaffolding placement', async () => {
    let placed = false
    clientMocks.callTool.mockImplementation(async ({ name }: { name: string }) => {
      if (name === 'get_self')
        return { content: [], structuredContent: { x: 0, y: 64, z: 0, health: 20, food: 20 } }
      if (name === 'get_inventory') {
        return {
          content: [],
          structuredContent: {
            selectedSlot: 0,
            hotbar: [
              { slot: 0, id: 'minecraft:oak_planks', count: 1 },
              ...(placed ? [{ slot: 1, id: 'minecraft:oak_log', count: 1 }] : []),
            ],
            main: [],
            armor: [],
            offhand: { empty: true },
          },
        }
      }
      if (name === 'find_blocks')
        return { content: [], structuredContent: { matches: [{ x: 2, y: 63, z: 0, id: 'minecraft:oak_log', distance: 2 }], truncated: false } }
      if (name === 'break_block')
        return { content: [], structuredContent: { broken: true } }
      if (name === 'get_block')
        return { content: [], structuredContent: { id: 'minecraft:air' } }
      if (name === 'select_hotbar_slot')
        return { content: [], structuredContent: { selected: true } }
      if (name === 'place_block') {
        placed = true
        return { content: [], structuredContent: { placed: true } }
      }
      if (name === 'poll_events')
        return { content: [], structuredContent: { events: [] } }
      return { content: [] }
    })

    const directory = await temporaryDirectory('airi-game-host-collect-pit-')
    const context = createHostContext()
    await setupGameHost(context, { persistencePath: join(directory, 'game-host.json') }, directory)
    await defineInvoke(context, gameHostApplyConfig)({ url: 'http://127.0.0.1:25600/mcp', allowedTools: [] })

    const result = await defineInvoke(context, gameHostExecuteCommand)({
      requestId: 'req-collect-pit',
      action: 'collect',
      params: { blockId: 'minecraft:oak_log', maxCount: 1, radius: 16 },
    })

    expect(result).toMatchObject({
      status: 'ok',
      endReason: 'collected',
      postCondition: { kind: 'collected', target: 1, actual: 1, met: true },
    })
    expect(result.dropPosition).toBeUndefined()
    const placeCalls = clientMocks.callTool.mock.calls.filter(([args]: [{ name: string }]) => args.name === 'place_block')
    expect(placeCalls).toHaveLength(1)
  }, 20_000)

  // §9-6: without a scaffolding item the recovery cannot run; the receipt must
  // report where the drop stayed instead of digging forever.
  it('reports the drop position when a pit drop cannot be recovered', async () => {
    let findCalls = 0
    clientMocks.callTool.mockImplementation(async ({ name }: { name: string }) => {
      if (name === 'get_self')
        return { content: [], structuredContent: { x: 0, y: 64, z: 0, health: 20, food: 20 } }
      if (name === 'get_inventory')
        return { content: [], structuredContent: { selectedSlot: 0, hotbar: [], main: [], armor: [], offhand: { empty: true } } }
      if (name === 'find_blocks') {
        findCalls++
        return findCalls === 1
          ? { content: [], structuredContent: { matches: [{ x: 2, y: 63, z: 0, id: 'minecraft:oak_log', distance: 2 }], truncated: false } }
          : { content: [], structuredContent: { matches: [], truncated: false } }
      }
      if (name === 'break_block')
        return { content: [], structuredContent: { broken: true } }
      if (name === 'get_block')
        return { content: [], structuredContent: { id: 'minecraft:air' } }
      if (name === 'poll_events')
        return { content: [], structuredContent: { events: [] } }
      return { content: [] }
    })

    const directory = await temporaryDirectory('airi-game-host-collect-pit-stuck-')
    const context = createHostContext()
    await setupGameHost(context, { persistencePath: join(directory, 'game-host.json') }, directory)
    await defineInvoke(context, gameHostApplyConfig)({ url: 'http://127.0.0.1:25600/mcp', allowedTools: [] })

    const result = await defineInvoke(context, gameHostExecuteCommand)({
      requestId: 'req-collect-pit-stuck',
      action: 'collect',
      params: { blockId: 'minecraft:oak_log', maxCount: 1, radius: 16 },
    })

    expect(result).toMatchObject({
      status: 'failed',
      endReason: 'no_target',
      postCondition: { kind: 'collected', target: 1, actual: 0, met: false },
      dropPosition: { x: 2, y: 63, z: 0 },
    })
    const placeCalls = clientMocks.callTool.mock.calls.filter(([args]: [{ name: string }]) => args.name === 'place_block')
    expect(placeCalls).toHaveLength(0)
  }, 20_000)

  it('crafts a known recipe and reports the measured inventory delta', async () => {
    let inventoryReads = 0
    let craftCalls = 0
    clientMocks.callTool.mockImplementation(async ({ name }: { name: string }) => {
      if (name === 'get_self')
        return { content: [], structuredContent: { x: 0, y: 64, z: 0, health: 20, food: 20 } }
      if (name === 'get_inventory') {
        inventoryReads++
        const crafted = inventoryReads > 1
        return {
          content: [],
          structuredContent: {
            selectedSlot: 0,
            hotbar: crafted
              ? [
                  { slot: 0, id: 'farmersdelight:flint_knife', count: 1 },
                  { slot: 1, id: 'minecraft:flint', count: 2 },
                  { slot: 2, id: 'minecraft:stick', count: 2 },
                ]
              : [
                  { slot: 1, id: 'minecraft:flint', count: 3 },
                  { slot: 2, id: 'minecraft:stick', count: 3 },
                ],
            main: [],
            armor: [],
            offhand: { empty: true },
          },
        }
      }
      if (name === 'craft_by_recipe') {
        craftCalls++
        return craftCalls > 1
          ? { content: [], structuredContent: { claimed: true, output: { id: 'farmersdelight:flint_knife', count: 1 } } }
          : { content: [], structuredContent: { placed: true } }
      }
      return { content: [] }
    })

    const directory = await temporaryDirectory('airi-game-host-craft-')
    const context = createHostContext()
    await setupGameHost(context, { persistencePath: join(directory, 'game-host.json') }, directory)
    await defineInvoke(context, gameHostApplyConfig)({ url: 'http://127.0.0.1:25600/mcp', allowedTools: [] })

    const result = await defineInvoke(context, gameHostExecuteCommand)({
      requestId: 'req-craft',
      action: 'craft',
      params: { recipeId: 'farmersdelight:flint_knife' },
    })

    expect(result).toMatchObject({
      status: 'ok',
      checked: true,
      commandId: 'req-craft',
      endReason: 'crafted',
      postCondition: { kind: 'crafted', target: 1, actual: 1, met: true },
      crafted: {
        recipeId: 'farmersdelight:flint_knife',
        output: { id: 'farmersdelight:flint_knife', count: 1 },
        attempts: 2,
        inventoryDelta: { 'farmersdelight:flint_knife': 1, 'minecraft:flint': -1, 'minecraft:stick': -1 },
      },
    })
  })

  it('fails a recipe that needs a crafting table without claiming success', async () => {
    clientMocks.callTool.mockImplementation(async ({ name }: { name: string }) => {
      if (name === 'get_self')
        return { content: [], structuredContent: { x: 0, y: 64, z: 0, health: 20, food: 20 } }
      if (name === 'get_inventory')
        return { content: [], structuredContent: { selectedSlot: 0, hotbar: [], main: [], armor: [], offhand: { empty: true } } }
      if (name === 'craft_by_recipe')
        return { content: [], structuredContent: { error: 'recipe_needs_crafting_table' } }
      return { content: [] }
    })

    const directory = await temporaryDirectory('airi-game-host-craft-fail-')
    const context = createHostContext()
    await setupGameHost(context, { persistencePath: join(directory, 'game-host.json') }, directory)
    await defineInvoke(context, gameHostApplyConfig)({ url: 'http://127.0.0.1:25600/mcp', allowedTools: [] })

    const result = await defineInvoke(context, gameHostExecuteCommand)({
      requestId: 'req-craft-fail',
      action: 'craft',
      params: { recipeId: 'farmersdelight:cutting_board' },
    })

    expect(result).toMatchObject({ status: 'failed', checked: false, endReason: 'executor_error: craft failed: recipe_needs_crafting_table' })
    expect(result.postCondition).toMatchObject({ met: false })
    expect(result.crafted).toBeUndefined()
  })

  it('reports an exhausted craft loop as not_confirmed, never as crafted', async () => {
    clientMocks.callTool.mockImplementation(async ({ name }: { name: string }) => {
      if (name === 'get_self')
        return { content: [], structuredContent: { x: 0, y: 64, z: 0, health: 20, food: 20 } }
      if (name === 'get_inventory')
        return { content: [], structuredContent: { selectedSlot: 0, hotbar: [], main: [], armor: [], offhand: { empty: true } } }
      if (name === 'craft_by_recipe')
        return { content: [], structuredContent: { placed: true } }
      return { content: [] }
    })

    const directory = await temporaryDirectory('airi-game-host-craft-exhausted-')
    const context = createHostContext()
    await setupGameHost(context, { persistencePath: join(directory, 'game-host.json') }, directory)
    await defineInvoke(context, gameHostApplyConfig)({ url: 'http://127.0.0.1:25600/mcp', allowedTools: [] })

    const result = await defineInvoke(context, gameHostExecuteCommand)({
      requestId: 'req-craft-exhausted',
      action: 'craft',
      params: { recipeId: 'farmersdelight:iron_knife' },
    })

    expect(result).toMatchObject({ status: 'failed', checked: false, endReason: 'executor_error: craft failed: not_confirmed' })
  })

  it('drops a hotbar stack and reports the measured inventory decrease', async () => {
    let inventoryReads = 0
    let dropCalls = 0
    clientMocks.callTool.mockImplementation(async ({ name }: { name: string }) => {
      if (name === 'get_self')
        return { content: [], structuredContent: { x: 0, y: 64, z: 0, health: 20, food: 20 } }
      if (name === 'get_inventory') {
        inventoryReads++
        const remaining = inventoryReads >= 3 ? 2 : 4
        return {
          content: [],
          structuredContent: {
            selectedSlot: 0,
            hotbar: remaining > 0 ? [{ slot: 2, id: 'minecraft:oak_log', count: remaining }] : [],
            main: [],
            armor: [],
            offhand: { empty: true },
          },
        }
      }
      if (name === 'select_hotbar_slot')
        return { content: [], structuredContent: { ok: true, message: 'selected slot 2' } }
      if (name === 'drop_held_item') {
        dropCalls++
        return { content: [], structuredContent: { ok: true, message: 'dropped one' } }
      }
      return { content: [] }
    })

    const directory = await temporaryDirectory('airi-game-host-drop-')
    const context = createHostContext()
    await setupGameHost(context, { persistencePath: join(directory, 'game-host.json') }, directory)
    await defineInvoke(context, gameHostApplyConfig)({ url: 'http://127.0.0.1:25600/mcp', allowedTools: [] })

    const result = await defineInvoke(context, gameHostExecuteCommand)({
      requestId: 'req-drop',
      action: 'drop',
      params: { itemId: 'minecraft:oak_log', count: 2 },
    })

    expect(dropCalls).toBe(2)
    expect(result).toMatchObject({
      status: 'ok',
      checked: true,
      endReason: 'dropped',
      postCondition: { kind: 'dropped', target: 2, actual: 2, met: true },
      dropped: { itemId: 'minecraft:oak_log', count: 2, slot: 2 },
    })
  })

  it('moves a main-inventory stack into the hotbar before dropping it', async () => {
    let inventoryReads = 0
    let swapCalls = 0
    clientMocks.callTool.mockImplementation(async ({ name }: { name: string }) => {
      if (name === 'get_self')
        return { content: [], structuredContent: { x: 0, y: 64, z: 0, health: 20, food: 20 } }
      if (name === 'get_inventory') {
        inventoryReads++
        // The first two reads see the stack in the main inventory (baseline +
        // slot resolution); after the swap it sits in hotbar slot 5 and the
        // final read sees one fewer item.
        const inMain = inventoryReads <= 2
        const remaining = inventoryReads >= 3 ? 1 : 2
        return {
          content: [],
          structuredContent: {
            selectedSlot: 0,
            hotbar: inMain ? [] : [{ slot: 5, id: 'minecraft:oak_planks', count: remaining }],
            main: inMain ? [{ slot: 9, id: 'minecraft:oak_planks', count: 2 }] : [],
            armor: [],
            offhand: { empty: true },
          },
        }
      }
      if (name === 'swap_slots') {
        swapCalls++
        return { content: [], structuredContent: { ok: true, message: 'swapped' } }
      }
      if (name === 'select_hotbar_slot')
        return { content: [], structuredContent: { ok: true, message: 'selected slot 5' } }
      if (name === 'drop_held_item')
        return { content: [], structuredContent: { ok: true, message: 'dropped one' } }
      return { content: [] }
    })

    const directory = await temporaryDirectory('airi-game-host-drop-main-')
    const context = createHostContext()
    await setupGameHost(context, { persistencePath: join(directory, 'game-host.json') }, directory)
    await defineInvoke(context, gameHostApplyConfig)({ url: 'http://127.0.0.1:25600/mcp', allowedTools: [] })

    const result = await defineInvoke(context, gameHostExecuteCommand)({
      requestId: 'req-drop-main',
      action: 'drop',
      params: { itemId: 'minecraft:oak_planks', count: 1 },
    })

    expect(swapCalls).toBe(1)
    expect(result).toMatchObject({
      status: 'ok',
      checked: true,
      postCondition: { kind: 'dropped', target: 1, actual: 1, met: true },
      // The swap moved the stack into the first empty hotbar slot.
      dropped: { itemId: 'minecraft:oak_planks', count: 1, slot: 0, verifiedBy: 'inventory-delta' },
    })
  })

  it('verifies a late-reflected drop from the emptied target slot', async () => {
    // The count reads never change (throttled client), but the target slot is
    // empty after the accepted throws.
    clientMocks.callTool.mockImplementation(async ({ name }: { name: string }) => {
      if (name === 'get_self')
        return { content: [], structuredContent: { x: 0, y: 64, z: 0, health: 20, food: 20 } }
      if (name === 'get_inventory') {
        return {
          content: [],
          structuredContent: {
            selectedSlot: 0,
            hotbar: [],
            main: [{ slot: 9, id: 'minecraft:oak_log', count: 4 }],
            armor: [],
            offhand: { empty: true },
          },
        }
      }
      if (name === 'swap_slots')
        return { content: [], structuredContent: { ok: true, message: 'swapped' } }
      if (name === 'select_hotbar_slot')
        return { content: [], structuredContent: { ok: true, message: 'selected slot 0' } }
      if (name === 'drop_held_item')
        return { content: [], structuredContent: { ok: true, message: 'dropped one' } }
      return { content: [] }
    })

    const directory = await temporaryDirectory('airi-game-host-drop-late-')
    const context = createHostContext()
    await setupGameHost(context, { persistencePath: join(directory, 'game-host.json') }, directory)
    await defineInvoke(context, gameHostApplyConfig)({ url: 'http://127.0.0.1:25600/mcp', allowedTools: [] })

    const result = await defineInvoke(context, gameHostExecuteCommand)({
      requestId: 'req-drop-late',
      action: 'drop',
      params: { itemId: 'minecraft:oak_log', count: 2 },
    })

    expect(result).toMatchObject({
      status: 'ok',
      checked: true,
      postCondition: { kind: 'dropped', target: 2, actual: 2, met: true },
      dropped: { itemId: 'minecraft:oak_log', count: 2, slot: 0, verifiedBy: 'slot-empty' },
    })
  }, 20_000)

  it('fails to drop when a main-inventory stack has no hotbar slot to move into', async () => {
    clientMocks.callTool.mockImplementation(async ({ name }: { name: string }) => {
      if (name === 'get_self')
        return { content: [], structuredContent: { x: 0, y: 64, z: 0, health: 20, food: 20 } }
      if (name === 'get_inventory') {
        const hotbar = Array.from({ length: 9 }, (_, slot) => ({ slot, id: 'minecraft:cobblestone', count: 64 }))
        return { content: [], structuredContent: { selectedSlot: 0, hotbar, main: [{ slot: 9, id: 'minecraft:oak_log', count: 4 }], armor: [], offhand: { empty: true } } }
      }
      return { content: [] }
    })

    const directory = await temporaryDirectory('airi-game-host-drop-miss-')
    const context = createHostContext()
    await setupGameHost(context, { persistencePath: join(directory, 'game-host.json') }, directory)
    await defineInvoke(context, gameHostApplyConfig)({ url: 'http://127.0.0.1:25600/mcp', allowedTools: [] })

    const result = await defineInvoke(context, gameHostExecuteCommand)({
      requestId: 'req-drop-miss',
      action: 'drop',
      params: { itemId: 'minecraft:oak_log', count: 1 },
    })

    expect(result).toMatchObject({ status: 'failed', checked: false })
    expect(result.endReason).toContain('no_hotbar_space')
  })

  it('locates another player through the server-side player list', async () => {
    clientMocks.callTool.mockImplementation(async ({ name }: { name: string }) => {
      if (name === 'get_self')
        return { content: [], structuredContent: { x: 1, y: 64, z: 1, health: 20, food: 20 } }
      if (name === 'list_players')
        return { content: [], structuredContent: { count: 1, players: [{ name: 'AfterRain', uuid: 'u1', x: 36.7, y: 87.0, z: -11.6, dimension: 'minecraft:overworld' }] } }
      return { content: [] }
    })

    const directory = await temporaryDirectory('airi-game-host-locate-')
    const context = createHostContext()
    await setupGameHost(context, { persistencePath: join(directory, 'game-host.json') }, directory)
    await defineInvoke(context, gameHostApplyConfig)({ url: 'http://127.0.0.1:25600/mcp', allowedTools: [] })

    const result = await defineInvoke(context, gameHostExecuteCommand)({
      requestId: 'req-locate',
      action: 'locate',
      params: { name: 'afterrain' },
    })

    expect(result).toMatchObject({
      status: 'ok',
      endReason: 'located',
      located: { name: 'AfterRain', position: { x: 36.7, y: 87, z: -11.6 }, dimension: 'minecraft:overworld' },
    })
    // CD-L1: the locate receipt carries the uuid the player list already has.
    expect(result.located?.uuid).toBe('u1')
  })

  it('resolves a follow target through the player list when the entity list is truncated', async () => {
    const crowd = Array.from({ length: 100 }, (_, index) => ({ uuid: `u-${index}`, name: `Entity${index}`, type: 'minecraft:cow', position: { x: 0, y: 64, z: 0 } }))
    clientMocks.callTool.mockImplementation(async ({ name }: { name: string }) => {
      if (name === 'get_self')
        return { content: [], structuredContent: { x: 0, y: 64, z: 0, health: 20, food: 20 } }
      if (name === 'get_inventory')
        return { content: [], structuredContent: { selectedSlot: 0, hotbar: [], main: [], armor: [], offhand: { empty: true } } }
      if (name === 'query_entities')
        return { content: [], structuredContent: { entities: crowd, total: 130, returned: 100, dimension: 'minecraft:overworld' } }
      if (name === 'list_players')
        return { content: [], structuredContent: { players: [{ name: 'Alice', uuid: 'u-alice', x: 8, y: 64, z: 8, dimension: 'minecraft:overworld' }] } }
      if (name === 'get_blocks_region')
        return { content: [], structuredContent: { blocks: [] } }
      if (name === 'poll_events')
        return { content: [], structuredContent: { events: [] } }
      return { content: [] }
    })

    const directory = await temporaryDirectory('airi-game-host-follow-truncated-')
    const context = createHostContext()
    await setupGameHost(context, { persistencePath: join(directory, 'game-host.json') }, directory)
    await defineInvoke(context, gameHostApplyConfig)({ url: 'http://127.0.0.1:25600/mcp', allowedTools: [] })

    const result = await defineInvoke(context, gameHostExecuteCommand)({
      requestId: 'req-follow-truncated',
      action: 'follow',
      params: { target: 'Alice', keepDistance: 3, timeoutSeconds: 1 },
    })

    // The truncated entity list did not hide the target: the player list
    // resolved it, so the follow is not a target_lost (CD-L1).
    expect(result.endReason).not.toBe('target_lost')
    expect(result.endReason).not.toBe('target_not_in_read')
    const names = clientMocks.callTool.mock.calls.map(([args]: [{ name: string }]) => args.name)
    expect(names).toContain('list_players')
  }, 20_000)

  it('reports target_not_in_read when a truncated list cannot resolve a non-player target', async () => {
    const crowd = Array.from({ length: 100 }, (_, index) => ({ uuid: `u-${index}`, name: `Entity${index}`, type: 'minecraft:cow', position: { x: 0, y: 64, z: 0 } }))
    clientMocks.callTool.mockImplementation(async ({ name }: { name: string }) => {
      if (name === 'get_self')
        return { content: [], structuredContent: { x: 0, y: 64, z: 0, health: 20, food: 20 } }
      if (name === 'get_inventory')
        return { content: [], structuredContent: { selectedSlot: 0, hotbar: [], main: [], armor: [], offhand: { empty: true } } }
      if (name === 'query_entities')
        return { content: [], structuredContent: { entities: crowd, total: 130, returned: 100, dimension: 'minecraft:overworld' } }
      if (name === 'list_players')
        return { content: [], structuredContent: { players: [] } }
      return { content: [] }
    })

    const directory = await temporaryDirectory('airi-game-host-follow-truncated-none-')
    const context = createHostContext()
    await setupGameHost(context, { persistencePath: join(directory, 'game-host.json') }, directory)
    await defineInvoke(context, gameHostApplyConfig)({ url: 'http://127.0.0.1:25600/mcp', allowedTools: [] })

    const result = await defineInvoke(context, gameHostExecuteCommand)({
      requestId: 'req-follow-truncated-none',
      action: 'follow',
      params: { target: 'Ghost', keepDistance: 3 },
    })

    expect(result).toMatchObject({ status: 'failed', endReason: 'target_not_in_read', postCondition: { kind: 'none', met: false } })
  })

  it('passes the binding dimension to the follow entity query', async () => {
    clientMocks.callTool.mockImplementation(async ({ name }: { name: string }) => {
      if (name === 'get_status')
        return { content: [], structuredContent: { minecraftVersion: '1.21.1', worldId: 'world-1', dimension: 'minecraft:overworld' } }
      if (name === 'get_self')
        return { content: [], structuredContent: { x: 0, y: 64, z: 0, health: 20, food: 20, dimension: 'minecraft:overworld' } }
      if (name === 'get_inventory')
        return { content: [], structuredContent: { selectedSlot: 0, hotbar: [], main: [], armor: [], offhand: { empty: true } } }
      if (name === 'query_entities')
        return { content: [], structuredContent: { entities: [{ name: 'Alice', uuid: 'u-1', type: 'minecraft:player', position: { x: 5, y: 64, z: 0 } }], dimension: 'minecraft:overworld' } }
      if (name === 'get_blocks_region')
        return { content: [], structuredContent: { blocks: [] } }
      if (name === 'poll_events')
        return { content: [], structuredContent: { events: [] } }
      return { content: [] }
    })

    const directory = await temporaryDirectory('airi-game-host-follow-dimension-')
    const context = createHostContext()
    await setupGameHost(context, { persistencePath: join(directory, 'game-host.json') }, directory)
    await defineInvoke(context, gameHostApplyConfig)({ url: 'http://127.0.0.1:25600/mcp', allowedTools: [] })

    await defineInvoke(context, gameHostExecuteCommand)({
      requestId: 'req-follow-dimension',
      action: 'follow',
      params: { target: 'Alice', keepDistance: 3, timeoutSeconds: 1 },
    })

    // D12: the spatial read must name the dimension it belongs to.
    const queryArgs = (clientMocks.callTool.mock.calls.find(([args]) => args.name === 'query_entities')?.[0] as { arguments?: Record<string, unknown> } | undefined)?.arguments
    expect(queryArgs?.dimension).toBe('minecraft:overworld')
  }, 20_000)

  it('equips an item from the main inventory into the armor slot and verifies it', async () => {
    clientMocks.callTool.mockImplementation(async ({ name }: { name: string }) => {
      if (name === 'get_status')
        return { content: [], structuredContent: { minecraftVersion: '1.21.1', worldId: 'world-1', dimension: 'minecraft:overworld' } }
      if (name === 'get_self')
        return { content: [], structuredContent: { x: 0, y: 64, z: 0, health: 20, food: 20 } }
      if (name === 'get_inventory')
        return { content: [], structuredContent: { selectedSlot: 0, hotbar: [], main: [{ slot: 9, id: 'minecraft:iron_helmet', count: 1 }], armor: [], offhand: { empty: true } } }
      if (name === 'get_equipment')
        return { content: [], structuredContent: { mainHand: { empty: true }, offHand: { empty: true }, helmet: { id: 'minecraft:iron_helmet', count: 1 }, chest: { empty: true }, legs: { empty: true }, boots: { empty: true } } }
      if (name === 'swap_slots')
        return { content: [], structuredContent: { ok: true, message: 'swapped' } }
      return { content: [] }
    })

    const directory = await temporaryDirectory('airi-game-host-equip-')
    const context = createHostContext()
    await setupGameHost(context, { persistencePath: join(directory, 'game-host.json') }, directory)
    await defineInvoke(context, gameHostApplyConfig)({ url: 'http://127.0.0.1:25600/mcp', allowedTools: [] })

    const result = await defineInvoke(context, gameHostExecuteCommand)({
      requestId: 'req-equip',
      action: 'equip',
      params: { itemId: 'minecraft:iron_helmet', target: 'head' },
    })

    expect(result).toMatchObject({
      status: 'ok',
      checked: true,
      commandId: 'req-equip',
      endReason: 'equipped',
      postCondition: {
        kind: 'equipped',
        met: true,
        equipped: { target: 'head', expectedItemId: 'minecraft:iron_helmet', actualItemId: 'minecraft:iron_helmet' },
      },
      equipped: { itemId: 'minecraft:iron_helmet', target: 'head' },
    })
    // Main container slot 9 -> helmet menu slot 36.
    expect(clientMocks.callTool).toHaveBeenCalledWith({ name: 'swap_slots', arguments: { slotA: 9, slotB: 36 } })
  })

  it('fails an equip with not_in_inventory when the item is absent', async () => {
    clientMocks.callTool.mockImplementation(async ({ name }: { name: string }) => {
      if (name === 'get_status')
        return { content: [], structuredContent: { minecraftVersion: '1.21.1', worldId: 'world-1' } }
      if (name === 'get_self')
        return { content: [], structuredContent: { x: 0, y: 64, z: 0, health: 20, food: 20 } }
      if (name === 'get_inventory')
        return { content: [], structuredContent: { selectedSlot: 0, hotbar: [], main: [], armor: [], offhand: { empty: true } } }
      return { content: [] }
    })

    const directory = await temporaryDirectory('airi-game-host-equip-miss-')
    const context = createHostContext()
    await setupGameHost(context, { persistencePath: join(directory, 'game-host.json') }, directory)
    await defineInvoke(context, gameHostApplyConfig)({ url: 'http://127.0.0.1:25600/mcp', allowedTools: [] })

    const result = await defineInvoke(context, gameHostExecuteCommand)({
      requestId: 'req-equip-miss',
      action: 'equip',
      params: { itemId: 'minecraft:iron_helmet', target: 'head' },
    })

    expect(result).toMatchObject({ status: 'failed', checked: false, commandId: 'req-equip-miss' })
    expect(result.endReason).toContain('not_in_inventory')
    expect(result.equipped).toBeUndefined()
  })

  it('uses an item through start_using, a get_self poll, then release_using', async () => {
    clientMocks.callTool.mockImplementation(async ({ name }: { name: string }) => {
      if (name === 'get_status')
        return { content: [], structuredContent: { minecraftVersion: '1.21.1', worldId: 'world-1' } }
      if (name === 'get_self')
        return { content: [], structuredContent: { x: 0, y: 64, z: 0, health: 20, food: 20, usingItem: true, usingItemId: 'minecraft:bow', usingTicks: 3 } }
      if (name === 'get_inventory')
        return { content: [], structuredContent: { selectedSlot: 0, hotbar: [], main: [], armor: [], offhand: { empty: true } } }
      if (name === 'start_using')
        return { content: [], structuredContent: { using: true, usingItemId: 'minecraft:bow', usingTicks: 0 } }
      if (name === 'release_using')
        return { content: [], structuredContent: { using: false } }
      return { content: [] }
    })

    const directory = await temporaryDirectory('airi-game-host-use-')
    const context = createHostContext()
    await setupGameHost(context, { persistencePath: join(directory, 'game-host.json') }, directory)
    await defineInvoke(context, gameHostApplyConfig)({ url: 'http://127.0.0.1:25600/mcp', allowedTools: [] })

    const result = await defineInvoke(context, gameHostExecuteCommand)({
      requestId: 'req-use',
      action: 'use',
      params: { mode: 'item', holdTicks: 1 },
    })

    expect(result).toMatchObject({
      status: 'ok',
      checked: false,
      endReason: 'used',
      postCondition: { kind: 'none', met: true },
      used: { itemId: 'minecraft:bow', mode: 'item', heldTicks: 1, released: true, aborted: false },
    })

    const names = clientMocks.callTool.mock.calls.map(([args]: [{ name: string }]) => args.name)
    const start = names.indexOf('start_using')
    const release = names.indexOf('release_using')
    const poll = names.findIndex((name, index) => name === 'get_self' && index > start && index < release)
    expect(start).toBeGreaterThanOrEqual(0)
    expect(poll).toBeGreaterThan(start)
    expect(release).toBeGreaterThan(poll)
    expect(names).not.toContain('stop_using')
  })

  it('aborts an item use through stop_using instead of releasing', async () => {
    clientMocks.callTool.mockImplementation(async ({ name }: { name: string }) => {
      if (name === 'get_status')
        return { content: [], structuredContent: { minecraftVersion: '1.21.1', worldId: 'world-1' } }
      if (name === 'get_self')
        return { content: [], structuredContent: { x: 0, y: 64, z: 0, health: 20, food: 20, usingItemId: 'minecraft:bow' } }
      if (name === 'get_inventory')
        return { content: [], structuredContent: { selectedSlot: 0, hotbar: [], main: [], armor: [], offhand: { empty: true } } }
      if (name === 'start_using')
        return { content: [], structuredContent: { using: true, usingItemId: 'minecraft:bow' } }
      if (name === 'stop_using')
        return { content: [], structuredContent: { using: false } }
      return { content: [] }
    })

    const directory = await temporaryDirectory('airi-game-host-use-abort-')
    const context = createHostContext()
    await setupGameHost(context, { persistencePath: join(directory, 'game-host.json') }, directory)
    await defineInvoke(context, gameHostApplyConfig)({ url: 'http://127.0.0.1:25600/mcp', allowedTools: [] })

    const result = await defineInvoke(context, gameHostExecuteCommand)({
      requestId: 'req-use-abort',
      action: 'use',
      params: { mode: 'item', holdTicks: 0, abort: true },
    })

    expect(result).toMatchObject({
      status: 'ok',
      endReason: 'aborted',
      used: { mode: 'item', released: false, aborted: true },
    })
    const names = clientMocks.callTool.mock.calls.map(([args]: [{ name: string }]) => args.name)
    expect(names).toContain('stop_using')
    expect(names).not.toContain('release_using')
  })

  it('uses a block and an entity through place_block and use_entity', async () => {
    clientMocks.callTool.mockImplementation(async ({ name }: { name: string }) => {
      if (name === 'get_status')
        return { content: [], structuredContent: { minecraftVersion: '1.21.1', worldId: 'world-1' } }
      if (name === 'get_self')
        return { content: [], structuredContent: { x: 0, y: 64, z: 0, health: 20, food: 20 } }
      if (name === 'get_inventory')
        return { content: [], structuredContent: { selectedSlot: 0, hotbar: [], main: [], armor: [], offhand: { empty: true } } }
      if (name === 'place_block')
        return { content: [], structuredContent: { result: 'SUCCESS' } }
      if (name === 'use_entity')
        return { content: [], structuredContent: { result: 'SUCCESS' } }
      return { content: [] }
    })

    const directory = await temporaryDirectory('airi-game-host-use-targets-')
    const context = createHostContext()
    await setupGameHost(context, { persistencePath: join(directory, 'game-host.json') }, directory)
    await defineInvoke(context, gameHostApplyConfig)({ url: 'http://127.0.0.1:25600/mcp', allowedTools: [] })

    const block = await defineInvoke(context, gameHostExecuteCommand)({
      requestId: 'req-use-block',
      action: 'use',
      params: { mode: 'block', x: 1, y: 64, z: 2 },
    })
    expect(block).toMatchObject({
      status: 'ok',
      endReason: 'used',
      used: { mode: 'block', heldTicks: 0, released: false, aborted: false },
    })
    expect(clientMocks.callTool).toHaveBeenCalledWith({ name: 'place_block', arguments: { x: 1, y: 64, z: 2 } })

    const entity = await defineInvoke(context, gameHostExecuteCommand)({
      requestId: 'req-use-entity',
      action: 'use',
      params: { mode: 'entity', uuid: 'entity-1' },
    })
    expect(entity).toMatchObject({ status: 'ok', endReason: 'used', used: { mode: 'entity' } })
    expect(clientMocks.callTool).toHaveBeenCalledWith({ name: 'use_entity', arguments: { uuid: 'entity-1' } })
  })

  it('observes inventory, equipment and effects beside the player state', async () => {
    clientMocks.callTool.mockImplementation(async ({ name }: { name: string }) => {
      if (name === 'get_status')
        return { content: [], structuredContent: { minecraftVersion: '1.21.1', worldId: 'world-1' } }
      if (name === 'get_self')
        return { content: [], structuredContent: { x: 10, y: 64, z: 10, health: 20, food: 18, selectedSlot: 0 } }
      if (name === 'get_inventory')
        return { content: [], structuredContent: { selectedSlot: 0, hotbar: [{ slot: 0, id: 'minecraft:bread', count: 1 }], main: [], armor: [], offhand: { empty: true } } }
      if (name === 'get_equipment')
        return { content: [], structuredContent: { mainHand: { id: 'minecraft:bread' }, offHand: { empty: true } } }
      if (name === 'get_status_effects')
        return { content: [], structuredContent: { effects: [{ id: 'minecraft:night_vision', amplifier: 0, durationTicks: 200 }] } }
      if (name === 'get_blocks_region')
        return { content: [], structuredContent: { blocks: [] } }
      return { content: [] }
    })

    const directory = await temporaryDirectory('airi-game-host-observe-rich-')
    const context = createHostContext()
    await setupGameHost(context, { persistencePath: join(directory, 'game-host.json') }, directory)
    await defineInvoke(context, gameHostApplyConfig)({ url: 'http://127.0.0.1:25600/mcp', allowedTools: [] })

    const result = await defineInvoke(context, gameHostExecuteCommand)({ requestId: 'req-observe-rich', action: 'observe', params: { radius: 12 } })

    expect(result).toMatchObject({ status: 'ok', checked: true, postCondition: { kind: 'observed', target: 12, actual: 12, met: true } })
    expect(result.observed?.inventory).toMatchObject({ selectedSlot: 0 })
    expect(result.observed?.equipment).toMatchObject({ mainHand: { id: 'minecraft:bread' } })
    expect(result.observed?.effects).toMatchObject({ effects: [{ id: 'minecraft:night_vision' }] })
    expect(result.observed?.missing).toBeUndefined()
    expect(result.observed?.truncated).toBeUndefined()
  })

  it('records missing observe reads without failing the observation', async () => {
    clientMocks.callTool.mockImplementation(async ({ name }: { name: string }) => {
      if (name === 'get_status')
        return { content: [], structuredContent: { minecraftVersion: '1.21.1', worldId: 'world-1' } }
      if (name === 'get_self')
        return { content: [], structuredContent: { x: 0, y: 64, z: 0, health: 20, food: 20 } }
      if (name === 'get_inventory')
        return { content: [], structuredContent: { selectedSlot: 0, hotbar: [], main: [], armor: [], offhand: { empty: true } } }
      if (name === 'get_equipment' || name === 'get_status_effects')
        throw new Error('bridge offline')
      return { content: [] }
    })

    const directory = await temporaryDirectory('airi-game-host-observe-missing-')
    const context = createHostContext()
    await setupGameHost(context, { persistencePath: join(directory, 'game-host.json') }, directory)
    await defineInvoke(context, gameHostApplyConfig)({ url: 'http://127.0.0.1:25600/mcp', allowedTools: [] })

    const result = await defineInvoke(context, gameHostExecuteCommand)({ requestId: 'req-observe-missing', action: 'observe', params: {} })

    expect(result.status).toBe('ok')
    expect(result.observed?.inventory).toBeDefined()
    expect(result.observed?.missing).toEqual(['equipment', 'effects'])
  })

  it('caps an over-long observed inventory list and notes the truncation', async () => {
    const main = Array.from({ length: 30 }, (_, index) => ({ slot: 9 + index, id: 'minecraft:cobblestone', count: 1 }))
    clientMocks.callTool.mockImplementation(async ({ name }: { name: string }) => {
      if (name === 'get_status')
        return { content: [], structuredContent: { minecraftVersion: '1.21.1', worldId: 'world-1' } }
      if (name === 'get_self')
        return { content: [], structuredContent: { x: 0, y: 64, z: 0, health: 20, food: 20 } }
      if (name === 'get_inventory')
        return { content: [], structuredContent: { selectedSlot: 0, hotbar: [], main, armor: [], offhand: { empty: true } } }
      if (name === 'get_blocks_region')
        return { content: [], structuredContent: { blocks: [] } }
      return { content: [] }
    })

    const directory = await temporaryDirectory('airi-game-host-observe-truncate-')
    const context = createHostContext()
    await setupGameHost(context, { persistencePath: join(directory, 'game-host.json') }, directory)
    await defineInvoke(context, gameHostApplyConfig)({ url: 'http://127.0.0.1:25600/mcp', allowedTools: [] })

    const result = await defineInvoke(context, gameHostExecuteCommand)({ requestId: 'req-observe-truncate', action: 'observe', params: {} })

    expect(result.observed?.truncated).toBe(true)
    expect((result.observed?.inventory?.main as unknown[]).length).toBe(27)
  })

  it('ends follow with target_lost when nothing matches', async () => {
    clientMocks.callTool.mockImplementation(async ({ name }: { name: string }) => {
      if (name === 'get_self')
        return { content: [], structuredContent: { x: 0, y: 64, z: 0, health: 20, food: 20 } }
      if (name === 'get_inventory')
        return { content: [], structuredContent: { selectedSlot: 0, hotbar: [], main: [], armor: [], offhand: { empty: true } } }
      if (name === 'query_entities')
        return { content: [], structuredContent: { entities: [] } }
      if (name === 'poll_events')
        return { content: [], structuredContent: { events: [] } }
      return { content: [] }
    })

    const directory = await temporaryDirectory('airi-game-host-follow-')
    const context = createHostContext()
    await setupGameHost(context, { persistencePath: join(directory, 'game-host.json') }, directory)
    await defineInvoke(context, gameHostApplyConfig)({ url: 'http://127.0.0.1:25600/mcp', allowedTools: [] })

    const result = await defineInvoke(context, gameHostExecuteCommand)({
      requestId: 'req-follow',
      action: 'follow',
      params: { target: 'Nobody', keepDistance: 3 },
    })

    expect(result).toMatchObject({
      status: 'failed',
      checked: false,
      commandId: 'req-follow',
      endReason: 'target_lost',
      postCondition: { kind: 'none', met: false },
    })
  })

  it('supplies from the hotbar and verifies the food delta', async () => {
    // Read #1 is the connect-time identity read; #2 starts the supply.
    let selfReads = 0
    clientMocks.callTool.mockImplementation(async ({ name }: { name: string }) => {
      if (name === 'get_self') {
        selfReads++
        return { content: [], structuredContent: { x: 0, y: 64, z: 0, health: 20, food: selfReads <= 2 ? 10 : 16 } }
      }
      if (name === 'get_inventory')
        return { content: [], structuredContent: { selectedSlot: 0, hotbar: [{ slot: 0, id: 'minecraft:bread', count: 2, food: true }], main: [], armor: [], offhand: { empty: true } } }
      if (name === 'select_hotbar_slot')
        return { content: [], structuredContent: { ok: true, message: 'selected slot 0' } }
      if (name === 'start_using')
        return { content: [], structuredContent: { using: true, usingItemId: 'minecraft:bread' } }
      if (name === 'release_using')
        return { content: [], structuredContent: { using: false } }
      return { content: [] }
    })

    const directory = await temporaryDirectory('airi-game-host-supply-hotbar-')
    const context = createHostContext()
    await setupGameHost(context, { persistencePath: join(directory, 'game-host.json') }, directory)
    await defineInvoke(context, gameHostApplyConfig)({ url: 'http://127.0.0.1:25600/mcp', allowedTools: [] })

    const result = await defineInvoke(context, gameHostExecuteCommand)({ requestId: 'req-supply-hotbar', action: 'supply', params: {} })

    expect(result).toMatchObject({
      status: 'ok',
      checked: true,
      endReason: 'fed',
      postCondition: { kind: 'fed', target: 1, actual: 6, met: true },
      fed: { itemId: 'minecraft:bread', foodBefore: 10, foodAfter: 16, slot: 0 },
    })
    const names = clientMocks.callTool.mock.calls.map(([args]: [{ name: string }]) => args.name)
    expect(names).toContain('start_using')
    expect(names).toContain('release_using')
    expect(names).not.toContain('swap_slots')
  })

  it('moves main-inventory food into an empty hotbar slot before eating', async () => {
    let selfReads = 0
    let swapCalls = 0
    clientMocks.callTool.mockImplementation(async ({ name }: { name: string }) => {
      if (name === 'get_self') {
        selfReads++
        return { content: [], structuredContent: { x: 0, y: 64, z: 0, health: 20, food: selfReads <= 2 ? 10 : 16 } }
      }
      if (name === 'get_inventory')
        return { content: [], structuredContent: { selectedSlot: 0, hotbar: [{ slot: 0, id: 'minecraft:stone', count: 1 }], main: [{ slot: 9, id: 'minecraft:cooked_beef', count: 3, food: true }], armor: [], offhand: { empty: true } } }
      if (name === 'swap_slots') {
        swapCalls++
        return { content: [], structuredContent: { ok: true, message: 'swapped' } }
      }
      if (name === 'select_hotbar_slot')
        return { content: [], structuredContent: { ok: true, message: 'selected slot 1' } }
      if (name === 'start_using')
        return { content: [], structuredContent: { using: true, usingItemId: 'minecraft:cooked_beef' } }
      if (name === 'release_using')
        return { content: [], structuredContent: { using: false } }
      return { content: [] }
    })

    const directory = await temporaryDirectory('airi-game-host-supply-main-')
    const context = createHostContext()
    await setupGameHost(context, { persistencePath: join(directory, 'game-host.json') }, directory)
    await defineInvoke(context, gameHostApplyConfig)({ url: 'http://127.0.0.1:25600/mcp', allowedTools: [] })

    const result = await defineInvoke(context, gameHostExecuteCommand)({ requestId: 'req-supply-main', action: 'supply', params: {} })

    expect(swapCalls).toBe(1)
    expect(clientMocks.callTool).toHaveBeenCalledWith({ name: 'swap_slots', arguments: { slotA: 9, slotB: 1 } })
    expect(result).toMatchObject({
      status: 'ok',
      checked: true,
      endReason: 'fed',
      postCondition: { kind: 'fed', target: 1, actual: 6, met: true },
      fed: { itemId: 'minecraft:cooked_beef', foodBefore: 10, foodAfter: 16, slot: 1 },
    })
  })

  it('fails supply with no_food when nothing edible is reachable', async () => {
    clientMocks.callTool.mockImplementation(async ({ name }: { name: string }) => {
      if (name === 'get_self')
        return { content: [], structuredContent: { x: 0, y: 64, z: 0, health: 20, food: 10 } }
      if (name === 'get_inventory')
        return { content: [], structuredContent: { selectedSlot: 0, hotbar: [{ slot: 0, id: 'minecraft:stone', count: 1 }], main: [{ slot: 9, id: 'minecraft:coal', count: 4 }], armor: [], offhand: { empty: true } } }
      return { content: [] }
    })

    const directory = await temporaryDirectory('airi-game-host-supply-none-')
    const context = createHostContext()
    await setupGameHost(context, { persistencePath: join(directory, 'game-host.json') }, directory)
    await defineInvoke(context, gameHostApplyConfig)({ url: 'http://127.0.0.1:25600/mcp', allowedTools: [] })

    const result = await defineInvoke(context, gameHostExecuteCommand)({ requestId: 'req-supply-none', action: 'supply', params: {} })

    expect(result).toMatchObject({ status: 'failed', checked: false, commandId: 'req-supply-none' })
    expect(result.endReason).toContain('no_food')
    expect(result.fed).toBeUndefined()
  })

  it('refuses supply when hunger is already full without starting a use', async () => {
    const calls: string[] = []
    clientMocks.callTool.mockImplementation(async ({ name }: { name: string }) => {
      calls.push(name)
      if (name === 'get_self')
        return { content: [], structuredContent: { x: 0, y: 64, z: 0, health: 20, food: 20 } }
      if (name === 'get_inventory')
        return { content: [], structuredContent: { selectedSlot: 0, hotbar: [{ slot: 0, id: 'minecraft:bread', count: 2, food: true }], main: [], armor: [], offhand: { empty: true } } }
      return { content: [] }
    })

    const directory = await temporaryDirectory('airi-game-host-supply-full-')
    const context = createHostContext()
    await setupGameHost(context, { persistencePath: join(directory, 'game-host.json') }, directory)
    await defineInvoke(context, gameHostApplyConfig)({ url: 'http://127.0.0.1:25600/mcp', allowedTools: [] })

    const result = await defineInvoke(context, gameHostExecuteCommand)({ requestId: 'req-supply-full', action: 'supply', params: {} })

    expect(result).toMatchObject({ status: 'failed', checked: false })
    expect(result.endReason).toContain('already_full')
    expect(calls).not.toContain('start_using')
    expect(result.fed).toBeUndefined()
  })

  it('sleeps at a bed and reports the sleep timer', async () => {
    clientMocks.callTool.mockImplementation(async ({ name }: { name: string }) => {
      if (name === 'get_self')
        return { content: [], structuredContent: { x: 1, y: 64, z: 1, health: 20, food: 20, sleeping: true, sleepTimer: 20 } }
      if (name === 'get_inventory')
        return { content: [], structuredContent: { selectedSlot: 0, hotbar: [], main: [], armor: [], offhand: { empty: true } } }
      if (name === 'sleep')
        return { content: [], structuredContent: { sleeping: true, sleepTimer: 20, bedPosition: { x: 1, y: 64, z: 2 } } }
      return { content: [] }
    })

    const directory = await temporaryDirectory('airi-game-host-sleep-')
    const context = createHostContext()
    await setupGameHost(context, { persistencePath: join(directory, 'game-host.json') }, directory)
    await defineInvoke(context, gameHostApplyConfig)({ url: 'http://127.0.0.1:25600/mcp', allowedTools: [] })

    const result = await defineInvoke(context, gameHostExecuteCommand)({ requestId: 'req-sleep', action: 'sleep', params: { x: 1, y: 64, z: 2 } })

    expect(clientMocks.callTool).toHaveBeenCalledWith({ name: 'sleep', arguments: { x: 1, y: 64, z: 2 } })
    expect(result).toMatchObject({
      status: 'ok',
      endReason: 'slept',
      slept: { position: { x: 1, y: 64, z: 2 }, sleepTimer: 20 },
    })
  })

  it('fails sleep with not_sleeping when the player never falls asleep', async () => {
    clientMocks.callTool.mockImplementation(async ({ name }: { name: string }) => {
      if (name === 'get_self')
        return { content: [], structuredContent: { x: 1, y: 64, z: 1, health: 20, food: 20 } }
      if (name === 'get_inventory')
        return { content: [], structuredContent: { selectedSlot: 0, hotbar: [], main: [], armor: [], offhand: { empty: true } } }
      if (name === 'sleep')
        return { content: [], structuredContent: { sleeping: false, sleepTimer: 0, bedPosition: { x: 1, y: 64, z: 2 }, error: 'not_sleeping' } }
      return { content: [] }
    })

    const directory = await temporaryDirectory('airi-game-host-sleep-timeout-')
    const context = createHostContext()
    await setupGameHost(context, { persistencePath: join(directory, 'game-host.json') }, directory)
    await defineInvoke(context, gameHostApplyConfig)({ url: 'http://127.0.0.1:25600/mcp', allowedTools: [] })

    const result = await defineInvoke(context, gameHostExecuteCommand)({ requestId: 'req-sleep-timeout', action: 'sleep', params: { x: 1, y: 64, z: 2 } })

    expect(result.status).toBe('failed')
    expect(result.endReason).toContain('not_sleeping')
    expect(result.slept).toBeUndefined()
  })

  it('fails sleep with no_bed when the block is not a bed', async () => {
    clientMocks.callTool.mockImplementation(async ({ name }: { name: string }) => {
      if (name === 'get_self')
        return { content: [], structuredContent: { x: 1, y: 64, z: 1, health: 20, food: 20 } }
      if (name === 'get_inventory')
        return { content: [], structuredContent: { selectedSlot: 0, hotbar: [], main: [], armor: [], offhand: { empty: true } } }
      if (name === 'sleep')
        return { content: [], structuredContent: { sleeping: false, error: 'no_bed' } }
      return { content: [] }
    })

    const directory = await temporaryDirectory('airi-game-host-sleep-nobed-')
    const context = createHostContext()
    await setupGameHost(context, { persistencePath: join(directory, 'game-host.json') }, directory)
    await defineInvoke(context, gameHostApplyConfig)({ url: 'http://127.0.0.1:25600/mcp', allowedTools: [] })

    const result = await defineInvoke(context, gameHostExecuteCommand)({ requestId: 'req-sleep-nobed', action: 'sleep', params: { x: 1, y: 64, z: 2 } })

    expect(result.status).toBe('failed')
    expect(result.endReason).toContain('no_bed')
  })

  it('respawns after death and reports the fresh position', async () => {
    clientMocks.callTool.mockImplementation(async ({ name }: { name: string }) => {
      if (name === 'get_self')
        return { content: [], structuredContent: { x: 3, y: 70, z: 3, health: 20, food: 20 } }
      if (name === 'get_inventory')
        return { content: [], structuredContent: { selectedSlot: 0, hotbar: [], main: [], armor: [], offhand: { empty: true } } }
      if (name === 'respawn')
        return { content: [], structuredContent: { respawned: true, position: { x: 3, y: 70, z: 3 } } }
      return { content: [] }
    })

    const directory = await temporaryDirectory('airi-game-host-respawn-')
    const context = createHostContext()
    await setupGameHost(context, { persistencePath: join(directory, 'game-host.json') }, directory)
    await defineInvoke(context, gameHostApplyConfig)({ url: 'http://127.0.0.1:25600/mcp', allowedTools: [] })

    const result = await defineInvoke(context, gameHostExecuteCommand)({ requestId: 'req-respawn', action: 'respawn', params: {} })

    expect(result).toMatchObject({
      status: 'ok',
      endReason: 'respawned',
      respawned: { position: { x: 3, y: 70, z: 3 } },
    })
  })

  it('fails respawn with not_dead while the player is alive', async () => {
    clientMocks.callTool.mockImplementation(async ({ name }: { name: string }) => {
      if (name === 'get_self')
        return { content: [], structuredContent: { x: 3, y: 70, z: 3, health: 20, food: 20 } }
      if (name === 'get_inventory')
        return { content: [], structuredContent: { selectedSlot: 0, hotbar: [], main: [], armor: [], offhand: { empty: true } } }
      if (name === 'respawn')
        return { content: [], structuredContent: { respawned: false, error: 'not_dead' } }
      return { content: [] }
    })

    const directory = await temporaryDirectory('airi-game-host-respawn-alive-')
    const context = createHostContext()
    await setupGameHost(context, { persistencePath: join(directory, 'game-host.json') }, directory)
    await defineInvoke(context, gameHostApplyConfig)({ url: 'http://127.0.0.1:25600/mcp', allowedTools: [] })

    const result = await defineInvoke(context, gameHostExecuteCommand)({ requestId: 'req-respawn-alive', action: 'respawn', params: {} })

    expect(result.status).toBe('failed')
    expect(result.endReason).toContain('not_dead')
    expect(result.respawned).toBeUndefined()
  })

  it('follows through the terrain port and keeps the first target uuid', async () => {
    let entityQueries = 0
    clientMocks.callTool.mockImplementation(async ({ name }: { name: string }) => {
      if (name === 'get_self')
        return { content: [], structuredContent: { x: 0, y: 64, z: 0, health: 20, food: 20 } }
      if (name === 'get_inventory')
        return { content: [], structuredContent: { selectedSlot: 0, hotbar: [], main: [], armor: [], offhand: { empty: true } } }
      if (name === 'query_entities') {
        entityQueries++
        // The second query renames the entity but keeps the uuid: a name-based
        // re-resolve would lose it and end with target_lost.
        return entityQueries === 1
          ? { content: [], structuredContent: { entities: [{ name: 'Alice', uuid: 'u-1', type: 'minecraft:player', position: { x: 5.8, y: 64, z: -2.6 } }] } }
          : { content: [], structuredContent: { entities: [{ name: 'Bob', uuid: 'u-1', type: 'minecraft:player', position: { x: 6.4, y: 64, z: -2.7 } }] } }
      }
      if (name === 'get_blocks_region')
        return { content: [], structuredContent: { blocks: [] } }
      if (name === 'poll_events')
        return { content: [], structuredContent: { events: [] } }
      return { content: [] }
    })

    const directory = await temporaryDirectory('airi-game-host-follow-terrain-')
    const context = createHostContext()
    await setupGameHost(context, { persistencePath: join(directory, 'game-host.json') }, directory)
    await defineInvoke(context, gameHostApplyConfig)({ url: 'http://127.0.0.1:25600/mcp', allowedTools: [] })

    const result = await defineInvoke(context, gameHostExecuteCommand)({
      requestId: 'req-follow-terrain',
      action: 'follow',
      params: { target: 'Alice', keepDistance: 3, timeoutSeconds: 1 },
    })

    const names = clientMocks.callTool.mock.calls.map(([args]: [{ name: string }]) => args.name)
    expect(names).toContain('get_blocks_region')
    expect(names).not.toContain('navigate_to')
    expect(names).not.toContain('navigation_status')
    expect(entityQueries).toBeGreaterThanOrEqual(2)
    // Regression: the query must be centered on the player. The server-side
    // default is the world spawn, which misses targets only tens of blocks away.
    const queryArgs = (clientMocks.callTool.mock.calls.find(([args]) => args.name === 'query_entities')?.[0] as { arguments?: Record<string, unknown> } | undefined)?.arguments
    expect(queryArgs?.center).toEqual({ x: 0, y: 64, z: 0 })
    // The uuid keyed re-read found the renamed entity; a name re-resolve would
    // have ended with target_lost.
    expect(result.endReason).not.toBe('target_lost')
    // ROOT CAUSE: live MC-4c the follow passed the entity's fractional position
    // as the goal; planner nodes are integer cells, so the goal never matched
    // and every leg ended `no_path` (she never moved). The leg now floors the
    // goal, so every region read stays aligned to integer cells: floor(-2.7) +
    // the 8-block margin gives z = 5.
    const regionCalls = clientMocks.callTool.mock.calls.filter(([args]: [{ name: string }]) => args.name === 'get_blocks_region')
    expect(regionCalls.length).toBeGreaterThan(0)
    // The floored goal shows on the min side of the region: floor(-2.7) - 8 =
    // -11, while an unfloored goal would leave a fractional -10.6.
    const regionFroms = regionCalls.map(([args]) => (args as unknown as { arguments: { from: { x: number, y: number, z: number } } }).arguments.from)
    for (const from of regionFroms) {
      expect(from.z).toBe(-11)
      expect(Number.isInteger(from.z)).toBe(true)
    }
  }, 20_000)

  it('ends follow with target_offline when the fixed player leaves every read', async () => {
    let entityQueries = 0
    clientMocks.callTool.mockImplementation(async ({ name }: { name: string }) => {
      if (name === 'get_self')
        return { content: [], structuredContent: { x: 0, y: 64, z: 0, health: 20, food: 20 } }
      if (name === 'get_inventory')
        return { content: [], structuredContent: { selectedSlot: 0, hotbar: [], main: [], armor: [], offhand: { empty: true } } }
      if (name === 'query_entities') {
        entityQueries++
        return entityQueries === 1
          ? { content: [], structuredContent: { entities: [{ name: 'Alice', uuid: 'u-1', type: 'minecraft:player', position: { x: 5, y: 64, z: 0 } }] } }
          : { content: [], structuredContent: { entities: [] } }
      }
      // CD-L2 coarse fallback: the player is not in the server player list.
      if (name === 'list_players')
        return { content: [], structuredContent: { players: [] } }
      if (name === 'get_blocks_region')
        return { content: [], structuredContent: { blocks: [] } }
      if (name === 'poll_events')
        return { content: [], structuredContent: { events: [] } }
      return { content: [] }
    })

    const directory = await temporaryDirectory('airi-game-host-follow-lost-')
    const context = createHostContext()
    await setupGameHost(context, { persistencePath: join(directory, 'game-host.json') }, directory)
    await defineInvoke(context, gameHostApplyConfig)({ url: 'http://127.0.0.1:25600/mcp', allowedTools: [] })

    const result = await defineInvoke(context, gameHostExecuteCommand)({
      requestId: 'req-follow-lost',
      action: 'follow',
      params: { target: 'Alice', keepDistance: 3, timeoutSeconds: 2 },
    })

    // The target left the loaded fine range and the server player list no
    // longer has it: `target_offline` is the typed coarse result (CD-L2), not a
    // plain `target_lost`.
    expect(result).toMatchObject({ status: 'failed', checked: false, endReason: 'target_offline', postCondition: { kind: 'none', met: false } })
    const names = clientMocks.callTool.mock.calls.map(([args]: [{ name: string }]) => args.name)
    expect(names).toContain('list_players')
  }, 20_000)

  it('ends follow with target_unreachable after three failed legs', async () => {
    clientMocks.callTool.mockImplementation(async (request: { name: string, arguments?: { from?: { x: number, y: number, z: number }, to?: { x: number, y: number, z: number } } }) => {
      const { name, arguments: args } = request
      if (name === 'get_self')
        return { content: [], structuredContent: { x: 0, y: 64, z: 0, health: 20, food: 20 } }
      if (name === 'get_inventory')
        return { content: [], structuredContent: { selectedSlot: 0, hotbar: [], main: [], armor: [], offhand: { empty: true } } }
      if (name === 'query_entities')
        return { content: [], structuredContent: { entities: [{ name: 'Alice', uuid: 'u-1', type: 'minecraft:player', position: { x: 10, y: 64, z: 0 } }] } }
      if (name === 'get_blocks_region' && args?.from && args.to) {
        // A complete solid region: every block is read (no `no_chunk`) but
        // nothing is walkable, so every leg ends `no_path`.
        const blocks: Array<{ x: number, y: number, z: number, id: string }> = []
        for (let x = args.from.x; x <= args.to.x; x++) {
          for (let y = args.from.y; y <= args.to.y; y++) {
            for (let z = args.from.z; z <= args.to.z; z++)
              blocks.push({ x, y, z, id: 'minecraft:stone' })
          }
        }
        return { content: [], structuredContent: { blocks } }
      }
      if (name === 'poll_events')
        return { content: [], structuredContent: { events: [] } }
      return { content: [] }
    })

    const directory = await temporaryDirectory('airi-game-host-follow-unreachable-')
    const context = createHostContext()
    await setupGameHost(context, { persistencePath: join(directory, 'game-host.json') }, directory)
    await defineInvoke(context, gameHostApplyConfig)({ url: 'http://127.0.0.1:25600/mcp', allowedTools: [] })

    const result = await defineInvoke(context, gameHostExecuteCommand)({
      requestId: 'req-follow-unreachable',
      action: 'follow',
      params: { target: 'Alice', keepDistance: 3, timeoutSeconds: 30 },
    })

    expect(result).toMatchObject({
      status: 'failed',
      checked: false,
      endReason: 'target_unreachable',
      postCondition: { kind: 'none', met: false },
    })
  }, 30_000)

  it('does not plan a follow leg while the target stays inside the keep distance', async () => {
    clientMocks.callTool.mockImplementation(async ({ name }: { name: string }) => {
      if (name === 'get_self')
        return { content: [], structuredContent: { x: 0, y: 64, z: 0, health: 20, food: 20 } }
      if (name === 'get_inventory')
        return { content: [], structuredContent: { selectedSlot: 0, hotbar: [], main: [], armor: [], offhand: { empty: true } } }
      if (name === 'query_entities')
        return { content: [], structuredContent: { entities: [{ name: 'Alice', uuid: 'u-1', type: 'minecraft:player', position: { x: 1, y: 64, z: 0 } }] } }
      if (name === 'poll_events')
        return { content: [], structuredContent: { events: [] } }
      return { content: [] }
    })

    const directory = await temporaryDirectory('airi-game-host-follow-close-')
    const context = createHostContext()
    await setupGameHost(context, { persistencePath: join(directory, 'game-host.json') }, directory)
    await defineInvoke(context, gameHostApplyConfig)({ url: 'http://127.0.0.1:25600/mcp', allowedTools: [] })

    await defineInvoke(context, gameHostExecuteCommand)({
      requestId: 'req-follow-close',
      action: 'follow',
      params: { target: 'Alice', keepDistance: 3, timeoutSeconds: 1 },
    })

    const regionCalls = clientMocks.callTool.mock.calls.filter(([args]: [{ name: string }]) => args.name === 'get_blocks_region')
    expect(regionCalls).toHaveLength(0)
  }, 20_000)

  it('attributes a collect to the break window only', async () => {
    let broken = false
    clientMocks.callTool.mockImplementation(async ({ name }: { name: string }) => {
      if (name === 'get_self')
        return { content: [], structuredContent: { x: 0, y: 64, z: 0, health: 20, food: 20 } }
      if (name === 'get_inventory')
        return { content: [], structuredContent: { selectedSlot: 0, hotbar: broken ? [{ slot: 0, id: 'minecraft:oak_log', count: 4 }] : [], main: [], armor: [], offhand: { empty: true } } }
      if (name === 'find_blocks')
        return { content: [], structuredContent: { matches: [{ x: 2, y: 64, z: 0, id: 'minecraft:oak_log', distance: 2 }] } }
      if (name === 'break_block') {
        broken = true
        return { content: [], structuredContent: { started: true, mode: 'survival' } }
      }
      if (name === 'get_block')
        return { content: [], structuredContent: { id: 'minecraft:air' } }
      if (name === 'poll_events')
        return { content: [], structuredContent: { events: [] } }
      return { content: [] }
    })

    const directory = await temporaryDirectory('airi-game-host-collect-attributed-')
    const context = createHostContext()
    await setupGameHost(context, { persistencePath: join(directory, 'game-host.json') }, directory)
    await defineInvoke(context, gameHostApplyConfig)({ url: 'http://127.0.0.1:25600/mcp', allowedTools: [] })

    const result = await defineInvoke(context, gameHostExecuteCommand)({
      requestId: 'req-collect-attributed',
      action: 'collect',
      params: { blockId: 'minecraft:oak_log', maxCount: 4, radius: 16 },
    })

    expect(result).toMatchObject({
      status: 'ok',
      checked: true,
      endReason: 'collected',
      postCondition: { kind: 'collected', target: 4, actual: 4, met: true },
    })
    const names = clientMocks.callTool.mock.calls.map(([args]: [{ name: string }]) => args.name)
    expect(names).not.toContain('navigate_to')
  })

  it('does not count inventory growth with no break as collected', async () => {
    // The inventory already holds four logs, but this command breaks nothing:
    // the whole-command delta would have read 4, the per-break attribution is 0.
    clientMocks.callTool.mockImplementation(async ({ name }: { name: string }) => {
      if (name === 'get_self')
        return { content: [], structuredContent: { x: 0, y: 64, z: 0, health: 20, food: 20 } }
      if (name === 'get_inventory')
        return { content: [], structuredContent: { selectedSlot: 0, hotbar: [{ slot: 0, id: 'minecraft:oak_log', count: 4 }], main: [], armor: [], offhand: { empty: true } } }
      if (name === 'find_blocks')
        return { content: [], structuredContent: { matches: [] } }
      if (name === 'poll_events')
        return { content: [], structuredContent: { events: [] } }
      return { content: [] }
    })

    const directory = await temporaryDirectory('airi-game-host-collect-nobreak-')
    const context = createHostContext()
    await setupGameHost(context, { persistencePath: join(directory, 'game-host.json') }, directory)
    await defineInvoke(context, gameHostApplyConfig)({ url: 'http://127.0.0.1:25600/mcp', allowedTools: [] })

    const result = await defineInvoke(context, gameHostExecuteCommand)({
      requestId: 'req-collect-nobreak',
      action: 'collect',
      params: { blockId: 'minecraft:oak_log', maxCount: 4, radius: 16 },
    })

    expect(result).toMatchObject({
      status: 'failed',
      checked: true,
      endReason: 'no_target',
      postCondition: { kind: 'collected', target: 4, actual: 0, met: false },
    })
  })

  it('evaluates the harvest, equips the tool from the main inventory and breaks', async () => {
    let blockReads = 0
    clientMocks.callTool.mockImplementation(async ({ name }: { name: string }) => {
      if (name === 'get_status')
        return { content: [], structuredContent: { minecraftVersion: '1.21.1', worldId: 'world-1', dimension: 'minecraft:overworld' } }
      if (name === 'get_self')
        return { content: [], structuredContent: { x: 0, y: 64, z: 0, health: 20, food: 20, dimension: 'minecraft:overworld' } }
      if (name === 'get_inventory')
        return { content: [], structuredContent: { selectedSlot: 0, hotbar: [], main: [{ slot: 9, id: 'minecraft:iron_pickaxe', count: 1, damage: 0, maxDamage: 250 }], armor: [], offhand: { empty: true } } }
      if (name === 'mine_evaluate_harvest') {
        return {
          content: [],
          structuredContent: {
            blockStateId: 'minecraft:stone',
            x: 1,
            y: 64,
            z: 0,
            dimension: 'minecraft:overworld',
            requiresTool: true,
            harvestEligible: true,
            estimateQuality: 'exact',
            candidates: [{ slot: 9, hotbar: false, itemId: 'minecraft:iron_pickaxe', count: 1, damage: 0, maxDamage: 250, harvestEligible: true, destroySpeed: 6, estimatedTicks: 4 }],
            hazards: [],
            unmet: [],
          },
        }
      }
      if (name === 'get_block') {
        blockReads += 1
        return { content: [], structuredContent: { id: blockReads <= 2 ? 'minecraft:stone' : 'minecraft:air' } }
      }
      if (name === 'get_equipment')
        return { content: [], structuredContent: { mainHand: { id: 'minecraft:iron_pickaxe', count: 1 } } }
      if (name === 'break_block')
        return { content: [], structuredContent: { started: true, mode: 'survival' } }
      if (name === 'select_hotbar_slot' || name === 'swap_slots' || name === 'look_at')
        return { content: [], structuredContent: { ok: true } }
      return { content: [] }
    })

    const directory = await temporaryDirectory('airi-game-host-mining-break-')
    const context = createHostContext()
    await setupGameHost(context, { persistencePath: join(directory, 'game-host.json') }, directory)
    await defineInvoke(context, gameHostApplyConfig)({ url: 'http://127.0.0.1:25600/mcp', allowedTools: [] })

    const result = await defineInvoke(context, gameHostExecuteCommand)({
      requestId: 'req-mine-break',
      action: 'break',
      params: { x: 1, y: 64, z: 0 },
    })

    expect(result).toMatchObject({
      status: 'ok',
      checked: true,
      endReason: 'broken',
      broken: { blockId: 'minecraft:stone', tool: 'minecraft:iron_pickaxe' },
    })
    expect(result.broken?.breakId).toBeTruthy()
    const names = clientMocks.callTool.mock.calls.map(([args]: [{ name: string }]) => args.name)
    expect(names).toContain('mine_evaluate_harvest')
    expect(names).toContain('swap_slots')
    expect(names).toContain('select_hotbar_slot')
  })

  it('refuses a break no reachable tool can harvest, before mining', async () => {
    clientMocks.callTool.mockImplementation(async ({ name }: { name: string }) => {
      if (name === 'get_status')
        return { content: [], structuredContent: { minecraftVersion: '1.21.1', worldId: 'world-1' } }
      if (name === 'get_self')
        return { content: [], structuredContent: { x: 0, y: 64, z: 0, health: 20, food: 20, dimension: 'minecraft:overworld' } }
      if (name === 'get_block')
        return { content: [], structuredContent: { id: 'minecraft:stone' } }
      if (name === 'mine_evaluate_harvest') {
        return {
          content: [],
          structuredContent: {
            blockStateId: 'minecraft:stone',
            x: 1,
            y: 64,
            z: 0,
            requiresTool: true,
            harvestEligible: false,
            candidates: [],
            unmet: ['no_tool'],
          },
        }
      }
      return { content: [] }
    })

    const directory = await temporaryDirectory('airi-game-host-mining-reject-')
    const context = createHostContext()
    await setupGameHost(context, { persistencePath: join(directory, 'game-host.json') }, directory)
    await defineInvoke(context, gameHostApplyConfig)({ url: 'http://127.0.0.1:25600/mcp', allowedTools: [] })

    const result = await defineInvoke(context, gameHostExecuteCommand)({
      requestId: 'req-mine-reject',
      action: 'break',
      params: { x: 1, y: 64, z: 0 },
    })

    expect(result).toMatchObject({
      status: 'failed',
      endReason: 'no_tool',
      broken: { rejection: { reason: 'no_tool' } },
    })
    const breaks = clientMocks.callTool.mock.calls.filter(([args]: [{ name: string }]) => args.name === 'break_block')
    expect(breaks).toHaveLength(0)
  })

  it('attributes a required product from server break evidence', async () => {
    let blockReads = 0
    let broken = false
    clientMocks.callTool.mockImplementation(async ({ name }: { name: string }) => {
      if (name === 'get_status')
        return { content: [], structuredContent: { minecraftVersion: '1.21.1', worldId: 'world-1' } }
      if (name === 'get_self')
        return { content: [], structuredContent: { x: 0, y: 64, z: 0, health: 20, food: 20, dimension: 'minecraft:overworld' } }
      if (name === 'get_inventory') {
        return {
          content: [],
          structuredContent: broken
            ? { selectedSlot: 0, hotbar: [{ slot: 0, id: 'minecraft:raw_iron', count: 2 }], main: [], armor: [], offhand: { empty: true } }
            : { selectedSlot: 0, hotbar: [{ slot: 0, id: 'minecraft:iron_pickaxe', count: 1, damage: 0, maxDamage: 250 }], main: [], armor: [], offhand: { empty: true } },
        }
      }
      if (name === 'mine_evaluate_harvest') {
        return {
          content: [],
          structuredContent: {
            blockStateId: 'minecraft:iron_ore',
            x: 1,
            y: 64,
            z: 0,
            requiresTool: true,
            harvestEligible: true,
            candidates: [{ slot: 0, hotbar: true, itemId: 'minecraft:iron_pickaxe', count: 1, damage: 0, maxDamage: 250, harvestEligible: true, destroySpeed: 6, estimatedTicks: 4 }],
            hazards: [],
            unmet: [],
          },
        }
      }
      if (name === 'get_block') {
        blockReads += 1
        return { content: [], structuredContent: { id: blockReads <= 2 ? 'minecraft:iron_ore' : 'minecraft:air' } }
      }
      if (name === 'get_equipment')
        return { content: [], structuredContent: { mainHand: { id: 'minecraft:iron_pickaxe', count: 1 } } }
      if (name === 'break_block') {
        broken = true
        return { content: [], structuredContent: { started: true, mode: 'survival' } }
      }
      if (name === 'mine_break_evidence')
        return { content: [], structuredContent: { records: [{ drops: [{ itemId: 'minecraft:raw_iron', count: 2, entityUuids: ['e1', 'e2'] }] }] } }
      if (name === 'select_hotbar_slot' || name === 'look_at')
        return { content: [], structuredContent: { ok: true } }
      return { content: [] }
    })

    const directory = await temporaryDirectory('airi-game-host-mining-evidence-')
    const context = createHostContext()
    await setupGameHost(context, { persistencePath: join(directory, 'game-host.json') }, directory)
    await defineInvoke(context, gameHostApplyConfig)({ url: 'http://127.0.0.1:25600/mcp', allowedTools: [] })

    const result = await defineInvoke(context, gameHostExecuteCommand)({
      requestId: 'req-mine-evidence',
      action: 'break',
      params: { x: 1, y: 64, z: 0, itemId: 'minecraft:raw_iron' },
    })

    expect(result).toMatchObject({
      status: 'ok',
      endReason: 'broken',
      broken: {
        tool: 'minecraft:iron_pickaxe',
        product: { itemId: 'minecraft:raw_iron', lowerBound: 2, fuzzy: 0, evidence: 'server-attributed' },
      },
    })
    const evidenceCalls = clientMocks.callTool.mock.calls.filter(([args]: [{ name: string }]) => args.name === 'mine_break_evidence')
    expect(evidenceCalls).toHaveLength(1)
  })

  it('returns structured tool prerequisites when collect lacks the tool', async () => {
    clientMocks.callTool.mockImplementation(async ({ name }: { name: string }) => {
      if (name === 'get_self')
        return { content: [], structuredContent: { x: 0, y: 64, z: 0, health: 20, food: 20 } }
      if (name === 'get_inventory')
        return { content: [], structuredContent: { selectedSlot: 0, hotbar: [], main: [], armor: [], offhand: { empty: true } } }
      if (name === 'find_blocks')
        return { content: [], structuredContent: { matches: [{ x: 2, y: 64, z: 0, id: 'minecraft:iron_ore', distance: 2 }] } }
      if (name === 'mine_evaluate_harvest') {
        return {
          content: [],
          structuredContent: {
            blockStateId: 'minecraft:iron_ore',
            x: 2,
            y: 64,
            z: 0,
            requiresTool: true,
            harvestEligible: false,
            candidates: [],
            unmet: ['no_tool'],
          },
        }
      }
      if (name === 'poll_events')
        return { content: [], structuredContent: { events: [] } }
      return { content: [] }
    })

    const directory = await temporaryDirectory('airi-game-host-mining-prereq-')
    const context = createHostContext()
    await setupGameHost(context, { persistencePath: join(directory, 'game-host.json') }, directory)
    await defineInvoke(context, gameHostApplyConfig)({ url: 'http://127.0.0.1:25600/mcp', allowedTools: [] })

    const result = await defineInvoke(context, gameHostExecuteCommand)({
      requestId: 'req-collect-prereq',
      action: 'collect',
      params: { blockId: 'minecraft:iron_ore', maxCount: 1, radius: 16 },
    })

    expect(result).toMatchObject({
      status: 'failed',
      endReason: 'missing_tool',
      prerequisites: { target: 'minecraft:stone_pickaxe', craftable: false },
    })
    expect(result.prerequisites?.missing.some(entry => entry.itemId === 'minecraft:cobblestone')).toBe(true)
    const breaks = clientMocks.callTool.mock.calls.filter(([args]: [{ name: string }]) => args.name === 'break_block')
    expect(breaks).toHaveLength(0)
  })
})

interface FakeMenuStack { id: string, count: number }

interface FakeMenuState {
  containerId: number
  type: string
  slots: Map<number, FakeMenuStack>
  inventorySlots: Set<number>
  carried: FakeMenuStack | null
  furnace?: { lit: boolean, litProgress: number, cookProgress: number }
}

function menuSlotJson(state: FakeMenuState, index: number): Record<string, unknown> {
  const item = state.slots.get(index)
  return {
    index,
    container: state.inventorySlots.has(index) ? 'Inventory' : 'Container',
    ...(state.inventorySlots.has(index) ? { invSlot: index - 27 } : {}),
    ...(item && item.count > 0 ? { id: item.id, count: item.count } : { empty: true }),
  }
}

function menuCarriedJson(state: FakeMenuState): Record<string, unknown> {
  return state.carried
    ? { index: -1, container: 'Cursor', id: state.carried.id, count: state.carried.count }
    : { index: -1, container: 'Cursor', empty: true }
}

function menuClickFake(state: FakeMenuState, slot: number): void {
  const item = state.slots.get(slot)
  if (!state.carried) {
    if (item && item.count > 0) {
      state.carried = { ...item }
      state.slots.delete(slot)
    }
    return
  }
  if (!item || item.count <= 0) {
    state.slots.set(slot, { ...state.carried })
    state.carried = null
    return
  }
  if (item.id === state.carried.id) {
    item.count += state.carried.count
    state.carried = null
    return
  }
  state.slots.set(slot, { ...state.carried })
  state.carried = item
}

describe('menu and workstation commands (mc-4b)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    appMock.getVersion.mockReturnValue('0.10.0')
    clientInstances.items.length = 0
    transportInstances.items.length = 0
    clientMocks.connect.mockResolvedValue(undefined)
    clientMocks.close.mockResolvedValue(undefined)
    clientMocks.callTool.mockResolvedValue({ content: [] })
  })

  function chestState(): FakeMenuState {
    return {
      containerId: 7,
      type: 'minecraft:generic_9x3',
      slots: new Map<number, FakeMenuStack>([[0, { id: 'minecraft:iron_ingot', count: 3 }]]),
      inventorySlots: new Set<number>([27, 28, 29]),
      carried: null,
    }
  }

  function menuClient(state: FakeMenuState, hooks: { onQuickMove?: (slot: number) => void, craft?: () => Record<string, unknown> } = {}) {
    return async ({ name, arguments: args }: { name: string, arguments?: Record<string, unknown> }) => {
      if (name === 'get_status')
        return { content: [], structuredContent: { minecraftVersion: '1.21.1', worldId: 'world-1' } }
      if (name === 'get_self')
        return { content: [], structuredContent: { x: 0, y: 64, z: 0, health: 20, food: 20 } }
      if (name === 'get_inventory')
        return { content: [], structuredContent: { selectedSlot: 0, hotbar: [], main: [], armor: [], offhand: { empty: true } } }
      if (name === 'menu_open')
        return { content: [], structuredContent: { opened: true, containerId: state.containerId, type: state.type, slots: 63 } }
      if (name === 'menu_snapshot')
        return { content: [], structuredContent: { containerId: state.containerId, type: state.type, carried: menuCarriedJson(state), slots: [...state.slots.keys()].map(index => menuSlotJson(state, index)), ...(state.furnace ? { furnace: state.furnace } : {}) } }
      if (name === 'menu_craft')
        return { content: [], structuredContent: hooks.craft ? hooks.craft() : { placed: false, error: 'unknown_recipe' } }
      if (name === 'menu_click') {
        if (args?.containerId !== state.containerId)
          return { content: [], structuredContent: { accepted: false, error: 'menu_mismatch' } }
        const slot = Number(args?.slot)
        if (args?.quickMove === true)
          hooks.onQuickMove?.(slot)
        else
          menuClickFake(state, slot)
        return { content: [], structuredContent: { accepted: true, containerId: state.containerId, slot: menuSlotJson(state, slot), carried: menuCarriedJson(state) } }
      }
      if (name === 'menu_close')
        return { content: [], structuredContent: { closed: true } }
      return { content: [] }
    }
  }

  it('opens, reads, moves a whole stack and closes a chest menu', async () => {
    const state = chestState()
    clientMocks.callTool.mockImplementation(menuClient(state))

    const directory = await temporaryDirectory('airi-game-host-menu-seq-')
    const context = createHostContext()
    await setupGameHost(context, { persistencePath: join(directory, 'game-host.json') }, directory)
    await defineInvoke(context, gameHostApplyConfig)({ url: 'http://127.0.0.1:25600/mcp', allowedTools: [] })

    const open = await defineInvoke(context, gameHostExecuteCommand)({ requestId: 'menu-open', action: 'open_container', params: { x: 1, y: 64, z: 2 } })
    expect(open).toMatchObject({ status: 'ok', commandId: 'menu-open', endReason: 'opened', menu: { containerId: 7, type: 'minecraft:generic_9x3', slots: 63 } })

    const read = await defineInvoke(context, gameHostExecuteCommand)({ requestId: 'menu-read', action: 'read_menu', params: {} })
    expect(read).toMatchObject({ status: 'ok', endReason: 'menu_read', menuSnapshot: { containerId: 7, type: 'minecraft:generic_9x3' } })
    expect(read.menuSnapshot?.slots.find(slot => slot.index === 0)).toMatchObject({ id: 'minecraft:iron_ingot', count: 3 })

    const move = await defineInvoke(context, gameHostExecuteCommand)({ requestId: 'menu-move', action: 'move_item', params: { from: 0, to: 27, count: 3 } })
    expect(move).toMatchObject({
      status: 'ok',
      checked: true,
      endReason: 'moved',
      postCondition: { kind: 'moved', target: 3, actual: 3, met: true },
      moved: { containerId: 7, from: 0, to: 27, requested: 3, moved: 3 },
    })

    const close = await defineInvoke(context, gameHostExecuteCommand)({ requestId: 'menu-close', action: 'close_menu', params: {} })
    expect(close).toMatchObject({ status: 'ok', endReason: 'closed' })

    const menuCalls = clientMocks.callTool.mock.calls
      .map(([args]: [{ name: string }]) => args.name)
      .filter((name: string) => name.startsWith('menu_'))
    expect(menuCalls).toEqual([
      'menu_open',
      'menu_snapshot',
      'menu_snapshot',
      'menu_snapshot',
      'menu_click',
      'menu_click',
      'menu_snapshot',
      'menu_close',
    ])
    expect(clientMocks.callTool).toHaveBeenCalledWith({ name: 'menu_click', arguments: { containerId: 7, slot: 0 } })
    expect(clientMocks.callTool).toHaveBeenCalledWith({ name: 'menu_click', arguments: { containerId: 7, slot: 27 } })
  })

  it('surfaces menu_mismatch and never clicks when the container id changes', async () => {
    const state = chestState()
    let snapshots = 0
    clientMocks.callTool.mockImplementation(async ({ name }: { name: string }) => {
      if (name === 'get_status')
        return { content: [], structuredContent: { minecraftVersion: '1.21.1', worldId: 'world-1' } }
      if (name === 'get_self')
        return { content: [], structuredContent: { x: 0, y: 64, z: 0, health: 20, food: 20 } }
      if (name === 'get_inventory')
        return { content: [], structuredContent: { selectedSlot: 0, hotbar: [], main: [], armor: [], offhand: { empty: true } } }
      if (name === 'menu_snapshot') {
        snapshots++
        // The menu identity changes under the executor after the first read.
        const containerId = snapshots === 1 ? 7 : 8
        return { content: [], structuredContent: { containerId, type: 'minecraft:generic_9x3', carried: menuCarriedJson(state), slots: [menuSlotJson(state, 0)] } }
      }
      if (name === 'menu_click')
        return { content: [], structuredContent: { accepted: false, error: 'menu_mismatch' } }
      return { content: [] }
    })

    const directory = await temporaryDirectory('airi-game-host-menu-mismatch-')
    const context = createHostContext()
    await setupGameHost(context, { persistencePath: join(directory, 'game-host.json') }, directory)
    await defineInvoke(context, gameHostApplyConfig)({ url: 'http://127.0.0.1:25600/mcp', allowedTools: [] })

    const result = await defineInvoke(context, gameHostExecuteCommand)({ requestId: 'menu-move-mismatch', action: 'move_item', params: { from: 0, to: 27, count: 3 } })

    expect(result.status).toBe('failed')
    expect(result.endReason).toContain('menu_mismatch')
    expect(result.moved).toBeUndefined()
    const clicks = clientMocks.callTool.mock.calls.filter(([args]: [{ name: string }]) => args.name === 'menu_click')
    expect(clicks).toHaveLength(0)
  })

  it('crafts through a table with the two-beat claim and a verified inventory delta', async () => {
    let crafted = false
    let claimed = false
    clientMocks.callTool.mockImplementation(async ({ name, arguments: args }: { name: string, arguments?: Record<string, unknown> }) => {
      if (name === 'get_status')
        return { content: [], structuredContent: { minecraftVersion: '1.21.1', worldId: 'world-1' } }
      if (name === 'get_self')
        return { content: [], structuredContent: { x: 0, y: 64, z: 0, health: 20, food: 20 } }
      if (name === 'get_inventory')
        return { content: [], structuredContent: { selectedSlot: 0, hotbar: claimed ? [{ slot: 0, id: 'minecraft:iron_pickaxe', count: 1 }] : [], main: [], armor: [], offhand: { empty: true } } }
      if (name === 'menu_open')
        return { content: [], structuredContent: { opened: true, containerId: 12, type: 'minecraft:crafting', slots: 46 } }
      if (name === 'menu_snapshot')
        return { content: [], structuredContent: { containerId: 12, type: 'minecraft:crafting', carried: { index: -1, container: 'Cursor', empty: true }, slots: crafted ? [{ index: 0, container: 'ResultSlot', id: 'minecraft:iron_pickaxe', count: 1 }] : [] } }
      if (name === 'menu_craft') {
        crafted = true
        return { content: [], structuredContent: { placed: true, expected: { id: 'minecraft:iron_pickaxe', count: 1 } } }
      }
      if (name === 'menu_click') {
        if (args?.slot === 0 && args?.quickMove === true)
          claimed = true
        return { content: [], structuredContent: { accepted: true, containerId: 12, slot: { index: 0, container: 'ResultSlot', empty: true }, carried: { index: -1, container: 'Cursor', empty: true } } }
      }
      return { content: [] }
    })

    const directory = await temporaryDirectory('airi-game-host-craft-table-')
    const context = createHostContext()
    await setupGameHost(context, { persistencePath: join(directory, 'game-host.json') }, directory)
    await defineInvoke(context, gameHostApplyConfig)({ url: 'http://127.0.0.1:25600/mcp', allowedTools: [] })

    const result = await defineInvoke(context, gameHostExecuteCommand)({ requestId: 'menu-craft', action: 'craft_table', params: { x: 1, y: 64, z: 2, recipeId: 'minecraft:iron_pickaxe' } })

    expect(result).toMatchObject({
      status: 'ok',
      checked: true,
      endReason: 'crafted',
      postCondition: { kind: 'crafted', target: 1, actual: 1, met: true },
      crafted: {
        recipeId: 'minecraft:iron_pickaxe',
        output: { id: 'minecraft:iron_pickaxe', count: 1 },
        attempts: 1,
        inventoryDelta: { 'minecraft:iron_pickaxe': 1 },
      },
    })
    expect(clientMocks.callTool).toHaveBeenCalledWith({ name: 'menu_click', arguments: { containerId: 12, slot: 0, quickMove: true } })
  })

  it('reports unknown_recipe from a crafting table without claiming success', async () => {
    clientMocks.callTool.mockImplementation(async ({ name }: { name: string }) => {
      if (name === 'get_status')
        return { content: [], structuredContent: { minecraftVersion: '1.21.1', worldId: 'world-1' } }
      if (name === 'get_self')
        return { content: [], structuredContent: { x: 0, y: 64, z: 0, health: 20, food: 20 } }
      if (name === 'get_inventory')
        return { content: [], structuredContent: { selectedSlot: 0, hotbar: [], main: [], armor: [], offhand: { empty: true } } }
      if (name === 'menu_open')
        return { content: [], structuredContent: { opened: true, containerId: 12, type: 'minecraft:crafting', slots: 46 } }
      if (name === 'menu_snapshot')
        return { content: [], structuredContent: { containerId: 12, type: 'minecraft:crafting', carried: { index: -1, container: 'Cursor', empty: true }, slots: [] } }
      if (name === 'menu_craft')
        return { content: [], structuredContent: { placed: false, error: 'unknown_recipe' } }
      return { content: [] }
    })

    const directory = await temporaryDirectory('airi-game-host-craft-unknown-')
    const context = createHostContext()
    await setupGameHost(context, { persistencePath: join(directory, 'game-host.json') }, directory)
    await defineInvoke(context, gameHostApplyConfig)({ url: 'http://127.0.0.1:25600/mcp', allowedTools: [] })

    const result = await defineInvoke(context, gameHostExecuteCommand)({ requestId: 'menu-craft-unknown', action: 'craft_table', params: { x: 1, y: 64, z: 2, recipeId: 'minecraft:not_a_recipe' } })

    expect(result.status).toBe('failed')
    expect(result.endReason).toContain('unknown_recipe')
    expect(result.crafted).toBeUndefined()
  })

  it('rejects a non-crafting menu with menu_not_crafting', async () => {
    clientMocks.callTool.mockImplementation(async ({ name }: { name: string }) => {
      if (name === 'get_status')
        return { content: [], structuredContent: { minecraftVersion: '1.21.1', worldId: 'world-1' } }
      if (name === 'get_self')
        return { content: [], structuredContent: { x: 0, y: 64, z: 0, health: 20, food: 20 } }
      if (name === 'get_inventory')
        return { content: [], structuredContent: { selectedSlot: 0, hotbar: [], main: [], armor: [], offhand: { empty: true } } }
      if (name === 'menu_open')
        return { content: [], structuredContent: { opened: true, containerId: 12, type: 'minecraft:generic_9x3', slots: 63 } }
      return { content: [] }
    })

    const directory = await temporaryDirectory('airi-game-host-craft-notable-')
    const context = createHostContext()
    await setupGameHost(context, { persistencePath: join(directory, 'game-host.json') }, directory)
    await defineInvoke(context, gameHostApplyConfig)({ url: 'http://127.0.0.1:25600/mcp', allowedTools: [] })

    const result = await defineInvoke(context, gameHostExecuteCommand)({ requestId: 'menu-craft-notable', action: 'craft_table', params: { x: 1, y: 64, z: 2, recipeId: 'minecraft:iron_pickaxe' } })

    expect(result.status).toBe('failed')
    expect(result.endReason).toContain('menu_not_crafting')
    const craftCalls = clientMocks.callTool.mock.calls.filter(([args]: [{ name: string }]) => args.name === 'menu_craft')
    expect(craftCalls).toHaveLength(0)
  })

  it('reports not_confirmed when the crafting output never appears', async () => {
    clientMocks.callTool.mockImplementation(async ({ name }: { name: string }) => {
      if (name === 'get_status')
        return { content: [], structuredContent: { minecraftVersion: '1.21.1', worldId: 'world-1' } }
      if (name === 'get_self')
        return { content: [], structuredContent: { x: 0, y: 64, z: 0, health: 20, food: 20 } }
      if (name === 'get_inventory')
        return { content: [], structuredContent: { selectedSlot: 0, hotbar: [], main: [], armor: [], offhand: { empty: true } } }
      if (name === 'menu_open')
        return { content: [], structuredContent: { opened: true, containerId: 12, type: 'minecraft:crafting', slots: 46 } }
      if (name === 'menu_snapshot')
        return { content: [], structuredContent: { containerId: 12, type: 'minecraft:crafting', carried: { index: -1, container: 'Cursor', empty: true }, slots: [] } }
      if (name === 'menu_craft')
        return { content: [], structuredContent: { placed: true, expected: { id: 'minecraft:iron_pickaxe', count: 1 } } }
      return { content: [] }
    })

    const directory = await temporaryDirectory('airi-game-host-craft-noconfirm-')
    const context = createHostContext()
    await setupGameHost(context, { persistencePath: join(directory, 'game-host.json') }, directory)
    await defineInvoke(context, gameHostApplyConfig)({ url: 'http://127.0.0.1:25600/mcp', allowedTools: [] })

    const result = await defineInvoke(context, gameHostExecuteCommand)({ requestId: 'menu-craft-noconfirm', action: 'craft_table', params: { x: 1, y: 64, z: 2, recipeId: 'minecraft:iron_pickaxe', attempts: 1 } })

    expect(result.status).toBe('failed')
    expect(result.endReason).toContain('not_confirmed')
    expect(result.crafted).toBeUndefined()
  })

  it('loads and takes a furnace output, recording residue without counting it as output', async () => {
    const state: FakeMenuState = {
      containerId: 20,
      type: 'minecraft:furnace',
      slots: new Map<number, FakeMenuStack>([
        [30, { id: 'minecraft:raw_iron', count: 3 }],
        [31, { id: 'minecraft:coal', count: 2 }],
        [2, { id: 'minecraft:iron_ingot', count: 3 }],
      ]),
      inventorySlots: new Set<number>([27, 28, 29, 30, 31]),
      carried: null,
      furnace: { lit: true, litProgress: 0.5, cookProgress: 0.3 },
    }
    let taken = false
    clientMocks.callTool.mockImplementation(async ({ name, arguments: args }: { name: string, arguments?: Record<string, unknown> }) => {
      if (name === 'get_status')
        return { content: [], structuredContent: { minecraftVersion: '1.21.1', worldId: 'world-1' } }
      if (name === 'get_self')
        return { content: [], structuredContent: { x: 0, y: 64, z: 0, health: 20, food: 20 } }
      if (name === 'get_inventory')
        return { content: [], structuredContent: { selectedSlot: 0, hotbar: taken ? [{ slot: 0, id: 'minecraft:iron_ingot', count: 3 }] : [], main: [], armor: [], offhand: { empty: true } } }
      if (name === 'menu_open')
        return { content: [], structuredContent: { opened: true, containerId: state.containerId, type: state.type, slots: 39 } }
      if (name === 'menu_snapshot')
        return { content: [], structuredContent: { containerId: state.containerId, type: state.type, carried: menuCarriedJson(state), slots: [...state.slots.keys()].map(index => menuSlotJson(state, index)), ...(state.furnace ? { furnace: state.furnace } : {}) } }
      if (name === 'menu_click') {
        if (args?.containerId !== state.containerId)
          return { content: [], structuredContent: { accepted: false, error: 'menu_mismatch' } }
        const slot = Number(args?.slot)
        if (args?.quickMove === true) {
          if (slot === 2) {
            state.slots.delete(2)
            taken = true
          }
        }
        else {
          menuClickFake(state, slot)
        }
        return { content: [], structuredContent: { accepted: true, containerId: state.containerId, slot: menuSlotJson(state, slot), carried: menuCarriedJson(state) } }
      }
      return { content: [] }
    })

    const directory = await temporaryDirectory('airi-game-host-smelt-')
    const context = createHostContext()
    await setupGameHost(context, { persistencePath: join(directory, 'game-host.json') }, directory)
    await defineInvoke(context, gameHostApplyConfig)({ url: 'http://127.0.0.1:25600/mcp', allowedTools: [] })

    const load = await defineInvoke(context, gameHostExecuteCommand)({
      requestId: 'smelt-load',
      action: 'smelt_load',
      params: { x: 1, y: 64, z: 2, inputItemId: 'minecraft:raw_iron', fuelItemId: 'minecraft:coal', count: 3 },
    })
    expect(load).toMatchObject({
      status: 'ok',
      endReason: 'cooking',
      smelt: {
        containerId: 20,
        stage: 'cooking',
        inputItemId: 'minecraft:raw_iron',
        fuelItemId: 'minecraft:coal',
        requested: 3,
        loaded: 3,
        cooking: { lit: true, litProgress: 0.5, cookProgress: 0.3 },
      },
    })

    const take = await defineInvoke(context, gameHostExecuteCommand)({
      requestId: 'smelt-take',
      action: 'smelt_take',
      params: { x: 1, y: 64, z: 2 },
    })
    expect(take).toMatchObject({
      status: 'ok',
      checked: true,
      endReason: 'taken',
      postCondition: { kind: 'moved', target: 3, actual: 3, met: true },
      smelt: {
        containerId: 20,
        stage: 'taken',
        inputItemId: 'minecraft:raw_iron',
        requested: 3,
        taken: { itemId: 'minecraft:iron_ingot', count: 3 },
        residue: [{ itemId: 'minecraft:raw_iron', count: 3 }, { itemId: 'minecraft:coal', count: 2 }],
      },
    })
    // The leftover input is recorded but never counted as the output.
    expect(take.smelt?.taken?.itemId).toBe('minecraft:iron_ingot')
  })

  it('reports slot_empty when a furnace has no finished output', async () => {
    const state: FakeMenuState = {
      containerId: 20,
      type: 'minecraft:furnace',
      slots: new Map<number, FakeMenuStack>([[0, { id: 'minecraft:raw_iron', count: 3 }]]),
      inventorySlots: new Set<number>([27]),
      carried: null,
      furnace: { lit: true, litProgress: 0.5, cookProgress: 0.3 },
    }
    clientMocks.callTool.mockImplementation(menuClient(state))

    const directory = await temporaryDirectory('airi-game-host-smelt-empty-')
    const context = createHostContext()
    await setupGameHost(context, { persistencePath: join(directory, 'game-host.json') }, directory)
    await defineInvoke(context, gameHostApplyConfig)({ url: 'http://127.0.0.1:25600/mcp', allowedTools: [] })

    const result = await defineInvoke(context, gameHostExecuteCommand)({ requestId: 'smelt-empty', action: 'smelt_take', params: { x: 1, y: 64, z: 2 } })

    expect(result.status).toBe('failed')
    expect(result.endReason).toContain('slot_empty')
  })
})

describe('gameCommandPort (mc-1c D1)', () => {
  it('reports offline state and reuses the renderer registry path after connect', async () => {
    const directory = await temporaryDirectory('airi-game-host-port-')
    const context = createHostContext()
    const port = await setupGameHost(context, { persistencePath: join(directory, 'game-host.json') }, directory)

    expect(port.isConnected()).toBe(false)
    const offline = await port.execute({ requestId: 'port-r1', action: 'status' })
    expect(offline).toMatchObject({ status: 'rejected', checked: false, endReason: 'not_connected' })
    expect(port.listTools().map(tool => tool.name)).toContain('game_collect')

    await defineInvoke(context, gameHostApplyConfig)({ url: 'http://127.0.0.1:25600/mcp', allowedTools: [] })
    expect(port.isConnected()).toBe(true)

    const status = await port.execute({ requestId: 'port-r2', action: 'status' })
    expect(status).toMatchObject({ status: 'ok', endReason: 'idle' })
  })

  it('rejects an empty cancel id without touching the registry', async () => {
    const directory = await temporaryDirectory('airi-game-host-port-cancel-')
    const context = createHostContext()
    const port = await setupGameHost(context, { persistencePath: join(directory, 'game-host.json') }, directory)

    await expect(port.cancel('')).resolves.toMatchObject({ status: 'rejected', endReason: 'unknown_command' })
  })

  it('reports a command aborted before issue as cancelled without a registry entry', async () => {
    const directory = await temporaryDirectory('airi-game-host-port-abort-')
    const context = createHostContext()
    const port = await setupGameHost(context, { persistencePath: join(directory, 'game-host.json') }, directory)
    await defineInvoke(context, gameHostApplyConfig)({ url: 'http://127.0.0.1:25600/mcp', allowedTools: [] })

    const controller = new AbortController()
    controller.abort()
    const result = await port.execute({
      requestId: 'port-r3',
      action: 'say',
      params: { text: 'hi' },
      signal: controller.signal,
    })

    expect(result).toMatchObject({ status: 'cancelled', commandId: null, endReason: 'cancelled' })
  })
})

describe('ranged weapon commands (mc-4d)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    appMock.getVersion.mockReturnValue('0.10.0')
    clientInstances.items.length = 0
    transportInstances.items.length = 0
    clientMocks.connect.mockResolvedValue(undefined)
    clientMocks.close.mockResolvedValue(undefined)
    clientMocks.callTool.mockResolvedValue({ content: [] })
  })

  const TARGET_ENTITY = { name: 'Zombie', uuid: 'target-uuid', type: 'minecraft:zombie', position: { x: 10, y: 64, z: 0 } }

  /** Common tool stubs plus per-test weapon handlers. */
  function shootClient(overrides: Record<string, () => unknown>) {
    return async ({ name }: { name: string }) => {
      if (name === 'get_status')
        return { content: [], structuredContent: { minecraftVersion: '1.21.1', worldId: 'world-1' } }
      if (name === 'get_self')
        return { content: [], structuredContent: { x: 0, y: 64, z: 0, health: 20, food: 20, selectedSlot: 0 } }
      if (name === 'get_inventory')
        return { content: [], structuredContent: { selectedSlot: 0, hotbar: [], main: [], armor: [], offhand: { empty: true } } }
      if (name === 'get_equipment')
        return { content: [], structuredContent: { mainHand: { empty: true }, offHand: { empty: true }, helmet: { empty: true }, chest: { empty: true }, legs: { empty: true }, boots: { empty: true } } }
      if (name === 'query_entities')
        return { content: [], structuredContent: { entities: [TARGET_ENTITY] } }
      if (name === 'poll_events')
        return { content: [], structuredContent: { events: [] } }
      const handler = overrides[name]
      if (handler)
        return { content: [], structuredContent: handler() }
      return { content: [] }
    }
  }

  /** Like {@link shootClient} but self-identifies so attacker-uuid links resolve. */
  function shootClientAsSelf(uuid: string, overrides: Record<string, () => unknown>) {
    const base = shootClient(overrides)
    return async (call: { name: string }) => {
      if (call.name === 'get_self')
        return { content: [], structuredContent: { uuid, x: 0, y: 64, z: 0, health: 20, food: 20, selectedSlot: 0 } }
      return base(call)
    }
  }

  it('fires a bow once and reports the shot without claiming a hit', async () => {
    let statusCalls = 0
    clientMocks.callTool.mockImplementation(shootClient({
      combat_start: () => ({ state: 'running', weapon: 'bow' }),
      combat_status: () => {
        statusCalls++
        return statusCalls === 1
          ? { state: 'running', weapon: 'bow', shotsFired: 0, projectileUuids: [] }
          : { state: 'done', weapon: 'bow', shotsFired: 1, projectileUuids: ['proj-1'], endReason: 'done' }
      },
    }))

    const directory = await temporaryDirectory('airi-game-host-shoot-bow-')
    const context = createHostContext()
    await setupGameHost(context, { persistencePath: join(directory, 'game-host.json') }, directory)
    await defineInvoke(context, gameHostApplyConfig)({ url: 'http://127.0.0.1:25600/mcp', allowedTools: [] })

    const result = await defineInvoke(context, gameHostExecuteCommand)({
      requestId: 'req-shoot-bow',
      action: 'shoot',
      params: { target: 'Zombie', weapon: 'bow', maxShots: 1 },
    })

    expect(result).toMatchObject({
      status: 'ok',
      commandId: 'req-shoot-bow',
      shot: {
        weapon: 'bow',
        targetUuid: 'target-uuid',
        shots: [{ shot: 1, projectileUuid: 'proj-1', hitEvidence: 'unobserved' }],
        endReason: 'done',
      },
    })
    // A fired shot with no attributable event is unobserved, never a miss.
    expect(result.shot?.hits).toBeUndefined()
    expect(result.shot?.killed).toBeUndefined()
    expect(clientMocks.callTool).toHaveBeenCalledWith(expect.objectContaining({ name: 'combat_start' }))
  })

  it('records the resolved profile and predicted curve on the receipt', async () => {
    let statusCalls = 0
    clientMocks.callTool.mockImplementation(shootClient({
      combat_start: () => ({ state: 'running', weapon: 'bow' }),
      combat_status: () => {
        statusCalls++
        return statusCalls === 1
          ? { state: 'running', weapon: 'bow', shotsFired: 0, projectileUuids: [] }
          : { state: 'done', weapon: 'bow', shotsFired: 1, projectileUuids: ['proj-meta'], endReason: 'done' }
      },
    }))

    const directory = await temporaryDirectory('airi-game-host-shoot-ballistic-')
    const context = createHostContext()
    await setupGameHost(context, { persistencePath: join(directory, 'game-host.json') }, directory)
    await defineInvoke(context, gameHostApplyConfig)({ url: 'http://127.0.0.1:25600/mcp', allowedTools: [] })

    const result = await defineInvoke(context, gameHostExecuteCommand)({
      requestId: 'req-shoot-ballistic',
      action: 'shoot',
      params: { target: 'Zombie', weapon: 'bow', maxShots: 1 },
    })

    expect(result).toMatchObject({
      status: 'ok',
      shot: {
        weapon: 'bow',
        profileId: 'bow-arrow',
        fireReason: 'ballistic_solution',
        arc: 'low',
      },
    })
    expect(result.shot?.solutionRevision).toBe(1)
    expect(result.shot?.predictedFlightTicks ?? 0).toBeGreaterThan(0)
    expect(result.shot?.closestDistance).toBe(0)
  })

  it('refuses a bow shot with no ballistic solution and keeps the ammo', async () => {
    const base = shootClient({
      combat_start: () => ({ state: 'running', weapon: 'bow' }),
      combat_status: () => ({ state: 'done', weapon: 'bow', shotsFired: 0, projectileUuids: [], endReason: 'done' }),
    })
    clientMocks.callTool.mockImplementation(async (call: { name: string }) => {
      if (call.name === 'query_entities')
        return { content: [], structuredContent: { entities: [{ name: 'Zombie', uuid: 'target-uuid', type: 'minecraft:zombie', position: { x: 400, y: 64, z: 0 } }] } }
      return base(call)
    })

    const directory = await temporaryDirectory('airi-game-host-shoot-nosolution-')
    const context = createHostContext()
    await setupGameHost(context, { persistencePath: join(directory, 'game-host.json') }, directory)
    await defineInvoke(context, gameHostApplyConfig)({ url: 'http://127.0.0.1:25600/mcp', allowedTools: [] })

    const result = await defineInvoke(context, gameHostExecuteCommand)({
      requestId: 'req-shoot-nosolution',
      action: 'shoot',
      params: { target: 'Zombie', weapon: 'bow', maxShots: 1 },
    })

    expect(result).toMatchObject({
      status: 'failed',
      endReason: 'no_ballistic_solution',
      shot: { shots: [], refusalReason: 'no_ballistic_solution' },
    })
    expect(clientMocks.callTool).not.toHaveBeenCalledWith(expect.objectContaining({ name: 'combat_start' }))
  })

  it('refuses an under-drawn bow before starting the client task', async () => {
    clientMocks.callTool.mockImplementation(shootClient({ combat_start: () => ({ state: 'running', weapon: 'bow' }) }))

    const directory = await temporaryDirectory('airi-game-host-shoot-charge-')
    const context = createHostContext()
    await setupGameHost(context, { persistencePath: join(directory, 'game-host.json') }, directory)
    await defineInvoke(context, gameHostApplyConfig)({ url: 'http://127.0.0.1:25600/mcp', allowedTools: [] })

    const result = await defineInvoke(context, gameHostExecuteCommand)({
      requestId: 'req-shoot-charge',
      action: 'shoot',
      params: { target: 'Zombie', weapon: 'bow', maxShots: 1, chargeTicks: 1 },
    })

    expect(result).toMatchObject({ status: 'failed', endReason: 'insufficient_charge' })
    expect(clientMocks.callTool).not.toHaveBeenCalledWith(expect.objectContaining({ name: 'combat_start' }))
  })

  it('maps ammo-verified shots without a projectile uuid by shot order', async () => {
    let statusCalls = 0
    clientMocks.callTool.mockImplementation(shootClient({
      combat_start: () => ({ state: 'running', weapon: 'bow' }),
      combat_status: () => {
        statusCalls++
        return statusCalls === 1
          ? { state: 'running', weapon: 'bow', shotsFired: 0, projectileUuids: [], shotVerifiedBy: [] }
          : { state: 'done', weapon: 'bow', shotsFired: 2, projectileUuids: ['proj-2'], shotVerifiedBy: ['ammo', 'projectile'], endReason: 'done' }
      },
    }))

    const directory = await temporaryDirectory('airi-game-host-shoot-ammo-')
    const context = createHostContext()
    await setupGameHost(context, { persistencePath: join(directory, 'game-host.json') }, directory)
    await defineInvoke(context, gameHostApplyConfig)({ url: 'http://127.0.0.1:25600/mcp', allowedTools: [] })

    const result = await defineInvoke(context, gameHostExecuteCommand)({
      requestId: 'req-shoot-ammo',
      action: 'shoot',
      params: { target: 'Zombie', weapon: 'bow', maxShots: 2 },
    })

    expect(result.shot?.shots).toEqual([
      { shot: 1, verifiedBy: 'ammo', hitEvidence: 'unobserved' },
      { shot: 2, projectileUuid: 'proj-2', verifiedBy: 'projectile', hitEvidence: 'unobserved' },
    ])
  })

  it('carries a kill event onto a shot that is accounted after the event', async () => {
    let statusCalls = 0
    let eventCalls = 0
    clientMocks.callTool.mockImplementation(shootClient({
      combat_start: () => ({ state: 'running', weapon: 'bow' }),
      combat_status: () => {
        statusCalls++
        return statusCalls === 1
          ? { state: 'running', weapon: 'bow', shotsFired: 0, projectileUuids: [], shotVerifiedBy: [] }
          : { state: 'done', weapon: 'bow', shotsFired: 1, projectileUuids: ['proj-kill'], shotVerifiedBy: ['projectile'], endReason: 'done' }
      },
      poll_server_events: () => {
        eventCalls++
        // R9: the death event names the arrow this task fired, so the kill can
        // be linked to the shot instead of trusting the target uuid alone.
        return eventCalls === 1
          ? { events: [{ id: 7, type: 'entity_death', data: { uuid: 'target-uuid', cause: 'arrow', projectileUuid: 'proj-kill' } }], lastId: 7 }
          : { events: [], lastId: 7 }
      },
    }))

    const directory = await temporaryDirectory('airi-game-host-shoot-kill-')
    const context = createHostContext()
    await setupGameHost(context, { persistencePath: join(directory, 'game-host.json') }, directory)
    await defineInvoke(context, gameHostApplyConfig)({ url: 'http://127.0.0.1:25600/mcp', allowedTools: [] })

    const result = await defineInvoke(context, gameHostExecuteCommand)({
      requestId: 'req-shoot-kill',
      action: 'shoot',
      params: { target: 'Zombie', weapon: 'bow', maxShots: 1 },
    })

    expect(result.shot?.killed).toBe(true)
    expect(result.shot?.shots).toEqual([
      { shot: 1, projectileUuid: 'proj-kill', verifiedBy: 'projectile', hitEvidence: 'entity_death' },
    ])
  })

  it('attributes a kill when the death event names the projectile this shot fired', async () => {
    let statusCalls = 0
    clientMocks.callTool.mockImplementation(shootClient({
      combat_start: () => ({ state: 'running', weapon: 'bow' }),
      combat_status: () => {
        statusCalls++
        return statusCalls === 1
          ? { state: 'running', weapon: 'bow', shotsFired: 0, projectileUuids: [] }
          : { state: 'done', weapon: 'bow', shotsFired: 1, projectileUuids: ['proj-mine'], shotVerifiedBy: ['projectile'], endReason: 'done' }
      },
      poll_server_events: () => ({
        events: [{ id: 9, type: 'entity_death', data: { uuid: 'target-uuid', cause: 'arrow', projectileUuid: 'proj-mine' } }],
        lastId: 9,
      }),
    }))

    const directory = await temporaryDirectory('airi-game-host-shoot-kill-projectile-')
    const context = createHostContext()
    await setupGameHost(context, { persistencePath: join(directory, 'game-host.json') }, directory)
    await defineInvoke(context, gameHostApplyConfig)({ url: 'http://127.0.0.1:25600/mcp', allowedTools: [] })

    const result = await defineInvoke(context, gameHostExecuteCommand)({
      requestId: 'req-shoot-kill-projectile',
      action: 'shoot',
      params: { target: 'Zombie', weapon: 'bow', maxShots: 1 },
    })

    expect(result.shot?.killed).toBe(true)
    expect(result.shot?.killEvidence).toBe('projectile')
    expect(result.shot?.unobservedTargetDeath).toBeUndefined()
  })

  it('keeps a target death unobserved when the event names another projectile', async () => {
    let statusCalls = 0
    clientMocks.callTool.mockImplementation(shootClient({
      combat_start: () => ({ state: 'running', weapon: 'bow' }),
      combat_status: () => {
        statusCalls++
        return statusCalls === 1
          ? { state: 'running', weapon: 'bow', shotsFired: 0, projectileUuids: [] }
          : { state: 'done', weapon: 'bow', shotsFired: 1, projectileUuids: ['proj-mine'], shotVerifiedBy: ['projectile'], endReason: 'done' }
      },
      poll_server_events: () => ({
        events: [{ id: 11, type: 'entity_death', data: { uuid: 'target-uuid', cause: 'arrow', projectileUuid: 'other-arrow' } }],
        lastId: 11,
      }),
    }))

    const directory = await temporaryDirectory('airi-game-host-shoot-kill-other-projectile-')
    const context = createHostContext()
    await setupGameHost(context, { persistencePath: join(directory, 'game-host.json') }, directory)
    await defineInvoke(context, gameHostApplyConfig)({ url: 'http://127.0.0.1:25600/mcp', allowedTools: [] })

    const result = await defineInvoke(context, gameHostExecuteCommand)({
      requestId: 'req-shoot-kill-other-projectile',
      action: 'shoot',
      params: { target: 'Zombie', weapon: 'bow', maxShots: 1 },
    })

    expect(result.shot?.killed).toBeUndefined()
    expect(result.shot?.unobservedTargetDeath).toBe(true)
  })

  it('attributes a kill when the death event names this player as the attacker', async () => {
    let statusCalls = 0
    clientMocks.callTool.mockImplementation(shootClientAsSelf('player-uuid', {
      combat_start: () => ({ state: 'running', weapon: 'bow' }),
      combat_status: () => {
        statusCalls++
        return statusCalls === 1
          ? { state: 'running', weapon: 'bow', shotsFired: 0, projectileUuids: [] }
          : { state: 'done', weapon: 'bow', shotsFired: 1, projectileUuids: ['proj-mine'], shotVerifiedBy: ['projectile'], endReason: 'done' }
      },
      poll_server_events: () => ({
        events: [{ id: 12, type: 'entity_death', data: { uuid: 'target-uuid', cause: 'arrow', attackerUuid: 'player-uuid' } }],
        lastId: 12,
      }),
    }))

    const directory = await temporaryDirectory('airi-game-host-shoot-kill-attacker-')
    const context = createHostContext()
    await setupGameHost(context, { persistencePath: join(directory, 'game-host.json') }, directory)
    await defineInvoke(context, gameHostApplyConfig)({ url: 'http://127.0.0.1:25600/mcp', allowedTools: [] })

    const result = await defineInvoke(context, gameHostExecuteCommand)({
      requestId: 'req-shoot-kill-attacker',
      action: 'shoot',
      params: { target: 'Zombie', weapon: 'bow', maxShots: 1 },
    })

    expect(result.shot?.killed).toBe(true)
    expect(result.shot?.killEvidence).toBe('attacker')
  })

  it('keeps a target death unobserved when the event names another attacker', async () => {
    let statusCalls = 0
    clientMocks.callTool.mockImplementation(shootClientAsSelf('player-uuid', {
      combat_start: () => ({ state: 'running', weapon: 'bow' }),
      combat_status: () => {
        statusCalls++
        return statusCalls === 1
          ? { state: 'running', weapon: 'bow', shotsFired: 0, projectileUuids: [] }
          : { state: 'done', weapon: 'bow', shotsFired: 1, projectileUuids: ['proj-mine'], shotVerifiedBy: ['projectile'], endReason: 'done' }
      },
      poll_server_events: () => ({
        events: [{ id: 13, type: 'entity_death', data: { uuid: 'target-uuid', cause: 'arrow', attackerUuid: 'other-player' } }],
        lastId: 13,
      }),
    }))

    const directory = await temporaryDirectory('airi-game-host-shoot-kill-other-attacker-')
    const context = createHostContext()
    await setupGameHost(context, { persistencePath: join(directory, 'game-host.json') }, directory)
    await defineInvoke(context, gameHostApplyConfig)({ url: 'http://127.0.0.1:25600/mcp', allowedTools: [] })

    const result = await defineInvoke(context, gameHostExecuteCommand)({
      requestId: 'req-shoot-kill-other-attacker',
      action: 'shoot',
      params: { target: 'Zombie', weapon: 'bow', maxShots: 1 },
    })

    expect(result.shot?.killed).toBeUndefined()
    expect(result.shot?.unobservedTargetDeath).toBe(true)
  })

  it('attributes a kill within the shot-time window when the event names no uuids', async () => {
    let statusCalls = 0
    clientMocks.callTool.mockImplementation(shootClient({
      combat_start: () => ({ state: 'running', weapon: 'bow' }),
      combat_status: () => {
        statusCalls++
        return statusCalls === 1
          ? { state: 'running', weapon: 'bow', shotsFired: 0, projectileUuids: [] }
          : { state: 'done', weapon: 'bow', shotsFired: 1, projectileUuids: ['proj-window'], shotVerifiedBy: ['projectile'], lastShotTick: 1000, endReason: 'done' }
      },
      poll_server_events: () => ({
        events: [{ id: 14, type: 'entity_death', gameTime: 1050, data: { uuid: 'target-uuid', cause: 'arrow' } }],
        lastId: 14,
      }),
    }))

    const directory = await temporaryDirectory('airi-game-host-shoot-kill-window-')
    const context = createHostContext()
    await setupGameHost(context, { persistencePath: join(directory, 'game-host.json') }, directory)
    await defineInvoke(context, gameHostApplyConfig)({ url: 'http://127.0.0.1:25600/mcp', allowedTools: [] })

    const result = await defineInvoke(context, gameHostExecuteCommand)({
      requestId: 'req-shoot-kill-window',
      action: 'shoot',
      params: { target: 'Zombie', weapon: 'bow', maxShots: 1 },
    })

    expect(result.shot?.killed).toBe(true)
    expect(result.shot?.killEvidence).toBe('window')
  })

  it('keeps a target death unobserved when the event has no attribution and no window', async () => {
    let statusCalls = 0
    clientMocks.callTool.mockImplementation(shootClient({
      combat_start: () => ({ state: 'running', weapon: 'bow' }),
      combat_status: () => {
        statusCalls++
        return statusCalls === 1
          ? { state: 'running', weapon: 'bow', shotsFired: 0, projectileUuids: [] }
          : { state: 'done', weapon: 'bow', shotsFired: 1, projectileUuids: ['proj-x'], shotVerifiedBy: ['projectile'], endReason: 'done' }
      },
      poll_server_events: () => ({
        events: [{ id: 15, type: 'entity_death', data: { uuid: 'target-uuid', cause: 'arrow' } }],
        lastId: 15,
      }),
    }))

    const directory = await temporaryDirectory('airi-game-host-shoot-kill-unobserved-')
    const context = createHostContext()
    await setupGameHost(context, { persistencePath: join(directory, 'game-host.json') }, directory)
    await defineInvoke(context, gameHostApplyConfig)({ url: 'http://127.0.0.1:25600/mcp', allowedTools: [] })

    const result = await defineInvoke(context, gameHostExecuteCommand)({
      requestId: 'req-shoot-kill-unobserved',
      action: 'shoot',
      params: { target: 'Zombie', weapon: 'bow', maxShots: 1 },
    })

    expect(result.shot?.killed).toBeUndefined()
    expect(result.shot?.unobservedTargetDeath).toBe(true)
  })

  it('reports the mod aim point re-read for a target that moved after the shot started', async () => {
    let statusCalls = 0
    const aimTarget = { x: 12.4, y: 65.1, z: 3.5 }
    clientMocks.callTool.mockImplementation(shootClient({
      combat_start: () => ({ state: 'running', weapon: 'bow' }),
      combat_status: () => {
        statusCalls++
        return statusCalls === 1
          ? { state: 'running', weapon: 'bow', shotsFired: 0, projectileUuids: [], aimTarget, aimSource: 'fresh' }
          : { state: 'done', weapon: 'bow', shotsFired: 1, projectileUuids: ['proj-aim'], shotVerifiedBy: ['projectile'], endReason: 'done', aimTarget, aimSource: 'fresh' }
      },
    }))

    const directory = await temporaryDirectory('airi-game-host-shoot-aim-')
    const context = createHostContext()
    await setupGameHost(context, { persistencePath: join(directory, 'game-host.json') }, directory)
    await defineInvoke(context, gameHostApplyConfig)({ url: 'http://127.0.0.1:25600/mcp', allowedTools: [] })

    const result = await defineInvoke(context, gameHostExecuteCommand)({
      requestId: 'req-shoot-aim',
      action: 'shoot',
      params: { target: 'Zombie', weapon: 'bow', maxShots: 1 },
    })

    expect(result.shot?.aimTarget).toEqual(aimTarget)
    expect(result.shot?.aimSource).toBe('fresh')
    // The pinned resolve returned x=10; a moved target must not read as that.
    expect(result.shot?.aimTarget?.x).not.toBe(TARGET_ENTITY.position.x)
  })

  it('reports returned false when only a backup trident exists and this throw is missing', async () => {
    let statusCalls = 0
    clientMocks.callTool.mockImplementation(shootClient({
      combat_start: () => ({ state: 'running', weapon: 'trident' }),
      combat_status: () => {
        statusCalls++
        return statusCalls === 1
          ? { state: 'running', weapon: 'trident', shotsFired: 0, projectileUuids: [] }
          : { state: 'done', weapon: 'trident', shotsFired: 1, projectileUuids: [], shotVerifiedBy: ['ammo'], returned: false, endReason: 'return_pending' }
      },
    }))

    const directory = await temporaryDirectory('airi-game-host-shoot-trident-backup-')
    const context = createHostContext()
    await setupGameHost(context, { persistencePath: join(directory, 'game-host.json') }, directory)
    await defineInvoke(context, gameHostApplyConfig)({ url: 'http://127.0.0.1:25600/mcp', allowedTools: [] })

    const result = await defineInvoke(context, gameHostExecuteCommand)({
      requestId: 'req-shoot-trident-backup',
      action: 'shoot',
      params: { target: 'Zombie', weapon: 'trident' },
    })

    expect(result.shot?.returned).toBe(false)
  })

  it('reports no_ammo from combat_start without firing a phantom shot', async () => {
    clientMocks.callTool.mockImplementation(shootClient({
      combat_start: () => ({ state: 'done', weapon: 'bow', shotsFired: 0, endReason: 'no_ammo' }),
    }))

    const directory = await temporaryDirectory('airi-game-host-shoot-noammo-')
    const context = createHostContext()
    await setupGameHost(context, { persistencePath: join(directory, 'game-host.json') }, directory)
    await defineInvoke(context, gameHostApplyConfig)({ url: 'http://127.0.0.1:25600/mcp', allowedTools: [] })

    const result = await defineInvoke(context, gameHostExecuteCommand)({
      requestId: 'req-shoot-noammo',
      action: 'shoot',
      params: { target: 'Zombie', weapon: 'bow' },
    })

    expect(result).toMatchObject({ status: 'failed', endReason: 'no_ammo', shot: { shots: [], endReason: 'no_ammo' } })
    expect(result.postCondition).toMatchObject({ kind: 'none', met: false })
  })

  it('reports weapon_unavailable for auto with no ranged weapon and does not start', async () => {
    clientMocks.callTool.mockImplementation(shootClient({}))

    const directory = await temporaryDirectory('airi-game-host-shoot-noweapon-')
    const context = createHostContext()
    await setupGameHost(context, { persistencePath: join(directory, 'game-host.json') }, directory)
    await defineInvoke(context, gameHostApplyConfig)({ url: 'http://127.0.0.1:25600/mcp', allowedTools: [] })

    const result = await defineInvoke(context, gameHostExecuteCommand)({
      requestId: 'req-shoot-noweapon',
      action: 'shoot',
      params: { target: 'Zombie', weapon: 'auto' },
    })

    expect(result).toMatchObject({ status: 'failed', endReason: 'weapon_unavailable', shot: { shots: [] } })
    const startCalls = clientMocks.callTool.mock.calls.filter(([args]: [{ name: string }]) => args.name === 'combat_start')
    expect(startCalls).toHaveLength(0)
  })

  it('reports target_lost when the target cannot be resolved, with no phantom shots', async () => {
    clientMocks.callTool.mockImplementation(async ({ name }: { name: string }) => {
      if (name === 'get_status')
        return { content: [], structuredContent: { minecraftVersion: '1.21.1', worldId: 'world-1' } }
      if (name === 'get_self')
        return { content: [], structuredContent: { x: 0, y: 64, z: 0, health: 20, food: 20 } }
      if (name === 'query_entities')
        return { content: [], structuredContent: { entities: [] } }
      return { content: [] }
    })

    const directory = await temporaryDirectory('airi-game-host-shoot-lost-')
    const context = createHostContext()
    await setupGameHost(context, { persistencePath: join(directory, 'game-host.json') }, directory)
    await defineInvoke(context, gameHostApplyConfig)({ url: 'http://127.0.0.1:25600/mcp', allowedTools: [] })

    const result = await defineInvoke(context, gameHostExecuteCommand)({
      requestId: 'req-shoot-lost',
      action: 'shoot',
      params: { target: 'Nobody', weapon: 'bow' },
    })

    expect(result).toMatchObject({ status: 'failed', endReason: 'target_lost', shot: { shots: [], targetUuid: '' } })
    const startCalls = clientMocks.callTool.mock.calls.filter(([args]: [{ name: string }]) => args.name === 'combat_start')
    expect(startCalls).toHaveLength(0)
  })

  it('cancels a charging bow through combat_cancel without claiming a release', async () => {
    let statusCalls = 0
    let startSeen = false
    clientMocks.callTool.mockImplementation(async ({ name }: { name: string }) => {
      if (name === 'get_status')
        return { content: [], structuredContent: { minecraftVersion: '1.21.1', worldId: 'world-1' } }
      if (name === 'get_self')
        return { content: [], structuredContent: { x: 0, y: 64, z: 0, health: 20, food: 20 } }
      if (name === 'get_inventory')
        return { content: [], structuredContent: { selectedSlot: 0, hotbar: [], main: [], armor: [], offhand: { empty: true } } }
      if (name === 'query_entities')
        return { content: [], structuredContent: { entities: [TARGET_ENTITY] } }
      if (name === 'poll_events')
        return { content: [], structuredContent: { events: [] } }
      if (name === 'combat_start') {
        startSeen = true
        return { content: [], structuredContent: { state: 'running', weapon: 'bow' } }
      }
      if (name === 'combat_cancel')
        return { content: [], structuredContent: { state: 'cancelled', weapon: 'bow', shotsFired: 0 } }
      if (name === 'combat_status') {
        statusCalls++
        // While the task is still running the charge never releases; once the
        // cancel lands the task reports cancelled with no shots.
        return { content: [], structuredContent: statusCalls < 2 ? { state: 'running', shotsFired: 0 } : { state: 'cancelled', shotsFired: 0, endReason: 'cancelled' } }
      }
      return { content: [] }
    })

    const directory = await temporaryDirectory('airi-game-host-shoot-cancel-')
    const context = createHostContext()
    await setupGameHost(context, { persistencePath: join(directory, 'game-host.json') }, directory)
    await defineInvoke(context, gameHostApplyConfig)({ url: 'http://127.0.0.1:25600/mcp', allowedTools: [] })

    const inFlight = defineInvoke(context, gameHostExecuteCommand)({
      requestId: 'req-shoot-cancel',
      action: 'shoot',
      params: { target: 'Zombie', weapon: 'bow', maxShots: 3 },
    })
    await vi.waitFor(() => expect(startSeen).toBe(true))

    const cancelled = await defineInvoke(context, gameHostExecuteCommand)({
      requestId: 'req-shoot-cancel-request',
      action: 'cancel',
      params: {},
    })

    expect(clientMocks.callTool).toHaveBeenCalledWith({ name: 'combat_cancel', arguments: {} })
    expect(cancelled.status).toBe('cancelled')
    // No shot was fired, so the receipt never claims a fired projectile.
    expect(cancelled.shot?.shots ?? []).toHaveLength(0)
    await inFlight
  })

  it('loads then fires a crossbow, reflecting the charged state', async () => {
    let statusCalls = 0
    let chargedSeen = false
    clientMocks.callTool.mockImplementation(shootClient({
      combat_start: () => ({ state: 'running', weapon: 'crossbow' }),
      combat_status: () => {
        statusCalls++
        if (statusCalls === 1) {
          chargedSeen = true
          return { state: 'running', weapon: 'crossbow', charged: true, shotsFired: 0, projectileUuids: [] }
        }
        return { state: 'done', weapon: 'crossbow', shotsFired: 1, projectileUuids: ['bolt-1'], endReason: 'done' }
      },
    }))

    const directory = await temporaryDirectory('airi-game-host-shoot-crossbow-')
    const context = createHostContext()
    await setupGameHost(context, { persistencePath: join(directory, 'game-host.json') }, directory)
    await defineInvoke(context, gameHostApplyConfig)({ url: 'http://127.0.0.1:25600/mcp', allowedTools: [] })

    const result = await defineInvoke(context, gameHostExecuteCommand)({
      requestId: 'req-shoot-crossbow',
      action: 'shoot',
      params: { target: 'Zombie', weapon: 'crossbow' },
    })

    expect(chargedSeen).toBe(true)
    expect(result).toMatchObject({
      status: 'ok',
      shot: { weapon: 'crossbow', shots: [{ shot: 1, projectileUuid: 'bolt-1' }], endReason: 'done' },
    })
  })

  it('records a trident throw and reports a returned trident', async () => {
    let statusCalls = 0
    clientMocks.callTool.mockImplementation(shootClient({
      combat_start: () => ({ state: 'running', weapon: 'trident' }),
      combat_status: () => {
        statusCalls++
        return statusCalls === 1
          ? { state: 'running', weapon: 'trident', shotsFired: 0, projectileUuids: [] }
          : { state: 'done', weapon: 'trident', shotsFired: 1, projectileUuids: ['trident-1'], returned: true, endReason: 'returned' }
      },
    }))

    const directory = await temporaryDirectory('airi-game-host-shoot-trident-')
    const context = createHostContext()
    await setupGameHost(context, { persistencePath: join(directory, 'game-host.json') }, directory)
    await defineInvoke(context, gameHostApplyConfig)({ url: 'http://127.0.0.1:25600/mcp', allowedTools: [] })

    const result = await defineInvoke(context, gameHostExecuteCommand)({
      requestId: 'req-shoot-trident',
      action: 'shoot',
      params: { target: 'Zombie', weapon: 'trident' },
    })

    expect(result).toMatchObject({
      status: 'ok',
      shot: { weapon: 'trident', returned: true, shots: [{ shot: 1, projectileUuid: 'trident-1' }], endReason: 'returned' },
    })
  })

  it('reports a trident return timeout distinctly from a returned trident', async () => {
    let statusCalls = 0
    clientMocks.callTool.mockImplementation(shootClient({
      combat_start: () => ({ state: 'running', weapon: 'trident' }),
      combat_status: () => {
        statusCalls++
        return statusCalls === 1
          ? { state: 'running', weapon: 'trident', shotsFired: 0, projectileUuids: [] }
          : { state: 'done', weapon: 'trident', shotsFired: 1, projectileUuids: ['trident-1'], endReason: 'return_pending' }
      },
    }))

    const directory = await temporaryDirectory('airi-game-host-shoot-trident-pending-')
    const context = createHostContext()
    await setupGameHost(context, { persistencePath: join(directory, 'game-host.json') }, directory)
    await defineInvoke(context, gameHostApplyConfig)({ url: 'http://127.0.0.1:25600/mcp', allowedTools: [] })

    const result = await defineInvoke(context, gameHostExecuteCommand)({
      requestId: 'req-shoot-trident-pending',
      action: 'shoot',
      params: { target: 'Zombie', weapon: 'trident' },
    })

    expect(result.shot?.endReason).toBe('return_pending')
    expect(result.shot?.returned).toBeUndefined()
  })

  it('ends a shot with reflex_preempted and keeps the fired shot', async () => {
    let statusCalls = 0
    clientMocks.callTool.mockImplementation(async ({ name }: { name: string }) => {
      if (name === 'get_status')
        return { content: [], structuredContent: { minecraftVersion: '1.21.1', worldId: 'world-1' } }
      if (name === 'get_self')
        return { content: [], structuredContent: { x: 0, y: 64, z: 0, health: 20, food: 20 } }
      if (name === 'get_inventory')
        return { content: [], structuredContent: { selectedSlot: 0, hotbar: [], main: [], armor: [], offhand: { empty: true } } }
      if (name === 'query_entities')
        return { content: [], structuredContent: { entities: [TARGET_ENTITY] } }
      if (name === 'poll_events') {
        // The reflex echoes the command id it preempted (the request id).
        return { content: [], structuredContent: { events: [{ id: 1, type: 'reflex', data: { preemptedCommandId: 'req-shoot-reflex' } }] } }
      }
      if (name === 'combat_start')
        return { content: [], structuredContent: { state: 'running', weapon: 'bow' } }
      if (name === 'combat_status') {
        statusCalls++
        return { content: [], structuredContent: statusCalls === 1 ? { state: 'running', shotsFired: 0 } : { state: 'cancelled', shotsFired: 1, projectileUuids: ['proj-1'], endReason: 'reflex_preempted' } }
      }
      if (name === 'combat_cancel')
        return { content: [], structuredContent: { state: 'cancelled', shotsFired: 1 } }
      return { content: [] }
    })

    const directory = await temporaryDirectory('airi-game-host-shoot-reflex-')
    const context = createHostContext()
    await setupGameHost(context, { persistencePath: join(directory, 'game-host.json') }, directory)
    await defineInvoke(context, gameHostApplyConfig)({ url: 'http://127.0.0.1:25600/mcp', allowedTools: [] })

    const result = await defineInvoke(context, gameHostExecuteCommand)({
      requestId: 'req-shoot-reflex',
      action: 'shoot',
      params: { target: 'Zombie', weapon: 'bow', maxShots: 3 },
    })

    expect(result.endReason).toBe('reflex_preempted')
    expect(result.shot?.shots).toHaveLength(1)
    expect(result.shot?.shots[0]).toMatchObject({ shot: 1, projectileUuid: 'proj-1' })
  })

  it('refuses a riptide trident without starting a combat task', async () => {
    clientMocks.callTool.mockImplementation(async ({ name }: { name: string }) => {
      if (name === 'get_status')
        return { content: [], structuredContent: { minecraftVersion: '1.21.1', worldId: 'world-1' } }
      if (name === 'get_self')
        return { content: [], structuredContent: { x: 0, y: 64, z: 0, health: 20, food: 20 } }
      if (name === 'query_entities')
        return { content: [], structuredContent: { entities: [TARGET_ENTITY] } }
      if (name === 'get_equipment')
        return { content: [], structuredContent: { mainHand: { id: 'minecraft:trident', count: 1, enchantments: { 'minecraft:riptide': 1 } } } }
      return { content: [] }
    })

    const directory = await temporaryDirectory('airi-game-host-shoot-riptide-')
    const context = createHostContext()
    await setupGameHost(context, { persistencePath: join(directory, 'game-host.json') }, directory)
    await defineInvoke(context, gameHostApplyConfig)({ url: 'http://127.0.0.1:25600/mcp', allowedTools: [] })

    const result = await defineInvoke(context, gameHostExecuteCommand)({
      requestId: 'req-shoot-riptide',
      action: 'shoot',
      params: { target: 'Zombie', weapon: 'trident' },
    })

    expect(result).toMatchObject({ status: 'failed', endReason: 'unsupported_weapon_feature', shot: { shots: [] } })
    const startCalls = clientMocks.callTool.mock.calls.filter(([args]: [{ name: string }]) => args.name === 'combat_start')
    expect(startCalls).toHaveLength(0)
  })
})

describe('advanced movement and dimension binding (mc-4e)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    appMock.getVersion.mockReturnValue('0.10.0')
    clientInstances.items.length = 0
    transportInstances.items.length = 0
    clientMocks.connect.mockResolvedValue(undefined)
    clientMocks.close.mockResolvedValue(undefined)
    clientMocks.callTool.mockResolvedValue({ content: [] })
  })

  it('terminates the active write command on a dimension change and binds new commands to the new dimension', async () => {
    let liveDimension = 'minecraft:overworld'
    let releasePath: (() => void) | undefined
    clientMocks.callTool.mockImplementation(async ({ name }: { name: string }) => {
      if (name === 'get_status')
        return { content: [], structuredContent: { minecraftVersion: '1.21.1', worldId: 'world-1', dimension: liveDimension } }
      if (name === 'get_self')
        return { content: [], structuredContent: { x: 0, y: 64, z: 0, health: 20, food: 20, selectedSlot: 0, dimension: liveDimension } }
      if (name === 'get_inventory')
        return { content: [], structuredContent: { selectedSlot: 0, hotbar: [], main: [], armor: [], offhand: { empty: true } } }
      if (name === 'get_equipment')
        return { content: [], structuredContent: { mainHand: { empty: true }, offHand: { empty: true }, helmet: { empty: true }, chest: { empty: true }, legs: { empty: true }, boots: { empty: true } } }
      if (name === 'get_status_effects')
        return { content: [], structuredContent: { effects: [] } }
      if (name === 'get_blocks_region')
        return { content: [], structuredContent: { blocks: [] } }
      if (name === 'navigate_to') {
        // The first move blocks so the dimension change lands mid-command.
        if (!releasePath) {
          await new Promise<void>((resolve) => {
            releasePath = resolve
          })
        }
        return { content: [], structuredContent: { started: true } }
      }
      if (name === 'navigation_status')
        return { content: [], structuredContent: { active: false, endReason: 'reached', finalPosition: { x: 0, y: 64, z: 0 } } }
      return { content: [] }
    })

    const directory = await temporaryDirectory('airi-game-host-dimension-')
    const context = createHostContext()
    await setupGameHost(context, { persistencePath: join(directory, 'game-host.json') }, directory)
    await defineInvoke(context, gameHostApplyConfig)({ url: 'http://127.0.0.1:25600/mcp', allowedTools: [], movement: { planner: 'legacy' } })

    const moveTo = defineInvoke(context, gameHostExecuteCommand)({
      requestId: 'req-dim-move',
      action: 'move_to',
      params: { x: 0, y: 64, z: 0, tolerance: 1 },
    })
    await vi.waitFor(() => expect(releasePath).toBeDefined())

    // Crossing a portal: the next fresh get_self reports the nether.
    liveDimension = 'minecraft:the_nether'
    await defineInvoke(context, gameHostExecuteCommand)({ requestId: 'req-dim-observe', action: 'observe', params: { radius: 4 } })

    releasePath!()
    const terminated = await moveTo
    expect(terminated).toMatchObject({ status: 'cancelled', endReason: 'dimension_changed', checked: false })

    // A new command binds to the new dimension and runs.
    const after = await defineInvoke(context, gameHostExecuteCommand)({
      requestId: 'req-dim-after',
      action: 'move_to',
      params: { x: 0, y: 64, z: 0, tolerance: 1 },
    })
    expect(after).toMatchObject({ status: 'ok', world: { dimension: 'minecraft:the_nether' } })
  })

  it('launches a riptide, reports displacement and durability, and verifies arrival', async () => {
    let statusCalls = 0
    clientMocks.callTool.mockImplementation(async ({ name }: { name: string }) => {
      if (name === 'get_status')
        return { content: [], structuredContent: { minecraftVersion: '1.21.1', worldId: 'world-1', dimension: 'minecraft:overworld' } }
      if (name === 'get_self')
        return { content: [], structuredContent: { x: 8, y: 64, z: 0, health: 20, food: 20, selectedSlot: 0, dimension: 'minecraft:overworld' } }
      if (name === 'get_inventory')
        return { content: [], structuredContent: { selectedSlot: 0, hotbar: [], main: [], armor: [], offhand: { empty: true } } }
      if (name === 'riptide')
        return { content: [], structuredContent: { state: 'running', endReason: 'running' } }
      if (name === 'riptide_status') {
        statusCalls++
        return {
          content: [],
          structuredContent: statusCalls === 1
            ? { state: 'running', endReason: 'running' }
            : { state: 'done', endReason: 'launched', from: { x: 0, y: 64, z: 0 }, to: { x: 8, y: 64, z: 0 }, displacement: { x: 8, y: 0, z: 0 }, distance: 8, durabilityBefore: 0, durabilityAfter: 1 },
        }
      }
      return { content: [] }
    })

    const directory = await temporaryDirectory('airi-game-host-riptide-')
    const context = createHostContext()
    await setupGameHost(context, { persistencePath: join(directory, 'game-host.json') }, directory)
    await defineInvoke(context, gameHostApplyConfig)({ url: 'http://127.0.0.1:25600/mcp', allowedTools: [] })

    const result = await defineInvoke(context, gameHostExecuteCommand)({
      requestId: 'req-riptide',
      action: 'riptide',
      params: { x: 8, y: 64, z: 0, tolerance: 2 },
    })

    expect(result).toMatchObject({
      status: 'ok',
      checked: true,
      endReason: 'launched',
      postCondition: { kind: 'distance', target: 2, met: true },
      riptide: { distance: 8, durabilityBefore: 0, durabilityAfter: 1, endReason: 'launched' },
    })
    expect(clientMocks.callTool).toHaveBeenCalledWith({ name: 'riptide', arguments: { targetX: 8, targetY: 64, targetZ: 0 } })
  })

  it('fails a riptide with riptide_unavailable and never charges when conditions are unmet', async () => {
    clientMocks.callTool.mockImplementation(async ({ name }: { name: string }) => {
      if (name === 'get_status')
        return { content: [], structuredContent: { minecraftVersion: '1.21.1', worldId: 'world-1', dimension: 'minecraft:overworld' } }
      if (name === 'get_self')
        return { content: [], structuredContent: { x: 0, y: 64, z: 0, health: 20, food: 20, selectedSlot: 0, dimension: 'minecraft:overworld' } }
      if (name === 'get_inventory')
        return { content: [], structuredContent: { selectedSlot: 0, hotbar: [], main: [], armor: [], offhand: { empty: true } } }
      if (name === 'riptide')
        return { content: [], structuredContent: { state: 'done', endReason: 'riptide_unavailable', unmet: 'not_in_water_or_rain' } }
      return { content: [] }
    })

    const directory = await temporaryDirectory('airi-game-host-riptide-unavailable-')
    const context = createHostContext()
    await setupGameHost(context, { persistencePath: join(directory, 'game-host.json') }, directory)
    await defineInvoke(context, gameHostApplyConfig)({ url: 'http://127.0.0.1:25600/mcp', allowedTools: [] })

    const result = await defineInvoke(context, gameHostExecuteCommand)({
      requestId: 'req-riptide-unavailable',
      action: 'riptide',
      params: { x: 8, y: 64, z: 0, tolerance: 2 },
    })

    expect(result).toMatchObject({ status: 'failed', endReason: 'riptide_unavailable', riptide: { endReason: 'riptide_unavailable' } })
    // §9-3: a diagnostic read that reports none of the fields leaves the
    // receipt without `unmetDetail`, but the refusal still reads the status
    // once so a mod that does report them can fill it in.
    expect(result.riptide?.unmetDetail).toBeUndefined()
    const statusCalls = clientMocks.callTool.mock.calls.filter(([args]: [{ name: string }]) => args.name === 'riptide_status')
    expect(statusCalls).toHaveLength(1)
  })

  // §9-3: mod 0.2.15 reports why a riptide was refused in `riptide_status`; the
  // receipt passes the fields through, including a real `rainLevel: 0`.
  it('passes the mod water/rain diagnostics through a riptide_unavailable receipt', async () => {
    clientMocks.callTool.mockImplementation(async ({ name }: { name: string }) => {
      if (name === 'get_status')
        return { content: [], structuredContent: { minecraftVersion: '1.21.1', worldId: 'world-1', dimension: 'minecraft:overworld' } }
      if (name === 'get_self')
        return { content: [], structuredContent: { x: 0, y: 64, z: 0, health: 20, food: 20, selectedSlot: 0, dimension: 'minecraft:overworld' } }
      if (name === 'get_inventory')
        return { content: [], structuredContent: { selectedSlot: 0, hotbar: [], main: [], armor: [], offhand: { empty: true } } }
      if (name === 'riptide')
        return { content: [], structuredContent: { state: 'done', endReason: 'riptide_unavailable', unmet: 'not_in_water_or_rain' } }
      if (name === 'riptide_status')
        return { content: [], structuredContent: { state: 'done', endReason: 'riptide_unavailable', inWater: false, inRain: true, rainLevel: 0 } }
      return { content: [] }
    })

    const directory = await temporaryDirectory('airi-game-host-riptide-unmet-detail-')
    const context = createHostContext()
    await setupGameHost(context, { persistencePath: join(directory, 'game-host.json') }, directory)
    await defineInvoke(context, gameHostApplyConfig)({ url: 'http://127.0.0.1:25600/mcp', allowedTools: [] })

    const result = await defineInvoke(context, gameHostExecuteCommand)({
      requestId: 'req-riptide-unmet-detail',
      action: 'riptide',
      params: { x: 8, y: 64, z: 0, tolerance: 2 },
    })

    expect(result).toMatchObject({
      status: 'failed',
      endReason: 'riptide_unavailable',
      riptide: { endReason: 'riptide_unavailable', unmetDetail: { inWater: false, inRain: true, rainLevel: 0 } },
    })
    const statusCalls = clientMocks.callTool.mock.calls.filter(([args]: [{ name: string }]) => args.name === 'riptide_status')
    expect(statusCalls).toHaveLength(1)
  })

  // §9-4: the mod records durability at release, before the server syncs it, so
  // the host polls the status until the value changes.
  it('polls the released trident durability until the server syncs the new value', async () => {
    let statusCalls = 0
    clientMocks.callTool.mockImplementation(async ({ name }: { name: string }) => {
      if (name === 'get_status')
        return { content: [], structuredContent: { minecraftVersion: '1.21.1', worldId: 'world-1', dimension: 'minecraft:overworld' } }
      if (name === 'get_self')
        return { content: [], structuredContent: { x: 8, y: 64, z: 0, health: 20, food: 20, selectedSlot: 0, dimension: 'minecraft:overworld' } }
      if (name === 'get_inventory')
        return { content: [], structuredContent: { selectedSlot: 0, hotbar: [], main: [], armor: [], offhand: { empty: true } } }
      if (name === 'riptide')
        return { content: [], structuredContent: { state: 'running', endReason: 'running' } }
      if (name === 'riptide_status') {
        statusCalls++
        if (statusCalls === 1)
          return { content: [], structuredContent: { state: 'running', endReason: 'running' } }
        const synced = statusCalls > 2
        return {
          content: [],
          structuredContent: {
            state: 'done',
            endReason: 'launched',
            from: { x: 0, y: 64, z: 0 },
            to: { x: 8, y: 64, z: 0 },
            distance: 8,
            durabilityBefore: 0,
            durabilityAfter: synced ? 1 : 0,
          },
        }
      }
      return { content: [] }
    })

    const directory = await temporaryDirectory('airi-game-host-riptide-durability-')
    const context = createHostContext()
    await setupGameHost(context, { persistencePath: join(directory, 'game-host.json') }, directory)
    await defineInvoke(context, gameHostApplyConfig)({ url: 'http://127.0.0.1:25600/mcp', allowedTools: [] })

    const result = await defineInvoke(context, gameHostExecuteCommand)({
      requestId: 'req-riptide-durability',
      action: 'riptide',
      params: { x: 8, y: 64, z: 0, tolerance: 2 },
    })

    expect(result).toMatchObject({ status: 'ok', riptide: { durabilityBefore: 0, durabilityAfter: 1 } })
    expect(statusCalls).toBeGreaterThanOrEqual(3)
  })

  // §9-4: when the server never reports a change, the release-time value is
  // kept honestly instead of failing the command.
  it('keeps the release-time durability when the server never syncs a change', async () => {
    let statusCalls = 0
    clientMocks.callTool.mockImplementation(async ({ name }: { name: string }) => {
      if (name === 'get_status')
        return { content: [], structuredContent: { minecraftVersion: '1.21.1', worldId: 'world-1', dimension: 'minecraft:overworld' } }
      if (name === 'get_self')
        return { content: [], structuredContent: { x: 8, y: 64, z: 0, health: 20, food: 20, selectedSlot: 0, dimension: 'minecraft:overworld' } }
      if (name === 'get_inventory')
        return { content: [], structuredContent: { selectedSlot: 0, hotbar: [], main: [], armor: [], offhand: { empty: true } } }
      if (name === 'riptide')
        return { content: [], structuredContent: { state: 'running', endReason: 'running' } }
      if (name === 'riptide_status') {
        statusCalls++
        return {
          content: [],
          structuredContent: statusCalls === 1
            ? { state: 'running', endReason: 'running' }
            : { state: 'done', endReason: 'launched', distance: 8, durabilityBefore: 0, durabilityAfter: 0 },
        }
      }
      return { content: [] }
    })

    const directory = await temporaryDirectory('airi-game-host-riptide-durability-stale-')
    const context = createHostContext()
    await setupGameHost(context, { persistencePath: join(directory, 'game-host.json') }, directory)
    await defineInvoke(context, gameHostApplyConfig)({ url: 'http://127.0.0.1:25600/mcp', allowedTools: [] })

    const result = await defineInvoke(context, gameHostExecuteCommand)({
      requestId: 'req-riptide-durability-stale',
      action: 'riptide',
      params: { x: 8, y: 64, z: 0, tolerance: 2 },
    })

    expect(result).toMatchObject({ status: 'ok', riptide: { durabilityBefore: 0, durabilityAfter: 0 } })
    expect(statusCalls).toBeGreaterThanOrEqual(3)
  }, 20_000)

  it('aborts a charging riptide through the abort path without a launch', async () => {
    let charging = false
    clientMocks.callTool.mockImplementation(async ({ name }: { name: string }) => {
      if (name === 'get_status')
        return { content: [], structuredContent: { minecraftVersion: '1.21.1', worldId: 'world-1', dimension: 'minecraft:overworld' } }
      if (name === 'get_self')
        return { content: [], structuredContent: { x: 0, y: 64, z: 0, health: 20, food: 20, selectedSlot: 0, dimension: 'minecraft:overworld' } }
      if (name === 'get_inventory')
        return { content: [], structuredContent: { selectedSlot: 0, hotbar: [], main: [], armor: [], offhand: { empty: true } } }
      if (name === 'riptide') {
        charging = true
        return { content: [], structuredContent: { state: 'running', endReason: 'running' } }
      }
      if (name === 'riptide_cancel' || name === 'combat_cancel') {
        charging = false
        return { content: [], structuredContent: { state: 'cancelled', endReason: 'cancelled' } }
      }
      if (name === 'riptide_status')
        return { content: [], structuredContent: charging ? { state: 'running', endReason: 'running' } : { state: 'cancelled', endReason: 'cancelled' } }
      return { content: [] }
    })

    const directory = await temporaryDirectory('airi-game-host-riptide-cancel-')
    const context = createHostContext()
    await setupGameHost(context, { persistencePath: join(directory, 'game-host.json') }, directory)
    await defineInvoke(context, gameHostApplyConfig)({ url: 'http://127.0.0.1:25600/mcp', allowedTools: [] })

    const inFlight = defineInvoke(context, gameHostExecuteCommand)({
      requestId: 'req-riptide-cancel',
      action: 'riptide',
      params: { x: 8, y: 64, z: 0, tolerance: 2 },
    })
    await vi.waitFor(() => expect(charging).toBe(true))

    const cancelled = await defineInvoke(context, gameHostExecuteCommand)({ requestId: 'req-riptide-cancel-request', action: 'cancel', params: {} })

    expect(clientMocks.callTool).toHaveBeenCalledWith({ name: 'riptide_cancel', arguments: {} })
    expect(cancelled.status).toBe('cancelled')
    // No launched receipt: the abort never released the throw.
    expect(cancelled.riptide).toBeUndefined()
    await inFlight
  })

  // §9-1: the app can connect before a player is in the world. The connect-time
  // identity build then fails, and noteLiveDimension used to early-return, so a
  // later portal crossing never converged.
  it('establishes a missing world binding from a late player read and still stops on the next dimension change', async () => {
    let playerJoined = false
    let statusCalls = 0
    let liveDimension = 'minecraft:overworld'
    let releasePath: (() => void) | undefined
    clientMocks.callTool.mockImplementation(async ({ name }: { name: string }) => {
      if (name === 'get_status') {
        statusCalls++
        // The bridge is not ready yet when the app connects without a player.
        if (statusCalls === 1)
          throw new Error('bridge warming up')
        return { content: [], structuredContent: { minecraftVersion: '1.21.1', worldId: 'world-1', dimension: liveDimension } }
      }
      if (name === 'get_self') {
        if (!playerJoined)
          throw new Error('no_player')
        return { content: [], structuredContent: { x: 0, y: 64, z: 0, health: 20, food: 20, selectedSlot: 0, dimension: liveDimension } }
      }
      if (name === 'get_inventory')
        return { content: [], structuredContent: { selectedSlot: 0, hotbar: [], main: [], armor: [], offhand: { empty: true } } }
      if (name === 'get_equipment')
        return { content: [], structuredContent: { mainHand: { empty: true }, offHand: { empty: true }, helmet: { empty: true }, chest: { empty: true }, legs: { empty: true }, boots: { empty: true } } }
      if (name === 'get_status_effects')
        return { content: [], structuredContent: { effects: [] } }
      if (name === 'get_blocks_region')
        return { content: [], structuredContent: { blocks: [] } }
      if (name === 'navigate_to') {
        if (!releasePath) {
          await new Promise<void>((resolve) => {
            releasePath = resolve
          })
        }
        return { content: [], structuredContent: { started: true } }
      }
      if (name === 'navigation_status')
        return { content: [], structuredContent: { active: false, endReason: 'reached', finalPosition: { x: 0, y: 64, z: 0 } } }
      return { content: [] }
    })

    const directory = await temporaryDirectory('airi-game-host-late-binding-')
    const context = createHostContext()
    await setupGameHost(context, { persistencePath: join(directory, 'game-host.json') }, directory)
    await defineInvoke(context, gameHostApplyConfig)({ url: 'http://127.0.0.1:25600/mcp', allowedTools: [], movement: { planner: 'legacy' } })

    // Connected with no player: the connect-time identity build failed.
    expect((await defineInvoke(context, gameHostGetStatus)()).identity).toBeUndefined()

    playerJoined = true
    await defineInvoke(context, gameHostExecuteCommand)({ requestId: 'req-late-observe', action: 'observe', params: { radius: 4 } })
    const bound = await defineInvoke(context, gameHostGetStatus)()
    expect(bound).toMatchObject({ status: 'connected', identity: { dimension: 'minecraft:overworld', worldId: 'world-1' } })

    // A later binding change still terminates the running write command.
    const moveTo = defineInvoke(context, gameHostExecuteCommand)({ requestId: 'req-late-move', action: 'move_to', params: { x: 0, y: 64, z: 0, tolerance: 1 } })
    await vi.waitFor(() => expect(releasePath).toBeDefined())
    liveDimension = 'minecraft:the_nether'
    await defineInvoke(context, gameHostExecuteCommand)({ requestId: 'req-late-observe-2', action: 'observe', params: { radius: 4 } })
    releasePath!()
    expect(await moveTo).toMatchObject({ status: 'cancelled', endReason: 'dimension_changed' })
  })

  // §9-7: the registry settles, but the post-settlement fresh read used to be
  // unbounded, so a stalled get_self left the invoke unanswered and the
  // devtools smoke promise never resolved.
  it('resolves a command stopped by a dimension change when the post-settle read stalls', async () => {
    let liveDimension = 'minecraft:overworld'
    let releasePath: (() => void) | undefined
    let hangSelf = false
    clientMocks.callTool.mockImplementation(async ({ name }: { name: string }) => {
      if (name === 'get_status')
        return { content: [], structuredContent: { minecraftVersion: '1.21.1', worldId: 'world-1', dimension: liveDimension } }
      if (name === 'get_self') {
        if (hangSelf)
          await new Promise<never>(() => {})
        return { content: [], structuredContent: { x: 0, y: 64, z: 0, health: 20, food: 20, selectedSlot: 0, dimension: liveDimension } }
      }
      if (name === 'get_inventory')
        return { content: [], structuredContent: { selectedSlot: 0, hotbar: [], main: [], armor: [], offhand: { empty: true } } }
      if (name === 'get_equipment')
        return { content: [], structuredContent: { mainHand: { empty: true }, offHand: { empty: true }, helmet: { empty: true }, chest: { empty: true }, legs: { empty: true }, boots: { empty: true } } }
      if (name === 'get_status_effects')
        return { content: [], structuredContent: { effects: [] } }
      if (name === 'get_blocks_region')
        return { content: [], structuredContent: { blocks: [] } }
      if (name === 'navigate_to') {
        if (!releasePath) {
          await new Promise<void>((resolve) => {
            releasePath = resolve
          })
        }
        return { content: [], structuredContent: { started: true } }
      }
      if (name === 'navigation_status')
        return { content: [], structuredContent: { active: false, endReason: 'reached', finalPosition: { x: 0, y: 64, z: 0 } } }
      return { content: [] }
    })

    const directory = await temporaryDirectory('airi-game-host-stalled-read-')
    const context = createHostContext()
    await setupGameHost(context, { persistencePath: join(directory, 'game-host.json') }, directory)
    await defineInvoke(context, gameHostApplyConfig)({ url: 'http://127.0.0.1:25600/mcp', allowedTools: [], movement: { planner: 'legacy' } })

    const moveTo = defineInvoke(context, gameHostExecuteCommand)({ requestId: 'req-stall-move', action: 'move_to', params: { x: 0, y: 64, z: 0, tolerance: 1 } })
    await vi.waitFor(() => expect(releasePath).toBeDefined())

    liveDimension = 'minecraft:the_nether'
    await defineInvoke(context, gameHostExecuteCommand)({ requestId: 'req-stall-observe', action: 'observe', params: { radius: 4 } })

    // The terminated command's post-settlement read now stalls forever.
    hangSelf = true
    releasePath!()
    const settled = await moveTo
    expect(settled).toMatchObject({ commandId: 'req-stall-move', endReason: 'check_failed: fresh_state' })
  }, 20_000)
})

describe('life and content commands (mc-4f)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    appMock.getVersion.mockReturnValue('0.10.0')
    clientInstances.items.length = 0
    transportInstances.items.length = 0
    clientMocks.connect.mockResolvedValue(undefined)
    clientMocks.close.mockResolvedValue(undefined)
    clientMocks.callTool.mockResolvedValue({ content: [] })
  })

  const SELF: { content: Array<Record<string, unknown>>, structuredContent: Record<string, unknown> } = { content: [], structuredContent: { x: 0, y: 64, z: 0, health: 20, food: 20, selectedSlot: 0 } }
  const EMPTY_INVENTORY: { content: Array<Record<string, unknown>>, structuredContent: Record<string, unknown> } = { content: [], structuredContent: { selectedSlot: 0, hotbar: [], main: [], armor: [], offhand: { empty: true } } }

  async function connect(context: ReturnType<typeof createHostContext>, directory: string): Promise<void> {
    await setupGameHost(context, { persistencePath: join(directory, 'game-host.json') }, directory)
    await defineInvoke(context, gameHostApplyConfig)({ url: 'http://127.0.0.1:25600/mcp', allowedTools: [] })
  }

  function menuSnapshot(containerId: number, type: string): { content: Array<Record<string, unknown>>, structuredContent: Record<string, unknown> } {
    return { content: [], structuredContent: { containerId, type, carried: { index: -1, container: 'Cursor', empty: true }, slots: [] } }
  }

  // ROOT CAUSE:
  //
  // Live MC-4f pressed the enchanting button and got accepted:true while the
  // server consumed nothing: the mod called the client menu's clickMenuButton,
  // which only mutates the local copy, and the next sync reverted it. The mod
  // now sends the vanilla button-click packet, so the executor reports `sent`
  // plus whether a bounded re-read observed the change.
  it('sends a generic menu button and reports an observed menu change', async () => {
    let snapshots = 0
    clientMocks.callTool.mockImplementation(async ({ name }: { name: string }) => {
      if (name === 'get_status')
        return { content: [], structuredContent: { minecraftVersion: '1.21.1', worldId: 'world-1' } }
      if (name === 'get_self')
        return SELF
      if (name === 'get_inventory')
        return EMPTY_INVENTORY
      if (name === 'menu_snapshot') {
        snapshots += 1
        const base = menuSnapshot(30, 'minecraft:enchantment')
        if (snapshots > 1)
          base.structuredContent.slots = [{ index: 0, container: '', id: 'minecraft:iron_sword', count: 1, enchantments: { 'minecraft:sharpness': 1 } }]
        return base
      }
      if (name === 'menu_button')
        return { content: [], structuredContent: { sent: true, containerId: 30, type: 'minecraft:enchantment' } }
      return { content: [] }
    })

    const directory = await temporaryDirectory('airi-game-host-menu-button-')
    const context = createHostContext()
    await connect(context, directory)

    const result = await defineInvoke(context, gameHostExecuteCommand)({
      requestId: 'req-menu-button',
      action: 'menu_action',
      params: { action: 'button', id: 2 },
    })

    expect(result).toMatchObject({
      status: 'ok',
      checked: false,
      endReason: 'button_applied',
      postCondition: { kind: 'none' },
      menuAction: { containerId: 30, action: 'button', sent: true, applied: true },
    })
    expect(clientMocks.callTool).toHaveBeenCalledWith({ name: 'menu_button', arguments: { id: 2 } })
  })

  it('reports button_sent when no menu change is observed after the click', async () => {
    let snapshots = 0
    clientMocks.callTool.mockImplementation(async ({ name }: { name: string }) => {
      if (name === 'get_status')
        return { content: [], structuredContent: { minecraftVersion: '1.21.1', worldId: 'world-1' } }
      if (name === 'get_self')
        return SELF
      if (name === 'get_inventory')
        return EMPTY_INVENTORY
      if (name === 'menu_snapshot') {
        snapshots += 1
        if (snapshots > 1)
          return { content: [], structuredContent: { error: 'no_menu' } }
        return menuSnapshot(30, 'minecraft:beacon')
      }
      if (name === 'menu_button')
        return { content: [], structuredContent: { sent: true, containerId: 30, type: 'minecraft:beacon' } }
      return { content: [] }
    })

    const directory = await temporaryDirectory('airi-game-host-menu-button-idempotent-')
    const context = createHostContext()
    await connect(context, directory)

    const result = await defineInvoke(context, gameHostExecuteCommand)({
      requestId: 'req-menu-button-idempotent',
      action: 'menu_action',
      params: { action: 'button', id: 3 },
    })

    expect(result).toMatchObject({
      status: 'ok',
      endReason: 'button_sent',
      menuAction: { containerId: 30, action: 'button', sent: true, applied: false },
    })
  })

  it('sets beacon effects and reports applied when the effect appears', async () => {
    clientMocks.callTool.mockImplementation(async ({ name }: { name: string }) => {
      if (name === 'get_status')
        return { content: [], structuredContent: { minecraftVersion: '1.21.1', worldId: 'world-1' } }
      if (name === 'get_self')
        return SELF
      if (name === 'get_inventory')
        return EMPTY_INVENTORY
      if (name === 'menu_snapshot')
        return menuSnapshot(30, 'minecraft:beacon')
      if (name === 'menu_set_beacon_effects')
        return { content: [], structuredContent: { sent: true, containerId: 30, type: 'minecraft:beacon' } }
      if (name === 'get_status_effects')
        return { content: [], structuredContent: { effects: [{ id: 'minecraft:speed', amplifier: 0, durationTicks: 400 }] } }
      return { content: [] }
    })

    const directory = await temporaryDirectory('airi-game-host-menu-beacon-')
    const context = createHostContext()
    await connect(context, directory)

    const result = await defineInvoke(context, gameHostExecuteCommand)({
      requestId: 'req-menu-beacon',
      action: 'menu_action',
      params: { action: 'beacon', primary: 'minecraft:speed', secondary: 'minecraft:haste' },
    })

    expect(result).toMatchObject({
      status: 'ok',
      endReason: 'beacon_applied',
      menuAction: { containerId: 30, action: 'beacon', sent: true, applied: true },
    })
    expect(clientMocks.callTool).toHaveBeenCalledWith({ name: 'menu_set_beacon_effects', arguments: { primary: 'minecraft:speed', secondary: 'minecraft:haste' } })
  })

  // The effect poll window is four seconds, so this case runs longer than the
  // default Vitest timeout; the semantics stay "never observed -> beacon_sent".
  it('reports beacon_sent when the effect does not appear in the bounded read', async () => {
    clientMocks.callTool.mockImplementation(async ({ name }: { name: string }) => {
      if (name === 'get_status')
        return { content: [], structuredContent: { minecraftVersion: '1.21.1', worldId: 'world-1' } }
      if (name === 'get_self')
        return SELF
      if (name === 'get_inventory')
        return EMPTY_INVENTORY
      if (name === 'menu_snapshot')
        return menuSnapshot(30, 'minecraft:beacon')
      if (name === 'menu_set_beacon_effects')
        return { content: [], structuredContent: { sent: true, containerId: 30, type: 'minecraft:beacon' } }
      if (name === 'get_status_effects')
        return { content: [], structuredContent: { effects: [] } }
      return { content: [] }
    })

    const directory = await temporaryDirectory('airi-game-host-menu-beacon-sent-')
    const context = createHostContext()
    await connect(context, directory)

    const result = await defineInvoke(context, gameHostExecuteCommand)({
      requestId: 'req-menu-beacon-sent',
      action: 'menu_action',
      params: { action: 'beacon', primary: 'minecraft:speed' },
    })

    expect(result).toMatchObject({
      status: 'ok',
      endReason: 'beacon_sent',
      menuAction: { containerId: 30, action: 'beacon', sent: true, applied: false },
    })
  }, 20_000)

  it('rejects beacon with menu_not_beacon and never calls the primitive', async () => {
    clientMocks.callTool.mockImplementation(async ({ name }: { name: string }) => {
      if (name === 'get_status')
        return { content: [], structuredContent: { minecraftVersion: '1.21.1', worldId: 'world-1' } }
      if (name === 'get_self')
        return SELF
      if (name === 'get_inventory')
        return EMPTY_INVENTORY
      if (name === 'menu_snapshot')
        return menuSnapshot(33, 'minecraft:generic_9x3')
      return { content: [] }
    })

    const directory = await temporaryDirectory('airi-game-host-menu-notbeacon-')
    const context = createHostContext()
    await connect(context, directory)

    const result = await defineInvoke(context, gameHostExecuteCommand)({
      requestId: 'req-menu-notbeacon',
      action: 'menu_action',
      params: { action: 'beacon', primary: 'minecraft:speed' },
    })

    expect(result.status).toBe('failed')
    expect(result.endReason).toContain('menu_not_beacon')
    const calls = clientMocks.callTool.mock.calls.filter(([args]: [{ name: string }]) => args.name === 'menu_set_beacon_effects')
    expect(calls).toHaveLength(0)
  })

  it('rejects beacon without a primary effect and never calls the primitive', async () => {
    clientMocks.callTool.mockImplementation(async ({ name }: { name: string }) => {
      if (name === 'get_status')
        return { content: [], structuredContent: { minecraftVersion: '1.21.1', worldId: 'world-1' } }
      if (name === 'get_self')
        return SELF
      if (name === 'get_inventory')
        return EMPTY_INVENTORY
      if (name === 'menu_snapshot')
        return menuSnapshot(30, 'minecraft:beacon')
      return { content: [] }
    })

    const directory = await temporaryDirectory('airi-game-host-menu-beacon-noprimary-')
    const context = createHostContext()
    await connect(context, directory)

    const result = await defineInvoke(context, gameHostExecuteCommand)({
      requestId: 'req-menu-beacon-noprimary',
      action: 'menu_action',
      params: { action: 'beacon' },
    })

    expect(result.status).toBe('failed')
    expect(result.endReason).toContain('beacon requires primary')
    const calls = clientMocks.callTool.mock.calls.filter(([args]: [{ name: string }]) => args.name === 'menu_set_beacon_effects')
    expect(calls).toHaveLength(0)
  })

  it('selects a villager trade and returns the offer summary', async () => {
    clientMocks.callTool.mockImplementation(async ({ name }: { name: string }) => {
      if (name === 'get_status')
        return { content: [], structuredContent: { minecraftVersion: '1.21.1', worldId: 'world-1' } }
      if (name === 'get_self')
        return SELF
      if (name === 'get_inventory')
        return EMPTY_INVENTORY
      if (name === 'menu_snapshot')
        return menuSnapshot(31, 'minecraft:merchant')
      if (name === 'menu_select_trade') {
        return {
          content: [],
          structuredContent: {
            accepted: true,
            containerId: 31,
            type: 'minecraft:merchant',
            offer: { result: { id: 'minecraft:emerald', count: 1 }, inputs: [{ id: 'minecraft:wheat', count: 20 }], outOfStock: false },
          },
        }
      }
      return { content: [] }
    })

    const directory = await temporaryDirectory('airi-game-host-menu-trade-')
    const context = createHostContext()
    await connect(context, directory)

    const result = await defineInvoke(context, gameHostExecuteCommand)({
      requestId: 'req-menu-trade',
      action: 'menu_action',
      params: { action: 'select_trade', index: 0 },
    })

    expect(result).toMatchObject({
      status: 'ok',
      endReason: 'trade_selected',
      menuAction: {
        containerId: 31,
        action: 'select_trade',
        accepted: true,
        offer: { result: { id: 'minecraft:emerald', count: 1 }, inputs: [{ id: 'minecraft:wheat', count: 20 }], outOfStock: false },
      },
    })
    expect(clientMocks.callTool).toHaveBeenCalledWith({ name: 'menu_select_trade', arguments: { index: 0 } })
  })

  it('rejects select_trade with menu_not_trade and never calls the primitive', async () => {
    clientMocks.callTool.mockImplementation(async ({ name }: { name: string }) => {
      if (name === 'get_status')
        return { content: [], structuredContent: { minecraftVersion: '1.21.1', worldId: 'world-1' } }
      if (name === 'get_self')
        return SELF
      if (name === 'get_inventory')
        return EMPTY_INVENTORY
      if (name === 'menu_snapshot')
        return menuSnapshot(33, 'minecraft:generic_9x3')
      return { content: [] }
    })

    const directory = await temporaryDirectory('airi-game-host-menu-nottrade-')
    const context = createHostContext()
    await connect(context, directory)

    const result = await defineInvoke(context, gameHostExecuteCommand)({
      requestId: 'req-menu-nottrade',
      action: 'menu_action',
      params: { action: 'select_trade', index: 0 },
    })

    expect(result.status).toBe('failed')
    expect(result.endReason).toContain('menu_not_trade')
    const calls = clientMocks.callTool.mock.calls.filter(([args]: [{ name: string }]) => args.name === 'menu_select_trade')
    expect(calls).toHaveLength(0)
  })

  it('renames an item at an anvil and returns the applied name', async () => {
    clientMocks.callTool.mockImplementation(async ({ name }: { name: string }) => {
      if (name === 'get_status')
        return { content: [], structuredContent: { minecraftVersion: '1.21.1', worldId: 'world-1' } }
      if (name === 'get_self')
        return SELF
      if (name === 'get_inventory')
        return EMPTY_INVENTORY
      if (name === 'menu_snapshot')
        return menuSnapshot(32, 'minecraft:anvil')
      if (name === 'menu_set_name')
        return { content: [], structuredContent: { accepted: true, changed: true, name: 'My Sword', containerId: 32, type: 'minecraft:anvil' } }
      return { content: [] }
    })

    const directory = await temporaryDirectory('airi-game-host-menu-anvil-')
    const context = createHostContext()
    await connect(context, directory)

    const result = await defineInvoke(context, gameHostExecuteCommand)({
      requestId: 'req-menu-anvil',
      action: 'menu_action',
      params: { action: 'set_name', text: 'My Sword' },
    })

    expect(result).toMatchObject({
      status: 'ok',
      endReason: 'renamed',
      menuAction: { containerId: 32, action: 'set_name', accepted: true, name: 'My Sword' },
    })
    expect(clientMocks.callTool).toHaveBeenCalledWith({ name: 'menu_set_name', arguments: { text: 'My Sword' } })
  })

  it('rejects set_name with menu_not_anvil and never calls the primitive', async () => {
    clientMocks.callTool.mockImplementation(async ({ name }: { name: string }) => {
      if (name === 'get_status')
        return { content: [], structuredContent: { minecraftVersion: '1.21.1', worldId: 'world-1' } }
      if (name === 'get_self')
        return SELF
      if (name === 'get_inventory')
        return EMPTY_INVENTORY
      if (name === 'menu_snapshot')
        return menuSnapshot(34, 'minecraft:generic_9x3')
      return { content: [] }
    })

    const directory = await temporaryDirectory('airi-game-host-menu-notanvil-')
    const context = createHostContext()
    await connect(context, directory)

    const result = await defineInvoke(context, gameHostExecuteCommand)({
      requestId: 'req-menu-notanvil',
      action: 'menu_action',
      params: { action: 'set_name', text: 'x' },
    })

    expect(result.status).toBe('failed')
    expect(result.endReason).toContain('menu_not_anvil')
    const calls = clientMocks.callTool.mock.calls.filter(([args]: [{ name: string }]) => args.name === 'menu_set_name')
    expect(calls).toHaveLength(0)
  })

  it('reports no_menu when no container is open', async () => {
    clientMocks.callTool.mockImplementation(async ({ name }: { name: string }) => {
      if (name === 'get_status')
        return { content: [], structuredContent: { minecraftVersion: '1.21.1', worldId: 'world-1' } }
      if (name === 'get_self')
        return SELF
      if (name === 'get_inventory')
        return EMPTY_INVENTORY
      if (name === 'menu_snapshot')
        return { content: [], structuredContent: { error: 'no_menu' } }
      return { content: [] }
    })

    const directory = await temporaryDirectory('airi-game-host-menu-nomenu-')
    const context = createHostContext()
    await connect(context, directory)

    const result = await defineInvoke(context, gameHostExecuteCommand)({
      requestId: 'req-menu-nomenu',
      action: 'menu_action',
      params: { action: 'button', id: 1 },
    })

    expect(result.status).toBe('failed')
    expect(result.endReason).toContain('no_menu')
    const calls = clientMocks.callTool.mock.calls.filter(([args]: [{ name: string }]) => args.name === 'menu_button')
    expect(calls).toHaveLength(0)
  })

  it('reads a written book with bounded pages and a truncation flag, never checked', async () => {
    clientMocks.callTool.mockImplementation(async ({ name }: { name: string }) => {
      if (name === 'get_status')
        return { content: [], structuredContent: { minecraftVersion: '1.21.1', worldId: 'world-1' } }
      if (name === 'get_self')
        return SELF
      if (name === 'get_inventory')
        return EMPTY_INVENTORY
      if (name === 'read_item') {
        return {
          content: [],
          structuredContent: {
            itemId: 'minecraft:written_book',
            title: 'Diary',
            author: 'Steve',
            generation: 0,
            pages: ['first page', 'second page'],
            truncated: true,
          },
        }
      }
      return { content: [] }
    })

    const directory = await temporaryDirectory('airi-game-host-read-book-')
    const context = createHostContext()
    await connect(context, directory)

    const result = await defineInvoke(context, gameHostExecuteCommand)({
      requestId: 'req-read-book',
      action: 'read_item',
      params: {},
    })

    expect(result).toMatchObject({
      status: 'ok',
      checked: false,
      endReason: 'read',
      postCondition: { kind: 'none' },
      itemContent: { itemId: 'minecraft:written_book', title: 'Diary', author: 'Steve', pages: ['first page', 'second page'], truncated: true },
    })
    // Untrusted content must never satisfy a completion gate.
    expect(result.checked).toBe(false)
    expect(clientMocks.callTool).toHaveBeenCalledWith({ name: 'read_item', arguments: {} })
  })

  it('reads a written book from an explicit slot', async () => {
    clientMocks.callTool.mockImplementation(async ({ name }: { name: string }) => {
      if (name === 'get_status')
        return { content: [], structuredContent: { minecraftVersion: '1.21.1', worldId: 'world-1' } }
      if (name === 'get_self')
        return SELF
      if (name === 'get_inventory')
        return EMPTY_INVENTORY
      if (name === 'read_item')
        return { content: [], structuredContent: { itemId: 'minecraft:written_book', pages: [] } }
      return { content: [] }
    })

    const directory = await temporaryDirectory('airi-game-host-read-book-slot-')
    const context = createHostContext()
    await connect(context, directory)

    const result = await defineInvoke(context, gameHostExecuteCommand)({
      requestId: 'req-read-book-slot',
      action: 'read_item',
      params: { slot: 36 },
    })

    expect(result).toMatchObject({ status: 'ok', checked: false, itemContent: { itemId: 'minecraft:written_book' } })
    expect(clientMocks.callTool).toHaveBeenCalledWith({ name: 'read_item', arguments: { slot: 36 } })
  })

  it('returns unsupported_item for a non-book item', async () => {
    clientMocks.callTool.mockImplementation(async ({ name }: { name: string }) => {
      if (name === 'get_status')
        return { content: [], structuredContent: { minecraftVersion: '1.21.1', worldId: 'world-1' } }
      if (name === 'get_self')
        return SELF
      if (name === 'get_inventory')
        return EMPTY_INVENTORY
      if (name === 'read_item')
        return { content: [], structuredContent: { itemId: 'minecraft:stone', unsupported: true, error: 'unsupported_item' } }
      return { content: [] }
    })

    const directory = await temporaryDirectory('airi-game-host-read-unsupported-')
    const context = createHostContext()
    await connect(context, directory)

    const result = await defineInvoke(context, gameHostExecuteCommand)({
      requestId: 'req-read-unsupported',
      action: 'read_item',
      params: {},
    })

    expect(result).toMatchObject({ status: 'ok', checked: false, endReason: 'unsupported_item', itemContent: { itemId: 'minecraft:stone', unsupported: true } })
  })

  it('reads sign text and fails not_sign for a non-sign block', async () => {
    clientMocks.callTool.mockImplementation(async ({ name }: { name: string }) => {
      if (name === 'get_status')
        return { content: [], structuredContent: { minecraftVersion: '1.21.1', worldId: 'world-1' } }
      if (name === 'get_self')
        return SELF
      if (name === 'get_inventory')
        return EMPTY_INVENTORY
      if (name === 'read_sign')
        return { content: [], structuredContent: { lines: ['Hello', 'World', '', ''], back: ['Back line'], truncated: false } }
      return { content: [] }
    })

    const directory = await temporaryDirectory('airi-game-host-read-sign-')
    const context = createHostContext()
    await connect(context, directory)

    const result = await defineInvoke(context, gameHostExecuteCommand)({
      requestId: 'req-read-sign',
      action: 'read_sign',
      params: { x: 1, y: 64, z: 2 },
    })

    expect(result).toMatchObject({
      status: 'ok',
      checked: false,
      endReason: 'read',
      signContent: { lines: ['Hello', 'World', '', ''], back: ['Back line'] },
    })
    expect(clientMocks.callTool).toHaveBeenCalledWith({ name: 'read_sign', arguments: { x: 1, y: 64, z: 2 } })

    clientMocks.callTool.mockImplementation(async ({ name }: { name: string }) => {
      if (name === 'get_status')
        return { content: [], structuredContent: { minecraftVersion: '1.21.1', worldId: 'world-1' } }
      if (name === 'get_self')
        return SELF
      if (name === 'get_inventory')
        return EMPTY_INVENTORY
      if (name === 'read_sign')
        return { content: [], structuredContent: { error: 'not_sign' } }
      return { content: [] }
    })

    const failed = await defineInvoke(context, gameHostExecuteCommand)({
      requestId: 'req-read-sign-notsign',
      action: 'read_sign',
      params: { x: 1, y: 64, z: 2 },
    })
    expect(failed.status).toBe('failed')
    expect(failed.endReason).toContain('not_sign')
  })

  it('places one block verified by a fresh world read and an inventory decrease', async () => {
    let placed = false
    clientMocks.callTool.mockImplementation(async ({ name }: { name: string }) => {
      if (name === 'get_status')
        return { content: [], structuredContent: { minecraftVersion: '1.21.1', worldId: 'world-1' } }
      if (name === 'get_self')
        return SELF
      if (name === 'get_inventory')
        return { content: [], structuredContent: { selectedSlot: 0, hotbar: [{ slot: 0, id: 'minecraft:oak_planks', count: placed ? 1 : 2 }], main: [], armor: [], offhand: { empty: true } } }
      if (name === 'select_hotbar_slot')
        return { content: [], structuredContent: { ok: true } }
      if (name === 'get_block')
        return { content: [], structuredContent: { id: placed ? 'minecraft:oak_planks' : 'minecraft:air' } }
      if (name === 'place_block') {
        placed = true
        return { content: [], structuredContent: { result: 'SUCCESS' } }
      }
      return { content: [] }
    })

    const directory = await temporaryDirectory('airi-game-host-place-single-')
    const context = createHostContext()
    await connect(context, directory)

    const result = await defineInvoke(context, gameHostExecuteCommand)({
      requestId: 'req-place-single',
      action: 'place',
      params: { x: 1, y: 64, z: 0, itemId: 'minecraft:oak_planks' },
    })

    expect(result).toMatchObject({
      status: 'ok',
      checked: true,
      endReason: 'placed',
      postCondition: { kind: 'placed', target: 1, actual: 1, met: true },
      placed: { itemId: 'minecraft:oak_planks', requested: 1, placed: 1, blocks: [{ x: 1, y: 64, z: 0, ok: true }] },
    })
    expect(clientMocks.callTool).toHaveBeenCalledWith({ name: 'place_block', arguments: { x: 1, y: 63, z: 0, face: 'up', expectBlockId: 'minecraft:oak_planks' } })
  })

  // ROOT CAUSE:
  //
  // Live MC-4f placed a torch while the anvil menu was open: the client dropped
  // the use, the mod never confirmed it, and the receipt ended as a bare
  // not_confirmed. The same call succeeded as soon as the menu closed.
  //
  // We fixed this by rejecting the place up front with menu_open.
  it('fails with menu_open instead of silently not confirming a place while a menu is open', async () => {
    clientMocks.callTool.mockImplementation(async ({ name }: { name: string }) => {
      if (name === 'get_status')
        return { content: [], structuredContent: { minecraftVersion: '1.21.1', worldId: 'world-1' } }
      if (name === 'get_self')
        return SELF
      if (name === 'menu_snapshot')
        return { content: [], structuredContent: { containerId: 1, type: 'minecraft:anvil', slots: [] } }
      return { content: [] }
    })

    const directory = await temporaryDirectory('airi-game-host-place-menu-open-')
    const context = createHostContext()
    await connect(context, directory)

    const result = await defineInvoke(context, gameHostExecuteCommand)({
      requestId: 'req-place-menu-open',
      action: 'place',
      params: { x: 1, y: 64, z: 0, itemId: 'minecraft:oak_planks' },
    })

    expect(result.status).toBe('failed')
    expect(result.endReason).toContain('menu_open')
    expect(clientMocks.callTool.mock.calls.filter(([args]: [{ name: string }]) => args.name === 'place_block')).toHaveLength(0)
  })

  it('reports not_in_inventory when the block item is missing', async () => {
    clientMocks.callTool.mockImplementation(async ({ name }: { name: string }) => {
      if (name === 'get_status')
        return { content: [], structuredContent: { minecraftVersion: '1.21.1', worldId: 'world-1' } }
      if (name === 'get_self')
        return SELF
      if (name === 'get_inventory')
        return EMPTY_INVENTORY
      return { content: [] }
    })

    const directory = await temporaryDirectory('airi-game-host-place-nomat-')
    const context = createHostContext()
    await connect(context, directory)

    const result = await defineInvoke(context, gameHostExecuteCommand)({
      requestId: 'req-place-nomat',
      action: 'place',
      params: { x: 1, y: 64, z: 0, itemId: 'minecraft:oak_planks' },
    })

    expect(result.status).toBe('failed')
    expect(result.endReason).toContain('not_in_inventory')
    const places = clientMocks.callTool.mock.calls.filter(([args]: [{ name: string }]) => args.name === 'place_block')
    expect(places).toHaveLength(0)
  })

  it('reports blocked when the target spot is occupied and does not place', async () => {
    clientMocks.callTool.mockImplementation(async ({ name }: { name: string }) => {
      if (name === 'get_status')
        return { content: [], structuredContent: { minecraftVersion: '1.21.1', worldId: 'world-1' } }
      if (name === 'get_self')
        return SELF
      if (name === 'get_inventory')
        return { content: [], structuredContent: { selectedSlot: 0, hotbar: [{ slot: 0, id: 'minecraft:oak_planks', count: 2 }], main: [], armor: [], offhand: { empty: true } } }
      if (name === 'select_hotbar_slot')
        return { content: [], structuredContent: { ok: true } }
      if (name === 'get_block')
        return { content: [], structuredContent: { id: 'minecraft:stone' } }
      return { content: [] }
    })

    const directory = await temporaryDirectory('airi-game-host-place-blocked-')
    const context = createHostContext()
    await connect(context, directory)

    const result = await defineInvoke(context, gameHostExecuteCommand)({
      requestId: 'req-place-blocked',
      action: 'place',
      params: { x: 1, y: 64, z: 0, itemId: 'minecraft:oak_planks' },
    })

    expect(result.status).toBe('failed')
    expect(result.endReason).toContain('blocked')
    expect(result.placed).toMatchObject({ requested: 1, placed: 0, blocks: [{ ok: false, reason: 'blocked' }] })
    const places = clientMocks.callTool.mock.calls.filter(([args]: [{ name: string }]) => args.name === 'place_block')
    expect(places).toHaveLength(0)
  })

  it('places a batch with per-block results and stops at the first failure', async () => {
    const state = { placed: new Set<number>(), count: 3 }
    clientMocks.callTool.mockImplementation(async ({ name, arguments: args }: { name: string, arguments?: Record<string, unknown> }) => {
      if (name === 'get_status')
        return { content: [], structuredContent: { minecraftVersion: '1.21.1', worldId: 'world-1' } }
      if (name === 'get_self')
        return SELF
      if (name === 'get_inventory')
        return { content: [], structuredContent: { selectedSlot: 0, hotbar: [{ slot: 0, id: 'minecraft:cobblestone', count: state.count }], main: [], armor: [], offhand: { empty: true } } }
      if (name === 'select_hotbar_slot')
        return { content: [], structuredContent: { ok: true } }
      if (name === 'get_block') {
        const x = Number(args?.x)
        // (1,64,0) is free, (2,64,0) is occupied: the batch must stop there.
        if (x === 2)
          return { content: [], structuredContent: { id: 'minecraft:stone' } }
        return { content: [], structuredContent: { id: state.placed.has(x) ? 'minecraft:cobblestone' : 'minecraft:air' } }
      }
      if (name === 'place_block') {
        const x = Number(args?.x) + 1
        if (state.placed.has(x))
          return { content: [], structuredContent: { result: 'FAIL' } }
        state.placed.add(x)
        state.count -= 1
        return { content: [], structuredContent: { result: 'SUCCESS' } }
      }
      return { content: [] }
    })

    const directory = await temporaryDirectory('airi-game-host-place-batch-')
    const context = createHostContext()
    await connect(context, directory)

    const result = await defineInvoke(context, gameHostExecuteCommand)({
      requestId: 'req-place-batch',
      action: 'place',
      params: { x: 1, y: 64, z: 0, face: 'east', itemId: 'minecraft:cobblestone', count: 2 },
    })

    expect(result).toMatchObject({
      status: 'failed',
      checked: true,
      endReason: 'blocked',
      postCondition: { kind: 'placed', target: 2, actual: 1, met: false },
      placed: {
        itemId: 'minecraft:cobblestone',
        requested: 2,
        placed: 1,
        blocks: [
          { x: 1, y: 64, z: 0, ok: true },
          { x: 2, y: 64, z: 0, ok: false, reason: 'blocked' },
        ],
      },
    })
  })

  it('bounds placement attempts per block and reports not_confirmed', async () => {
    clientMocks.callTool.mockImplementation(async ({ name }: { name: string }) => {
      if (name === 'get_status')
        return { content: [], structuredContent: { minecraftVersion: '1.21.1', worldId: 'world-1' } }
      if (name === 'get_self')
        return SELF
      if (name === 'get_inventory')
        return { content: [], structuredContent: { selectedSlot: 0, hotbar: [{ slot: 0, id: 'minecraft:oak_planks', count: 2 }], main: [], armor: [], offhand: { empty: true } } }
      if (name === 'select_hotbar_slot')
        return { content: [], structuredContent: { ok: true } }
      if (name === 'get_block')
        return { content: [], structuredContent: { id: 'minecraft:air' } }
      if (name === 'place_block')
        return { content: [], structuredContent: { result: 'SUCCESS' } }
      return { content: [] }
    })

    const directory = await temporaryDirectory('airi-game-host-place-attempts-')
    const context = createHostContext()
    await connect(context, directory)

    const result = await defineInvoke(context, gameHostExecuteCommand)({
      requestId: 'req-place-attempts',
      action: 'place',
      params: { x: 1, y: 64, z: 0, itemId: 'minecraft:oak_planks', attempts: 2 },
    })

    expect(result.status).toBe('failed')
    expect(result.endReason).toContain('not_confirmed')
    expect(result.placed).toMatchObject({ requested: 1, placed: 0, blocks: [{ ok: false, reason: 'not_confirmed' }] })
    const places = clientMocks.callTool.mock.calls.filter(([args]: [{ name: string }]) => args.name === 'place_block')
    expect(places).toHaveLength(2)
  })

  it('passes sneak and yaw through to the place primitive', async () => {
    let placed = false
    clientMocks.callTool.mockImplementation(async ({ name }: { name: string }) => {
      if (name === 'get_status')
        return { content: [], structuredContent: { minecraftVersion: '1.21.1', worldId: 'world-1' } }
      if (name === 'get_self')
        return SELF
      if (name === 'get_inventory')
        return { content: [], structuredContent: { selectedSlot: 0, hotbar: [{ slot: 0, id: 'minecraft:oak_stairs', count: placed ? 0 : 1 }], main: [], armor: [], offhand: { empty: true } } }
      if (name === 'select_hotbar_slot')
        return { content: [], structuredContent: { ok: true } }
      if (name === 'get_block')
        return { content: [], structuredContent: { id: placed ? 'minecraft:oak_stairs' : 'minecraft:air' } }
      if (name === 'place_block') {
        placed = true
        return { content: [], structuredContent: { result: 'SUCCESS' } }
      }
      return { content: [] }
    })

    const directory = await temporaryDirectory('airi-game-host-place-sneak-')
    const context = createHostContext()
    await connect(context, directory)

    const result = await defineInvoke(context, gameHostExecuteCommand)({
      requestId: 'req-place-sneak',
      action: 'place',
      params: { x: 1, y: 64, z: 0, itemId: 'minecraft:oak_stairs', sneak: true, yaw: 90 },
    })

    expect(result.status).toBe('ok')
    expect(clientMocks.callTool).toHaveBeenCalledWith({
      name: 'place_block',
      arguments: { x: 1, y: 63, z: 0, face: 'up', sneak: true, yaw: 90, expectBlockId: 'minecraft:oak_stairs' },
    })
  })
})

describe('break and melee commands (mc-4g)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    appMock.getVersion.mockReturnValue('0.10.0')
    clientInstances.items.length = 0
    transportInstances.items.length = 0
    clientMocks.connect.mockResolvedValue(undefined)
    clientMocks.close.mockResolvedValue(undefined)
    clientMocks.callTool.mockResolvedValue({ content: [] })
  })

  const SELF: { content: Array<Record<string, unknown>>, structuredContent: Record<string, unknown> } = { content: [], structuredContent: { x: 0, y: 64, z: 0, health: 20, food: 20, selectedSlot: 0 } }
  const SWORD_INVENTORY: { content: Array<Record<string, unknown>>, structuredContent: Record<string, unknown> } = { content: [], structuredContent: { selectedSlot: 0, hotbar: [{ slot: 0, id: 'minecraft:iron_sword', count: 1 }], main: [], armor: [], offhand: { empty: true } } }

  async function connect(context: ReturnType<typeof createHostContext>, directory: string): Promise<void> {
    await setupGameHost(context, { persistencePath: join(directory, 'game-host.json') }, directory)
    await defineInvoke(context, gameHostApplyConfig)({ url: 'http://127.0.0.1:25600/mcp', allowedTools: [] })
  }

  it('breaks one block and confirms it with a bounded fresh read', async () => {
    let blockReads = 0
    clientMocks.callTool.mockImplementation(async ({ name }: { name: string }) => {
      if (name === 'get_status')
        return { content: [], structuredContent: { minecraftVersion: '1.21.1', worldId: 'world-1' } }
      if (name === 'get_self')
        return SELF
      if (name === 'get_block') {
        blockReads += 1
        return { content: [], structuredContent: { id: blockReads === 1 ? 'minecraft:stone' : 'minecraft:air' } }
      }
      if (name === 'break_block')
        return { content: [], structuredContent: { started: true, mode: 'survival' } }
      return { content: [] }
    })

    const directory = await temporaryDirectory('airi-game-host-break-single-')
    const context = createHostContext()
    await connect(context, directory)

    const result = await defineInvoke(context, gameHostExecuteCommand)({
      requestId: 'req-break-single',
      action: 'break',
      params: { x: 1, y: 64, z: 0 },
    })

    expect(result).toMatchObject({
      status: 'ok',
      checked: true,
      commandId: 'req-break-single',
      endReason: 'broken',
      postCondition: { kind: 'broken', target: 1, actual: 1, met: true },
      broken: { x: 1, y: 64, z: 0, blockId: 'minecraft:stone', mode: 'survival' },
    })
    expect(clientMocks.callTool).toHaveBeenCalledWith({ name: 'break_block', arguments: { x: 1, y: 64, z: 0, mode: 'survival' } })
  })

  it('fails already_air without issuing a break', async () => {
    clientMocks.callTool.mockImplementation(async ({ name }: { name: string }) => {
      if (name === 'get_status')
        return { content: [], structuredContent: { minecraftVersion: '1.21.1', worldId: 'world-1' } }
      if (name === 'get_self')
        return SELF
      if (name === 'get_block')
        return { content: [], structuredContent: { id: 'minecraft:air' } }
      return { content: [] }
    })

    const directory = await temporaryDirectory('airi-game-host-break-air-')
    const context = createHostContext()
    await connect(context, directory)

    const result = await defineInvoke(context, gameHostExecuteCommand)({
      requestId: 'req-break-air',
      action: 'break',
      params: { x: 1, y: 64, z: 0 },
    })

    expect(result).toMatchObject({
      status: 'failed',
      endReason: 'already_air',
      postCondition: { kind: 'broken', target: 1, actual: 0, met: false },
      broken: { blockId: 'minecraft:air' },
    })
    const breaks = clientMocks.callTool.mock.calls.filter(([args]: [{ name: string }]) => args.name === 'break_block')
    expect(breaks).toHaveLength(0)
  })

  it('fails out_of_reach without walking or breaking', async () => {
    clientMocks.callTool.mockImplementation(async ({ name }: { name: string }) => {
      if (name === 'get_status')
        return { content: [], structuredContent: { minecraftVersion: '1.21.1', worldId: 'world-1' } }
      if (name === 'get_self')
        return { content: [], structuredContent: { x: 20, y: 64, z: 20, health: 20, food: 20 } }
      if (name === 'get_block')
        return { content: [], structuredContent: { id: 'minecraft:stone' } }
      return { content: [] }
    })

    const directory = await temporaryDirectory('airi-game-host-break-far-')
    const context = createHostContext()
    await connect(context, directory)

    const result = await defineInvoke(context, gameHostExecuteCommand)({
      requestId: 'req-break-far',
      action: 'break',
      params: { x: 1, y: 64, z: 0, mode: 'instant' },
    })

    expect(result).toMatchObject({
      status: 'failed',
      endReason: 'out_of_reach',
      postCondition: { kind: 'broken', target: 1, actual: 0, met: false },
      broken: { x: 1, y: 64, z: 0, blockId: 'minecraft:stone', mode: 'instant' },
    })
    const breaks = clientMocks.callTool.mock.calls.filter(([args]: [{ name: string }]) => args.name === 'break_block')
    expect(breaks).toHaveLength(0)
  })

  it('attacks with the best inventory sword and reports a kill when the target disappears', async () => {
    let entityQueries = 0
    clientMocks.callTool.mockImplementation(async ({ name }: { name: string }) => {
      if (name === 'get_status')
        return { content: [], structuredContent: { minecraftVersion: '1.21.1', worldId: 'world-1' } }
      if (name === 'get_self')
        return SELF
      if (name === 'get_inventory')
        return SWORD_INVENTORY
      if (name === 'select_hotbar_slot')
        return { content: [], structuredContent: { ok: true } }
      if (name === 'query_entities') {
        entityQueries += 1
        return {
          content: [],
          structuredContent: entityQueries <= 2
            ? { entities: [{ name: 'Zombie', uuid: 'target-uuid', type: 'minecraft:zombie', x: 2, y: 64, z: 0, health: 20 }] }
            : { entities: [] },
        }
      }
      if (name === 'look' || name === 'attack_entity')
        return { content: [], structuredContent: { ok: true } }
      return { content: [] }
    })

    const directory = await temporaryDirectory('airi-game-host-attack-kill-')
    const context = createHostContext()
    await connect(context, directory)

    const result = await defineInvoke(context, gameHostExecuteCommand)({
      requestId: 'req-attack-kill',
      action: 'attack',
      params: { target: 'Zombie' },
    })

    expect(result).toMatchObject({
      status: 'ok',
      checked: true,
      endReason: 'killed',
      postCondition: { kind: 'hit', target: 1, actual: 1, met: true },
      attacked: {
        targetUuid: 'target-uuid',
        swings: 1,
        weapon: 'minecraft:iron_sword',
        hitEvidence: 'entity_death',
        killed: true,
        endReason: 'killed',
      },
    })
    expect(clientMocks.callTool).toHaveBeenCalledWith({ name: 'select_hotbar_slot', arguments: { slot: 0 } })
    expect(clientMocks.callTool).toHaveBeenCalledWith({ name: 'attack_entity', arguments: { uuid: 'target-uuid' } })
  })

  it('reports a hit only when a fresh read observed a health drop', async () => {
    let entityQueries = 0
    clientMocks.callTool.mockImplementation(async ({ name }: { name: string }) => {
      if (name === 'get_status')
        return { content: [], structuredContent: { minecraftVersion: '1.21.1', worldId: 'world-1' } }
      if (name === 'get_self')
        return SELF
      if (name === 'get_inventory')
        return SWORD_INVENTORY
      if (name === 'select_hotbar_slot')
        return { content: [], structuredContent: { ok: true } }
      if (name === 'query_entities') {
        entityQueries += 1
        const health = entityQueries >= 3 ? 15 : 20
        return { content: [], structuredContent: { entities: [{ name: 'Zombie', uuid: 'target-uuid', type: 'minecraft:zombie', x: 2, y: 64, z: 0, health }] } }
      }
      if (name === 'look' || name === 'attack_entity')
        return { content: [], structuredContent: { ok: true } }
      return { content: [] }
    })

    const directory = await temporaryDirectory('airi-game-host-attack-hit-')
    const context = createHostContext()
    await connect(context, directory)

    const result = await defineInvoke(context, gameHostExecuteCommand)({
      requestId: 'req-attack-hit',
      action: 'attack',
      params: { target: 'Zombie' },
    })

    expect(result).toMatchObject({
      status: 'ok',
      endReason: 'hit',
      postCondition: { kind: 'hit', target: 1, actual: 1, met: true },
      attacked: {
        targetUuid: 'target-uuid',
        swings: 1,
        weapon: 'minecraft:iron_sword',
        damageDealt: 5,
        healthBefore: 20,
        healthAfter: 15,
        hitEvidence: 'health_delta',
        endReason: 'hit',
      },
    })
    const attacks = clientMocks.callTool.mock.calls.filter(([args]: [{ name: string }]) => args.name === 'attack_entity')
    expect(attacks).toHaveLength(1)
  })

  // ROOT CAUSE:
  //
  // Live MC-4g: the killing blow's own read still showed health 0 (an observed
  // hit); the next iteration found the target gone and overwrote the outcome
  // with target_lost, so a completed kill reported met: false. A disappearance
  // after observed damage is now the kill evidence instead.
  it('reports a kill when the target disappears after observed damage', async () => {
    let entityQueries = 0
    clientMocks.callTool.mockImplementation(async ({ name }: { name: string }) => {
      if (name === 'get_status')
        return { content: [], structuredContent: { minecraftVersion: '1.21.1', worldId: 'world-1' } }
      if (name === 'get_self')
        return SELF
      if (name === 'get_inventory')
        return SWORD_INVENTORY
      if (name === 'select_hotbar_slot')
        return { content: [], structuredContent: { ok: true } }
      if (name === 'query_entities') {
        entityQueries += 1
        // 1: resolve, 2: pre-swing read, 3: post-swing read shows 0 health,
        // 4+: the target is gone.
        if (entityQueries <= 3) {
          const health = entityQueries === 3 ? 0 : 20
          return { content: [], structuredContent: { entities: [{ name: 'Zombie', uuid: 'target-uuid', type: 'minecraft:zombie', x: 2, y: 64, z: 0, health }] } }
        }
        return { content: [], structuredContent: { entities: [] } }
      }
      if (name === 'look' || name === 'attack_entity')
        return { content: [], structuredContent: { ok: true } }
      return { content: [] }
    })

    const directory = await temporaryDirectory('airi-game-host-attack-vanish-')
    const context = createHostContext()
    await connect(context, directory)

    const result = await defineInvoke(context, gameHostExecuteCommand)({
      requestId: 'req-attack-vanish',
      action: 'attack',
      params: { target: 'Zombie', maxSwings: 2 },
    })

    expect(result).toMatchObject({
      status: 'ok',
      endReason: 'killed',
      postCondition: { kind: 'hit', target: 1, actual: 1, met: true },
      attacked: { targetUuid: 'target-uuid', hitEvidence: 'entity_death', killed: true, endReason: 'killed' },
    })
  })

  it('fails out_of_reach for a target beyond the approach range without swinging', async () => {
    clientMocks.callTool.mockImplementation(async ({ name }: { name: string }) => {
      if (name === 'get_status')
        return { content: [], structuredContent: { minecraftVersion: '1.21.1', worldId: 'world-1' } }
      if (name === 'get_self')
        return SELF
      if (name === 'get_inventory')
        return SWORD_INVENTORY
      if (name === 'select_hotbar_slot')
        return { content: [], structuredContent: { ok: true } }
      if (name === 'query_entities')
        return { content: [], structuredContent: { entities: [{ name: 'Zombie', uuid: 'target-uuid', type: 'minecraft:zombie', x: 20, y: 64, z: 0, health: 20 }] } }
      return { content: [] }
    })

    const directory = await temporaryDirectory('airi-game-host-attack-far-')
    const context = createHostContext()
    await connect(context, directory)

    const result = await defineInvoke(context, gameHostExecuteCommand)({
      requestId: 'req-attack-far',
      action: 'attack',
      params: { target: 'Zombie' },
    })

    expect(result).toMatchObject({
      status: 'failed',
      endReason: 'out_of_reach',
      postCondition: { kind: 'hit', target: 1, actual: 0, met: false },
      attacked: { targetUuid: 'target-uuid', swings: 0, endReason: 'out_of_reach' },
    })
    const attacks = clientMocks.callTool.mock.calls.filter(([args]: [{ name: string }]) => args.name === 'attack_entity')
    expect(attacks).toHaveLength(0)
  })

  it('fails target_lost before selecting a weapon or swinging', async () => {
    clientMocks.callTool.mockImplementation(async ({ name }: { name: string }) => {
      if (name === 'get_status')
        return { content: [], structuredContent: { minecraftVersion: '1.21.1', worldId: 'world-1' } }
      if (name === 'get_self')
        return SELF
      if (name === 'get_inventory')
        return SWORD_INVENTORY
      if (name === 'query_entities')
        return { content: [], structuredContent: { entities: [] } }
      return { content: [] }
    })

    const directory = await temporaryDirectory('airi-game-host-attack-lost-')
    const context = createHostContext()
    await connect(context, directory)

    const result = await defineInvoke(context, gameHostExecuteCommand)({
      requestId: 'req-attack-lost',
      action: 'attack',
      params: { target: 'Nobody' },
    })

    expect(result).toMatchObject({
      status: 'failed',
      endReason: 'target_lost',
      postCondition: { kind: 'hit', target: 1, actual: 0, met: false },
      attacked: { targetUuid: '', swings: 0, endReason: 'target_lost' },
    })
    const attacks = clientMocks.callTool.mock.calls.filter(([args]: [{ name: string }]) => args.name === 'attack_entity')
    expect(attacks).toHaveLength(0)
  })
})
