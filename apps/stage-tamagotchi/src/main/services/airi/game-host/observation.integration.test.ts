import type { GameWorldIdentity } from '../../../../shared/eventa'

import { writeFile } from 'node:fs/promises'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { describe, expect, it } from 'vitest'

import { gameWorldIdentityFrom } from './index'

/**
 * Deterministic MC-0a observation probe for the real MCPFabric chain.
 *
 * This is the "protocol script, no LLM" from mc-0a-spec work item 5: it speaks
 * MCP to the mcpfabric Node server, reads the read-only tool set, and asserts
 * the fields the game-host identity cache depends on. It stays skipped unless
 * `MCPFABRIC_URL` is set, so the normal suite never needs a running game.
 *
 * Run against a configured environment:
 *
 * ```powershell
 * $env:MCPFABRIC_URL = 'http://127.0.0.1:25600/mcp'
 * pnpm -F @proj-airi/stage-tamagotchi exec vitest run src/main/services/airi/game-host/observation.integration.test.ts
 * ```
 */

type ToolResult = Parameters<typeof gameWorldIdentityFrom>[0]

const liveUrl = process.env.MCPFABRIC_URL
const liveToken = process.env.MCPFABRIC_TOKEN

function recordOf(result: ToolResult): Record<string, unknown> {
  const structured = result.structuredContent
  if (structured !== null && typeof structured === 'object' && !Array.isArray(structured))
    return structured as Record<string, unknown>
  const text = (result.content ?? [])
    .filter((item): item is { type: 'text', text: string } => item.type === 'text' && typeof item.text === 'string')
    .map(item => item.text)
    .join('')
  return text.trim() ? JSON.parse(text) as Record<string, unknown> : {}
}

describe.runIf(Boolean(liveUrl))('mcpfabric live read-only observation (MC-0a)', () => {
  it('reads identity, position, inventory, and a block region with capture times', async () => {
    const transport = new StreamableHTTPClientTransport(new URL(liveUrl!), (liveToken ? { requestInit: { headers: { Authorization: `Bearer ${liveToken}` } } } : {}))
    const client = new Client({ name: 'proj-airi:mc-0a-observation', version: '0.0.0' })
    await client.connect(transport)

    try {
      const capturedAt = Date.now()
      const status = await client.callTool({ name: 'get_status', arguments: {} }) as ToolResult
      const self = await client.callTool({ name: 'get_self', arguments: {} }) as ToolResult
      const inventory = await client.callTool({ name: 'get_inventory', arguments: {} }) as ToolResult

      const identity: GameWorldIdentity | undefined = gameWorldIdentityFrom(status, self)
      expect(identity?.minecraftVersion).toBeTruthy()
      expect(identity?.dimension).toBeTruthy()

      const selfState = recordOf(self)
      const position = {
        x: Number(selfState.x),
        y: Number(selfState.y),
        z: Number(selfState.z),
      }
      expect(Number.isFinite(position.x)).toBe(true)
      expect(Number.isFinite(position.y)).toBe(true)
      expect(Number.isFinite(position.z)).toBe(true)

      const from = { x: Math.floor(position.x) - 2, y: Math.floor(position.y) - 1, z: Math.floor(position.z) - 2 }
      const to = { x: Math.floor(position.x) + 2, y: Math.floor(position.y) + 1, z: Math.floor(position.z) + 2 }
      // Block reads are a server-side capability: a dedicated server without
      // the mcpfabric mod cannot serve them through the client bridge. The
      // probe records the skip instead of failing on an unavailable tool.
      const statusState = recordOf(status)
      const capabilities = Array.isArray(statusState.capabilities) ? statusState.capabilities as string[] : []
      const supportsWorldRead = capabilities.includes('world_read')
      const region = supportsWorldRead
        ? await client.callTool({ name: 'get_blocks_region', arguments: { from, to, includeAir: false } }) as ToolResult
        : undefined

      expect(inventory.isError).not.toBe(true)
      expect(Object.keys(recordOf(inventory)).length).toBeGreaterThan(0)
      if (region) {
        expect(region.isError).not.toBe(true)
        expect(Object.keys(recordOf(region)).length).toBeGreaterThan(0)
      }

      const report = {
        capturedAt,
        identity,
        position,
        inventoryKeys: Object.keys(recordOf(inventory)),
        regionKeys: region ? Object.keys(recordOf(region)) : null,
        regionSample: region ? recordOf(region) : null,
        ...(supportsWorldRead ? {} : { regionSkipped: 'world_read capability is absent (server side has no mcpfabric mod)' }),
      }
      console.info('[mc-0a] live observation', JSON.stringify(report, null, 2))

      // The acceptance record keeps the machine-readable report; vitest may
      // swallow console output on a passing run.
      const reportPath = process.env.MCPFABRIC_REPORT_PATH
      if (reportPath)
        await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    }
    finally {
      await client.close()
    }
  }, 60_000)
})
