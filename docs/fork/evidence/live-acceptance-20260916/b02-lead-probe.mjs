/**
 * F-24 lead probe: one turn-triggered shot at the mounted sheep, then read the
 * client combat status (aimLead) to see which velocity source the aim used.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const TARGET = 'MTarget'
const SHOOTER = { x: 248, y: 201, z: -35 }
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
const server = new Client({ name: 'lead-server', version: '1.0.0' })
await server.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:25602/mcp')))
const game = new Client({ name: 'lead-game', version: '1.0.0' })
await game.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:25600/mcp')))
async function run(command) {
  return await server.callTool({ name: 'run_command', arguments: { command } })
}
async function query(center, radius, types) {
  return structuredOf(await server.callTool({ name: 'query_entities', arguments: { center, radius, includePlayers: false, types, maxResults: 80 } }))
}
async function cartState() {
  const record = await query({ x: 240, y: 201, z: -30 }, 22, ['minecraft:minecart'])
  const entry = (record?.entities ?? [])[0]
  return entry ? { z: Number(entry.z) } : undefined
}
async function targetState() {
  const record = await query({ x: 240.5, y: 201, z: -30 }, 22, ['minecraft:sheep'])
  const entry = (record?.entities ?? []).find(candidate => candidate.name === TARGET)
  return entry ? { health: Number(entry.health), z: Number(entry.z) } : undefined
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

await run('kill @e[type=minecraft:arrow]')
await run(`kill @e[type=minecraft:sheep,name=${TARGET}]`)
await run(`tp airitest ${SHOOTER.x} ${SHOOTER.y} ${SHOOTER.z} 90 0`)
await sleep(600)
await run(`summon minecraft:sheep 246.5 201 -30 {CustomName:'"${TARGET}"',CustomNameVisible:1b,NoAI:1b,Silent:1b,PersistenceRequired:1b,Health:45f,attributes:[{id:"minecraft:generic.max_health",base:45},{id:"minecraft:generic.knockback_resistance",base:1.0}]}`)
await sleep(500)
await run(`ride @e[type=minecraft:sheep,name=${TARGET},limit=1] mount @e[type=minecraft:minecart,x=239,y=200,z=-40,dx=3,dy=8,dz=22,limit=1]`)
await sleep(500)
console.log('target mounted:', JSON.stringify(await targetState()))

let last = await cartState()
let direction = 0
const started = Date.now()
while (Date.now() - started < 14000) {
  await sleep(100)
  const now = await cartState()
  if (!now)
    continue
  const step = now.z - last.z
  if (Math.abs(step) > 0.02) {
    const next = Math.sign(step)
    if (direction !== 0 && next !== direction)
      break
    direction = next
    last = now
  }
}
const before = await targetState()
await evalJs(`window.__lead = 'pending'
window.__AIRI_GAME_HOST_SMOKE__.executeGameTool('game_shoot', { target: '${TARGET}', weapon: 'bow', maxShots: 1, chargeTicks: 20 }).then(r => { window.__lead = r }).catch(e => { window.__lead = { error: String(e) } })
'go'`)
let state = 'pending'
for (let attempt = 0; attempt < 90 && state === 'pending'; attempt++) {
  await sleep(200)
  state = await evalJs('typeof window.__lead === "string" ? window.__lead : JSON.stringify(window.__lead)')
}
await sleep(700)
const after = await targetState()
const status = structuredOf(await game.callTool({ name: 'combat_status', arguments: {} }))
console.log('before:', JSON.stringify(before), 'after:', JSON.stringify(after))
console.log('combat status:', JSON.stringify({ state: status?.state, shotsFired: status?.shotsFired, endReason: status?.endReason, aimTarget: status?.aimTarget, aimSource: status?.aimSource, aimLead: status?.aimLead, release: status?.release }).slice(0, 1200))
const receipt = typeof state === 'string' ? JSON.parse(state) : state
console.log('receipt shot:', JSON.stringify(receipt?.shot).slice(0, 400))
await run('kill @e[type=minecraft:arrow]')
await run(`kill @e[type=minecraft:sheep,name=${TARGET}]`)
ws.close(); await game.close(); await server.close()
