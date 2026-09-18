/**
 * B-08 remainder: firework crossbow (its own profile + load recognition),
 * spectral arrow (glowing read back), tipped arrow (effect read back).
 *
 * The bot's ordinary arrows are removed for each part so the ammo report names
 * the tested projectile, then restored at the end.
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
const server = new Client({ name: 'b08-server', version: '1.0.0' })
await server.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:25602/mcp')))
const game = new Client({ name: 'b08-game', version: '1.0.0' })
await game.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:25600/mcp')))
async function run(command) {
  const result = await server.callTool({ name: 'run_command', arguments: { command } })
  return structuredOf(result)
}
async function sheep() {
  const record = structuredOf(await server.callTool({ name: 'query_entities', arguments: { center: { x: SHEEP.x, y: SHEEP.y, z: SHEEP.z }, radius: 10, includePlayers: false, maxResults: 30, types: ['minecraft:sheep'] } }))
  const entry = (record?.entities ?? []).find(candidate => candidate.name === TARGET)
  return entry ? { health: Number(entry.health), uuid: entry.uuid } : undefined
}
async function sheepEffects() {
  const target = await sheep()
  if (!target?.uuid)
    return undefined
  const detail = structuredOf(await server.callTool({ name: 'get_entity', arguments: { uuid: target.uuid } }))
  return { health: detail?.health, effects: detail?.effects }
}
async function inventory() {
  const record = structuredOf(await game.callTool({ name: 'get_inventory', arguments: {} }))
  const slots = [...(record?.hotbar ?? []), ...(record?.main ?? [])].filter(Boolean)
  return slots.map(slot => `${slot.id}x${slot.count}`)
}
async function arrowCount() {
  const items = await inventory()
  return items.filter(id => id.startsWith('minecraft:arrow')).reduce((sum, id) => sum + Number(id.split('x')[1]), 0)
}
async function status() {
  return structuredOf(await game.callTool({ name: 'combat_status', arguments: {} }))
}
async function summonSheep(health) {
  await run(`kill @e[type=minecraft:sheep,name=${TARGET}]`)
  await run(`summon minecraft:sheep ${SHEEP.x} ${SHEEP.y} ${SHEEP.z} {CustomName:'"${TARGET}"',CustomNameVisible:1b,NoAI:1b,Silent:1b,PersistenceRequired:1b,Health:${health}f,attributes:[{id:"minecraft:generic.max_health",base:${health}},{id:"minecraft:generic.knockback_resistance",base:1.0}]}`)
  await sleep(600)
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
await sleep(1200)

async function shoot(weapon) {
  await evalJs(`window.__b08 = 'pending'
window.__AIRI_GAME_HOST_SMOKE__.executeGameTool('game_shoot', { target: '${TARGET}', weapon: '${weapon}', maxShots: 1, chargeTicks: 20 }).then(r => { window.__b08 = r }).catch(e => { window.__b08 = { error: String(e) } })
'go'`)
  let state = 'pending'
  for (let attempt = 0; attempt < 140 && state === 'pending'; attempt++) {
    await sleep(250)
    state = await evalJs('typeof window.__b08 === "string" ? window.__b08 : JSON.stringify(window.__b08)')
  }
  return typeof state === 'string' ? JSON.parse(state) : state
}

const evidence = { id: 'B-08 firework crossbow, spectral and tipped arrows', startedAt: new Date().toISOString(), parts: [] }
const ordinaryArrows = await arrowCount()
evidence.ordinaryArrows = ordinaryArrows
await run(`tp airitest ${BOT.x} ${BOT.y} ${BOT.z} 180 0`)
await summonSheep(45)
await sleep(600)

// Part 1: firework crossbow.
await run('clear airitest minecraft:arrow')
await run('clear airitest minecraft:crossbow')
await run('clear airitest minecraft:firework_rocket')
await run('give airitest minecraft:crossbow 1')
await run('give airitest minecraft:firework_rocket 8')
await sleep(800)
const status1 = await status()
const health1 = (await sheep())?.health
const receipt1 = await shoot('crossbow')
await sleep(1200)
const after1 = await sheepEffects()
evidence.parts.push({
  name: 'firework-crossbow',
  ammoReported: status1?.projectiles,
  healthBefore: health1,
  healthAfter: after1?.health,
  effectsAfter: after1?.effects,
  profileId: receipt1?.shot?.profileId,
  fired: receipt1?.shot?.shots?.length ?? 0,
  verifiedBy: receipt1?.shot?.shots?.[0]?.verifiedBy,
  closestDistance: receipt1?.shot?.closestDistance,
  refusal: receipt1?.shot?.refusalReason ?? receipt1?.endReason,
  receipt: receipt1,
})
console.log('firework:', JSON.stringify({ ammo: status1?.projectiles, profile: receipt1?.shot?.profileId, fired: receipt1?.shot?.shots?.length ?? 0, verified: receipt1?.shot?.shots?.[0]?.verifiedBy, hp: `${health1}->${after1?.health}` }).slice(0, 400))

// Part 2: spectral arrow from the bow.
await run('clear airitest minecraft:arrow')
await run('clear airitest minecraft:crossbow')
await run('clear airitest minecraft:firework_rocket')
await run('give airitest minecraft:spectral_arrow 4')
await sleep(800)
const status2 = await status()
const health2 = (await sheep())?.health
const receipt2 = await shoot('bow')
await sleep(1200)
const after2 = await sheepEffects()
evidence.parts.push({
  name: 'spectral-arrow',
  ammoReported: status2?.projectiles,
  healthBefore: health2,
  healthAfter: after2?.health,
  effectsAfter: after2?.effects,
  profileId: receipt2?.shot?.profileId,
  fired: receipt2?.shot?.shots?.length ?? 0,
  receipt: receipt2,
})
console.log('spectral:', JSON.stringify({ ammo: status2?.projectiles, profile: receipt2?.shot?.profileId, fired: receipt2?.shot?.shots?.length ?? 0, hp: `${health2}->${after2?.health}`, effects: after2?.effects }).slice(0, 500))

// Part 3: tipped arrow (slowness) from the bow.
await run('clear airitest minecraft:arrow')
await run('clear airitest minecraft:spectral_arrow')
await run('give airitest minecraft:tipped_arrow[potion_contents={potion:"minecraft:slowness"}] 4')
await sleep(800)
const status3 = await status()
const health3 = (await sheep())?.health
const receipt3 = await shoot('bow')
await sleep(1200)
const after3 = await sheepEffects()
evidence.parts.push({
  name: 'tipped-arrow-slowness',
  ammoReported: status3?.projectiles,
  healthBefore: health3,
  healthAfter: after3?.health,
  effectsAfter: after3?.effects,
  profileId: receipt3?.shot?.profileId,
  fired: receipt3?.shot?.shots?.length ?? 0,
  receipt: receipt3,
})
console.log('tipped:', JSON.stringify({ ammo: status3?.projectiles, profile: receipt3?.shot?.profileId, fired: receipt3?.shot?.shots?.length ?? 0, hp: `${health3}->${after3?.health}`, effects: after3?.effects }).slice(0, 500))

// Restore the ordinary arrows and clean the fixture.
await run('clear airitest minecraft:tipped_arrow')
await run('clear airitest minecraft:crossbow')
await run('clear airitest minecraft:firework_rocket')
let toGive = evidence.ordinaryArrows
while (toGive > 0) { const chunk = Math.min(64, toGive); await run(`give airitest minecraft:arrow ${chunk}`); toGive -= chunk }
const restored = await arrowCount()
evidence.restoredArrows = restored
console.log('arrows restored:', restored)
await run(`kill @e[type=minecraft:sheep,name=${TARGET}]`)
await run('kill @e[type=minecraft:firework_rocket]')
await run('kill @e[type=minecraft:arrow]')
evidence.finishedAt = new Date().toISOString()
writeFileSync(new URL('./b08.json', import.meta.url), JSON.stringify(evidence, null, 2))
ws.close()
await game.close()
await server.close()
