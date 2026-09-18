/**
 * CD-B1 static matrix on the dedicated range.
 *
 * Range: main platform x42-44, floor y140 (feet y141), z -64..-15.
 * +10 platform: y150 top (feet y151) at z -16..-14; -10 platform: y130 top
 * (feet y131) at z -16..-14.
 *
 * Conditions (shooter -> target): dy 0 at 10/20/40; target +10 above the
 * shooter at 10/20; target -10 below the shooter at 10/20; shooter on the +10
 * platform firing down at the main platform at 10/20/40. 10 shots each.
 *
 * Usage: node b1-range.mjs <outPath> [shotsPerCondition]
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const outPath = process.argv[2] ?? 'b1-range.json'
const SHOTS = Number(process.argv[3] ?? 10)
const SERVER_PORT = 25602
const CLIENT_PORT = 25600
const CDP_PORT = 9222
const BOT = 'airitest'
const TARGET = 'Target'
const TARGET_NBT = `{CustomName:'"${TARGET}"',CustomNameVisible:1b,NoAI:1b,Silent:1b,PersistenceRequired:1b,Health:400f,attributes:[{id:"minecraft:generic.max_health",base:400},{id:"minecraft:generic.knockback_resistance",base:1.0}]}`

const HIGH = { x: 43.5, y: 151, z: -15.5 }
const LOW = { x: 43.5, y: 131, z: -15.5 }
const main = (z, y = 141) => ({ x: 43.5, y, z })

const CONDITIONS = [
  { label: 'dy0 d10', shooter: main(-57.5), target: main(-47.5) },
  { label: 'dy0 d20', shooter: main(-57.5), target: main(-37.5) },
  { label: 'dy0 d40', shooter: main(-57.5), target: main(-17.5) },
  { label: 'dy+10 d10', shooter: main(-25.5), target: { x: 43.5, y: 151, z: -15.5 } },
  { label: 'dy+10 d20', shooter: main(-35.5), target: { x: 43.5, y: 151, z: -15.5 } },
  { label: 'dy-10 d10', shooter: main(-25.5), target: { x: 43.5, y: 131, z: -15.5 } },
  { label: 'dy-10 d20', shooter: main(-35.5), target: { x: 43.5, y: 131, z: -15.5 } },
  { label: 'high->main d10', shooter: { x: 43.5, y: 151, z: -15.5 }, target: main(-25.5) },
  { label: 'high->main d20', shooter: { x: 43.5, y: 151, z: -15.5 }, target: main(-35.5) },
  { label: 'high->main d40', shooter: { x: 43.5, y: 151, z: -15.5 }, target: main(-55.5) },
]

const evidence = { id: 'B-01 range matrix', startedAt: new Date().toISOString(), shotsPerCondition: SHOTS, conditions: [], verdict: 'unknown' }

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

const server = new Client({ name: 'b1r-server', version: '1.0.0' })
await server.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${SERVER_PORT}/mcp`)))
const game = new Client({ name: 'b1r-game', version: '1.0.0' })
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

async function targetHealth(center) {
  const record = structuredOf(await call(server, 'query_entities', { center, radius: 10, includePlayers: false, maxResults: 20, types: ['minecraft:sheep'] }, { tolerateError: true }))
  const entry = (record?.entities ?? []).find(candidate => candidate.name === TARGET)
  return entry ? Number(entry.health) : undefined
}

async function summonTarget(position) {
  await runCommand(`kill @e[type=minecraft:sheep,name=${TARGET}]`)
  await runCommand(`summon minecraft:sheep ${position.x} ${position.y} ${position.z} ${TARGET_NBT}`)
  await new Promise(resolve => setTimeout(resolve, 500))
}

function yawTo(from, to) {
  return Math.atan2(-(to.x - from.x), to.z - from.z) * 180 / Math.PI
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
  return evalJs(`window.__b1rResult = 'pending'
window.__AIRI_GAME_HOST_SMOKE__.executeGameTool('${tool}', ${JSON.stringify(payload)})
  .then(result => { window.__b1rResult = result })
  .catch(error => { window.__b1rResult = { error: String(error) } })
'started'`).then(async () => {
    const deadline = Date.now() + maxMs
    for (;;) {
      const current = await evalJs('typeof window.__b1rResult === "string" ? window.__b1rResult : JSON.stringify(window.__b1rResult)')
      if (current !== 'pending')
        return JSON.parse(current)
      if (Date.now() > deadline)
        return { error: 'timeout waiting for tool result' }
      await new Promise(resolve => setTimeout(resolve, 200))
    }
  })
}

try {
  await waitForProbe()
  await runCommand('time set day')
  await runCommand('weather clear')
  await runCommand(`clear ${BOT} minecraft:bow`)
  await runCommand(`clear ${BOT} minecraft:crossbow`)
  await runCommand(`give ${BOT} minecraft:bow 1`)
  await runCommand(`clear ${BOT} minecraft:arrow`)
  await runCommand(`give ${BOT} minecraft:arrow 512`)

  for (const condition of CONDITIONS) {
    await runCommand(`kill @e[type=minecraft:sheep,name=${TARGET}]`)
    await summonTarget(condition.target)
    await call(server, 'teleport_player', { player: BOT, x: condition.shooter.x, y: condition.shooter.y, z: condition.shooter.z, yaw: yawTo(condition.shooter, condition.target), pitch: 0 })
    await new Promise(resolve => setTimeout(resolve, 700))
    const center = condition.target
    const shots = []
    for (let index = 0; index < SHOTS; index++) {
      let before = await targetHealth(center)
      if (before === undefined || before <= 0) {
        await summonTarget(condition.target)
        before = await targetHealth(center)
      }
      const receipt = await evalTool('game_shoot', { target: TARGET, weapon: 'bow', maxShots: 1, chargeTicks: 20 })
      await new Promise(resolve => setTimeout(resolve, 900))
      const after = await targetHealth(center)
      const damage = before !== undefined && after !== undefined && after > 0 ? Math.max(0, before - after) : undefined
      const shot = receipt?.shot?.shots?.[0]
      shots.push({
        index: index + 1,
        endReason: receipt?.endReason,
        fired: shot !== undefined,
        hit: after === 0 || after === undefined ? true : damage !== undefined ? damage > 0 : undefined,
        damage,
        predictedFlightTicks: receipt?.shot?.predictedFlightTicks,
        closestDistance: receipt?.shot?.closestDistance,
        arc: receipt?.shot?.arc,
      })
      process.stdout.write(`${condition.label} ${index + 1}/${SHOTS} hit=${shots.at(-1).hit} dmg=${damage}\r`)
    }
    const fired = shots.filter(shot => shot.fired).length
    const hits = shots.filter(shot => shot.hit === true).length
    evidence.conditions.push({ ...condition, fired, hits, hitRate: fired > 0 ? Number((hits / fired).toFixed(3)) : undefined, shots })
    note(`\n${condition.label}: fired=${fired} hits=${hits} rate=${evidence.conditions.at(-1).hitRate}`)
  }

  const totals = evidence.conditions.reduce((accumulator, condition) => ({ fired: accumulator.fired + condition.fired, hits: accumulator.hits + condition.hits }), { fired: 0, hits: 0 })
  evidence.analysis = { ...totals, hitRate: totals.fired > 0 ? Number((totals.hits / totals.fired).toFixed(3)) : undefined }
  evidence.verdict = totals.fired >= CONDITIONS.length * SHOTS * 0.9 ? 'PASS' : 'PARTIAL'
  note(`B-01 range: fired=${totals.fired} hits=${totals.hits} rate=${evidence.analysis.hitRate}`)
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
  console.log(JSON.stringify({ verdict: evidence.verdict, analysis: evidence.analysis, conditions: evidence.conditions.map(condition => ({ label: condition.label, fired: condition.fired, hits: condition.hits, rate: condition.hitRate })) }, null, 2))
  ws.close()
  await game.close()
  await server.close()
}
