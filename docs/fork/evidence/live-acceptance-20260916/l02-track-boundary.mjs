/**
 * L-02 + L-06: the target crosses the 64-block boundary outward and returns
 * while a follow runs. The tracker must keep updating without reporting the
 * target lost, and the follow must not spin while the target is away.
 *
 * Runs `travelMode: auto` so a gliding target holds the F-05 guard (no ground
 * chase into the air and no launch assessment starvation). If the target turns
 * airborne WITHOUT gliding (creative hover), the run cancels early instead of
 * letting the ground legs chase an airborne ring.
 *
 * Usage: node l02-track-boundary.mjs <outPath> [timeoutSeconds]
 */
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const outPath = process.argv[2] ?? 'l02-track-boundary.json'
const timeoutSeconds = Number(process.argv[3] ?? 240)
const SERVER_PORT = 25602
const CLIENT_PORT = 25600
const CDP_PORT = 9222
const TARGET = 'AfterRain'
const TARGET_UUID = 'd0451c6d-d02c-320a-b06b-495bc9b06605'
const KEEP = 3
const AIRI_LOG = `${process.env.TEMP}\\airi-preview8.log`

const evidence = {
  id: 'L-02+L-06',
  startedAt: new Date().toISOString(),
  fixture: { target: TARGET, keepDistance: KEEP, timeoutSeconds, travelMode: 'auto' },
  steps: [],
  samples: [],
  receipt: undefined,
  logAnalysis: undefined,
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

const server = new Client({ name: 'l02-server', version: '1.0.0' })
await server.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${SERVER_PORT}/mcp`)))
const game = new Client({ name: 'l02-game', version: '1.0.0' })
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

async function playerPosition() {
  const record = structuredOf(await call(server, 'get_entity', { uuid: TARGET_UUID }))
  if (!record || record.error)
    return undefined
  return { x: Number(record.x), y: Number(record.y), z: Number(record.z), fallFlying: record.fallFlying === true }
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
    throw new Error(`${TARGET} is not online`)
  const startDistance = horizontal(bot, player)
  evidence.steps.push({ step: 'start', bot, player, distance: startDistance })

  const logOffset = statSync(AIRI_LOG).size

  await waitForProbe()
  await evalJs(`window.__l02Result = 'pending'
window.__AIRI_GAME_HOST_SMOKE__.executeGameTool('game_follow', { target: '${TARGET}', keepDistance: ${KEEP}, timeoutSeconds: ${timeoutSeconds}, travelMode: 'auto' })
  .then(result => { window.__l02Result = result })
  .catch(error => { window.__l02Result = { error: String(error) } })
'started'`)

  const startedAt = Date.now()
  let receipt
  let maxDistance = startDistance
  let minDistanceAfterMax = Number.POSITIVE_INFINITY
  let maxSeenAt = 0
  let hoverSamples = 0
  let aborted = false
  for (;;) {
    const botNow = await botPosition()
    const playerNow = await playerPosition()
    const distance = playerNow ? horizontal(botNow, playerNow) : undefined
    if (distance !== undefined) {
      if (distance > maxDistance) {
        maxDistance = distance
        maxSeenAt = Date.now() - startedAt
      }
      if (maxDistance > 80 && distance < minDistanceAfterMax)
        minDistanceAfterMax = distance
    }

    // Safety: an airborne target that is NOT gliding gets no auto guard, so
    // cancel before the ground legs chase an airborne ring.
    if (playerNow && playerNow.fallFlying !== true && (playerNow.y - botNow.y) > 6)
      hoverSamples += 1
    else
      hoverSamples = 0
    if (hoverSamples >= 2) {
      await evalJs(`window.__AIRI_GAME_HOST_SMOKE__.executeGameTool('game_cancel', {}).catch(() => {})`).catch(() => {})
      evidence.steps.push({ step: 'abort-creative-hover' })
      note('target airborne without gliding; cancelled to avoid an unprotected air chase')
      aborted = true
      break
    }

    const current = await evalJs('typeof window.__l02Result === "string" ? window.__l02Result : JSON.stringify(window.__l02Result)')
    evidence.samples.push({ t: Date.now() - startedAt, bot: botNow, player: playerNow, distance, pending: current === 'pending' })
    if (current !== 'pending') {
      receipt = JSON.parse(current)
      break
    }
    if (Date.now() - startedAt > (timeoutSeconds + 20) * 1000)
      break
    await new Promise(resolve => setTimeout(resolve, 250))
  }

  const logTail = readFileSync(AIRI_LOG, 'utf8').slice(logOffset)
  const stands = [...logTail.matchAll(/follow: leg to stand ([-\d.]+),([-\d.]+) \(target ([-\d.]+),([-\d.]+)\)/g)]
    .map(match => ({
      standToTarget: Math.hypot(Number(match[1]) - Number(match[3]), Number(match[2]) - Number(match[4])),
    }))
  const fineStands = stands.filter(stand => stand.standToTarget < 5).length
  const coarseStands = stands.filter(stand => stand.standToTarget >= 6).length
  const lostLines = (logTail.match(/waiting_for_target|target_lost|target_not_in_read|locator_unavailable|entity_unloaded/g) ?? []).length
  const airLines = (logTail.match(/air-follow [a-z-]+ d=/g) ?? []).length

  evidence.receipt = receipt
  evidence.logAnalysis = { legCount: stands.length, fineStands, coarseStands, lostLines, airLines }
  const endReason = receipt?.endReason ?? (aborted ? 'cancelled-by-guard' : receipt?.error)
  const crossedOut = maxDistance > 80
  const returned = crossedOut && minDistanceAfterMax < 40
  const trackingFailure = ['target_lost', 'target_not_in_read', 'waiting_for_target', 'locator_unavailable', 'entity_unloaded'].includes(endReason)
  evidence.analysis = {
    endReason,
    startDistance,
    maxDistance: Number(maxDistance.toFixed(1)),
    minDistanceAfterMax: Number.isFinite(minDistanceAfterMax) ? Number(minDistanceAfterMax.toFixed(1)) : undefined,
    maxSeenAtMs: maxSeenAt,
    crossedOut,
    returned,
    trackingFailure,
    airLines,
    follow: receipt?.follow ? { endReason: receipt.follow.endReason, launches: receipt.follow.launchAttempts, loss: receipt.follow.lossCount, source: receipt.follow.finalTargetObservation?.source } : undefined,
  }
  evidence.verdict = crossedOut && returned && !trackingFailure ? 'PASS' : 'FAIL'
  note(`L-02/L-06: endReason=${endReason} maxDist=${maxDistance.toFixed(1)} backTo=${Number.isFinite(minDistanceAfterMax) ? minDistanceAfterMax.toFixed(1) : 'n/a'} fine=${fineStands} coarse=${coarseStands} air=${airLines} lost=${lostLines} -> ${evidence.verdict}`)
}
catch (error) {
  evidence.error = String(error)
  evidence.verdict = 'ERROR'
  console.error(error)
}
finally {
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, JSON.stringify(evidence, null, 2))
  console.log(JSON.stringify({ verdict: evidence.verdict, analysis: evidence.analysis, logAnalysis: evidence.logAnalysis }, null, 2))
  ws.close()
  await game.close()
  await server.close()
}
