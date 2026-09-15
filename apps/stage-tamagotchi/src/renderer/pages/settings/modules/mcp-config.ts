import type {
  ElectronMcpConfigFile,
  ElectronMcpServerCommon,
  ElectronMcpServerConfig,
} from '../../../../shared/eventa'

type TranslateMcpMessage = (key: string, params?: Record<string, unknown>) => string

export type McpTransportKind = 'stdio' | 'streamable-http' | 'sse'

/** Editable MCP server form state used by the settings page. */
export interface ServerForm {
  rowId: string
  identifier: string
  kind: McpTransportKind
  command: string
  argsText: string
  envEntries: { key: string, value: string }[]
  cwd: string
  url: string
  headersEntries: { key: string, value: string }[]
  enabled: boolean
  requestTimeoutMs?: number
  maxTotalTimeoutMs?: number
}

/** Editable MCP server rows derived from persisted config. */
export interface LoadedServerForms {
  servers: ServerForm[]
  savedIds: Set<string>
  selectedRowId: string
}

function makeRowId() {
  return `mcp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function splitArgsText(argsText: string) {
  return argsText.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
}

function entriesToObject(entries: { key: string, value: string }[]) {
  const out: Record<string, string> = {}
  for (const { key, value } of entries) {
    const normalizedKey = key.trim()
    if (normalizedKey)
      out[normalizedKey] = value
  }
  return out
}

function commonFieldsOf(server: ServerForm): Partial<ElectronMcpServerCommon> {
  const common: Partial<ElectronMcpServerCommon> = {}
  if (!server.enabled)
    common.enabled = false

  if (server.requestTimeoutMs !== undefined)
    common.requestTimeoutMs = server.requestTimeoutMs

  if (server.maxTotalTimeoutMs !== undefined)
    common.maxTotalTimeoutMs = server.maxTotalTimeoutMs

  return common
}

/** Creates a blank MCP server row for new entries. */
export function createServerForm(): ServerForm {
  return {
    rowId: makeRowId(),
    identifier: '',
    kind: 'stdio',
    command: '',
    argsText: '',
    envEntries: [],
    cwd: '',
    url: '',
    headersEntries: [],
    enabled: true,
    requestTimeoutMs: undefined,
    maxTotalTimeoutMs: undefined,
  }
}

/** Resolves the persisted server identifier for a selected row. */
export function findServerIdentifierByRowId(servers: ServerForm[], rowId: string) {
  return servers.find(server => server.rowId === rowId)?.identifier.trim() || undefined
}

/** Converts one editable server row into persisted MCP server config. */
export function buildServerConfig(server: ServerForm): ElectronMcpServerConfig & ElectronMcpServerCommon {
  const common = commonFieldsOf(server)

  if (server.kind === 'stdio') {
    const config: ElectronMcpServerConfig = {
      kind: 'stdio',
      command: server.command.trim(),
    }

    const args = splitArgsText(server.argsText)
    if (args.length)
      config.args = args

    const env = entriesToObject(server.envEntries)
    if (Object.keys(env).length)
      config.env = env

    if (server.cwd.trim())
      config.cwd = server.cwd.trim()

    return { ...config, ...common }
  }

  // streamable-http and sse share the same url/headers shape.
  const headers = entriesToObject(server.headersEntries)
  const headersField = Object.keys(headers).length ? { headers } : {}
  const config: ElectronMcpServerConfig = server.kind === 'sse'
    ? { kind: 'sse', url: server.url.trim(), ...headersField }
    : { kind: 'streamable-http', url: server.url.trim(), ...headersField }

  return { ...config, ...common }
}

/** Builds the persisted MCP config file from editable rows. */
export function buildConfigFile(
  servers: ServerForm[],
  translateMessage: TranslateMcpMessage,
): ElectronMcpConfigFile {
  const config: ElectronMcpConfigFile = { mcpServers: {} }
  const seenIdentifiers = new Set<string>()

  for (const [index, server] of servers.entries()) {
    const identifier = server.identifier.trim()
    if (!identifier)
      throw new Error(translateMessage('errors.empty-identifier', { index: index + 1 }))

    if (seenIdentifiers.has(identifier))
      throw new Error(translateMessage('errors.duplicate-identifier', { name: identifier }))

    if (server.kind === 'stdio') {
      if (!server.command.trim())
        throw new Error(translateMessage('errors.empty-command', { name: identifier }))
    }
    else if (!server.url.trim()) {
      throw new Error(translateMessage('errors.empty-url', { name: identifier }))
    }

    seenIdentifiers.add(identifier)
    config.mcpServers[identifier] = buildServerConfig(server)
  }

  return config
}

/** Builds the JSON editor draft while preserving the current draft when form validation fails. */
export function syncJsonDraftFromServers(
  servers: ServerForm[],
  previousDraft: string,
  translateMessage: TranslateMcpMessage,
  formatError: (error: unknown) => string,
) {
  try {
    return {
      draft: `${JSON.stringify(buildConfigFile(servers, translateMessage), null, 2)}\n`,
      error: '',
    }
  }
  catch (error) {
    return {
      draft: previousDraft,
      error: formatError(error),
    }
  }
}

/** Loads editable rows from persisted MCP config. */
export function loadServerForms(
  config: ElectronMcpConfigFile,
  options: { selectedIdentifier?: string } = {},
): LoadedServerForms {
  const servers = Object.entries(config.mcpServers ?? {}).map(([identifier, server]) => ({
    rowId: makeRowId(),
    identifier,
    kind: server.kind,
    command: server.kind === 'stdio' ? server.command : '',
    argsText: server.kind === 'stdio' ? (server.args ?? []).join('\n') : '',
    envEntries: server.kind === 'stdio'
      ? Object.entries(server.env ?? {}).map(([key, value]) => ({ key, value }))
      : [],
    cwd: server.kind === 'stdio' ? server.cwd ?? '' : '',
    url: server.kind === 'stdio' ? '' : server.url,
    headersEntries: server.kind === 'stdio'
      ? []
      : Object.entries(server.headers ?? {}).map(([key, value]) => ({ key, value })),
    enabled: server.enabled !== false,
    requestTimeoutMs: server.requestTimeoutMs,
    maxTotalTimeoutMs: server.maxTotalTimeoutMs,
  }))

  const selectedRowId = options.selectedIdentifier
    ? (servers.find(server => server.identifier === options.selectedIdentifier)?.rowId ?? servers[0]?.rowId ?? '')
    : (servers[0]?.rowId ?? '')

  return {
    servers,
    savedIds: new Set(servers.map(server => server.rowId)),
    selectedRowId,
  }
}

/** Previews the endpoint one server row connects to. */
export function previewServerCommand(server: ServerForm) {
  if (server.kind !== 'stdio')
    return server.url.trim()

  return [server.command, ...splitArgsText(server.argsText)].join(' ')
}
