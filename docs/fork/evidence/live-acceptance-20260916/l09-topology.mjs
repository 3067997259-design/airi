/**
 * L-09: dual-endpoint topology for the target detail read.
 *
 * Facts collected live:
 * - `get_entity` on the server endpoint (25602) for a loaded entity;
 * - `get_entity` on the client endpoint (25600) for the same entity;
 * - `get_self` on both endpoints (client-only tool).
 *
 * Typed degradation: start a tracked follow while both endpoints are alive,
 * then stop the server MCP process mid-follow. Fine reads go through the
 * SERVER_FIRST routing, so they fail; the follow must end bounded with a typed
 * `locator_unavailable`, never a false `target_lost`, and never crash.
 *
 * Leaves 25602 stopped; the caller restarts mcp-wrap-25602 afterwards.
 *
 * Usage: node l09-topology.mjs <outPath>
 */
import { execSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const outPath = process.argv[2] ?? 'l09-topology.json'
const SERVER_PORT = 25602
const CLIENT_PORT = 25600
const CDP_PORT = 9222
const BOT = 'airitest'
const LABEL = 'Lumi'
const SHEEP_NBT = `{CustomName:'"${LABEL}"',CustomNameVisible:1b,NoAI:1b,Silent:1b,PersistenceRequired:1b}`
const START = { x: 76.5, y: 75, z: -28.5 }
const SHEEP = { x: 84.5, y: 75, z: -28.5 }

const evidence = {
  id: 'L-09',
  startedAt: new Date().toISOString(),
  facts: {},
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

function summarizeDetail(result) {
  const record = structuredOf(result)
  if (!record)
    return { isError: result?.isError === true, keys: [] }
  return {
    isError: result?.isError === true,
    keys: Object.keys(record).sort(),
    fallFlying: record.fallFlying,
    onGround: record.onGround,
    bounds: record.bounds,
    sourceTick: record.sourceTick,
    dimension: record.dimension,
    name: record.name,
  }
}

const server = new Client({ name: 'l09-server', version: '1.0.0' })
await server.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${SERVER_PORT}/mcp`)))
const game = new Client({ name: 'l09-game', version: '1.0.0' })
await game.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${CLIENT_PORT}/mcp`)))

async function call(client, name, args, { tolerateError = false } = {}) {
  const result = await client.callTool({ name, arguments: args })
  if (result.isError === true && !tolerateError)
    throw new Error(`${name} failed: ${textOf(result).slice(0, 300)}`)
  return result
}

function killPort(port) {
  const out = execSync('netstat -ano -p tcp').toString()
  const line = out.split(/\r?\n/).find(candidate => candidate.includes(`:${port}`) && candidate.includes('LISTENING'))
  const pid = line?.trim().split(/\s+/).pop()
  if (!pid)
    throw new Error(`no listener on port ${port}`)
  execSync(`taskkill /PID ${pid} /F`)
  return pid
}

async function botPosition() {
  const record = structuredOf(await call(game, 'get_self', {}))
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
  await call(server, 'run_command', { command: `kill @e[type=minecraft:sheep,name=${LABEL}]` }, { tolerateError: true })
  await call(server, 'teleport_player', { player: BOT, x: START.x, y: START.y, z: START.z, yaw: -90, pitch: 0 })
  await call(server, 'run_command', { command: 'effect give airitest minecraft:instant_health 1 10 true' }, { tolerateError: true })
  await new Promise(resolve => setTimeout(resolve, 800))
  await call(server, 'summon_entity', { type: 'minecraft:sheep', x: SHEEP.x, y: SHEEP.y, z: SHEEP.z, nbt: SHEEP_NBT })
  await new Promise(resolve => setTimeout(resolve, 600))
  const list = structuredOf(await call(server, 'query_entities', { center: { x: 80, y: 75, z: -28 }, radius: 24, includePlayers: false, maxResults: 50 }))
  const sheep = (list?.entities ?? []).find(entry => entry.name === LABEL)
  if (!sheep)
    throw new Error('sheep not found after summon')

  // Facts: the same detail read through both endpoints, plus a client-only tool.
  evidence.facts.serverGetEntity = summarizeDetail(await call(server, 'get_entity', { uuid: sheep.uuid }, { tolerateError: true }))
  evidence.facts.clientGetEntity = summarizeDetail(await call(game, 'get_entity', { uuid: sheep.uuid }, { tolerateError: true }))
  evidence.facts.clientGetSelf = summarizeDetail(await call(game, 'get_self', {}, { tolerateError: true }))
  evidence.facts.serverGetSelf = summarizeDetail(await call(server, 'get_self', {}, { tolerateError: true }))
  note(`server get_entity keys=${evidence.facts.serverGetEntity.keys.length} client get_entity isError=${evidence.facts.clientGetEntity.isError} server get_self isError=${evidence.facts.serverGetSelf.isError}`)

  await waitForProbe()
  await evalJs(`window.__l09Follow = 'pending'
window.__AIRI_GAME_HOST_SMOKE__.executeGameTool('game_follow', { target: '${LABEL}', keepDistance: 3, timeoutSeconds: 45 })
  .then(result => { window.__l09Follow = result })
  .catch(error => { window.__l09Follow = { error: String(error) } })
'started'`)

  const startedAt = Date.now()
  while (Date.now() - startedAt < 3000) {
    evidence.samples.push({ phase: 'alive', t: Date.now() - startedAt, bot: await botPosition() })
    await new Promise(resolve => setTimeout(resolve, 250))
  }

  const killedPid = killPort(SERVER_PORT)
  evidence.steps.push({ step: 'kill-server-endpoint', pid: killedPid })
  note(`killed 25602 listener pid=${killedPid}`)

  let receipt
  const deadline = Date.now() + 40_000
  while (Date.now() < deadline) {
    const current = await evalJs('typeof window.__l09Follow === "string" ? window.__l09Follow : JSON.stringify(window.__l09Follow)')
    evidence.samples.push({ phase: 'server-down', t: Date.now() - startedAt, bot: await botPosition(), pending: current === 'pending' })
    if (current !== 'pending') {
      receipt = JSON.parse(current)
      break
    }
    await new Promise(resolve => setTimeout(resolve, 500))
  }

  evidence.receipt = receipt
  const endReason = receipt?.endReason ?? receipt?.error
  evidence.analysis = {
    endReason,
    met: receipt?.postCondition?.met,
    degradedAfterMs: Date.now() - startedAt,
  }
  evidence.verdict = endReason === 'locator_unavailable' ? 'PASS' : 'FAIL'
  note(`L-09 degraded follow: endReason=${endReason} met=${receipt?.postCondition?.met} -> ${evidence.verdict}`)
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
  try {
    await server.close()
  }
  catch {}
}
