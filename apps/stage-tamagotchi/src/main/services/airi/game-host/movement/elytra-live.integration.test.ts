import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { describe, expect, it } from 'vitest'

import { runElytraMove } from './elytra'
import { createMcpMovementPort } from './host-port'

/**
 * Live OV-5 probe for the host-side elytra takeoff path.
 *
 * This is the "protocol script, no LLM" instrument for the acceptance item that
 * says a single-trip flight must actually call the new launch path. It builds
 * the production movement port (same `hasTool` discovery, same tool names) and
 * runs the mover directly, so a failure is the mover's own typed verdict instead
 * of something an agent turn swallowed. It stays skipped unless `MCPFABRIC_URL`
 * is set, so the normal suite never needs a running game.
 *
 * Run against a configured environment (bot client bridge wrapped by MCP):
 *
 * ```powershell
 * $env:MCPFABRIC_URL = 'http://127.0.0.1:25600/mcp'
 * $env:OV5_GOAL = '150,120,-17'
 * pnpm -F @proj-airi/stage-tamagotchi exec vitest run src/main/services/airi/game-host/movement/elytra-live.integration.test.ts
 * ```
 *
 * The bot must already stand on the launch pad, wear an elytra and carry
 * rockets: this probe drives the mover, it does not prepare the inventory.
 */

interface ToolResult { structuredContent?: unknown, content?: Array<{ type: string, text?: string }> }

const liveUrl = process.env.MCPFABRIC_URL
const liveToken = process.env.MCPFABRIC_TOKEN
const goalText = process.env.OV5_GOAL ?? '150,120,-17'

function recordOf(result: ToolResult): Record<string, unknown> {
  const structured = result.structuredContent
  if (structured !== null && typeof structured === 'object' && !Array.isArray(structured))
    return structured as Record<string, unknown>
  const text = (result.content ?? [])
    .filter(item => item.type === 'text' && typeof item.text === 'string')
    .map(item => item.text)
    .join('')
  return text.trim() ? JSON.parse(text) as Record<string, unknown> : {}
}

describe.runIf(Boolean(liveUrl))('mcpfabric live elytra takeoff (OV-5)', () => {
  it('launches from flat ground through the launch macro and reports its phases', async () => {
    const transport = new StreamableHTTPClientTransport(
      new URL(liveUrl!),
      liveToken ? { requestInit: { headers: { Authorization: `Bearer ${liveToken}` } } } : {},
    )
    const client = new Client({ name: 'proj-airi:ov5-live', version: '0.0.0' })
    await client.connect(transport)

    try {
      const listed = await client.listTools()
      const tools = new Set(listed.tools.map(tool => tool.name))
      const callTool = async (name: string, args: Record<string, unknown>) =>
        recordOf(await client.callTool({ name, arguments: args }) as ToolResult)

      const status = await callTool('get_status', {})
      const self = await callTool('get_self', {})
      const dimension = typeof status.dimension === 'string'
        ? status.dimension
        : typeof self.dimension === 'string' ? self.dimension : undefined
      const [x, y, z] = goalText.split(',').map(Number)

      const trail: string[] = []
      const port = createMcpMovementPort(callTool, {
        dimension: () => dimension,
        connectionGeneration: () => 1,
        hasTool: name => tools.has(name),
      })
      // The launch macro is the point of this probe: without its three tools the
      // mover falls back to the edge run, which cannot lift off flat ground.
      expect(tools.has('elytra_launch')).toBe(true)

      const result = await runElytraMove({
        port,
        goal: { x: x!, y: y!, z: z! },
        tolerance: 4,
        ...(dimension ? { world: { worldId: 'live-probe', dimension, mapVersion: 'live' } } : {}),
        deps: { sleep: async (ms: number) => new Promise(resolve => setTimeout(resolve, ms)) },
        debug: (message: string) => {
          trail.push(message)
          console.info(`[ov5] ${message}`)
        },
      })

      console.info(`[ov5] result ${JSON.stringify(result)}`)
      const joined = trail.join('\n')
      // The acceptance fact: the takeoff went through the macro, not the edge run.
      expect(joined).toContain('elytra launch phase=')
      expect(joined).toContain('elytra deployed via launched')
      expect(result.status).toBe('reached')
    }
    finally {
      await client.close()
    }
  }, 240_000)
})
