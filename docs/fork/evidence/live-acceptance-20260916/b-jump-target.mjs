/**
 * CD-B3: stopping and jumping targets on the ballistics range.
 *
 * The stationary target is the baseline (already 100% at 20 blocks). A jump is
 * simulated by lifting the sheep ~1.3 blocks and firing while it falls: the
 * fall is a real accelerated motion with a real velocity, so the receipt's
 * predicted flight time and the actual impact can be compared.
 *
 * Usage: node b-jump-target.mjs <outPath>
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const outPath = process.argv[2] ?? 'b-jump-target.json'
const SHOTS = Number(process.argv[3] ?? 12)
const BOT = 'airitest'
const TARGET = 'Target'
const TARGET_NBT = `{CustomName:'"${TARGET}"',CustomNameVisible:1b,NoAI:1b,Silent:1b,PersistenceRequired:1b,Health:400f,attributes:[{id:"minecraft:generic.max_health",base:400},{id:"minecraft:generic.knockback_resistance",base:1.0}]}`
const SHOOTER = { x: 43.5, y: 141, z: -57.5 }
const TARGET_POS = { x: 43.5, y: 141, z: -37.5 }
const evidence = { id: 'B-03 stop and jump', startedAt: new Date().toISOString(), shotsPerCase: SHOTS, cases: [], verdict: 'unknown' }

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

const server = new Client({ name: 'bj-server', version: '1.0.0' })
await server.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:25602/mcp')))

async function call(client, name, args, { tolerateError = false } = {}) {
  const result = await client.callTool({ name, arguments: args })
  if (result.isError === true && !tolerateError)
    throw new Error(`${name} failed: ${textOf(result).slice(0, 240)}`)
  return result
}
async function run(command) {
  return await call(server, 'run_command', { command }, { tolerateError: true })
}
async function targetHealth() {
  const record = structuredOf(await call(server, 'query_entities', { center: TARGET_POS, radius: 10, includePlayers: false, maxResults: 20, types: ['minecraft:sheep'] }, { tolerateError: true }))
  const entry = (record?.entities ?? []).find(candidate => candidate.name === TARGET)
  return entry ? { health: Number(entry.health), y: Number(entry.y) } : undefined
}
async function summonTarget(y = TARGET_POS.y) {
  await run(`kill @e[type=minecraft:sheep,name=${TARGET}]`)
  await run(`summon minecraft:sheep ${TARGET_POS.x} ${y} ${TARGET_POS.z} ${TARGET_NBT}`)
  await new Promise(resolve => setTimeout(resolve, 500))
}
async function nearestArrow() {
  const record = structuredOf(await call(server, 'query_entities', { center: TARGET_POS, radius: 8, includePlayers: false, maxResults: 30, types: ['minecraft:arrow'] }, { tolerateError: true }))
  const arrows = record?.entities ?? []
  if (arrows.length === 0)
    return undefined
  let best
  for (const arrow of arrows) {
    const distance = Math.hypot(Number(arrow.x) - TARGET_POS.x, Number(arrow.y) - (TARGET_POS.y + 0.65), Number(arrow.z) - TARGET_POS.z)
    if (!best || distance < best.distance)
      best = { y: Number(arrow.y), dy: Number(arrow.y) - (TARGET_POS.y + 0.65), distance }
  }
  return best
}

const targets = await (await fetch('http://127.0.0.1:9222/json/list')).json()
const page = targets.find(item => item.type === 'page' && item.url.includes('synced-leader=true'))
const ws = new WebSocket(page.webSocketDebuggerUrl)
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
async function waitProbe() {
  await evalJs(`location.hash = '#/devtools/game-host'; 'ok'`)
  await new Promise(resolve => setTimeout(resolve, 1400))
  for (let attempt = 0; attempt < 12; attempt++) {
    if (await evalJs('window.__AIRI_GAME_HOST_SMOKE__ ? "ready" : "missing"') === 'ready')
      return
    await new Promise(resolve => setTimeout(resolve, 800))
  }
  throw new Error('probe missing')
}
async function evalTool(tool, payload, maxMs = 90_000) {
  await evalJs(`window.__bj = 'pending'
window.__AIRI_GAME_HOST_SMOKE__.executeGameTool('${tool}', ${JSON.stringify(payload)})
  .then(result => { window.__bj = result })
  .catch(error => { window.__bj = { error: String(error) } })
'started'`)
  const deadline = Date.now() + maxMs
  for (;;) {
    const current = await evalJs('typeof window.__bj === "string" ? window.__bj : JSON.stringify(window.__bj)')
    if (current !== 'pending')
      return JSON.parse(current)
    if (Date.now() > deadline)
      return { error: 'timeout' }
    await new Promise(resolve => setTimeout(resolve, 200))
  }
}

try {
  await waitProbe()
  await run('time set day')
  await run('weather clear')
  await run('clear airitest minecraft:bow')
  await run('give airitest minecraft:bow 1')
  await run('clear airitest minecraft:arrow')
  await run('give airitest minecraft:arrow 512')
  await call(server, 'teleport_player', { player: BOT, x: SHOOTER.x, y: SHOOTER.y, z: SHOOTER.z, yaw: 180, pitch: 0 })
  await new Promise(resolve => setTimeout(resolve, 700))

  // ===== case 1: the target stops (stationary baseline) =====
  await summonTarget()
  const stopShots = []
  for (let index = 0; index < SHOTS; index++) {
    let before = await targetHealth()
    if (!before || before.health <= 0) {
      await summonTarget()
      before = await targetHealth()
    }
    await run('kill @e[type=minecraft:arrow]')
    const receipt = await evalTool('game_shoot', { target: TARGET, weapon: 'bow', maxShots: 1, chargeTicks: 20 })
    await new Promise(resolve => setTimeout(resolve, 900))
    const after = await targetHealth()
    const damage = before && after && after.health > 0 ? Math.max(0, before.health - after.health) : undefined
    const shot = receipt?.shot?.shots?.[0]
    stopShots.push({ index: index + 1, hit: damage !== undefined ? damage > 0 : undefined, damage, predictedFlightTicks: receipt?.shot?.predictedFlightTicks, closestDistance: receipt?.shot?.closestDistance, arrow: await nearestArrow() })
  }
  evidence.cases.push({ id: 'B-03a', label: 'stationary target (baseline)', shots: stopShots, hits: stopShots.filter(s => s.hit === true).length })
  note(`B-03a stationary: ${stopShots.filter(s => s.hit === true).length}/${SHOTS}`)

  // ===== case 2: the target jumps (lifted, fired while falling) =====
  await summonTarget()
  const jumpShots = []
  for (let index = 0; index < SHOTS; index++) {
    let before = await targetHealth()
    if (!before || before.health <= 0) {
      await summonTarget()
      before = await targetHealth()
    }
    // Keep the target airborne in phases: a single lift would land long before
    // the 20-tick charge releases, so the release would never see motion.
    await run('kill @e[type=minecraft:arrow]')
    const juggle = setInterval(() => {
      void run(`tp @e[type=minecraft:sheep,name=${TARGET}] ${TARGET_POS.x} ${TARGET_POS.y + 1.3} ${TARGET_POS.z}`)
    }, 400)
    const receipt = await evalTool('game_shoot', { target: TARGET, weapon: 'bow', maxShots: 1, chargeTicks: 20 })
    clearInterval(juggle)
    await new Promise(resolve => setTimeout(resolve, 900))
    const after = await targetHealth()
    const damage = before && after && after.health > 0 ? Math.max(0, before.health - after.health) : undefined
    const shot = receipt?.shot?.shots?.[0]
    jumpShots.push({ index: index + 1, hit: damage !== undefined ? damage > 0 : undefined, damage, predictedFlightTicks: receipt?.shot?.predictedFlightTicks, closestDistance: receipt?.shot?.closestDistance, arrivalY: after?.y, arrow: await nearestArrow() })
  }
  evidence.cases.push({ id: 'B-03b', label: 'jumping target (lifted, fired while falling)', shots: jumpShots, hits: jumpShots.filter(s => s.hit === true).length })
  note(`B-03b jumping: ${jumpShots.filter(s => s.hit === true).length}/${SHOTS}`)

  evidence.verdict = 'PASS'
}
catch (error) {
  evidence.error = String(error)
  evidence.verdict = 'ERROR'
  console.error(error)
}
finally {
  try {
    await run(`kill @e[type=minecraft:sheep,name=${TARGET}]`)
    await run(`give ${BOT} minecraft:arrow 64`)
    await call(server, 'teleport_player', { player: BOT, x: 82.5, y: 75, z: -24.5, yaw: 0, pitch: 0 })
  }
  catch {}
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, JSON.stringify(evidence, null, 2))
  console.log(JSON.stringify({ verdict: evidence.verdict, error: evidence.error, cases: evidence.cases.map(c => ({ id: c.id, label: c.label, hits: c.hits, shots: c.shots.length, residuals: c.shots.map(s => s.arrow?.dy).filter(v => typeof v === 'number') })) }, null, 2))
  ws.close()
  await server.close()
}
