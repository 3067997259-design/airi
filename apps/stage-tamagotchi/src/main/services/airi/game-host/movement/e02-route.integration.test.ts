import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { describe, expect, it } from 'vitest'

import { FLIGHT_PROFILE_VERSION, resolveFlightPlannerSwitch } from '../flight/profile'
import { runElytraMove } from './elytra'
import { createMcpMovementPort } from './host-port'

/**
 * Live route runner for the river-canyon fixture (E-02 / E-07 / OV-5 venue).
 *
 * One run = teleport the bot onto the copper bridge deck, fly the whole route
 * with the production elytra mover, and record what happened. It deliberately
 * does NOT assert "reached": the point of an obstacle fixture is to find out
 * whether the mover handles each obstacle, and a typed failure plus its debug
 * trail is the evidence, not a red suite. The only hard assertion is that the
 * harness itself worked (the mover returned, and either flew or gave a reason).
 *
 * Skipped unless `MCPFABRIC_URL` is set.
 *
 * ```powershell
 * $env:MCPFABRIC_URL = 'http://127.0.0.1:25600/mcp'
 * $env:MCPFABRIC_SERVER_URL = 'http://127.0.0.1:25602/mcp'
 * $env:E02_RUNS = '5'
 * $env:E02_OUT = 'D:\airi\docs\fork\evidence\flight-venue-20260918\route-runs.jsonl'
 * pnpm -F @proj-airi/stage-tamagotchi exec vitest run src/main/services/airi/game-host/movement/e02-route.integration.test.ts
 * ```
 *
 * Environment:
 *   E02_START   bridge deck stand point, default `-1007,74,79`
 *   E02_GOAL    cave pad, default `-843,65,-266`
 *   E02_RUNS    how many runs, default 1
 *   E02_BUDGET_MS per-run wall-clock budget, default 150000
 *   E02_OUT     JSONL output path (appended, one line per run)
 */

interface ToolResult { structuredContent?: unknown, content?: Array<{ type: string, text?: string }> }

const liveUrl = process.env.MCPFABRIC_URL
const serverUrl = process.env.MCPFABRIC_SERVER_URL ?? 'http://127.0.0.1:25602/mcp'
const token = process.env.MCPFABRIC_TOKEN
const [startX, startY, startZ] = (process.env.E02_START ?? '-1007,74,79').split(',').map(Number)
const [goalX, goalY, goalZ] = (process.env.E02_GOAL ?? '-843,65,-266').split(',').map(Number)
const runs = Number(process.env.E02_RUNS ?? 1)
const budgetMs = Number(process.env.E02_BUDGET_MS ?? 150_000)
const outPath = process.env.E02_OUT ?? 'e02-route-runs.jsonl'

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

function positionOf(record: Record<string, unknown>): { x: number, y: number, z: number } | undefined {
  const nested = record.position
  const source = nested && typeof nested === 'object' && !Array.isArray(nested)
    ? nested as Record<string, unknown>
    : record
  const x = Number(source.x)
  const y = Number(source.y)
  const z = Number(source.z)
  return Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z) ? { x, y, z } : undefined
}

function rocketCount(inventory: Record<string, unknown>): number {
  let total = 0
  for (const key of ['hotbar', 'main'] as const) {
    const list = Array.isArray(inventory?.[key]) ? inventory[key] as Array<Record<string, unknown>> : []
    for (const item of list) {
      if (typeof item.id === 'string' && item.id.includes('firework_rocket'))
        total += Number(item.count) || 0
    }
  }
  const offhand = inventory?.offhand as Record<string, unknown> | undefined
  if (offhand && typeof offhand.id === 'string' && offhand.id.includes('firework_rocket'))
    total += Number(offhand.count) || 0
  return total
}

describe.runIf(Boolean(liveUrl))('river canyon route (E-02 live)', () => {
  it(`flies the fixture route ${runs}x and records each attempt`, async () => {
    const transport = new StreamableHTTPClientTransport(
      new URL(liveUrl!),
      token ? { requestInit: { headers: { Authorization: `Bearer ${token}` } } } : {},
    )
    const client = new Client({ name: 'proj-airi:e02-route', version: '0.0.0' })
    await client.connect(transport)
    const world = new Client({ name: 'proj-airi:e02-world', version: '0.0.0' })
    await world.connect(new StreamableHTTPClientTransport(new URL(serverUrl)))

    const callClient = async (name: string, args: Record<string, unknown>) =>
      recordOf(await client.callTool({ name, arguments: args }) as ToolResult)
    const callWorld = async (name: string, args: Record<string, unknown>) =>
      recordOf(await world.callTool({ name, arguments: args }) as ToolResult)
    /**
     * The production routing rule: a terrain read is a server-side tool.
     *
     * ROOT CAUSE this mirrors: the client bridge answers `get_blocks_region` with
     * `Bridge error [no_server]`, so a port wired to the client alone fails every
     * terrain read. That silently disabled the corridor and the rollout planner in
     * the first fixture runs (`corridor read_failed`, `rollout fell back to
     * heuristics`) and left the mover on the pre-B0 heuristics. `callGameTool` in
     * `game-host/index.ts` sends these names to the server bridge; this harness has
     * to do the same or it is not testing the production path.
     */
    const SERVER_FIRST_TOOLS = new Set([
      'get_block',
      'get_blocks_region',
      'get_break_evidence',
      'list_players',
      'teleport_player',
      'run_command',
    ])
    const callTool = async (name: string, args: Record<string, unknown>) =>
      SERVER_FIRST_TOOLS.has(name) ? await callWorld(name, args) : await callClient(name, args)
    const sleep = (ms: number): Promise<void> => new Promise((resolve) => {
      setTimeout(resolve, ms)
    })

    mkdirSync(dirname(outPath), { recursive: true })
    if (runs > 0)
      writeFileSync(outPath, '')

    try {
      const listed = await client.listTools()
      const tools = new Set(listed.tools.map(tool => tool.name))
      const status = await callTool('get_status', {})
      const self = await callTool('get_self', {})
      const dimension = typeof status.dimension === 'string'
        ? status.dimension
        : typeof self.dimension === 'string' ? self.dimension : undefined
      const port = createMcpMovementPort(callTool, {
        dimension: () => dimension,
        connectionGeneration: () => 1,
        hasTool: name => tools.has(name),
      })
      expect(tools.has('elytra_launch')).toBe(true)
      // The production switch: without it the mover flies the pre-B0 heuristics
      // and no corridor, which is not the path this venue is meant to test.
      const flightPlanner = resolveFlightPlannerSwitch(
        {
          planner: (process.env.E02_PLANNER ?? 'on') as 'off' | 'on',
          calibrated: process.env.E02_CALIBRATED !== 'false',
        },
        FLIGHT_PROFILE_VERSION,
      )
      console.info(`[e02] flight planner: ${flightPlanner ? `on (calibrated=${flightPlanner.calibrated})` : 'off (heuristics)'}`)

      for (let run = 1; run <= runs; run++) {
        await callWorld('teleport_player', { player: 'airitest', x: startX, y: startY, z: startZ })
        await sleep(2500)
        await callTool('stop_movement', {})
        // A run that starts below the mover's health floor is an automatic safety
        // landing, not a test of the route: the first fixture run after a crash
        // started at 4 HP and "flew" a 40-block circle back to the bridge.
        const preRun = await callTool('get_self', {})
        if (typeof preRun.health === 'number' && preRun.health <= 0) {
          // The fixture kills a survival bot that clips a bank, and a run on a
          // corpse tests nothing: respawn first, then heal.
          await callClient('respawn', {})
          await sleep(2500)
          await callWorld('teleport_player', { player: 'airitest', x: startX, y: startY, z: startZ })
          await sleep(2000)
        }
        if (typeof preRun.health === 'number' && preRun.health < 20) {
          await callWorld('run_command', { command: 'effect give airitest minecraft:instant_health 1 20 true' })
          await sleep(1500)
        }
        const healthAtStart = (await callTool('get_self', {})).health
        const inventoryBefore = await callTool('get_inventory', {})
        const rocketsBefore = rocketCount(inventoryBefore)
        const trail: string[] = []
        const samples: Array<{ at: number, x: number, y: number, z: number, health?: number, fallFlying?: boolean, onGround?: boolean }> = []
        const startedAt = Date.now()
        let stopReason: string | undefined
        // Independent sampling: the mover's own debug line has no health or
        // horizontal position, and a fixture run has to show where the damage
        // happened, not only where the flight ended.
        let sampling = { running: true }
        const sampler = (async () => {
          while (sampling.running) {
            try {
              const state = await callTool('get_self', {})
              const position = positionOf(state)
              if (position) {
                samples.push({
                  at: Date.now() - startedAt,
                  ...position,
                  ...(typeof state.health === 'number' ? { health: state.health } : {}),
                  ...(typeof state.fallFlying === 'boolean' ? { fallFlying: state.fallFlying } : {}),
                  ...(typeof state.onGround === 'boolean' ? { onGround: state.onGround } : {}),
                })
              }
            }
            catch {
              // A read during a teleport or a reconnect is not evidence; skip it.
            }
            await sleep(300)
          }
        })()

        const result = await runElytraMove({
          port,
          goal: { x: goalX!, y: goalY!, z: goalZ! },
          tolerance: 2,
          ...(flightPlanner ? { flightPlanner } : {}),
          ...(dimension ? { world: { worldId: 'fixture', dimension, mapVersion: 'live' } } : {}),
          shouldStop: () => {
            if (Date.now() - startedAt > budgetMs) {
              stopReason = 'budget'
              return true
            }
            return false
          },
          deps: { sleep },
          debug: (message: string) => {
            trail.push(message)
          },
        })
        sampling = { running: false }
        await sampler

        const after = await callTool('get_self', {})
        const inventoryAfter = await callTool('get_inventory', {})
        const finalPosition = positionOf(after)
        const horizontal = finalPosition ? Math.hypot(finalPosition.x - goalX!, finalPosition.z - goalZ!) : undefined
        const vertical = finalPosition ? finalPosition.y - goalY! : undefined
        const record = {
          run,
          at: new Date().toISOString(),
          startedAt: { x: startX, y: startY, z: startZ },
          healthAtStart,
          goal: { x: goalX, y: goalY, z: goalZ },
          status: result.status,
          detail: result.detail,
          failure: (result as { failure?: string }).failure,
          durationMs: Date.now() - startedAt,
          stopReason,
          rocketsBefore,
          rocketsAfter: rocketCount(inventoryAfter),
          finalPosition,
          horizontalGap: horizontal,
          verticalGap: vertical,
          onGround: after.onGround,
          health: after.health,
          minHealth: samples.reduce((min, sample) => sample.health !== undefined ? Math.min(min, sample.health) : min, 20),
          samples,
          trail,
        }
        appendFileSync(outPath, `${JSON.stringify(record)}\n`)
        console.info(`[e02] run ${run}: status=${result.status}${result.detail ? ` (${result.detail})` : ''} ${((Date.now() - startedAt) / 1000).toFixed(1)}s rockets ${rocketsBefore}->${record.rocketsAfter} final y=${finalPosition?.y} health=${after.health} minHealth=${record.minHealth} gap=${horizontal?.toFixed(1)}/${vertical?.toFixed(1)}`)
        for (const line of trail.slice(0, 6))
          console.info(`[e02]   ${line}`)
        for (const sample of samples.filter((sample, index) => index % 5 === 0 || (sample.health ?? 20) < 20))
          console.info(`[e02]   t=${(sample.at / 1000).toFixed(1)}s  ${sample.x.toFixed(0)},${sample.y.toFixed(0)},${sample.z.toFixed(0)}  hp=${sample.health ?? '?'} fly=${sample.fallFlying} ground=${sample.onGround}`)

        expect(result.status).toBeTruthy()
      }
    }
    finally {
      await client.close()
      await world.close()
    }
  }, 60_000 + runs * (budgetMs + 10_000))
})
