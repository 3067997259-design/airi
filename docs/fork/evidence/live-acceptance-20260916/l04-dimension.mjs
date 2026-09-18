/**
 * L-04: the target walks through a nether portal while a ground follow runs.
 *
 * Phase 1 expects a typed `target_dimension_changed` end (never movement into
 * the wrong dimension). Phase 2 waits for the target to return to the
 * overworld and starts a second follow to prove recovery.
 *
 * Usage: node l04-dimension.mjs <outPath>
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const outPath = process.argv[2] ?? 'l04-dimension.json'
const SERVER_PORT = 25602
const CLIENT_PORT = 25600
const CDP_PORT = 9222
const TARGET = 'AfterRain'
const TARGET_UUID = 'd0451c6d-d02c-320a-b06b-495bc9b06605'
const KEEP = 3
const NETHER = 'minecraft:the_nether'

const evidence = {
  id: 'L-04',
  startedAt: new Date().toISOString(),
  fixture: { target: TARGET, keepDistance: KEEP },
  steps: [],
  samples: [],
  firstReceipt: undefined,
  secondReceipt: undefined,
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

const server = new Client({ name: 'l04-server', version: '1.0.0' })
await server.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${SERVER_PORT}/mcp`)))
const game = new Client({ name: 'l04-game', version: '1.0.0' })
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

async function playerState() {
  const record = structuredOf(await call(server, 'get_entity', { uuid: TARGET_UUID }, { tolerateError: true }))
  if (!record || record.error || record.isError)
    return undefined
  return {
    x: Number(record.x),
    y: Number(record.y),
    z: Number(record.z),
    dimension: typeof record.dimension === 'string' ? record.dimension : undefined,
  }
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

async function runFollow(label, timeoutSeconds, maxMs) {
  await evalJs(`window.__l04${label} = 'pending'
window.__AIRI_GAME_HOST_SMOKE__.executeGameTool('game_follow', { target: '${TARGET}', keepDistance: ${KEEP}, timeoutSeconds: ${timeoutSeconds} })
  .then(result => { window.__l04${label} = result })
  .catch(error => { window.__l04${label} = { error: String(error) } })
'started'`)
  const startedAt = Date.now()
  let receipt
  let netherSeenAt
  for (;;) {
    const bot = await botPosition()
    const player = await playerState()
    if (player?.dimension === NETHER && netherSeenAt === undefined)
      netherSeenAt = Date.now() - startedAt
    const current = await evalJs(`typeof window.__l04${label} === "string" ? window.__l04${label} : JSON.stringify(window.__l04${label})`)
    evidence.samples.push({
      phase: label,
      t: Date.now() - startedAt,
      bot,
      player,
      distance: player ? horizontal(bot, player) : undefined,
      pending: current === 'pending',
    })
    if (current !== 'pending') {
      receipt = JSON.parse(current)
      break
    }
    if (Date.now() - startedAt > maxMs)
      break
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  return { receipt, netherSeenAt, startedAt }
}

try {
  const bot = await botPosition()
  const player = await playerState()
  if (!player)
    throw new Error(`${TARGET} is not online`)
  evidence.steps.push({ step: 'start', bot, player, distance: horizontal(bot, player), dimension: player.dimension })

  await waitForProbe()

  const first = await runFollow('First', 60, 90_000)
  evidence.firstReceipt = first.receipt
  const firstReason = first.receipt?.endReason ?? first.receipt?.error
  const dimensionLatencyMs = first.netherSeenAt !== undefined ? Date.now() - first.startedAt - first.netherSeenAt : undefined
  evidence.steps.push({
    step: 'phase1',
    endReason: firstReason,
    netherSeenAtMs: first.netherSeenAt,
    receiptWithinMsOfNether: dimensionLatencyMs,
  })
  note(`phase1: endReason=${firstReason} netherSeenAt=${first.netherSeenAt}ms (receipt latency ${dimensionLatencyMs}ms)`)

  // Phase 2: wait for the target to return, then a second follow must work.
  let secondReceipt
  let secondReason
  if (firstReason === 'target_dimension_changed') {
    const returnDeadline = Date.now() + 120_000
    let back = false
    while (Date.now() < returnDeadline) {
      const state = await playerState()
      if (state?.dimension !== NETHER) {
        back = true
        break
      }
      await new Promise(resolve => setTimeout(resolve, 2000))
    }
    evidence.steps.push({ step: 'return', back })
    if (back) {
      const second = await runFollow('Second', 15, 30_000)
      secondReceipt = second.receipt
      secondReason = secondReceipt?.endReason ?? secondReceipt?.error
      evidence.steps.push({ step: 'phase2', endReason: secondReason })
      note(`phase2: endReason=${secondReason}`)
    }
  }

  evidence.secondReceipt = secondReceipt
  const dimensionFailure = ['target_dimension_changed', 'target_lost', 'target_not_in_read'].includes(secondReason)
  evidence.analysis = {
    firstEndReason: firstReason,
    firstMet: first.receipt?.postCondition?.met,
    netherSeenAtMs: first.netherSeenAt,
    secondEndReason: secondReason,
    secondDimensionFailure: dimensionFailure,
  }
  evidence.verdict = firstReason === 'target_dimension_changed' && (secondReceipt ? !dimensionFailure : false) ? 'PASS' : 'FAIL'
  note(`L-04: first=${firstReason} second=${secondReason} -> ${evidence.verdict}`)
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
