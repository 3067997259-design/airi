/**
 * F-01 spot check: a follow with keepDistance 3 must park on the keep ring,
 * not walk onto or through the target.
 *
 * Fixture: a NoAI sheep 6 blocks from the bot on the corridor platform.
 * Before the fix the follow ended 0.00–0.92 blocks from the target; after the
 * fix the stand point is a ring at keepDistance, so the final distance should
 * sit near 3 (tolerance 0.75 plus movement).
 *
 * Usage: node f01-standoff-check.mjs <outPath>
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const outPath = process.argv[2] ?? 'f01-standoff-check.json'
const SERVER_PORT = 25602
const CLIENT_PORT = 25600
const CDP_PORT = 9222
const BOT = 'airitest'
const LABEL = 'Lumi'
const KEEP = 3
const SHEEP_NBT = `{CustomName:'"${LABEL}"',CustomNameVisible:1b,NoAI:1b,Silent:1b,PersistenceRequired:1b}`
const START = { x: 76.5, y: 75, z: -28.5 }
const SHEEP = { x: 82.5, y: 75, z: -28.5 }

const evidence = {
  id: 'F-01',
  startedAt: new Date().toISOString(),
  fixture: { label: LABEL, keepDistance: KEEP, start: START, sheep: SHEEP },
  steps: [],
  samples: [],
  receipt: undefined,
  verdict: 'unknown',
}

function note(message) {
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

const server = new Client({ name: 'f01-server', version: '1.0.0' })
await server.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${SERVER_PORT}/mcp`)))
const game = new Client({ name: 'f01-game', version: '1.0.0' })
await game.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${CLIENT_PORT}/mcp`)))

async function call(client, name, args, { tolerateError = false } = {}) {
  const result = await client.callTool({ name, arguments: args })
  if (result.isError === true && !tolerateError)
    throw new Error(`${name} failed: ${textOf(result).slice(0, 300)}`)
  return result
}

async function botPosition() {
  const record = structuredOf(await call(game, 'get_self', {}))
  return { x: Number(record.x), y: Number(record.y), z: Number(record.z) }
}

async function sheepPosition() {
  const result = await call(server, 'query_entities', {
    center: { x: 80, y: 75, z: -28 },
    radius: 24,
    includePlayers: false,
    maxResults: 50,
  })
  const record = structuredOf(result)
  const list = Array.isArray(record?.entities) ? record.entities : []
  const match = list.find(entry => entry.name === LABEL)
  return match ? { x: Number(match.x), y: Number(match.y), z: Number(match.z), uuid: match.uuid } : undefined
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
  await call(server, 'run_command', { command: `kill @e[type=minecraft:sheep,name=${LABEL}]` }, { tolerateError: true })
  await call(server, 'teleport_player', { player: BOT, x: START.x, y: START.y, z: START.z, yaw: -90, pitch: 0 })
  await call(server, 'run_command', { command: 'effect give airitest minecraft:instant_health 1 10 true' }, { tolerateError: true })
  await new Promise(resolve => setTimeout(resolve, 1000))

  await call(server, 'summon_entity', { type: 'minecraft:sheep', x: SHEEP.x, y: SHEEP.y, z: SHEEP.z, nbt: SHEEP_NBT })
  await new Promise(resolve => setTimeout(resolve, 600))
  const sheep = await sheepPosition()
  if (!sheep)
    throw new Error('sheep not found after summon')
  evidence.steps.push({ step: 'start', sheep, distance: horizontal(START, sheep) })

  await waitForProbe()
  await evalJs(`window.__f01Result = 'pending'
window.__AIRI_GAME_HOST_SMOKE__.executeGameTool('game_follow', { target: '${LABEL}', keepDistance: ${KEEP}, timeoutSeconds: 12 })
  .then(result => { window.__f01Result = result })
  .catch(error => { window.__f01Result = { error: String(error) } })
'started'`)

  let receipt
  let minDistance = Number.POSITIVE_INFINITY
  let finalDistance
  const startedAt = Date.now()
  for (;;) {
    const bot = await botPosition()
    const at = await sheepPosition()
    const distance = at ? horizontal(bot, at) : undefined
    if (distance !== undefined) {
      minDistance = Math.min(minDistance, distance)
      finalDistance = distance
    }
    const current = await evalJs('typeof window.__f01Result === "string" ? window.__f01Result : JSON.stringify(window.__f01Result)')
    evidence.samples.push({ t: Date.now() - startedAt, bot, sheep: at, distance, pending: current === 'pending' })
    if (current !== 'pending') {
      receipt = JSON.parse(current)
      break
    }
    if (Date.now() - startedAt > 40_000)
      break
    await new Promise(resolve => setTimeout(resolve, 250))
  }

  evidence.receipt = receipt
  evidence.analysis = {
    endReason: receipt?.endReason ?? receipt?.error,
    minDistance,
    finalDistance,
    parkedOnRing: minDistance >= KEEP - 1.5,
    walkedOntoTarget: minDistance <= 0.75,
  }
  evidence.verdict = evidence.analysis.parkedOnRing && !evidence.analysis.walkedOntoTarget ? 'PASS' : 'FAIL'
  note(`F-01 check: endReason=${evidence.analysis.endReason} min=${minDistance.toFixed(2)} final=${finalDistance?.toFixed(2)} -> ${evidence.verdict}`)
}
catch (error) {
  evidence.error = String(error)
  evidence.verdict = 'ERROR'
  console.error(error)
}
finally {
  try {
    await call(server, 'run_command', { command: `kill @e[type=minecraft:sheep,name=${LABEL}]` }, { tolerateError: true })
  }
  catch {}
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, JSON.stringify(evidence, null, 2))
  console.log(JSON.stringify({ verdict: evidence.verdict, analysis: evidence.analysis }, null, 2))
  ws.close()
  await game.close()
  await server.close()
}
