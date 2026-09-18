/**
 * L-10: after a cancel the command must converge bounded, the mover must stop,
 * and the terminal receipt must not revive.
 *
 * Fixture: NoAI sheep 8 blocks away; follow with a 60 s bound, cancel ~4 s in,
 * then watch the bot for 8 s. Observable release proxy: no displacement, no
 * running status, the same terminal receipt on game_status.
 *
 * Usage: node l10-cancel-release.mjs <outPath>
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const outPath = process.argv[2] ?? 'l10-cancel-release.json'
const SERVER_PORT = 25602
const CLIENT_PORT = 25600
const CDP_PORT = 9222
const BOT = 'airitest'
const LABEL = 'Lumi'
const KEEP = 3
const SHEEP_NBT = `{CustomName:'"${LABEL}"',CustomNameVisible:1b,NoAI:1b,Silent:1b,PersistenceRequired:1b}`
const START = { x: 76.5, y: 75, z: -28.5 }
const SHEEP = { x: 84.5, y: 75, z: -28.5 }

const evidence = {
  id: 'L-10',
  startedAt: new Date().toISOString(),
  fixture: { label: LABEL, keepDistance: KEEP, start: START, sheep: SHEEP },
  steps: [],
  samples: [],
  followReceipt: undefined,
  cancelReceipt: undefined,
  finalStatus: undefined,
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

const server = new Client({ name: 'l10-server', version: '1.0.0' })
await server.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${SERVER_PORT}/mcp`)))
const game = new Client({ name: 'l10-game', version: '1.0.0' })
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
  return match ? { x: Number(match.x), y: Number(match.y), z: Number(match.z) } : undefined
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
  await new Promise(resolve => setTimeout(resolve, 800))
  await call(server, 'summon_entity', { type: 'minecraft:sheep', x: SHEEP.x, y: SHEEP.y, z: SHEEP.z, nbt: SHEEP_NBT })
  await new Promise(resolve => setTimeout(resolve, 600))
  const sheep = await sheepPosition()
  if (!sheep)
    throw new Error('sheep not found after summon')
  evidence.steps.push({ step: 'start', sheep, distance: horizontal(START, sheep) })

  await waitForProbe()
  await evalJs(`window.__l10Follow = 'pending'
window.__AIRI_GAME_HOST_SMOKE__.executeGameTool('game_follow', { target: '${LABEL}', keepDistance: ${KEEP}, timeoutSeconds: 60 })
  .then(result => { window.__l10Follow = result })
  .catch(error => { window.__l10Follow = { error: String(error) } })
'started'`)

  const startedAt = Date.now()
  while (Date.now() - startedAt < 4000) {
    const bot = await botPosition()
    const at = await sheepPosition()
    evidence.samples.push({ phase: 'walking', t: Date.now() - startedAt, bot, distance: at ? horizontal(bot, at) : undefined })
    await new Promise(resolve => setTimeout(resolve, 250))
  }

  const cancelAt = Date.now()
  await evalJs(`window.__l10Cancel = 'pending'
window.__AIRI_GAME_HOST_SMOKE__.executeGameTool('game_cancel', {})
  .then(result => { window.__l10Cancel = result })
  .catch(error => { window.__l10Cancel = { error: String(error) } })
'sent'`)

  let followReceipt
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const current = await evalJs('typeof window.__l10Follow === "string" ? window.__l10Follow : JSON.stringify(window.__l10Follow)')
    if (current !== 'pending') {
      followReceipt = JSON.parse(current)
      break
    }
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  const cancelledLatencyMs = Date.now() - cancelAt
  const cancelCurrent = await evalJs('typeof window.__l10Cancel === "string" ? window.__l10Cancel : JSON.stringify(window.__l10Cancel)')
  evidence.followReceipt = followReceipt
  evidence.cancelReceipt = cancelCurrent === 'pending' ? undefined : JSON.parse(cancelCurrent)
  evidence.steps.push({ step: 'cancel', latencyMs: cancelledLatencyMs })

  // Post-cancel watch: the mover must stop and the terminal receipt must hold.
  let previous = await botPosition()
  let displacement = 0
  const watchUntil = Date.now() + 8000
  while (Date.now() < watchUntil) {
    const bot = await botPosition()
    displacement += Math.hypot(bot.x - previous.x, bot.z - previous.z)
    evidence.samples.push({ phase: 'post-cancel', t: Date.now() - cancelAt, bot, distance: undefined })
    previous = bot
    await new Promise(resolve => setTimeout(resolve, 250))
  }

  const status = JSON.parse(await evalJs(`window.__AIRI_GAME_HOST_SMOKE__.executeGameTool('game_status', {})
    .then(result => JSON.stringify(result))
    .catch(error => JSON.stringify({ error: String(error) }))`))
  evidence.finalStatus = { endReason: status?.endReason, commandId: status?.commandId }

  const endReason = followReceipt?.endReason ?? followReceipt?.error
  evidence.analysis = {
    endReason,
    cancelledLatencyMs,
    postCancelDisplacement: Number(displacement.toFixed(3)),
    finalStatusEndReason: status?.endReason,
  }
  evidence.verdict = endReason === 'cancelled'
    && cancelledLatencyMs <= 5_000
    && displacement <= 0.75
    && status?.endReason !== 'running'
    ? 'PASS'
    : 'FAIL'
  note(`L-10: endReason=${endReason} cancelLatency=${cancelledLatencyMs}ms displacement=${displacement.toFixed(2)} status=${status?.endReason} -> ${evidence.verdict}`)
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
