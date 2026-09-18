/**
 * L-01: a same-name replacement entity must not take over a running follow.
 *
 * Summons a NoAI sheep named "Lumi" (A), follows it by name through the AIRI
 * app (CDP), removes A mid-follow, then summons a second sheep with the same
 * name (B) further east. The follow keeps the uuid resolved at command start,
 * so it must NOT walk to B, and it must end with a typed reason.
 *
 * Usage: node l01-same-name.mjs <outPath>
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const outPath = process.argv[2] ?? 'l01-same-name.json'
const SERVER_PORT = 25602
const CLIENT_PORT = 25600
const CDP_PORT = 9222
const BOT = 'airitest'
const KEEP = 3
const LABEL = 'Lumi'
const SHEEP_NBT = `{CustomName:'"${LABEL}"',CustomNameVisible:1b,NoAI:1b,Silent:1b,PersistenceRequired:1b}`
const START = { x: 76.5, y: 75, z: -28.5 }
const A_POS = { x: 82.5, y: 75, z: -28.5 }
const B_POS = { x: 91.5, y: 75, z: -28.5 }
const QUERY_CENTER = { x: 84.5, y: 75, z: -28.5 }

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

function horizontal(a, b) {
  return Math.hypot(a.x - b.x, a.z - b.z)
}

const server = new Client({ name: 'l01-server', version: '1.0.0' })
await server.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${SERVER_PORT}/mcp`)))
const game = new Client({ name: 'l01-game', version: '1.0.0' })
await game.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${CLIENT_PORT}/mcp`)))

const evidence = {
  id: 'L-01',
  startedAt: new Date().toISOString(),
  fixture: { label: LABEL, keepDistance: KEEP, start: START, a: A_POS, b: B_POS },
  steps: [],
  samples: [],
  receipt: undefined,
  cleanup: [],
  verdict: 'unknown',
  notes: [],
}

function note(message) {
  evidence.notes.push(`${new Date().toISOString()} ${message}`)
  console.log(message)
}

async function call(client, name, args, { tolerateError = false } = {}) {
  const result = await client.callTool({ name, arguments: args })
  if (result.isError === true && !tolerateError)
    throw new Error(`${name} failed: ${textOf(result).slice(0, 300)}`)
  return result
}

async function querySheep() {
  const result = await call(server, 'query_entities', {
    center: QUERY_CENTER,
    radius: 24,
    includePlayers: false,
    maxResults: 100,
  })
  const record = structuredOf(result)
  const list = Array.isArray(record?.entities) ? record.entities : []
  return list.filter(entry => entry.name === LABEL).map(entry => ({
    uuid: entry.uuid,
    x: Number(entry.x),
    y: Number(entry.y),
    z: Number(entry.z),
  }))
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

async function readReceipt() {
  const current = await evalJs('typeof window.__l01Result === "string" ? window.__l01Result : JSON.stringify(window.__l01Result)')
  if (current === 'pending')
    return undefined
  return JSON.parse(current)
}

let uuidA
let uuidB
let originalBotPos

try {
  // Cleanup any sheep left by earlier runs, then clear hostile mobs near the bot.
  await call(server, 'run_command', { command: 'kill @e[type=minecraft:sheep,name=Lumi]' }, { tolerateError: true })
  originalBotPos = await botPosition()
  evidence.steps.push({ step: 'original-bot-position', position: originalBotPos })

  await call(server, 'teleport_player', { player: BOT, x: START.x, y: START.y, z: START.z, yaw: -90, pitch: 0 })
  await call(server, 'run_command', { command: 'execute at airitest run kill @e[type=!minecraft:player,distance=..24]' }, { tolerateError: true })
  await call(server, 'run_command', { command: 'effect give airitest minecraft:instant_health 1 10 true' }, { tolerateError: true })
  await call(server, 'run_command', { command: 'effect give airitest minecraft:saturation 1 10 true' }, { tolerateError: true })
  await new Promise(resolve => setTimeout(resolve, 1200))

  await call(server, 'summon_entity', { type: 'minecraft:sheep', x: A_POS.x, y: A_POS.y, z: A_POS.z, nbt: SHEEP_NBT })
  await new Promise(resolve => setTimeout(resolve, 600))
  const first = await querySheep()
  if (first.length !== 1)
    throw new Error(`expected exactly one ${LABEL} after summon, found ${first.length}`)
  uuidA = first[0].uuid
  evidence.fixture.uuidA = uuidA
  evidence.steps.push({ step: 'summon-A', uuid: uuidA, position: first[0] })

  const botBefore = await botPosition()
  const distAStart = horizontal(botBefore, first[0])
  evidence.steps.push({ step: 'follow-start', bot: botBefore, distanceToA: distAStart })

  await waitForProbe()
  const payload = JSON.stringify({ target: LABEL, keepDistance: KEEP, timeoutSeconds: 40 })
  await evalJs(`window.__l01Result = 'pending'
window.__AIRI_GAME_HOST_SMOKE__.executeGameTool('game_follow', ${payload})
  .then(result => { window.__l01Result = result })
  .catch(error => { window.__l01Result = { error: String(error) } })
'started'`)

  // Phase 1: the follow must actually approach A (positive control).
  const phase1Start = Date.now()
  let minDistA = Number.POSITIVE_INFINITY
  while (Date.now() - phase1Start < 4200) {
    const bot = await botPosition()
    const sheep = await querySheep()
    const a = sheep.find(entry => entry.uuid === uuidA)
    const distA = a ? horizontal(bot, a) : undefined
    if (distA !== undefined)
      minDistA = Math.min(minDistA, distA)
    evidence.samples.push({ phase: 'a-alive', t: Date.now() - phase1Start, bot, distA, sheep })
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  evidence.steps.push({ step: 'phase1-control', distAStart, minDistA })

  // Remove A and confirm it is gone.
  const removedAAt = Date.now()
  await call(server, 'remove_entity', { uuid: uuidA })
  await new Promise(resolve => setTimeout(resolve, 400))
  const afterRemove = await querySheep()
  evidence.steps.push({ step: 'remove-A', remaining: afterRemove })

  // Summon B with the same name at a different position.
  await call(server, 'summon_entity', { type: 'minecraft:sheep', x: B_POS.x, y: B_POS.y, z: B_POS.z, nbt: SHEEP_NBT })
  await new Promise(resolve => setTimeout(resolve, 600))
  const second = await querySheep()
  const b = second.find(entry => entry.uuid !== uuidA)
  if (!b)
    throw new Error('summoned B not found by name')
  uuidB = b.uuid
  evidence.fixture.uuidB = uuidB
  evidence.steps.push({ step: 'summon-B', uuid: uuidB, position: b })

  // Phase 2: sample until the command resolves. B must stay far.
  let minDistB = Number.POSITIVE_INFINITY
  let receipt
  const phase2Start = Date.now()
  while (Date.now() - phase2Start < 50_000) {
    const bot = await botPosition()
    const distB = horizontal(bot, b)
    minDistB = Math.min(minDistB, distB)
    const pendingReceipt = await readReceipt()
    evidence.samples.push({ phase: 'b-present', t: Date.now() - removedAAt, bot, distB, pending: pendingReceipt === undefined })
    if (pendingReceipt !== undefined) {
      receipt = pendingReceipt
      break
    }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  evidence.receipt = receipt
  evidence.steps.push({ step: 'phase2-result', minDistB, resolvedAfterMs: receipt ? Date.now() - removedAAt : undefined })

  const endReason = receipt?.endReason ?? receipt?.error ?? receipt?.result?.endReason
  const typedEndReasons = ['target_offline', 'target_lost', 'target_not_in_read', 'entity_unloaded', 'waiting_for_target', 'locator_unavailable']
  const controlPassed = minDistA <= KEEP + 1.2
  const takeover = minDistB <= KEEP + 2
  const typedEnd = typedEndReasons.includes(endReason)
  const bounded = receipt !== undefined && (Date.now() - removedAAt) <= 30_000
  evidence.analysis = { endReason, controlPassed, minDistA, minDistB, takeover, typedEnd, bounded }
  evidence.verdict = controlPassed && !takeover && typedEnd && bounded ? 'PASS' : 'FAIL'
  if (!controlPassed)
    evidence.notes.push('control: the follow did not approach A within keepDistance + 1.2')
  if (takeover)
    evidence.notes.push('takeover: the bot approached the replacement entity B')
  if (!typedEnd)
    evidence.notes.push(`typed end missing: endReason=${JSON.stringify(endReason)}`)
  if (!bounded)
    evidence.notes.push('bounded finish missing or slower than 30s')
}
catch (error) {
  evidence.error = String(error)
  evidence.verdict = 'ERROR'
  console.error(error)
}
finally {
  try {
    if (uuidB)
      evidence.cleanup.push(await call(server, 'remove_entity', { uuid: uuidB }, { tolerateError: true }).then(() => `removed B ${uuidB}`))
  }
  catch {}
  try {
    await call(server, 'run_command', { command: 'kill @e[type=minecraft:sheep,name=Lumi]' }, { tolerateError: true })
    const remaining = await querySheep()
    evidence.cleanup.push({ step: 'lumi-remaining', remaining })
  }
  catch {}
  try {
    if (originalBotPos)
      await call(server, 'teleport_player', { player: BOT, x: originalBotPos.x, y: originalBotPos.y, z: originalBotPos.z, yaw: 0, pitch: 0 })
  }
  catch {}
  ws.close()
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, JSON.stringify(evidence, null, 2))
  console.log(JSON.stringify({
    verdict: evidence.verdict,
    endReason: evidence.analysis?.endReason,
    controlPassed: evidence.analysis?.controlPassed,
    minDistA: evidence.analysis?.minDistA,
    minDistB: evidence.analysis?.minDistB,
    takeover: evidence.analysis?.takeover,
    typedEnd: evidence.analysis?.typedEnd,
    bounded: evidence.analysis?.bounded,
    receipt: evidence.receipt,
  }, null, 2))
  await game.close()
  await server.close()
}
