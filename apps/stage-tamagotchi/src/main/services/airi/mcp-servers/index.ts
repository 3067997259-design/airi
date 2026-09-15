import type { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js'
import type { createContext } from '@moeru/eventa/adapters/electron/main'

import type {
  ElectronMcpCallToolPayload,
  ElectronMcpCallToolResult,
  ElectronMcpConfigFile,
  ElectronMcpServerCommon,
  ElectronMcpServerConfig,
  ElectronMcpStdioApplyResult,
  ElectronMcpStdioConfigText,
  ElectronMcpStdioRuntimeStatus,
  ElectronMcpStdioServerRuntimeStatus,
  ElectronMcpStdioTestPayload,
  ElectronMcpStdioTestResult,
  ElectronMcpToolDescriptor,
} from '../../../../shared/eventa'

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { useLogg } from '@guiiai/logg'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { defineInvokeHandler } from '@moeru/eventa'
import { errorMessageFrom } from '@moeru/std'
import { app, shell } from 'electron'

import {
  electronMcpApplyAndRestart,
  electronMcpCallTool,
  electronMcpCancelTool,
  electronMcpGetRuntimeStatus,
  electronMcpListTools,
  electronMcpOpenConfigFile,
  electronMcpReadConfigText,
  electronMcpTestServer,
  electronMcpWriteConfigText,
} from '../../../../shared/eventa'
import { electronMcpServerConfigSchema, parseElectronMcpConfigText } from '../../../../shared/mcp-config'
import { onAppBeforeQuit } from '../../../libs/bootkit/lifecycle'

type McpClientTransport = StdioClientTransport | StreamableHTTPClientTransport

interface McpServerSession {
  generation: number
  client: Client
  transport: McpClientTransport
  config: ElectronMcpServerConfig & ElectronMcpServerCommon
  disconnectHandled: boolean
}

interface McpServerControl {
  name: string
  config: ElectronMcpServerConfig & ElectronMcpServerCommon
  lifecycleGeneration: number
  generation: number
  reconnectAttempt: number
  session?: McpServerSession
  reconnectTask?: ReturnType<typeof setTimeout>
  connectPromise?: Promise<void>
  instructions?: string
  lastError?: string
}

type StartMcpServer = (name: string, config: ElectronMcpServerConfig & ElectronMcpServerCommon, reconnecting?: boolean) => Promise<void>

export interface McpStdioManager {
  ensureConfigFile: () => Promise<{ path: string }>
  openConfigFile: () => Promise<{ path: string }>
  applyAndRestart: () => Promise<ElectronMcpStdioApplyResult>
  listTools: () => Promise<ElectronMcpToolDescriptor[]>
  callTool: (payload: ElectronMcpCallToolPayload) => Promise<ElectronMcpCallToolResult>
  /** Aborts one in-flight call by correlation id. Idempotent. */
  cancelTool: (requestId: string) => { cancelled: boolean }
  stopAll: () => Promise<void>
  getRuntimeStatus: () => ElectronMcpStdioRuntimeStatus
  readConfigText: () => Promise<ElectronMcpStdioConfigText>
  writeConfigText: (text: string) => Promise<ElectronMcpStdioConfigText>
  testServer: (payload: ElectronMcpStdioTestPayload) => Promise<ElectronMcpStdioTestResult>
}

const defaultMcpConfig: ElectronMcpConfigFile = {
  mcpServers: {},
}
const toolNameSeparator = '::'
const defaultMcpRequestTimeoutMs = 10_000
const defaultMcpMaxTotalTimeoutMs = 15_000
const mcpTestStderrMaxChars = 16_000
const mcpReconnectMaxAttempts = 5
const mcpReconnectBaseDelayMs = 1_000
const mcpReconnectMaxDelayMs = 30_000
const mcpReconnectJitterFactor = 0.2
const mcpCallResultUnknownMessage = 'MCP connection was restored or is still recovering, but the original tool result is unknown. Retry the tool call explicitly.'

function stringifyError(error: unknown) {
  return errorMessageFrom(error) ?? String(error)
}

/**
 * Runs one MCP SDK request with the server's independent timeout budgets.
 *
 * The SDK receives both budgets and progress reset settings. AIRI also owns
 * the total-budget signal because SDK 1.x does not enforce `maxTotalTimeout`
 * when a server sends no progress notification.
 */
async function runMcpRequest<TResult>(
  config: ElectronMcpServerConfig & ElectronMcpServerCommon,
  request: (options: RequestOptions) => Promise<TResult>,
  externalSignal?: AbortSignal,
): Promise<TResult> {
  const requestTimeoutMs = config.requestTimeoutMs ?? defaultMcpRequestTimeoutMs
  const maxTotalTimeoutMs = config.maxTotalTimeoutMs ?? defaultMcpMaxTotalTimeoutMs
  const controller = new AbortController()

  // NOTICE:
  // The MCP SDK 1.x checks maxTotalTimeout only when progress resets a request timer.
  // AIRI needs a hard wall-clock cap even when a server sends no progress notification.
  // Source/context: https://github.com/modelcontextprotocol/typescript-sdk/issues/2695
  // Removal condition: remove this timer when the minimum SDK version enforces the cap unconditionally.
  const totalTimeout = setTimeout(() => {
    controller.abort(new Error(`MCP request exceeded maxTotalTimeoutMs (${maxTotalTimeoutMs}ms)`))
  }, maxTotalTimeoutMs)

  // The caller's revocation signal and the total-budget signal both end the
  // request; either one is enough, so they are combined instead of nested.
  const signal = externalSignal
    ? AbortSignal.any([externalSignal, controller.signal])
    : controller.signal

  try {
    return await request({
      timeout: requestTimeoutMs,
      maxTotalTimeout: maxTotalTimeoutMs,
      onprogress: () => {},
      resetTimeoutOnProgress: true,
      signal,
    })
  }
  finally {
    clearTimeout(totalTimeout)
  }
}

function getConfigPath() {
  return join(app.getPath('userData'), 'mcp.json')
}

function parseQualifiedToolName(name: string) {
  const separatorIndex = name.indexOf(toolNameSeparator)
  if (separatorIndex <= 0 || separatorIndex === name.length - toolNameSeparator.length) {
    throw new Error(`invalid qualified tool name: ${name}`)
  }

  return {
    serverName: name.slice(0, separatorIndex),
    toolName: name.slice(separatorIndex + toolNameSeparator.length),
  }
}

function resolveFallbackToolName(toolName: string): string | undefined {
  const normalizedTransportPrefix = toolName
    .replace(/^\.(?:stdio|stdo)::/, '')
    .replace(/^(?:stdio|stdo)::/, '')
  if (normalizedTransportPrefix !== toolName) {
    return normalizedTransportPrefix
  }

  const lastSeparatorIndex = toolName.lastIndexOf(toolNameSeparator)
  if (lastSeparatorIndex <= 0 || lastSeparatorIndex === toolName.length - toolNameSeparator.length) {
    return undefined
  }

  return toolName.slice(lastSeparatorIndex + toolNameSeparator.length)
}

async function closeSession(session: McpServerSession) {
  session.transport.onclose = undefined
  session.transport.onerror = undefined
  session.client.onclose = undefined
  session.client.onerror = undefined

  try {
    await session.client.close()
  }
  catch {
    // The transport close below is still required when the client close fails.
  }

  try {
    await session.transport.close()
  }
  catch {
    // The process can already be gone when an unexpected close reached us.
  }
}

function isRequestTimeoutError(error: unknown) {
  const message = stringifyError(error).toLowerCase()
  return message.includes('timeout') || message.includes('timed out')
}

function isConnectionLossError(error: unknown) {
  const message = stringifyError(error).toLowerCase()
  return message.includes('not connected')
    || message.includes('connection closed')
    || message.includes('connectionclosed')
    || message.includes('transport closed')
}

export function createMcpStdioManager(): McpStdioManager {
  const log = useLogg('main/mcp-stdio').useGlobalConfig()
  const sessions = new Map<string, McpServerSession>()
  const serverControls = new Map<string, McpServerControl>()
  const runtimeStatuses = new Map<string, ElectronMcpStdioServerRuntimeStatus>()
  // In-flight tool calls keyed by the renderer's correlation id. The renderer
  // sends an explicit cancel when its registration is revoked; Eventa cannot
  // carry an AbortSignal across the process boundary.
  const inFlightCalls = new Map<string, AbortController>()
  let updatedAt = Date.now()
  let lifecycleGeneration = 0
  let reconnectsEnabled = true

  const setRuntimeStatus = (status: ElectronMcpStdioServerRuntimeStatus) => {
    runtimeStatuses.set(status.name, status)
    updatedAt = Date.now()
  }

  const isActiveControl = (control: McpServerControl) => {
    return reconnectsEnabled
      && control.lifecycleGeneration === lifecycleGeneration
      && serverControls.get(control.name) === control
  }

  const isCurrentSession = (control: McpServerControl, session: McpServerSession) => {
    return isActiveControl(control)
      && control.generation === session.generation
      && control.session === session
  }

  const setControlStatus = (
    control: McpServerControl,
    state: ElectronMcpStdioServerRuntimeStatus['state'],
    lastError?: unknown,
  ) => {
    if (state === 'running') {
      control.lastError = undefined
    }
    else if (lastError !== undefined) {
      control.lastError = stringifyError(lastError)
    }

    const status: ElectronMcpStdioServerRuntimeStatus = {
      name: control.name,
      state,
      // Streamable HTTP/SSE transports spawn no child process, so the status
      // carries an empty command and no pid for those entries.
      command: control.config.kind === 'stdio' ? control.config.command : '',
      args: control.config.kind === 'stdio' ? control.config.args ?? [] : [],
      pid: control.session && 'pid' in control.session.transport ? control.session.transport.pid ?? null : null,
    }
    if (control.instructions !== undefined) {
      status.instructions = control.instructions
    }
    if (state !== 'stopped' && control.lastError !== undefined) {
      status.lastError = control.lastError
    }
    setRuntimeStatus(status)
  }

  const resolveReconnectDelay = (attempt: number) => {
    const exponentialDelay = Math.min(
      mcpReconnectMaxDelayMs,
      mcpReconnectBaseDelayMs * (2 ** (attempt - 1)),
    )
    const jitter = 1 + ((Math.random() * 2 - 1) * mcpReconnectJitterFactor)
    return Math.max(1, Math.round(exponentialDelay * jitter))
  }

  let startServer: StartMcpServer

  const ensureConfigFile = async () => {
    const path = getConfigPath()
    await mkdir(app.getPath('userData'), { recursive: true })

    try {
      await readFile(path, 'utf-8')
    }
    catch {
      await writeFile(path, `${JSON.stringify(defaultMcpConfig, null, 2)}\n`)
    }

    return { path }
  }

  const openConfigFile = async () => {
    const { path } = await ensureConfigFile()
    shell.showItemInFolder(path)
    return { path }
  }

  const readConfigFile = async (path: string): Promise<ElectronMcpConfigFile> => {
    const raw = await readFile(path, 'utf-8')
    return parseElectronMcpConfigText(raw)
  }

  const stopAll = async () => {
    // Invalidate every callback before closing transports. The SDK invokes
    // close callbacks during an intentional close, so invalidation must happen
    // before the first await.
    reconnectsEnabled = false
    lifecycleGeneration++

    const controls = [...serverControls.values()]
    const sessionsToClose = new Set<McpServerSession>()
    for (const control of controls) {
      if (control.reconnectTask) {
        clearTimeout(control.reconnectTask)
        control.reconnectTask = undefined
      }

      control.generation++
      if (control.session) {
        sessionsToClose.add(control.session)
        control.session = undefined
      }

      const session = sessions.get(control.name)
      if (session) {
        sessionsToClose.add(session)
      }
      sessions.delete(control.name)
      setControlStatus(control, 'stopped')
    }

    serverControls.clear()
    await Promise.all([...sessionsToClose].map(session => closeSession(session)))
  }

  const scheduleReconnect = (control: McpServerControl, error: unknown) => {
    if (!isActiveControl(control) || control.reconnectTask) {
      return
    }

    const nextAttempt = control.reconnectAttempt + 1
    if (nextAttempt > mcpReconnectMaxAttempts) {
      setControlStatus(control, 'error', error)
      return
    }

    control.reconnectAttempt = nextAttempt
    setControlStatus(control, 'reconnecting', error)

    const delay = resolveReconnectDelay(nextAttempt)
    control.reconnectTask = setTimeout(() => {
      control.reconnectTask = undefined

      const start = () => {
        if (!isActiveControl(control) || control.reconnectTask || control.connectPromise || sessions.has(control.name)) {
          return
        }

        void startServer(control.name, control.config, true).catch((startError) => {
          // A failed reconnect start (e.g. the command vanished between
          // generations) reaches here without any transport callback, so
          // nothing else would continue the chain. Re-enter the scheduler:
          // it deduplicates against the just-cleared task, advances the
          // attempt counter, and settles into `error` when attempts are
          // exhausted. Without this the server would stick at `reconnecting`
          // forever (found in the 2026-09-02 review).
          scheduleReconnect(control, startError)
        })
      }

      // A transport error can arrive before Client.connect() rejects. Wait for
      // that attempt to finish, then start exactly one replacement generation.
      if (control.connectPromise) {
        void control.connectPromise.then(start, start)
      }
      else {
        start()
      }
    }, delay)
  }

  const requestRecovery = (control: McpServerControl, error: unknown) => {
    if (!isActiveControl(control) || control.reconnectTask || control.connectPromise || sessions.has(control.name)) {
      return
    }

    // An explicit call after the bounded policy reached error starts one new
    // bounded recovery cycle. Automatic transport events never reset it.
    control.reconnectAttempt = 0
    scheduleReconnect(control, error)
  }

  const handleConnectionLoss = (control: McpServerControl, session: McpServerSession, error: unknown) => {
    if (!isCurrentSession(control, session) || session.disconnectHandled) {
      return
    }

    session.disconnectHandled = true
    session.transport.onclose = undefined
    session.transport.onerror = undefined
    session.client.onclose = undefined
    session.client.onerror = undefined
    control.session = undefined
    if (sessions.get(control.name) === session) {
      sessions.delete(control.name)
    }

    void closeSession(session)
    scheduleReconnect(control, error)
  }

  const bindSessionLifecycle = (control: McpServerControl, session: McpServerSession) => {
    const onClose = () => handleConnectionLoss(control, session, new Error('MCP transport closed'))
    const onError = (error: Error) => handleConnectionLoss(control, session, error)

    // Client.connect() preserves these transport callbacks before it installs
    // its own wrappers. Set both layers so the manager observes stdio errors
    // from the transport and the SDK's normalized client close event.
    session.transport.onclose = onClose
    session.transport.onerror = onError
    session.client.onclose = onClose
    session.client.onerror = onError
  }

  const listToolsForSession = async (serverName: string, session: McpServerSession): Promise<ElectronMcpToolDescriptor[]> => {
    try {
      const response = await runMcpRequest(session.config, options => session.client.listTools(undefined, options))
      return response.tools.map<ElectronMcpToolDescriptor>(item => ({
        serverName,
        name: `${serverName}${toolNameSeparator}${item.name}`,
        toolName: item.name,
        description: item.description,
        inputSchema: item.inputSchema,
      }))
    }
    catch (error) {
      log.withFields({ serverName }).withError(error).warn('failed to list tools from mcp server')
      return []
    }
  }

  const refreshToolDirectory = async (control: McpServerControl, generation: number) => {
    const session = control.session
    if (!session || control.generation !== generation || !isCurrentSession(control, session)) {
      return
    }

    await listToolsForSession(control.name, session)
  }

  startServer = (name: string, config: ElectronMcpServerConfig & ElectronMcpServerCommon, reconnecting = false): Promise<void> => {
    const control = serverControls.get(name)
    if (!control || control.config !== config || !isActiveControl(control)) {
      return Promise.reject(new Error(`mcp server is not active: ${name}`))
    }
    if (control.connectPromise) {
      return control.connectPromise
    }
    if (sessions.has(name)) {
      return Promise.resolve()
    }

    const generation = control.generation + 1
    control.generation = generation
    const transport: McpClientTransport = config.kind === 'stdio'
      ? new StdioClientTransport({
          command: config.command,
          args: config.args ?? [],
          env: config.env,
          cwd: config.cwd,
          stderr: 'pipe',
        })
      : new StreamableHTTPClientTransport(new URL(config.url), {
          requestInit: config.headers ? { headers: config.headers } : undefined,
        })
    const session: McpServerSession = {
      generation,
      client: new Client({
        name: `proj-airi:stage-tamagotchi:mcp:${name}`,
        version: app.getVersion(),
      }),
      transport,
      config,
      disconnectHandled: false,
    }
    control.session = session
    setControlStatus(control, reconnecting ? 'reconnecting' : 'starting')
    bindSessionLifecycle(control, session)
    // Only stdio spawns a child process with a stderr pipe; HTTP transports
    // must never be touched here.
    if (config.kind === 'stdio' && 'stderr' in session.transport) {
      session.transport.stderr?.on('data', (data) => {
        const text = data.toString('utf-8').trim()
        if (text) {
          log.withFields({ serverName: name }).warn(text)
        }
      })
    }

    const connectPromise = (async () => {
      try {
        const connectResult = await runMcpRequest(config, options => session.client.connect(session.transport, options)) as { instructions?: string } | undefined
        if (!isCurrentSession(control, session)) {
          throw new Error('MCP connection closed during startup')
        }

        control.instructions = connectResult?.instructions
        sessions.set(name, session)
        control.reconnectAttempt = 0
        setControlStatus(control, 'running')
        if (reconnecting) {
          void refreshToolDirectory(control, generation)
        }
      }
      catch (error) {
        if (isCurrentSession(control, session)) {
          session.disconnectHandled = true
          session.transport.onclose = undefined
          session.transport.onerror = undefined
          session.client.onclose = undefined
          session.client.onerror = undefined
          control.session = undefined
          sessions.delete(name)
          await closeSession(session)

          // A request timeout or an initialization error only ends this
          // connect request. Only a transport callback proves that the stdio
          // connection is unavailable and permits automatic retry.
          if (!session.disconnectHandled || isRequestTimeoutError(error)) {
            setControlStatus(control, 'error', error)
          }
        }
        else {
          await closeSession(session)
        }

        throw error
      }
    })()
    control.connectPromise = connectPromise
    void connectPromise.then(
      () => {
        if (control.connectPromise === connectPromise) {
          control.connectPromise = undefined
        }
      },
      () => {
        if (control.connectPromise === connectPromise) {
          control.connectPromise = undefined
        }
      },
    )
    return connectPromise
  }

  const applyAndRestart = async (): Promise<ElectronMcpStdioApplyResult> => {
    const { path } = await ensureConfigFile()
    const config = await readConfigFile(path)

    await stopAll()
    reconnectsEnabled = true
    runtimeStatuses.clear()

    const result: ElectronMcpStdioApplyResult = {
      path,
      started: [],
      failed: [],
      skipped: [],
    }

    for (const [name, server] of Object.entries(config.mcpServers)) {
      if (server.enabled === false) {
        result.skipped.push({ name, reason: 'disabled' })
        setRuntimeStatus({
          name,
          state: 'stopped',
          command: server.kind === 'stdio' ? server.command : '',
          args: server.kind === 'stdio' ? server.args ?? [] : [],
          pid: null,
        })
        continue
      }

      const control: McpServerControl = {
        name,
        config: server,
        lifecycleGeneration,
        generation: 0,
        reconnectAttempt: 0,
      }
      serverControls.set(name, control)

      try {
        await startServer(name, server)
        result.started.push({ name })
      }
      catch (error) {
        const message = stringifyError(error)
        result.failed.push({ name, error: message })
        if (isActiveControl(control) && runtimeStatuses.get(name)?.state !== 'reconnecting') {
          setControlStatus(control, 'error', message)
        }
      }
    }

    updatedAt = Date.now()

    return result
  }

  const listTools = async (): Promise<ElectronMcpToolDescriptor[]> => {
    const entries = [...sessions.entries()].sort(([left], [right]) => left.localeCompare(right))
    const listResult = await Promise.all(entries.map(([serverName, session]) => listToolsForSession(serverName, session)))

    return listResult.flat()
  }

  const callTool = async (payload: ElectronMcpCallToolPayload): Promise<ElectronMcpCallToolResult> => {
    const { serverName, toolName } = parseQualifiedToolName(payload.name)
    const control = serverControls.get(serverName)
    const session = sessions.get(serverName)
    if (!control) {
      throw new Error(`mcp server is not running: ${serverName}`)
    }
    if (!session || !isCurrentSession(control, session)) {
      requestRecovery(control, new Error('MCP connection is unavailable'))
      throw new Error(mcpCallResultUnknownMessage)
    }

    const controller = new AbortController()
    inFlightCalls.set(payload.requestId, controller)

    try {
      let result
      try {
        result = await runMcpRequest(session.config, options => session.client.callTool({
          name: toolName,
          arguments: payload.arguments ?? {},
        }, undefined, options), controller.signal)
      }
      catch (error) {
        if (isConnectionLossError(error)) {
          handleConnectionLoss(control, session, error)
          throw new Error(mcpCallResultUnknownMessage)
        }
        if (!isCurrentSession(control, session)) {
          throw new Error(mcpCallResultUnknownMessage)
        }
        if (isRequestTimeoutError(error) || controller.signal.aborted) {
          throw error
        }

        const fallbackToolName = resolveFallbackToolName(toolName)
        if (!fallbackToolName || fallbackToolName === toolName) {
          throw error
        }

        log.withFields({
          serverName,
          requestedToolName: toolName,
          fallbackToolName,
        }).warn('retrying mcp tool call with normalized tool name')

        result = await runMcpRequest(session.config, options => session.client.callTool({
          name: fallbackToolName,
          arguments: payload.arguments ?? {},
        }, undefined, options), controller.signal)
      }

      const normalized: ElectronMcpCallToolResult = {}
      if ('content' in result && Array.isArray(result.content)) {
        normalized.content = result.content as Array<Record<string, unknown>>
      }
      if ('structuredContent' in result && result.structuredContent && typeof result.structuredContent === 'object' && !Array.isArray(result.structuredContent)) {
        normalized.structuredContent = result.structuredContent as Record<string, unknown>
      }
      if ('isError' in result && typeof result.isError === 'boolean') {
        normalized.isError = result.isError
      }
      if ('toolResult' in result) {
        normalized.toolResult = result.toolResult
      }

      return normalized
    }
    finally {
      inFlightCalls.delete(payload.requestId)
    }
  }

  const cancelTool = (requestId: string): { cancelled: boolean } => {
    const controller = inFlightCalls.get(requestId)
    if (!controller) {
      return { cancelled: false }
    }
    controller.abort(new Error(`MCP tool call ${requestId} was cancelled.`))
    return { cancelled: true }
  }

  const getRuntimeStatus = (): ElectronMcpStdioRuntimeStatus => {
    return {
      path: getConfigPath(),
      servers: [...runtimeStatuses.values()].sort((left, right) => left.name.localeCompare(right.name)),
      updatedAt,
    }
  }

  const readConfigText = async (): Promise<ElectronMcpStdioConfigText> => {
    const { path } = await ensureConfigFile()
    const text = await readFile(path, 'utf-8')
    return { path, text }
  }

  const writeConfigText = async (text: string): Promise<ElectronMcpStdioConfigText> => {
    const { path } = await ensureConfigFile()
    const validated = parseElectronMcpConfigText(text)
    const normalized = `${JSON.stringify(validated, null, 2)}\n`
    await writeFile(path, normalized)
    return { path, text: normalized }
  }

  const testServer = async (payload: ElectronMcpStdioTestPayload): Promise<ElectronMcpStdioTestResult> => {
    const startedAt = Date.now()
    let transport: McpClientTransport | null = null
    let client: Client | null = null
    const stderrChunks: string[] = []

    try {
      const config = electronMcpServerConfigSchema.parse(payload.config)
      if (config.kind === 'stdio') {
        transport = new StdioClientTransport({
          command: config.command,
          args: config.args ?? [],
          env: config.env,
          cwd: config.cwd,
          stderr: 'pipe',
        })
        transport.stderr?.on('data', (data) => {
          const text = data.toString('utf-8')
          if (text)
            stderrChunks.push(text)
        })
      }
      else {
        transport = new StreamableHTTPClientTransport(new URL(config.url), {
          requestInit: config.headers ? { headers: config.headers } : undefined,
        })
      }
      client = new Client({
        name: `proj-airi:stage-tamagotchi:mcp:test:${payload.name}`,
        version: app.getVersion(),
      })

      await runMcpRequest(config, options => client!.connect(transport!, options))

      const response = await runMcpRequest(config, options => client!.listTools(undefined, options))

      if (stderrChunks.length > 0) {
        log.withFields({ serverName: payload.name }).debug(stderrChunks.join('').trim())
      }

      return {
        ok: true,
        tools: response.tools.map(tool => tool.name),
        durationMs: Date.now() - startedAt,
      }
    }
    catch (error) {
      const message = stringifyError(error)
      // Keep only the tail so a noisy failed server cannot flood the settings UI.
      const stderr = stderrChunks.join('').trim().slice(-mcpTestStderrMaxChars)
      return {
        ok: false,
        error: stderr ? `${message}\n\n${stderr}` : message,
        durationMs: Date.now() - startedAt,
      }
    }
    finally {
      if (client) {
        await client.close().catch(() => {})
      }
      if (transport) {
        await transport.close().catch(() => {})
      }
    }
  }

  return {
    ensureConfigFile,
    openConfigFile,
    applyAndRestart,
    listTools,
    callTool,
    cancelTool,
    stopAll,
    getRuntimeStatus,
    readConfigText,
    writeConfigText,
    testServer,
  }
}

export async function setupMcpStdioManager() {
  const log = useLogg('main/mcp-stdio').useGlobalConfig()
  const manager = createMcpStdioManager()

  onAppBeforeQuit(async () => {
    await manager.stopAll()
  })

  await manager.ensureConfigFile()

  try {
    await manager.applyAndRestart()
  }
  catch (error) {
    log.withError(error).warn('failed to apply mcp stdio config during startup')
  }

  return manager
}

export function createMcpServersService(params: { context: ReturnType<typeof createContext>['context'], manager: McpStdioManager }) {
  defineInvokeHandler(params.context, electronMcpOpenConfigFile, async () => {
    return params.manager.openConfigFile()
  })

  defineInvokeHandler(params.context, electronMcpApplyAndRestart, async () => {
    return params.manager.applyAndRestart()
  })

  defineInvokeHandler(params.context, electronMcpGetRuntimeStatus, async () => {
    return params.manager.getRuntimeStatus()
  })

  defineInvokeHandler(params.context, electronMcpListTools, async () => {
    return params.manager.listTools()
  })

  defineInvokeHandler(params.context, electronMcpCallTool, async (payload) => {
    return params.manager.callTool(payload)
  })

  defineInvokeHandler(params.context, electronMcpCancelTool, async ({ requestId }) => {
    return params.manager.cancelTool(requestId)
  })

  defineInvokeHandler(params.context, electronMcpReadConfigText, async () => {
    return params.manager.readConfigText()
  })

  defineInvokeHandler(params.context, electronMcpWriteConfigText, async (payload) => {
    return params.manager.writeConfigText(payload.text)
  })

  defineInvokeHandler(params.context, electronMcpTestServer, async (payload) => {
    return params.manager.testServer(payload)
  })
}
