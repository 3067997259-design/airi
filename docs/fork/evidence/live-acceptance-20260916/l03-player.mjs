/**
 * L-03 sub-case (a): the human player target is crowded out of the truncated
 * entity read, so the initial name resolve must fall back to the server player
 * list (CD-L1). Then the follow tracks the fixed uuid and closes to the keep
 * distance.
 *
 * Preconditions (verified, not assumed):
 * - the entity read centered on the bot is truncated (total > returned);
 * - AfterRain is NOT inside the returned 100 entries.
 *
 * Usage: node l03-player.mjs <outPath> [cleanup]
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const outPath = process.argv[2] ?? 'l03-player.json'
const cleanup = process.argv[3] === 'cleanup'
const SERVER_PORT = 25602
const CLIENT_PORT = 25600
const CDP_PORT = 9222
const BOT = 'airitest'
const TAG = 'airi-l03'
const TARGET_PLAYER = 'AfterRain'
const TARGET_UUID = 'd0451c6d-d02c-320a-b06b-495bc9b06605'
const KEEP = 3

const evidence = {
  id: 'L-03-a',
  startedAt: new Date().toISOString(),
  fixture: { target: TARGET_PLAYER, keepDistance: KEEP },
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

const server = new Client({ name: 'l03a-server', version: '1.0.0' })
await server.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${SERVER_PORT}/mcp`)))
const game = new Client({ name: 'l03a-game', version: '1.0.0' })
await game.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${CLIENT_PORT}/mcp`)))

async function call(client, name, args, { tolerateError = false } = {}) {
  const result = await client.callTool({ name, arguments: args })
  if (result.isError === true && !tolerateError)
    throw new Error(`${name} failed: ${textOf(result).slice(0, 300)}`)
  return result
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

async function playerPosition() {
  const result = await call(server, 'list_players', {})
  const record = structuredOf(result)
  const players = Array.isArray(record?.players) ? record.players : []
  const match = players.find(player => player.uuid === TARGET_UUID)
  if (!match)
    return undefined
  const position = match.position ?? match
  return { x: Number(position.x), y: Number(position.y), z: Number(position.z) }
}

function horizontal(a, b) {
  return Math.hypot(a.x - b.x, a.z - b.z)
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
  const bot = await botPosition()
  const player = await playerPosition()
  if (!player)
    throw new Error(`${TARGET_PLAYER} is not online`)
  evidence.steps.push({ step: 'start', bot, player, distance: horizontal(bot, player) })

  const crowded = await queryNearby(bot)
  const playerInList = crowded.entities.some(entry => entry.uuid === TARGET_UUID)
  const truncated = crowded.total > crowded.returned
  evidence.steps.push({
    step: 'precondition',
    total: crowded.total,
    returned: crowded.returned,
    truncated,
    playerInReturnedList: playerInList,
    cutoffDistance: crowded.entities[crowded.entities.length - 1]?.distance,
  })
  if (!truncated || playerInList) {
    evidence.verdict = 'PRECONDITION-FAILED'
    note(`precondition failed: truncated=${truncated} playerInReturnedList=${playerInList}`)
    throw new Error('precondition failed')
  }
  note(`precondition ok: total=${crowded.total} returned=${crowded.returned} cutoff=${crowded.entities[crowded.entities.length - 1]?.distance?.toFixed(1)} playerDistance=${horizontal(bot, player).toFixed(1)}`)

  await waitForProbe()
  await evalJs(`window.__l03aResult = 'pending'
window.__AIRI_GAME_HOST_SMOKE__.executeGameTool('game_follow', { target: '${TARGET_PLAYER}', keepDistance: ${KEEP}, timeoutSeconds: 25 })
  .then(result => { window.__l03aResult = result })
  .catch(error => { window.__l03aResult = { error: String(error) } })
'started'`)

  let receipt
  let minDistance = Number.POSITIVE_INFINITY
  const startedAt = Date.now()
  for (;;) {
    const botNow = await botPosition()
    const playerNow = await playerPosition()
    const distance = playerNow ? horizontal(botNow, playerNow) : undefined
    if (distance !== undefined)
      minDistance = Math.min(minDistance, distance)
    const current = await evalJs('typeof window.__l03aResult === "string" ? window.__l03aResult : JSON.stringify(window.__l03aResult)')
    evidence.samples.push({ t: Date.now() - startedAt, bot: botNow, player: playerNow, distance, pending: current === 'pending' })
    if (current !== 'pending') {
      receipt = JSON.parse(current)
      break
    }
    if (Date.now() - startedAt > 45_000)
      break
    await new Promise(resolve => setTimeout(resolve, 250))
  }

  evidence.receipt = receipt
  const endReason = receipt?.endReason ?? receipt?.error
  const failedResolution = endReason === 'target_lost' || endReason === 'target_not_in_read'
  const reached = minDistance <= KEEP + 1.5
  evidence.analysis = {
    endReason,
    resolvedAfterMs: Date.now() - startedAt,
    minDistance,
    reached,
    failedResolution,
  }
  evidence.verdict = !failedResolution && reached ? 'PASS' : 'FAIL'
  note(`sub-case (a) endReason=${endReason} minDistance=${minDistance.toFixed(2)} reached=${reached}`)

  if (cleanup) {
    // Empty loot first so the kill does not flood the courtyard with drops.
    await call(server, 'run_command', { command: `execute as @e[tag=${TAG}] run data merge entity @s {DeathLootTable:"minecraft:empty"}` }, { tolerateError: true })
    await call(server, 'run_command', { command: `kill @e[type=minecraft:sheep,tag=${TAG}]` }, { tolerateError: true })
    await call(server, 'run_command', { command: 'kill @e[type=minecraft:sheep,name=Lumi]' }, { tolerateError: true })
    await call(server, 'run_command', { command: 'execute positioned 89 75 -19 run kill @e[type=minecraft:item,distance=..20]' }, { tolerateError: true })
    evidence.cleanup = 'done'
    note('cleanup done')
  }
}
catch (error) {
  if (evidence.verdict === 'unknown')
    evidence.verdict = 'ERROR'
  evidence.error = String(error)
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
