/**
 * B-05: the user stands in the shooting line (expect friendly_blocked, zero
 * ammo), then steps aside (expect a fired shot that hits).
 */
import { writeFileSync } from 'node:fs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const TARGET = 'MTarget'
const BOT = { x: 258, y: 201, z: -32 }
const SHEEP = { x: 258, y: 201, z: -20 }
const IN_LINE = { x: 258, y: 201, z: -26 }
const ASIDE = { x: 263, y: 201, z: -26 }
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
const server = new Client({ name: 'b05-server', version: '1.0.0' })
await server.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:25602/mcp')))
const game = new Client({ name: 'b05-game', version: '1.0.0' })
await game.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:25600/mcp')))
async function run(command) {
  return structuredOf(await server.callTool({ name: 'run_command', arguments: { command } }))
}
async function sheep() {
  const record = structuredOf(await server.callTool({ name: 'query_entities', arguments: { center: { x: SHEEP.x, y: SHEEP.y, z: SHEEP.z }, radius: 10, includePlayers: false, maxResults: 30, types: ['minecraft:sheep'] } }))
  const entry = (record?.entities ?? []).find(candidate => candidate.name === TARGET)
  return entry ? { health: Number(entry.health), x: Number(entry.x), y: Number(entry.y), z: Number(entry.z) } : undefined
}
async function user() {
  const record = structuredOf(await server.callTool({ name: 'query_entities', arguments: { center: { x: BOT.x, y: BOT.y, z: BOT.z }, radius: 30, includePlayers: true, maxResults: 20, types: ['minecraft:player'] } }))
  const entry = (record?.entities ?? []).find(candidate => candidate.name === 'AfterRain')
  return entry ? { x: Number(entry.x), y: Number(entry.y), z: Number(entry.z) } : undefined
}
async function arrows() {
  const inventory = structuredOf(await game.callTool({ name: 'get_inventory', arguments: {} }))
  const slots = [...(inventory?.hotbar ?? []), ...(inventory?.main ?? [])].filter(Boolean)
  return slots.filter(slot => slot.id === 'minecraft:arrow').reduce((sum, slot) => sum + Number(slot.count ?? 0), 0)
}
async function waitFor(check, label, attempts = 240) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (await check())
      return true
    await sleep(750)
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

async function shoot() {
  await evalJs(`window.__b05 = 'pending'
window.__AIRI_GAME_HOST_SMOKE__.executeGameTool('game_shoot', { target: '${TARGET}', weapon: 'bow', maxShots: 1, chargeTicks: 20 }).then(r => { window.__b05 = r }).catch(e => { window.__b05 = { error: String(e) } })
'go'`)
  let state = 'pending'
  for (let attempt = 0; attempt < 120 && state === 'pending'; attempt++) {
    await sleep(250)
    state = await evalJs('typeof window.__b05 === "string" ? window.__b05 : JSON.stringify(window.__b05)')
  }
  return typeof state === 'string' ? JSON.parse(state) : state
}

const evidence = { id: 'B-05 friendly in the line', startedAt: new Date().toISOString() }
await run(`kill @e[type=minecraft:sheep,name=${TARGET}]`)
await run(`summon minecraft:sheep ${SHEEP.x} ${SHEEP.y} ${SHEEP.z} {CustomName:'"${TARGET}"',CustomNameVisible:1b,NoAI:1b,Silent:1b,PersistenceRequired:1b,Health:45f,attributes:[{id:"minecraft:generic.max_health",base:45},{id:"minecraft:generic.knockback_resistance",base:1.0}]}`)
await run(`tp airitest ${BOT.x} ${BOT.y} ${BOT.z} 180 0`)
await sleep(800)
console.log('target:', JSON.stringify(await sheep()), 'user:', JSON.stringify(await user()))

// Run 1: the user must be in the line.
if (!await waitFor(async () => {
  const u = await user()
  return u && Math.abs(u.x - IN_LINE.x) <= 2 && Math.abs(u.z - IN_LINE.z) <= 2
}, 'user stands in the line')) {
  process.exit(1)
}
const before1 = await arrows()
const health1 = (await sheep())?.health
const receipt1 = await shoot()
await sleep(800)
const after1 = await arrows()
evidence.blocked = {
  arrowsBefore: before1,
  arrowsAfter: after1,
  targetHealthBefore: health1,
  targetHealthAfter: (await sheep())?.health,
  endReason: receipt1?.endReason,
  refusalReason: receipt1?.shot?.refusalReason,
  refusalDetail: receipt1?.shot?.refusalDetail,
  fired: receipt1?.shot?.shots?.length ?? 0,
  receipt: receipt1,
}
console.log('blocked run:', JSON.stringify({ endReason: evidence.blocked.endReason, refusalReason: evidence.blocked.refusalReason, fired: evidence.blocked.fired, arrows: `${before1}->${after1}` }).slice(0, 400))

// Run 2: the user steps aside.
if (!await waitFor(async () => {
  const u = await user()
  return u && Math.abs(u.x - ASIDE.x) <= 2 && Math.abs(u.z - ASIDE.z) <= 2
}, 'user steps aside')) {
  process.exit(1)
}
const before2 = await arrows()
const receipt2 = await shoot()
await sleep(900)
const after2 = await arrows()
evidence.aside = {
  arrowsBefore: before2,
  arrowsAfter: after2,
  targetHealthAfter: (await sheep())?.health,
  endReason: receipt2?.endReason,
  fired: receipt2?.shot?.shots?.length ?? 0,
  closestDistance: receipt2?.shot?.closestDistance,
  hitEvidence: receipt2?.shot?.shots?.[0]?.hitEvidence,
  receipt: receipt2,
}
console.log('aside run:', JSON.stringify({ endReason: evidence.aside.endReason, fired: evidence.aside.fired, arrows: `${before2}->${after2}`, sheep: evidence.aside.targetHealthAfter }).slice(0, 400))

evidence.finishedAt = new Date().toISOString()
writeFileSync(new URL('./b05.json', import.meta.url), JSON.stringify(evidence, null, 2))
await run('kill @e[type=minecraft:arrow]')
ws.close()
await game.close()
await server.close()
