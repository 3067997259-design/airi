import { errorMessageFrom } from '@moeru/std'
import { describe, expect, it } from 'vitest'

import { parseElectronMcpConfigText } from '../../../../shared/mcp-config'
import {
  buildConfigFile,
  buildServerConfig,
  findServerIdentifierByRowId,
  loadServerForms,
  syncJsonDraftFromServers,
} from './mcp-config'

function translateMessage(key: string, params?: Record<string, unknown>) {
  if (params?.name)
    return `${key}:${String(params.name)}`

  if (params?.index)
    return `${key}:${String(params.index)}`

  return key
}

function stdioServer(overrides: Record<string, unknown> = {}) {
  return {
    rowId: 'mcp-static',
    identifier: 'filesystem',
    kind: 'stdio' as const,
    command: 'npx',
    argsText: '',
    envEntries: [],
    cwd: '',
    url: '',
    headersEntries: [],
    enabled: true,
    ...overrides,
  }
}

describe('mcp-config helpers', () => {
  it('preserves the selected server identity when rows are reloaded', () => {
    const config = {
      mcpServers: {
        filesystem: { kind: 'stdio' as const, command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem'] },
        github: { kind: 'stdio' as const, command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] },
      },
    }

    const initialLoad = loadServerForms(config)
    const selectedRowId = initialLoad.servers[1]!.rowId
    const selectedIdentifier = findServerIdentifierByRowId(initialLoad.servers, selectedRowId)
    const reloaded = loadServerForms(config, { selectedIdentifier })

    expect(selectedIdentifier).toBe('github')
    expect(reloaded.selectedRowId).not.toBe(selectedRowId)
    expect(reloaded.servers.find(server => server.rowId === reloaded.selectedRowId)?.identifier).toBe('github')
  })

  it('keeps cwd when converting form rows into MCP config', () => {
    const server = stdioServer({
      command: ' npx ',
      argsText: '-y\n@modelcontextprotocol/server-filesystem',
      envEntries: [{ key: ' ROOT ', value: '/tmp' }],
      cwd: ' /Users/doji/dojiwork/airi ',
    })

    expect(buildServerConfig(server)).toEqual({
      kind: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem'],
      env: { ROOT: '/tmp' },
      cwd: '/Users/doji/dojiwork/airi',
    })

    expect(buildConfigFile([server], translateMessage)).toEqual({
      mcpServers: {
        filesystem: {
          kind: 'stdio',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem'],
          env: { ROOT: '/tmp' },
          cwd: '/Users/doji/dojiwork/airi',
        },
      },
    })
  })

  it('preserves independent timeout budgets during form conversion', () => {
    const server = stdioServer({
      rowId: 'mcp-timeouts',
      identifier: 'slow-tools',
      command: 'slow-mcp',
      requestTimeoutMs: 2_000,
      maxTotalTimeoutMs: 500,
    })

    const config = buildConfigFile([server], translateMessage)
    const loaded = loadServerForms(config)

    expect(config.mcpServers['slow-tools']).toEqual({
      kind: 'stdio',
      command: 'slow-mcp',
      requestTimeoutMs: 2_000,
      maxTotalTimeoutMs: 500,
    })
    expect(loaded.servers[0]).toMatchObject({
      requestTimeoutMs: 2_000,
      maxTotalTimeoutMs: 500,
    })
  })

  it('builds a streamable-http entry from its own form fields', () => {
    const server = stdioServer({
      rowId: 'mcp-http',
      identifier: 'remote',
      kind: 'streamable-http' as const,
      url: ' http://127.0.0.1:25600/mcp ',
      headersEntries: [{ key: 'Authorization', value: 'Bearer secret' }],
      enabled: false,
    })

    expect(buildServerConfig(server)).toEqual({
      kind: 'streamable-http',
      url: 'http://127.0.0.1:25600/mcp',
      headers: { Authorization: 'Bearer secret' },
      enabled: false,
    })

    const config = buildConfigFile([server], translateMessage)
    expect(config.mcpServers.remote).toEqual({
      kind: 'streamable-http',
      url: 'http://127.0.0.1:25600/mcp',
      headers: { Authorization: 'Bearer secret' },
      enabled: false,
    })
  })

  it('loads a streamable-http entry into url and headers form fields', () => {
    const config = {
      mcpServers: {
        remote: {
          kind: 'streamable-http' as const,
          url: 'http://127.0.0.1:25600/mcp',
          headers: { Authorization: 'Bearer secret' },
        },
      },
    }

    const loaded = loadServerForms(config)
    expect(loaded.servers[0]).toMatchObject({
      identifier: 'remote',
      kind: 'streamable-http',
      url: 'http://127.0.0.1:25600/mcp',
      command: '',
      headersEntries: [{ key: 'Authorization', value: 'Bearer secret' }],
      envEntries: [],
    })
  })

  it('requires an endpoint URL for streamable-http rows', () => {
    const server = stdioServer({
      identifier: 'remote',
      kind: 'streamable-http' as const,
      url: '   ',
    })

    expect(() => buildConfigFile([server], translateMessage)).toThrow('errors.empty-url:remote')
  })

  it('keeps the existing JSON draft when form rows are incomplete', () => {
    const previousDraft = '{\n  "mcpServers": {\n    "saved": { "command": "npx" }\n  }\n}\n'

    const result = syncJsonDraftFromServers(
      [stdioServer({ identifier: '', command: '' })],
      previousDraft,
      translateMessage,
      error => errorMessageFrom(error) ?? 'Unknown error',
    )

    expect(result.draft).toBe(previousDraft)
    expect(result.error).toBe('errors.empty-identifier:1')
  })

  it('rejects JSON drafts that violate the shared MCP schema', () => {
    expect(() => parseElectronMcpConfigText(JSON.stringify({
      mcpServers: {
        filesystem: {
          command: 'npx',
          env: [],
        },
      },
    }))).toThrow('mcpServers.filesystem.env: Invalid input: expected record, received array')
  })

  it('rejects unknown keys that the main process would reject too', () => {
    expect(() => parseElectronMcpConfigText(JSON.stringify({
      mcpServers: {
        filesystem: {
          command: 'npx',
          extraField: true,
        },
      },
    }))).toThrow('mcpServers.filesystem: Unrecognized key: "extraField"')
  })

  it('accepts independent positive integer timeout values and rejects unsafe values', () => {
    expect(parseElectronMcpConfigText(JSON.stringify({
      mcpServers: {
        filesystem: {
          command: 'npx',
          requestTimeoutMs: 2_000,
          maxTotalTimeoutMs: 500,
        },
      },
    }))).toEqual({
      mcpServers: {
        filesystem: {
          kind: 'stdio',
          command: 'npx',
          requestTimeoutMs: 2_000,
          maxTotalTimeoutMs: 500,
        },
      },
    })

    expect(() => parseElectronMcpConfigText(JSON.stringify({
      mcpServers: { filesystem: { command: 'npx', requestTimeoutMs: 0 } },
    }))).toThrow('mcpServers.filesystem.requestTimeoutMs')
    expect(() => parseElectronMcpConfigText(JSON.stringify({
      mcpServers: { filesystem: { command: 'npx', maxTotalTimeoutMs: 1.5 } },
    }))).toThrow('mcpServers.filesystem.maxTotalTimeoutMs')
    expect(() => parseElectronMcpConfigText(JSON.stringify({
      mcpServers: { filesystem: { command: 'npx', maxTotalTimeoutMs: 2_147_483_648 } },
    }))).toThrow('mcpServers.filesystem.maxTotalTimeoutMs')
  })

  it('normalizes a legacy stdio entry without kind into kind stdio', () => {
    expect(parseElectronMcpConfigText(JSON.stringify({
      mcpServers: {
        legacy: { command: 'npx', args: ['-y', 'pkg'] },
      },
    }))).toEqual({
      mcpServers: {
        legacy: { kind: 'stdio', command: 'npx', args: ['-y', 'pkg'] },
      },
    })
  })

  it('accepts a streamable-http entry with headers and common fields', () => {
    expect(parseElectronMcpConfigText(JSON.stringify({
      mcpServers: {
        remote: {
          kind: 'streamable-http',
          url: 'http://127.0.0.1:25600/mcp',
          headers: { Authorization: 'Bearer secret' },
          enabled: true,
          requestTimeoutMs: 5_000,
        },
      },
    }))).toEqual({
      mcpServers: {
        remote: {
          kind: 'streamable-http',
          url: 'http://127.0.0.1:25600/mcp',
          headers: { Authorization: 'Bearer secret' },
          enabled: true,
          requestTimeoutMs: 5_000,
        },
      },
    })
  })

  it('rejects a streamable-http entry with a stdio-only field', () => {
    expect(() => parseElectronMcpConfigText(JSON.stringify({
      mcpServers: {
        remote: { kind: 'streamable-http', url: 'http://127.0.0.1:25600/mcp', command: 'npx' },
      },
    }))).toThrow('mcpServers.remote: Unrecognized key: "command"')
  })

  it('rejects an unknown transport kind and a missing url', () => {
    expect(() => parseElectronMcpConfigText(JSON.stringify({
      mcpServers: {
        bogus: { kind: 'carrier-pigeon', command: 'npx' },
      },
    }))).toThrow('mcpServers.bogus.kind: Invalid discriminator value')

    expect(() => parseElectronMcpConfigText(JSON.stringify({
      mcpServers: {
        remote: { kind: 'streamable-http', url: '' },
      },
    }))).toThrow('mcpServers.remote.url')
  })
})
