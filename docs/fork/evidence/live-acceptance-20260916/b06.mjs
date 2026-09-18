/**
 * B-06: (1) the target dies mid-command, so the receipt must stay typed and
 * never turn a prediction into a hit; (2) the user and the bot shoot the same
 * sheep, so the kill attribution must be typed or unobserved, never guessed.
 */
import { writeFileSync } from 'node:fs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const TARGET = 'MTarget'
const BOT = { x: 258, y: 201, z: -32 }
const SHEEP = { x: 258, y: 201, z: -20 }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
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
const server = new Client({ name: 'b06-server', version: '1.0.0' })
await server.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:25602/mcp')))
const game = new Client({ name: 'b06-game', version: '1.0.0' })
await game.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:25600/mcp')))
async function run(command) {
  return structuredOf(await server.callTool({ name: 'run_command', arguments: { command } }))
}
async function sheep() {
  const record = structuredOf(await server.callTool({ name: 'query_entities', arguments: { center: { x: SHEEP.x, y: SHEEP.y, z: SHEEP.z }, radius: 12, includePlayers: false, maxResults: 30, types: ['minecraft:sheep'] } }))
  const entry = (record?.entities ?? []).find(candidate => candidate.name === TARGET)
  return entry ? { health: Number(entry.health), x: Number(entry.x), y: Number(entry.y), z: Number(entry.z) } : undefined
}
async function user() {
  const record = structuredOf(await server.callTool({ name: 'query_entities', arguments: { center: { x: BOT.x, y: BOT.y, z: BOT.z }, radius: 40, includePlayers: true, maxResults: 20, types: ['minecraft:player'] } }))
  const entry = (record?.entities ?? []).find(candidate => candidate.name === 'AfterRain')
  return entry ? { x: Number(entry.x), y: Number(entry.y), z: Number(entry.z) } : undefined
}
async function waitFor(check, label, attempts = 240) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (await check())
      return true
    await sleep(600)
  }
  console.log(`wait timeout for ${label}`)
  return false
}
const targets = await (await fetch('http://127.0.0.1:9222/json/list')).json()
const page = targets.find(item => item.type === 'page' && item.url.includes('synced-leader=true'))
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
let id = 0
const pending = new Map()
ws.onmessage = (event) => { const message = JSON.parse(event.data); if (pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id) } }
async function evalJs(expression) {
  const mid = ++id
  ws.send(JSON.stringify({ id: mid, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
  const message = await new Promise(resolve => pending.set(mid, resolve))
  return message.result?.exceptionDetails ? `EXC ${message.result.exceptionDetails.exception?.description}` : message.result?.result?.value
}
await evalJs(`location.hash = '#/devtools/game-host'; 'ok'`)
await sleep(1000)

async function shoot(maxShots = 1) {
  await evalJs(`window.__b06 = 'pending'
window.__AIRI_GAME_HOST_SMOKE__.executeGameTool('game_shoot', { target: '${TARGET}', weapon: 'bow', maxShots: ${maxShots}, chargeTicks: 20 }).then(r => { window.__b06 = r }).catch(e => { window.__b06 = { error: String(e) } })
'go'`)
  let state = 'pending'
  for (let attempt = 0; attempt < 140 && state === 'pending'; attempt++) {
    await sleep(250)
    state = await evalJs('typeof window.__b06 === "string" ? window.__b06 : JSON.stringify(window.__b06)')
  }
  return typeof state === 'string' ? JSON.parse(state) : state
}
async function summonSheep(health) {
  await run(`kill @e[type=minecraft:sheep,name=${TARGET}]`)
  await run(`summon minecraft:sheep ${SHEEP.x} ${SHEEP.y} ${SHEEP.z} {CustomName:'"${TARGET}"',CustomNameVisible:1b,NoAI:1b,Silent:1b,PersistenceRequired:1b,Health:${health}f,attributes:[{id:"minecraft:generic.max_health",base:${health}},{id:"minecraft:generic.knockback_resistance",base:1.0}]}`)
  await sleep(600)
}

const evidence = { id: 'B-06 target gone and two shooters', startedAt: new Date().toISOString() }

// Part 1: the sheep is killed while the shot command runs. The user is told to
// kill it; the script kills it anyway after a grace period so the case always
// happens, and the receipt must stay typed either way.
await summonSheep(45)
await run(`tp airitest ${BOT.x} ${BOT.y} ${BOT.z} 180 0`)
if (!await waitFor(async () => (await user()) !== undefined && true, 'user present')) {
  // no position gate for part 1; the user is instructed to stand by the sheep
}
await sleep(300)
const part1HealthBefore = (await sheep())?.health
const part1 = shoot(1)
await sleep(900)
await run(`kill @e[type=minecraft:sheep,name=${TARGET}]`)
const receipt1 = await part1
await sleep(700)
evidence.targetGone = {
  healthBefore: part1HealthBefore,
  sheepAfter: await sheep(),
  endReason: receipt1?.endReason,
  fired: receipt1?.shot?.shots?.length ?? 0,
  closestDistance: receipt1?.shot?.closestDistance,
  predictedFlightTicks: receipt1?.shot?.predictedFlightTicks,
  hitEvidence: receipt1?.shot?.shots?.[0]?.hitEvidence,
  killed: receipt1?.shot?.killed,
  unobservedTargetDeath: receipt1?.shot?.unobservedTargetDeath,
  receipt: receipt1,
}
console.log('part1 target-gone:', JSON.stringify({ endReason: evidence.targetGone.endReason, fired: evidence.targetGone.fired, killed: evidence.targetGone.killed, unobserved: evidence.targetGone.unobservedTargetDeath, hit: evidence.targetGone.hitEvidence }).slice(0, 300))

// Part 2: both shoot the same sheep.
await sleep(1000)
await summonSheep(18)
if (!await waitFor(async () => {
  const u = await user()
  return u && Math.abs(u.x - 252) <= 3 && Math.abs(u.z - (-22)) <= 3
}, 'user at the shooting spot')) {
  process.exit(1)
}
const part2Before = await sheep()
const receipt2 = await shoot(3)
await sleep(1000)
evidence.twoShooters = {
  healthBefore: part2Before?.health,
  sheepAfter: await sheep(),
  endReason: receipt2?.endReason,
  fired: receipt2?.shot?.shots?.length ?? 0,
  hits: receipt2?.shot?.hits,
  killed: receipt2?.shot?.killed,
  killEvidence: receipt2?.shot?.killEvidence,
  unobservedTargetDeath: receipt2?.shot?.unobservedTargetDeath,
  receipt: receipt2,
}
console.log('part2 two shooters:', JSON.stringify({ endReason: evidence.twoShooters.endReason, fired: evidence.twoShooters.fired, hits: evidence.twoShooters.hits, killed: evidence.twoShooters.killed, killEvidence: evidence.twoShooters.killEvidence, unobserved: evidence.twoShooters.unobservedTargetDeath, sheep: evidence.twoShooters.sheepAfter?.health }).slice(0, 400))

evidence.finishedAt = new Date().toISOString()
writeFileSync(new URL('./b06.json', import.meta.url), JSON.stringify(evidence, null, 2))
await run('kill @e[type=minecraft:arrow]')
await run(`kill @e[type=minecraft:sheep,name=${TARGET}]`)
await run(`tp airitest ${BOT.x} ${BOT.y} ${BOT.z} 180 0`)
ws.close()
await game.close()
await server.close()
