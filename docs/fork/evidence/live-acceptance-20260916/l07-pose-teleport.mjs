/**
 * L-07: target pose facts and the teleport jump.
 *
 * Phase 1 (facts): sample the server detail read for the walking target.
 * Phase 2 (teleport): run a follow, teleport the target 100+ blocks across the
 * same dimension, and verify the tracker keeps updating (no target_lost) while
 * the sample stream shows a >16-block jump inside one second.
 * Phase 3 (riding): teleport the target back near a saddled horse, wait for
 * `riding === true`, run a short follow and record the riding facts.
 *
 * Usage: node l07-pose-teleport.mjs <outPath>
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const outPath = process.argv[2] ?? 'l07-pose-teleport.json'
const SERVER_PORT = 25602
const CLIENT_PORT = 25600
const CDP_PORT = 9222
const TARGET = 'AfterRain'
const TARGET_UUID = 'd0451c6d-d02c-320a-b06b-495bc9b06605'
const KEEP = 3
const TELEPORT_DEST = { x: 50, y: 78, z: 33 }
const HORSE_NEAR = { x: 90, y: 75, z: -17 }

const evidence = {
  id: 'L-07',
  startedAt: new Date().toISOString(),
  fixture: { target: TARGET, keepDistance: KEEP, teleportDest: TELEPORT_DEST },
  steps: [],
  samples: [],
  receipts: {},
  facts: {},
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

const server = new Client({ name: 'l07-server', version: '1.0.0' })
await server.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${SERVER_PORT}/mcp`)))
const game = new Client({ name: 'l07-game', version: '1.0.0' })
await game.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${CLIENT_PORT}/mcp`)))

async function call(client, name, args, { tolerateError = false } = {}) {
  const result = await client.callTool({ name, arguments: args })
  if (result.isError === true && !tolerateError)
    throw new Error(`${name} failed: ${textOf(result).slice(0, 300)}`)
  return result
}

function factsOf(record) {
  if (!record)
    return undefined
  return {
    onGround: record.onGround,
    fallFlying: record.fallFlying,
    riding: record.riding,
    bounds: record.bounds,
    dimension: record.dimension,
    sourceTick: record.sourceTick,
  }
}

async function playerState() {
  const record = structuredOf(await call(server, 'get_entity', { uuid: TARGET_UUID }, { tolerateError: true }))
  if (!record || record.error || record.isError)
    return undefined
  return {
    x: Number(record.x),
    y: Number(record.y),
    z: Number(record.z),
    facts: factsOf(record),
  }
}

async function botPosition() {
  const record = structuredOf(await call(game, 'get_self', {}))
  return { x: Number(record.x), y: Number(record.y), z: Number(record.z) }
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

const TRACKING_FAILURES = ['target_lost', 'target_not_in_read', 'waiting_for_target', 'locator_unavailable', 'entity_unloaded', 'target_offline']

async function sampleUntilReceipt(key, maxMs) {
  const startedAt = Date.now()
  let receipt
  let jumpAt
  let previous
  for (;;) {
    const bot = await botPosition()
    const player = await playerState()
    if (player && previous) {
      const jump = Math.hypot(player.x - previous.x, player.y - previous.y, player.z - previous.z)
      if (jump > 16 && jumpAt === undefined)
        jumpAt = Date.now() - startedAt
    }
    if (player)
      previous = player
    const current = await evalJs(`typeof window.__l07${key} === "string" ? window.__l07${key} : JSON.stringify(window.__l07${key})`)
    evidence.samples.push({ phase: key, t: Date.now() - startedAt, bot, player, distance: player ? horizontal(bot, player) : undefined, pending: current === 'pending' })
    if (current !== 'pending') {
      receipt = JSON.parse(current)
      break
    }
    if (Date.now() - startedAt > maxMs)
      break
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  return { receipt, jumpAt, startedAt }
}

async function startFollow(key, timeoutSeconds) {
  await evalJs(`window.__l07${key} = 'pending'
window.__AIRI_GAME_HOST_SMOKE__.executeGameTool('game_follow', { target: '${TARGET}', keepDistance: ${KEEP}, timeoutSeconds: ${timeoutSeconds} })
  .then(result => { window.__l07${key} = result })
  .catch(error => { window.__l07${key} = { error: String(error) } })
'started'`)
}

try {
  const player = await playerState()
  if (!player)
    throw new Error(`${TARGET} is not online`)
  evidence.facts.walking = player.facts
  evidence.steps.push({ step: 'facts-walking', facts: player.facts })

  await waitForProbe()

  // Phase 2: teleport jump while following.
  await startFollow('Teleport', 90)
  await new Promise(resolve => setTimeout(resolve, 5000))
  await call(server, 'run_command', { command: `execute in minecraft:overworld run tp ${TARGET} ${TELEPORT_DEST.x} ${TELEPORT_DEST.y} ${TELEPORT_DEST.z}` })
  evidence.steps.push({ step: 'teleport', dest: TELEPORT_DEST })
  const teleport = await sampleUntilReceipt('Teleport', 90_000)
  evidence.receipts.teleport = teleport.receipt
  const teleportReason = teleport.receipt?.endReason ?? teleport.receipt?.error
  evidence.steps.push({ step: 'teleport-result', endReason: teleportReason, jumpAtMs: teleport.jumpAt })

  // Phase 3: riding. Teleport the target back near the horse and wait for the mount.
  const horses = structuredOf(await call(server, 'query_entities', { center: HORSE_NEAR, radius: 16, includePlayers: false, maxResults: 20, types: ['minecraft:horse'] }))
  const horse = (horses?.entities ?? [])[0]
  if (horse) {
    await call(server, 'run_command', { command: `execute in minecraft:overworld run tp ${TARGET} ${(Number(horse.x) + 1.5).toFixed(2)} ${Number(horse.y).toFixed(2)} ${Number(horse.z).toFixed(2)}` })
    evidence.steps.push({ step: 'teleport-back', horse: { x: horse.x, y: horse.y, z: horse.z } })
  }

  const rideDeadline = Date.now() + 240_000
  let riding = false
  while (Date.now() < rideDeadline) {
    const state = await playerState()
    if (state?.facts.riding === true) {
      riding = true
      evidence.facts.riding = state.facts
      break
    }
    await new Promise(resolve => setTimeout(resolve, 3000))
  }
  evidence.steps.push({ step: 'riding', riding })

  let ridingReason
  if (riding) {
    await startFollow('Riding', 12)
    const ridingRun = await sampleUntilReceipt('Riding', 25_000)
    evidence.receipts.riding = ridingRun.receipt
    ridingReason = ridingRun.receipt?.endReason ?? ridingRun.receipt?.error
    evidence.steps.push({ step: 'riding-result', endReason: ridingReason })
  }

  evidence.analysis = {
    teleportEndReason: teleportReason,
    teleportJumpDetectedMs: teleport.jumpAt,
    teleportTrackingLoss: TRACKING_FAILURES.includes(teleportReason),
    ridingFact: riding,
    ridingEndReason: ridingReason,
    ridingTrackingLoss: ridingReason ? TRACKING_FAILURES.includes(ridingReason) : undefined,
  }
  evidence.verdict = !evidence.analysis.teleportTrackingLoss
    && teleport.jumpAt !== undefined
    && riding
    && !evidence.analysis.ridingTrackingLoss
    ? 'PASS'
    : 'FAIL'
  note(`L-07: teleport=${teleportReason} jumpAt=${teleport.jumpAt}ms riding=${riding} ridingEnd=${ridingReason} -> ${evidence.verdict}`)
}
catch (error) {
  evidence.error = String(error)
  evidence.verdict = 'ERROR'
  console.error(error)
}
finally {
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, JSON.stringify(evidence, null, 2))
  console.log(JSON.stringify({ verdict: evidence.verdict, analysis: evidence.analysis, facts: evidence.facts }, null, 2))
  ws.close()
  await game.close()
  await server.close()
}
