import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const appMock = vi.hoisted(() => ({
  getPath: vi.fn(),
  getVersion: vi.fn(),
}))

const shellMock = vi.hoisted(() => ({
  showItemInFolder: vi.fn(),
}))

const clientMocks = vi.hoisted(() => ({
  close: vi.fn(),
  connect: vi.fn(),
  listTools: vi.fn(),
  callTool: vi.fn(),
}))

const clientInstances = vi.hoisted(() => ({
  items: [] as Array<{
    onclose?: () => void
    onerror?: (error: Error) => void
  }>,
}))

const transportInstances = vi.hoisted(() => ({
  items: [] as Array<{
    onclose?: () => void
    onerror?: (error: Error) => void
  }>,
}))

const httpTransportInstances = vi.hoisted(() => ({
  items: [] as Array<{ url: string, requestInit?: { headers?: Record<string, string> } }>,
}))

vi.mock('electron', () => ({
  app: appMock,
  shell: shellMock,
}))

vi.mock('@guiiai/logg', () => ({
  useLogg: vi.fn(() => ({
    useGlobalConfig: () => ({
      debug: vi.fn(),
      warn: vi.fn(),
      withError: vi.fn(() => ({ warn: vi.fn() })),
      withFields: vi.fn(() => ({ debug: vi.fn(), warn: vi.fn() })),
    }),
  })),
}))

vi.mock('../../../libs/bootkit/lifecycle', () => ({
  onAppBeforeQuit: vi.fn(),
}))

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    onclose?: () => void
    onerror?: (error: Error) => void
    close = clientMocks.close
    connect = clientMocks.connect
    listTools = clientMocks.listTools
    callTool = clientMocks.callTool

    constructor() {
      clientInstances.items.push(this)
    }
  },
}))

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', async () => {
  const { PassThrough } = await import('node:stream')

  return {
    StdioClientTransport: class {
      onclose?: () => void
      onerror?: (error: Error) => void
      stderr = new PassThrough()

      constructor(readonly server: unknown) {
        transportInstances.items.push(this)
      }

      close = vi.fn(async () => undefined)
    },
  }
})

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: class {
    onclose?: () => void
    onerror?: (error: Error) => void

    constructor(url: URL, opts?: { requestInit?: { headers?: Record<string, string> } }) {
      httpTransportInstances.items.push({ url: url.toString(), requestInit: opts?.requestInit })
    }

    // The stderr pipe belongs to spawned child processes only; reading it on
    // an HTTP transport would be a bug that this test must surface.
    get stderr() {
      throw new Error('stderr must not be accessed for streamable-http transports')
    }

    close = vi.fn(async () => undefined)
  },
}))

describe('createMcpStdioManager', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    appMock.getPath.mockReturnValue('/tmp/airi-user-data')
    appMock.getVersion.mockReturnValue('0.10.0')
    clientMocks.close.mockResolvedValue(undefined)
    clientMocks.connect.mockResolvedValue(undefined)
    clientMocks.listTools.mockResolvedValue({ tools: [] })
    clientMocks.callTool.mockResolvedValue({ content: [] })
    clientInstances.items.length = 0
    transportInstances.items.length = 0
    httpTransportInstances.items.length = 0
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('includes stderr captured during connect failures in MCP server test results', async () => {
    const { createMcpStdioManager } = await import('./index')
    const manager = createMcpStdioManager()

    clientMocks.connect.mockImplementationOnce(async (transport: { stderr: NodeJS.WritableStream }) => {
      transport.stderr.write('Missing required environment variable: API_KEY\n')
      throw new Error('connect failed')
    })

    const result = await manager.testServer({
      name: 'broken-server',
      config: {
        kind: 'stdio',
        command: 'broken-mcp-server',
      },
    })

    expect(result.ok).toBe(false)
    expect(result.error).toContain('connect failed')
    expect(result.error).toContain('Missing required environment variable: API_KEY')
  })

  it('constructs a streamable-http transport for kind streamable-http and never touches stderr', async () => {
    const { createMcpStdioManager } = await import('./index')
    const manager = createMcpStdioManager()
    const userDataPath = await mkdtemp(join(tmpdir(), 'airi-mcp-http-'))
    appMock.getPath.mockReturnValue(userDataPath)

    try {
      await manager.writeConfigText(JSON.stringify({
        mcpServers: {
          remote: {
            kind: 'streamable-http',
            url: 'http://127.0.0.1:25600/mcp',
            headers: { Authorization: 'Bearer secret' },
          },
        },
      }))

      await manager.applyAndRestart()

      expect(httpTransportInstances.items).toHaveLength(1)
      expect(httpTransportInstances.items[0]?.url).toBe('http://127.0.0.1:25600/mcp')
      expect(httpTransportInstances.items[0]?.requestInit?.headers).toEqual({ Authorization: 'Bearer secret' })
      // No stdio transport exists and the http stderr getter (which throws)
      // is never read, so the stdio-only stderr wiring stays untouched.
      expect(transportInstances.items).toHaveLength(0)
      expect(manager.getRuntimeStatus().servers[0].state).toBe('running')
      expect(manager.getRuntimeStatus().servers[0].pid).toBeNull()
      expect(manager.getRuntimeStatus().servers[0].command).toBe('')
    }
    finally {
      await manager.stopAll()
      await rm(userDataPath, { recursive: true, force: true })
    }
  })

  it('tests a streamable-http server through the http transport', async () => {
    const { createMcpStdioManager } = await import('./index')
    const manager = createMcpStdioManager()

    clientMocks.listTools.mockResolvedValue({ tools: [{ name: 'http-tool', inputSchema: {} }] })

    const result = await manager.testServer({
      name: 'remote',
      config: {
        kind: 'streamable-http',
        url: 'http://127.0.0.1:25600/mcp',
      },
    })

    expect(result.ok).toBe(true)
    expect(result.tools).toEqual(['http-tool'])
    expect(httpTransportInstances.items).toHaveLength(1)
    expect(transportInstances.items).toHaveLength(0)
  })

  it('passes independent timeout budgets to each configured server request', async () => {
    const { createMcpStdioManager } = await import('./index')
    const manager = createMcpStdioManager()
    const userDataPath = await mkdtemp(join(tmpdir(), 'airi-mcp-timeouts-'))
    appMock.getPath.mockReturnValue(userDataPath)

    try {
      await manager.writeConfigText(JSON.stringify({
        mcpServers: {
          fast: {
            command: 'fast-mcp',
            requestTimeoutMs: 100,
            maxTotalTimeoutMs: 500,
          },
          slow: {
            command: 'slow-mcp',
            requestTimeoutMs: 2_000,
            maxTotalTimeoutMs: 5_000,
          },
        },
      }))

      await manager.applyAndRestart()
      await manager.listTools()
      await manager.callTool({ requestId: 'call-1', name: 'fast::tool' })

      expect(clientMocks.connect).toHaveBeenNthCalledWith(
        1,
        expect.anything(),
        expect.objectContaining({
          timeout: 100,
          maxTotalTimeout: 500,
          resetTimeoutOnProgress: true,
          onprogress: expect.any(Function),
        }),
      )
      expect(clientMocks.connect).toHaveBeenNthCalledWith(
        2,
        expect.anything(),
        expect.objectContaining({
          timeout: 2_000,
          maxTotalTimeout: 5_000,
        }),
      )

      const listOptions = clientMocks.listTools.mock.calls.map(call => call[1])
      expect(listOptions).toEqual(expect.arrayContaining([
        expect.objectContaining({ timeout: 100, maxTotalTimeout: 500 }),
        expect.objectContaining({ timeout: 2_000, maxTotalTimeout: 5_000 }),
      ]))

      expect(clientMocks.callTool).toHaveBeenCalledWith(
        { name: 'tool', arguments: {} },
        undefined,
        expect.objectContaining({ timeout: 100, maxTotalTimeout: 500 }),
      )
    }
    finally {
      await manager.stopAll()
      await rm(userDataPath, { recursive: true, force: true })
    }
  })

  it('enforces the configured total timeout when the server sends no response', async () => {
    const { createMcpStdioManager } = await import('./index')
    const manager = createMcpStdioManager()
    const connect = clientMocks.connect
    vi.useFakeTimers()
    connect.mockImplementationOnce(async (_transport: unknown, options: { signal?: AbortSignal }) => {
      await new Promise<never>((_, reject) => {
        options.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true })
      })
    })

    const resultPromise = manager.testServer({
      name: 'slow-server',
      config: {
        kind: 'stdio',
        command: 'slow-mcp',
        requestTimeoutMs: 5_000,
        maxTotalTimeoutMs: 50,
      },
    })

    await vi.advanceTimersByTimeAsync(50)
    const result = await resultPromise

    expect(result.ok).toBe(false)
    expect(result.error).toContain('maxTotalTimeoutMs (50ms)')
  })

  it('cancels one in-flight call by correlation id and stays idempotent', async () => {
    const { createMcpStdioManager } = await import('./index')
    const manager = createMcpStdioManager()
    const userDataPath = await mkdtemp(join(tmpdir(), 'airi-mcp-cancel-'))
    appMock.getPath.mockReturnValue(userDataPath)

    try {
      await manager.writeConfigText(JSON.stringify({
        mcpServers: {
          server: { command: 'mcp-server' },
        },
      }))
      await manager.applyAndRestart()

      let observedSignal: AbortSignal | undefined
      clientMocks.callTool.mockImplementation((_name: unknown, _schema: unknown, options: { signal?: AbortSignal }) => {
        observedSignal = options.signal
        return new Promise((_resolve, reject) => {
          options.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true })
        })
      })

      const pending = manager.callTool({ requestId: 'cancel-me', name: 'server::slow-tool' })
      expect(manager.cancelTool('cancel-me')).toEqual({ cancelled: true })
      await expect(pending).rejects.toThrow('was cancelled')
      expect(observedSignal?.aborted).toBe(true)

      // Repeated cancels and unknown ids never throw.
      expect(manager.cancelTool('cancel-me')).toEqual({ cancelled: false })
      expect(manager.cancelTool('never-started')).toEqual({ cancelled: false })
    }
    finally {
      await manager.stopAll()
      await rm(userDataPath, { recursive: true, force: true })
    }
  })

  it('removes a session after an unexpected close and does not leave RUNNING status', async () => {
    const { createMcpStdioManager } = await import('./index')
    const manager = createMcpStdioManager()
    const userDataPath = await mkdtemp(join(tmpdir(), 'airi-mcp-close-'))
    appMock.getPath.mockReturnValue(userDataPath)

    try {
      await manager.writeConfigText(JSON.stringify({
        mcpServers: {
          server: { command: 'mcp-server' },
        },
      }))
      await manager.applyAndRestart()

      transportInstances.items[0].onclose?.()

      const status = manager.getRuntimeStatus().servers[0]
      expect(status.state).toBe('reconnecting')
      expect(status.state).not.toBe('running')
      expect(status.lastError).toBe('MCP transport closed')
      await expect(manager.listTools()).resolves.toEqual([])
    }
    finally {
      await manager.stopAll()
      await rm(userDataPath, { recursive: true, force: true })
    }
  })

  it('deduplicates close and error events for one generation', async () => {
    const { createMcpStdioManager } = await import('./index')
    const manager = createMcpStdioManager()
    const userDataPath = await mkdtemp(join(tmpdir(), 'airi-mcp-events-'))
    appMock.getPath.mockReturnValue(userDataPath)
    vi.useFakeTimers()

    try {
      await manager.writeConfigText(JSON.stringify({
        mcpServers: {
          server: { command: 'mcp-server' },
        },
      }))
      await manager.applyAndRestart()

      transportInstances.items[0].onclose?.()
      transportInstances.items[0].onerror?.(new Error('late transport error'))
      clientInstances.items[0].onclose?.()
      clientInstances.items[0].onerror?.(new Error('late client error'))

      await vi.advanceTimersByTimeAsync(1_000)

      expect(clientMocks.connect).toHaveBeenCalledTimes(2)
    }
    finally {
      await manager.stopAll()
      await rm(userDataPath, { recursive: true, force: true })
    }
  })

  it('ignores a late close from an old generation after reconnection', async () => {
    const { createMcpStdioManager } = await import('./index')
    const manager = createMcpStdioManager()
    const userDataPath = await mkdtemp(join(tmpdir(), 'airi-mcp-generation-'))
    appMock.getPath.mockReturnValue(userDataPath)
    vi.useFakeTimers()

    try {
      await manager.writeConfigText(JSON.stringify({
        mcpServers: {
          server: { command: 'mcp-server' },
        },
      }))
      await manager.applyAndRestart()
      const oldClose = transportInstances.items[0].onclose

      oldClose?.()
      await vi.advanceTimersByTimeAsync(1_000)
      expect(manager.getRuntimeStatus().servers[0].state).toBe('running')

      oldClose?.()

      expect(manager.getRuntimeStatus().servers[0].state).toBe('running')
      expect(clientMocks.connect).toHaveBeenCalledTimes(2)
    }
    finally {
      await manager.stopAll()
      await rm(userDataPath, { recursive: true, force: true })
    }
  })

  it('does not reconnect after a manual stop', async () => {
    const { createMcpStdioManager } = await import('./index')
    const manager = createMcpStdioManager()
    const userDataPath = await mkdtemp(join(tmpdir(), 'airi-mcp-stop-'))
    appMock.getPath.mockReturnValue(userDataPath)
    vi.useFakeTimers()

    try {
      await manager.writeConfigText(JSON.stringify({
        mcpServers: {
          server: { command: 'mcp-server' },
        },
      }))
      await manager.applyAndRestart()
      await manager.stopAll()
      transportInstances.items[0].onclose?.()
      await vi.advanceTimersByTimeAsync(10_000)

      expect(clientMocks.connect).toHaveBeenCalledTimes(1)
      expect(manager.getRuntimeStatus().servers[0].state).toBe('stopped')
    }
    finally {
      await manager.stopAll()
      await rm(userDataPath, { recursive: true, force: true })
    }
  })

  it('does not replay a side-effecting call when connection state is unknown', async () => {
    const { createMcpStdioManager } = await import('./index')
    const manager = createMcpStdioManager()
    const userDataPath = await mkdtemp(join(tmpdir(), 'airi-mcp-call-'))
    appMock.getPath.mockReturnValue(userDataPath)
    vi.useFakeTimers()
    clientMocks.callTool.mockRejectedValue(new Error('Not connected'))

    try {
      await manager.writeConfigText(JSON.stringify({
        mcpServers: {
          server: { command: 'mcp-server' },
        },
      }))
      await manager.applyAndRestart()

      await expect(manager.callTool({ requestId: 'call-2', name: 'server::side-effect::tool' })).rejects.toThrow('original tool result is unknown')

      expect(clientMocks.callTool).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(clientMocks.connect).toHaveBeenCalledTimes(2)
    }
    finally {
      await manager.stopAll()
      await rm(userDataPath, { recursive: true, force: true })
    }
  })

  it('retries transport failures with bounded exponential backoff and enters error after exhaustion', async () => {
    const { createMcpStdioManager } = await import('./index')
    const manager = createMcpStdioManager()
    const userDataPath = await mkdtemp(join(tmpdir(), 'airi-mcp-retry-'))
    appMock.getPath.mockReturnValue(userDataPath)
    vi.useFakeTimers()
    let connectCalls = 0
    clientMocks.connect.mockImplementation(async (transport: { onerror?: (error: Error) => void }) => {
      connectCalls++
      if (connectCalls === 1) {
        return undefined
      }

      const error = new Error(`reconnect-${connectCalls}`)
      transport.onerror?.(error)
      throw error
    })

    try {
      await manager.writeConfigText(JSON.stringify({
        mcpServers: {
          server: { command: 'mcp-server' },
        },
      }))
      await manager.applyAndRestart()
      transportInstances.items[0].onclose?.()

      await vi.advanceTimersByTimeAsync(31_000)

      expect(connectCalls).toBe(6)
      expect(manager.getRuntimeStatus().servers[0].state).toBe('error')
      expect(manager.getRuntimeStatus().servers[0].lastError).toBe('reconnect-6')
    }
    finally {
      await manager.stopAll()
      await rm(userDataPath, { recursive: true, force: true })
    }
  })

  // A spawn failure (ENOENT on the restarted command) reaches startServer as
  // a plain connect rejection: no transport callback fires, so nothing may
  // re-enter handleConnectionLoss. The bounded chain must still advance into
  // `error` instead of leaving the server stuck at `reconnecting` forever.
  it('keeps the retry chain alive when a reconnect start fails without a transport event', async () => {
    const { createMcpStdioManager } = await import('./index')
    const manager = createMcpStdioManager()
    const userDataPath = await mkdtemp(join(tmpdir(), 'airi-mcp-respawn-'))
    appMock.getPath.mockReturnValue(userDataPath)
    vi.useFakeTimers()
    let connectCalls = 0
    clientMocks.connect.mockImplementation(async () => {
      connectCalls++
      if (connectCalls > 1)
        throw new Error('spawn ENOENT')
      return undefined
    })

    try {
      await manager.writeConfigText(JSON.stringify({
        mcpServers: {
          server: { command: 'mcp-server' },
        },
      }))
      await manager.applyAndRestart()
      transportInstances.items[0].onclose?.()

      await vi.advanceTimersByTimeAsync(120_000)

      expect(connectCalls).toBe(6)
      expect(manager.getRuntimeStatus().servers[0].state).toBe('error')
    }
    finally {
      await manager.stopAll()
      await rm(userDataPath, { recursive: true, force: true })
    }
  })

  it('does not schedule reconnect for a request timeout', async () => {
    const { createMcpStdioManager } = await import('./index')
    const manager = createMcpStdioManager()
    const userDataPath = await mkdtemp(join(tmpdir(), 'airi-mcp-request-timeout-'))
    appMock.getPath.mockReturnValue(userDataPath)
    vi.useFakeTimers()
    clientMocks.connect.mockImplementationOnce(async (_transport: unknown, options: { signal?: AbortSignal }) => {
      await new Promise<never>((_, reject) => {
        options.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true })
      })
    })

    try {
      await manager.writeConfigText(JSON.stringify({
        mcpServers: {
          server: {
            command: 'mcp-server',
            requestTimeoutMs: 5_000,
            maxTotalTimeoutMs: 50,
          },
        },
      }))

      const applyPromise = manager.applyAndRestart()
      await vi.waitFor(() => expect(clientMocks.connect).toHaveBeenCalledTimes(1))
      await vi.advanceTimersByTimeAsync(50)
      const result = await applyPromise
      await vi.advanceTimersByTimeAsync(31_000)

      expect(result.failed).toHaveLength(1)
      expect(clientMocks.connect).toHaveBeenCalledTimes(1)
      expect(manager.getRuntimeStatus().servers[0].state).toBe('error')
    }
    finally {
      await manager.stopAll()
      await rm(userDataPath, { recursive: true, force: true })
    }
  })

  it('refreshes the tool directory after reconnection', async () => {
    const { createMcpStdioManager } = await import('./index')
    const manager = createMcpStdioManager()
    const userDataPath = await mkdtemp(join(tmpdir(), 'airi-mcp-tools-'))
    appMock.getPath.mockReturnValue(userDataPath)
    vi.useFakeTimers()
    clientMocks.listTools.mockResolvedValue({ tools: [{ name: 'recovered-tool', inputSchema: {} }] })

    try {
      await manager.writeConfigText(JSON.stringify({
        mcpServers: {
          server: { command: 'mcp-server' },
        },
      }))
      await manager.applyAndRestart()
      transportInstances.items[0].onclose?.()

      await vi.advanceTimersByTimeAsync(1_000)

      expect(clientMocks.listTools).toHaveBeenCalledTimes(1)
      await expect(manager.listTools()).resolves.toEqual([expect.objectContaining({
        name: 'server::recovered-tool',
      })])
    }
    finally {
      await manager.stopAll()
      await rm(userDataPath, { recursive: true, force: true })
    }
  })
})
