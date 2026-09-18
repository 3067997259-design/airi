/**
 * CD-B1 static baseline v2: 10/20/28 blocks at height 0, 30 single-shot
 * commands per condition. A 400-HP NoAI sheep absorbs the hits; a hit is a
 * health drop, and each receipt's ballistics fields are recorded for later
 * calibration.
 *
 * Usage: node b1-static2.mjs <outPath>
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const outPath = process.argv[2] ?? 'b1-static2.json'
const SERVER_PORT = 25602
const CLIENT_PORT = 25600
const CDP_PORT = 9222
const BOT = 'airitest'
const TARGET = 'Target'
const TARGET_POS = { x: 96.5, y: 75, z: -29.5 }
const STANDS = [
  { label: '10 blocks', x: 86.5, y: 75, z: -29.5 },
  { label: '20 blocks', x: 76.5, y: 75, z: -29.5 },
  { label: '28 blocks (diagonal)', x: 74.5, y: 75, z: -11.5 },
]
const SHOTS_PER_CONDITION = 30
const TARGET_NBT = `{CustomName:'"${TARGET}"',CustomNameVisible:1b,NoAI:1b,Silent:1b,PersistenceRequired:1b,Health:400f,attributes:[{id:"minecraft:generic.max_health",base:400}]}`

const evidence = {
  id: 'B-01 static baseline v2',
  startedAt: new Date().toISOString(),
  fixture: { target: TARGET_POS, stands: STANDS, chargeTicks: 20, shotsPerCondition: SHOTS_PER_CONDITION },
  rounds: [],
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

const server = new Client({ name: 'b1b-server', version: '1.0.0' })
await server.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${SERVER_PORT}/mcp`)))
const game = new Client({ name: 'b1b-game', version: '1.0.0' })
await game.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${CLIENT_PORT}/mcp`)))

async function call(client, name, args, { tolerateError = false } = {}) {
  const result = await client.callTool({ name, arguments: args })
  if (result.isError === true && !tolerateError)
    throw new Error(`${name} failed: ${textOf(result).slice(0, 300)}`)
  return result
}

async function runCommand(command) {
  return await call(server, 'run_command', { command }, { tolerateError: true })
}

async function targetState() {
  const record = structuredOf(await call(server, 'query_entities', { center: TARGET_POS, radius: 12, includePlayers: false, maxResults: 20, types: ['minecraft:sheep'] }, { tolerateError: true }))
  const entry = (record?.entities ?? []).find(candidate => candidate.name === TARGET)
  return entry ? { health: Number(entry.health), uuid: entry.uuid } : undefined
}

async function summonTarget() {
  await runCommand(`kill @e[type=minecraft:sheep,name=${TARGET}]`)
  await runCommand(`summon minecraft:sheep ${TARGET_POS.x} ${TARGET_POS.y} ${TARGET_POS.z} ${TARGET_NBT}`)
  await new Promise(resolve => setTimeout(resolve, 600))
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

function evalTool(tool, payload, maxMs = 60_000) {
  return evalJs(`window.__b1bResult = 'pending'
window.__AIRI_GAME_HOST_SMOKE__.executeGameTool('${tool}', ${JSON.stringify(payload)})
  .then(result => { window.__b1bResult = result })
  .catch(error => { window.__b1bResult = { error: String(error) } })
'started'`).then(async () => {
    const deadline = Date.now() + maxMs
    for (;;) {
      const current = await evalJs('typeof window.__b1bResult === "string" ? window.__b1bResult : JSON.stringify(window.__b1bResult)')
      if (current !== 'pending')
        return JSON.parse(current)
      if (Date.now() > deadline)
        return { error: 'timeout waiting for tool result' }
      await new Promise(resolve => setTimeout(resolve, 200))
    }
  })
}

function yawTo(from, to) {
  return Math.atan2(-(to.x - from.x), to.z - from.z) * 180 / Math.PI
}

try {
  await waitForProbe()
  await runCommand('time set day')
  await runCommand('weather clear')
  await runCommand(`clear ${BOT} minecraft:bow`)
  await runCommand(`clear ${BOT} minecraft:crossbow`)
  await runCommand(`give ${BOT} minecraft:bow 1`)
  await runCommand(`give ${BOT} minecraft:arrow 300`)

  for (const stand of STANDS) {
    await call(server, 'teleport_player', { player: BOT, x: stand.x, y: stand.y, z: stand.z, yaw: yawTo(stand, TARGET_POS), pitch: 0 })
    await new Promise(resolve => setTimeout(resolve, 700))
    const distance = Math.hypot(TARGET_POS.x - stand.x, TARGET_POS.z - stand.z)
    const shots = []
    for (let index = 0; index < SHOTS_PER_CONDITION; index++) {
      let before = await targetState()
      if (!before || before.health <= 0) {
        await summonTarget()
        before = await targetState()
      }
      const receipt = await evalTool('game_shoot', { target: TARGET, weapon: 'bow', maxShots: 1, chargeTicks: 20 })
      await new Promise(resolve => setTimeout(resolve, 900))
      const after = await targetState()
      const healthBefore = before?.health
      const healthAfter = after?.health
      const damage = healthBefore !== undefined && healthAfter !== undefined && healthAfter > 0 ? Math.max(0, healthBefore - healthAfter) : undefined
      const shot = receipt?.shot?.shots?.[0]
      shots.push({
        index: index + 1,
        endReason: receipt?.endReason,
        fired: shot !== undefined,
        verifiedBy: shot?.verifiedBy,
        hit: healthAfter === 0 || after === undefined ? true : damage !== undefined ? damage > 0 : undefined,
        damage,
        healthBefore,
        healthAfter,
        predictedFlightTicks: receipt?.shot?.predictedFlightTicks,
        closestDistance: receipt?.shot?.closestDistance,
        arc: receipt?.shot?.arc,
        aimSource: receipt?.shot?.aimSource,
        refusalReason: receipt?.shot?.refusalReason,
      })
      process.stdout.write(`${stand.label} shot ${index + 1}/${SHOTS_PER_CONDITION} hit=${shots.at(-1).hit} dmg=${damage}\r`)
    }
    const fired = shots.filter(shot => shot.fired).length
    const hits = shots.filter(shot => shot.hit === true).length
    evidence.rounds.push({
      stand: stand.label,
      distance: Number(distance.toFixed(1)),
      fired,
      hits,
      hitRate: fired > 0 ? Number((hits / fired).toFixed(3)) : undefined,
      shots,
    })
    note(`\n${stand.label}: fired=${fired} hits=${hits} rate=${evidence.rounds.at(-1).hitRate}`)
  }

  const totals = evidence.rounds.reduce((accumulator, round) => ({ fired: accumulator.fired + round.fired, hits: accumulator.hits + round.hits }), { fired: 0, hits: 0 })
  evidence.analysis = { ...totals, hitRate: totals.fired > 0 ? Number((totals.hits / totals.fired).toFixed(3)) : undefined }
  evidence.verdict = totals.fired >= 80 && totals.hits / Math.max(1, totals.fired) >= 0.5 ? 'PASS' : 'PARTIAL'
  note(`B-01 v2: fired=${totals.fired} hits=${totals.hits} -> ${evidence.verdict}`)
}
catch (error) {
  evidence.error = String(error)
  evidence.verdict = 'ERROR'
  console.error(error)
}
finally {
  try {
    await runCommand(`kill @e[type=minecraft:sheep,name=${TARGET}]`)
    await runCommand(`give ${BOT} minecraft:arrow 64`)
    await call(server, 'teleport_player', { player: BOT, x: 82.5, y: 75, z: -24.5, yaw: 0, pitch: 0 })
  }
  catch {}
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, JSON.stringify(evidence, null, 2))
  console.log(JSON.stringify({ verdict: evidence.verdict, analysis: evidence.analysis }, null, 2))
  ws.close()
  await game.close()
  await server.close()
}
