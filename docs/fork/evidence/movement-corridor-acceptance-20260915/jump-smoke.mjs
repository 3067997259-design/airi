/**
 * Direct smoke test for the mod's per-tick jump task (Step 3).
 *
 * Teleports the bot to a named stand, submits one edge through `jump_plan`,
 * polls `jump_plan_status` until it settles, then prints the final status
 * (phase, per-edge landings, settle errors).
 *
 * Usage: node jump-smoke.mjs <startX> <startY> <startZ> <targetX> <targetY> <targetZ> [dirX] [dirZ]
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const [sxr, syr, szr, txr, tyr, tzr, dxr, dzr] = process.argv.slice(2)
const start = { x: Number(sxr), y: Number(syr), z: Number(szr) }
const target = { x: Number(txr), y: Number(tyr), z: Number(tzr) }
const dir = { x: Number(dxr ?? (target.x - start.x)), z: Number(dzr ?? (target.z - start.z)) }

const server = new Client({ name: 'jump-smoke-server', version: '1.0.0' })
await server.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:25602/mcp')))
const game = new Client({ name: 'jump-smoke-game', version: '1.0.0' })
await game.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:25600/mcp')))

const text = result => (result.content ?? []).map(part => part.text).join('')
const json = (result) => {
  const raw = text(result)
  try {
    return JSON.parse(raw)
  }
  catch {
    return raw
  }
}

const teleported = await server.callTool({
  name: 'teleport_player',
  arguments: { player: 'airitest', x: start.x + 0.5, y: start.y, z: start.z + 0.5, yaw: 0, pitch: 0 },
})
console.log('[teleport]', teleported.isError ? text(teleported) : 'ok')
await new Promise(resolve => setTimeout(resolve, 1200))

const started = await game.callTool({
  name: 'jump_plan',
  arguments: {
    edgesJson: JSON.stringify([{
      edgeId: 'smoke-0',
      fromX: start.x + 0.5,
      fromY: start.y,
      fromZ: start.z + 0.5,
      targetX: target.x + 0.5,
      targetY: target.y,
      targetZ: target.z + 0.5,
      takeoffX: start.x + 0.5,
      takeoffZ: start.z + 0.5,
      dirX: dir.x,
      dirZ: dir.z,
    }]),
    deadlineMs: Date.now() + 8000,
  },
})
console.log('[start]', JSON.stringify(json(started)).slice(0, 240))

for (let poll = 0; poll < 60; poll++) {
  await new Promise(resolve => setTimeout(resolve, 250))
  const status = json(await game.callTool({ name: 'jump_plan_status', arguments: {} }))
  if (poll % 4 === 0)
    console.log(`[poll ${poll}]`, JSON.stringify(status).slice(0, 240))
  if (status && status.state !== 'running') {
    console.log('[final]', JSON.stringify(status))
    await game.close().catch(() => {})
    await server.close().catch(() => {})
    process.exit(0)
  }
}
console.log('[final] timed out polling')
process.exit(1)
