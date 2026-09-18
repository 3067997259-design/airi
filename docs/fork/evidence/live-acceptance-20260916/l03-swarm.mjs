/**
 * L-03 setup: crowd the entity query past its 100-entry cap and verify the
 * truncation semantics.
 *
 * Sub-case (b): follow a non-player target that is outside the returned
 * 100-entry list while the read is truncated. The honest result is
 * `target_not_in_read`, not `target_lost`.
 *
 * The swarm stays in place for sub-case (a), where the human player target is
 * also crowded out of the list and the player-list fallback must resolve it.
 *
 * Usage: node l03-swarm.mjs <outPath>
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const outPath = process.argv[2] ?? 'l03-swarm.json'
const SERVER_PORT = 25602
const CLIENT_PORT = 25600
const CDP_PORT = 9222
const BOT = 'airitest'
const TAG = 'airi-l03'
const SWARM_TARGET = 105
const BOT_START = { x: 92.5, y: 75, z: -27.5 }
const LUMI_POS = { x: 74.5, y: 90, z: -38.5 }
const GRID = { xFrom: 85, xTo: 93, zFrom: -25, zTo: -13 }
const REGION = { from: { x: 82, y: 74, z: -27 }, to: { x: 94, y: 77, z: -11 } }

const evidence = {
  id: 'L-03',
  startedAt: new Date().toISOString(),
  fixture: { tag: TAG, target: SWARM_TARGET, grid: GRID, lumi: LUMI_POS, botStart: BOT_START },
  steps: [],
  samples: [],
  receipt: undefined,
  verdict: 'unknown',
  notes: [],
}

function note(message) {
  evidence.notes.push(`${new Date().toISOString()} ${message}`)
  console.log(message)
}

function textOf(result) {
  return (result?.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n')
}

function structuredOf(result) {
  if (result?.structuredContent && typeof result.structuredContent === 'object')
    return result.structuredContent
  const text = textOf(result)
  if (!text)
    return undefined
  try {
    return JSON.parse(text)
  }
  catch {
    return undefined
  }
}

const server = new Client({ name: 'l03-server', version: '1.0.0' })
await server.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${SERVER_PORT}/mcp`)))
const game = new Client({ name: 'l03-game', version: '1.0.0' })
await game.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${CLIENT_PORT}/mcp`)))

async function call(client, name, args, { tolerateError = false } = {}) {
  const result = await client.callTool({ name, arguments: args })
  if (result.isError === true && !tolerateError)
    throw new Error(`${name} failed: ${textOf(result).slice(0, 300)}`)
  return result
}

async function readRegion() {
  const result = await call(server, 'get_blocks_region', REGION)
  const record = structuredOf(result)
  const blocks = Array.isArray(record?.blocks) ? record.blocks : []
  const occupied = new Set(blocks.map(block => `${block.x},${block.y},${block.z}`))
  return occupied
}

async function queryNearby(center, radius = 64, maxResults = 100) {
  const result = await call(server, 'query_entities', { center, radius, includePlayers: true, maxResults })
  const record = structuredOf(result)
  return {
    total: Number(record?.total ?? -1),
    returned: Number(record?.returned ?? -1),
    entities: Array.isArray(record?.entities) ? record.entities : [],
  }
}

async function botPosition() {
  const result = await call(game, 'get_self', {})
  const record = structuredOf(result)
  return { x: Number(record.x), y: Number(record.y), z: Number(record.z) }
}

const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
const target = targets.find(item => item.type === 'page' && item.url.includes('synced-leader=true'))
if (!target)
  throw new Error('AIRI leader window not found on CDP')
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
let messageId = 0
const pending = new Map()
ws.onmessage = (event) => {
  const message = JSON.parse(event.data)
  if (pending.has(message.id)) {
    pending.get(message.id)(message)
    pending.delete(message.id)
  }
}
async function evalJs(expression) {
  const id = ++messageId
  ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
  const message = await new Promise(resolve => pending.set(id, resolve))
  if (message.result?.exceptionDetails)
    throw new Error(message.result.exceptionDetails.exception?.description ?? 'eval failed')
  return message.result?.result?.value
}
async function waitForProbe() {
  await evalJs(`location.hash = '#/devtools/game-host'; 'ok'`)
  await new Promise(resolve => setTimeout(resolve, 1500))
  for (let attempt = 0; attempt < 12; attempt++) {
    const ready = await evalJs('window.__AIRI_GAME_HOST_SMOKE__ ? "ready" : "missing"')
    if (ready === 'ready')
      return
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  throw new Error('game host smoke probe missing')
}

try {
  await call(server, 'run_command', { command: `kill @e[type=minecraft:sheep,tag=${TAG}]` }, { tolerateError: true })
  await call(server, 'run_command', { command: 'kill @e[type=minecraft:sheep,name=Lumi]' }, { tolerateError: true })
  await call(server, 'teleport_player', { player: BOT, x: BOT_START.x, y: BOT_START.y, z: BOT_START.z, yaw: -90, pitch: 0 })
  await call(server, 'run_command', { command: 'effect give airitest minecraft:instant_health 1 10 true' }, { tolerateError: true })
  await call(server, 'run_command', { command: 'effect give airitest minecraft:saturation 1 10 true' }, { tolerateError: true })
  await new Promise(resolve => setTimeout(resolve, 1000))

  const occupied = await readRegion()
  const bot = await botPosition()
  evidence.steps.push({ step: 'start', bot, occupiedCells: occupied.size })

  const cells = []
  for (let z = GRID.zFrom; z <= GRID.zTo; z++) {
    for (let x = GRID.xFrom; x <= GRID.xTo; x++) {
      const feet = `${x},75,${z}`
      const head = `${x},76,${z}`
      const floor = `${x},74,${z}`
      if (occupied.has(feet) || occupied.has(head) || !occupied.has(floor))
        continue
      cells.push({ x: x + 0.5, y: 75, z: z + 0.5, distance: Math.hypot(x + 0.5 - bot.x, z + 0.5 - bot.z) })
    }
  }
  cells.sort((a, b) => a.distance - b.distance)
  const chosen = cells.slice(0, SWARM_TARGET)
  evidence.steps.push({ step: 'cells', valid: cells.length, chosen: chosen.length, maxDistance: chosen[chosen.length - 1]?.distance })

  let spawned = 0
  const spawnErrors = []
  for (const cell of chosen) {
    try {
      const result = await call(server, 'summon_entity', {
        type: 'minecraft:sheep',
        x: cell.x,
        y: cell.y,
        z: cell.z,
        nbt: `{NoAI:1b,Silent:1b,PersistenceRequired:1b,Tags:["${TAG}"]}`,
      })
      if (result.isError === true)
        spawnErrors.push(textOf(result).slice(0, 120))
      else
        spawned++
    }
    catch (error) {
      spawnErrors.push(String(error).slice(0, 120))
    }
  }
  evidence.steps.push({ step: 'spawn', spawned, errors: spawnErrors.length })
  note(`spawned ${spawned} tagged sheep, ${spawnErrors.length} errors`)

  await new Promise(resolve => setTimeout(resolve, 1500))
  const crowded = await queryNearby(bot)
  const afterRainInList = crowded.entities.some(entry => entry.uuid === 'd0451c6d-d02c-320a-b06b-495bc9b06605')
  const truncated = crowded.total > crowded.returned
  evidence.steps.push({
    step: 'truncation-check',
    total: crowded.total,
    returned: crowded.returned,
    truncated,
    afterRainInList,
    nearest: crowded.entities.slice(0, 3).map(entry => ({ name: entry.name, distance: entry.distance })),
    farthest: crowded.entities.slice(-2).map(entry => ({ name: entry.name, distance: entry.distance })),
  })
  note(`entities total=${crowded.total} returned=${crowded.returned} truncated=${truncated} afterRainInList=${afterRainInList}`)
  if (!truncated)
    note('WARNING: the entity read is not truncated; the L-03 premise failed')

  // Sub-case (b): a non-player target outside the returned list.
  await call(server, 'summon_entity', {
    type: 'minecraft:sheep',
    x: LUMI_POS.x,
    y: LUMI_POS.y,
    z: LUMI_POS.z,
    nbt: `{CustomName:'"Lumi"',CustomNameVisible:1b,NoAI:1b,Silent:1b,NoGravity:1b,PersistenceRequired:1b}`,
  })
  await new Promise(resolve => setTimeout(resolve, 600))
  const lumiProbe = await queryNearby({ x: LUMI_POS.x, y: LUMI_POS.y, z: LUMI_POS.z }, 8, 20)
  const lumi = lumiProbe.entities.find(entry => entry.name === 'Lumi')
  evidence.steps.push({ step: 'lumi-placed', lumi, lumiDistanceFromBot: lumi ? Math.hypot(lumi.x - bot.x, lumi.z - bot.z) : undefined })
  if (!lumi)
    throw new Error('Lumi not found after summon')

  // Re-read with Lumi present: the crowded read must still truncate and must
  // not carry either the far non-player target or the player.
  await new Promise(resolve => setTimeout(resolve, 800))
  const crowdedAgain = await queryNearby(bot)
  const lumiInReturned = crowdedAgain.entities.some(entry => entry.uuid === lumi.uuid)
  const afterRainInReturned = crowdedAgain.entities.some(entry => entry.uuid === 'd0451c6d-d02c-320a-b06b-495bc9b06605')
  evidence.steps.push({
    step: 'lumi-visibility',
    total: crowdedAgain.total,
    returned: crowdedAgain.returned,
    truncated: crowdedAgain.total > crowdedAgain.returned,
    lumiInReturnedList: lumiInReturned,
    afterRainInReturnedList: afterRainInReturned,
  })
  if (lumiInReturned)
    note('WARNING: Lumi is inside the returned list; the exclusion premise failed')

  await waitForProbe()
  await evalJs(`window.__l03Result = 'pending'
window.__AIRI_GAME_HOST_SMOKE__.executeGameTool('game_follow', { target: 'Lumi', keepDistance: 3, timeoutSeconds: 20 })
  .then(result => { window.__l03Result = result })
  .catch(error => { window.__l03Result = { error: String(error) } })
'started'`)

  let receipt
  const startedAt = Date.now()
  while (Date.now() - startedAt < 30_000) {
    const current = await evalJs('typeof window.__l03Result === "string" ? window.__l03Result : JSON.stringify(window.__l03Result)')
    if (current !== 'pending') {
      receipt = JSON.parse(current)
      break
    }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  evidence.receipt = receipt
  evidence.analysis = {
    endReason: receipt?.endReason ?? receipt?.error,
    resolvedAfterMs: Date.now() - startedAt,
    expected: 'target_not_in_read',
  }
  evidence.verdict = evidence.analysis.endReason === 'target_not_in_read' ? 'PASS' : 'FAIL'
  note(`sub-case (b) endReason=${evidence.analysis.endReason} after ${evidence.analysis.resolvedAfterMs}ms`)
}
catch (error) {
  evidence.error = String(error)
  evidence.verdict = 'ERROR'
  console.error(error)
}
finally {
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, JSON.stringify(evidence, null, 2))
  console.log(JSON.stringify({ verdict: evidence.verdict, analysis: evidence.analysis }, null, 2))
  ws.close()
  await game.close()
  await server.close()
}
