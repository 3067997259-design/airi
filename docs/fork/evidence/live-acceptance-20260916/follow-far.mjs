/**
 * F-02 check: start a follow while the player target is beyond the 64-block
 * entity-query radius and the entity read is NOT truncated. The name resolve
 * must still locate the player (CD-L1 design: "first name resolve may reuse
 * the existing query and the player list").
 *
 * Usage: node follow-far.mjs <ground|auto> <outPath> [timeoutSeconds]
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const mode = process.argv[2] === 'auto' ? 'auto' : 'ground'
const outPath = process.argv[3] ?? `follow-far-${mode}.json`
const timeoutSeconds = Number(process.argv[4] ?? 40)
const SERVER_PORT = 25602
const CLIENT_PORT = 25600
const CDP_PORT = 9222
const TARGET = 'AfterRain'
const TARGET_UUID = 'd0451c6d-d02c-320a-b06b-495bc9b06605'
const KEEP = 3

const evidence = {
  id: 'F-02',
  mode,
  startedAt: new Date().toISOString(),
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

const server = new Client({ name: 'far-server', version: '1.0.0' })
await server.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${SERVER_PORT}/mcp`)))
const game = new Client({ name: 'far-game', version: '1.0.0' })
await game.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${CLIENT_PORT}/mcp`)))

async function call(client, name, args, { tolerateError = false } = {}) {
  const result = await client.callTool({ name, arguments: args })
  if (result.isError === true && !tolerateError)
    throw new Error(`${name} failed: ${textOf(result).slice(0, 300)}`)
  return result
}

async function botState() {
  const record = structuredOf(await call(game, 'get_self', {}))
  return {
    x: Number(record.x),
    y: Number(record.y),
    z: Number(record.z),
    fallFlying: record.fallFlying === true,
    onGround: record.onGround === true,
  }
}

async function playerState() {
  const record = structuredOf(await call(server, 'get_entity', { uuid: TARGET_UUID }))
  if (!record)
    return undefined
  return {
    x: Number(record.x),
    y: Number(record.y),
    z: Number(record.z),
    fallFlying: record.fallFlying === true,
  }
}

async function countFireworks() {
  const record = structuredOf(await call(game, 'get_inventory', {}))
  const slots = [...(record?.hotbar ?? []), ...(record?.main ?? [])]
  return slots.filter(slot => slot?.id === 'minecraft:firework_rocket').reduce((total, slot) => total + Number(slot.count ?? 0), 0)
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
  const bot = await botState()
  const player = await playerState()
  if (!player)
    throw new Error(`${TARGET} is not online`)
  const crowded = structuredOf(await call(server, 'query_entities', {
    center: { x: bot.x, y: bot.y, z: bot.z },
    radius: 64,
    includePlayers: true,
    maxResults: 100,
  }))
  const list = Array.isArray(crowded?.entities) ? crowded.entities : []
  const truncated = Number(crowded?.total ?? -1) > Number(crowded?.returned ?? -1)
  const playerInList = list.some(entry => entry.uuid === TARGET_UUID)
  evidence.steps.push({
    step: 'start',
    bot,
    player,
    horizontal: horizontal(bot, player),
    entityTotal: crowded?.total,
    entityReturned: crowded?.returned,
    truncated,
    playerInReturnedList: playerInList,
  })
  note(`distance=${horizontal(bot, player).toFixed(1)} truncated=${truncated} playerInList=${playerInList}`)

  const fireworksBefore = await countFireworks()
  evidence.steps.push({ step: 'fireworks-before', count: fireworksBefore })

  await waitForProbe()
  await evalJs(`window.__farResult = 'pending'
window.__AIRI_GAME_HOST_SMOKE__.executeGameTool('game_follow', { target: '${TARGET}', keepDistance: ${KEEP}, timeoutSeconds: ${timeoutSeconds}, travelMode: '${mode}' })
  .then(result => { window.__farResult = result })
  .catch(error => { window.__farResult = { error: String(error) } })
'started'`)

  let receipt
  let minDistance = Number.POSITIVE_INFINITY
  let maxBotY = bot.y
  let fallFlyingSeen = false
  const startedAt = Date.now()
  for (;;) {
    const botNow = await botState()
    const playerNow = await playerState()
    const distance = playerNow ? horizontal(botNow, playerNow) : undefined
    if (distance !== undefined)
      minDistance = Math.min(minDistance, distance)
    maxBotY = Math.max(maxBotY, botNow.y)
    fallFlyingSeen = fallFlyingSeen || botNow.fallFlying
    const current = await evalJs('typeof window.__farResult === "string" ? window.__farResult : JSON.stringify(window.__farResult)')
    evidence.samples.push({ t: Date.now() - startedAt, bot: botNow, player: playerNow, distance, pending: current === 'pending' })
    if (current !== 'pending') {
      receipt = JSON.parse(current)
      break
    }
    if (Date.now() - startedAt > (timeoutSeconds + 20) * 1000)
      break
    await new Promise(resolve => setTimeout(resolve, 250))
  }

  const fireworksAfter = await countFireworks()
  evidence.receipt = receipt
  evidence.analysis = {
    endReason: receipt?.endReason ?? receipt?.error,
    resolvedAfterMs: Date.now() - startedAt,
    minDistance,
    maxBotY,
    fallFlyingSeen,
    fireworksUsed: Math.max(0, fireworksBefore - fireworksAfter),
  }
  const endReason = evidence.analysis.endReason
  evidence.verdict = endReason === 'target_lost' || endReason === 'target_not_in_read' ? 'RESOLVE-FAILED' : 'RESOLVED'
  note(`endReason=${endReason} after ${evidence.analysis.resolvedAfterMs}ms minDistance=${Number.isFinite(minDistance) ? minDistance.toFixed(1) : '?'} fallFlyingSeen=${fallFlyingSeen} fireworksUsed=${evidence.analysis.fireworksUsed}`)
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
