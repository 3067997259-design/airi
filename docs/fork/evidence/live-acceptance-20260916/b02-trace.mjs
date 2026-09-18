/**
 * B-02 tracer: one turn-triggered shot at the mounted sheep, tracking the
 * arrow and the target each 100 ms to see where the arrow actually goes.
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
const server = new Client({ name: 'trace-server', version: '1.0.0' })
await server.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:25602/mcp')))
const game = new Client({ name: 'trace-game', version: '1.0.0' })
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
  return entry ? { x: Number(entry.x), y: Number(entry.y), z: Number(entry.z) } : undefined
}
async function targetState() {
  const record = await query({ x: 240.5, y: 201, z: -30 }, 22, ['minecraft:sheep'])
  const entry = (record?.entities ?? []).find(candidate => candidate.name === TARGET)
  return entry ? { health: Number(entry.health), x: Number(entry.x), y: Number(entry.y), z: Number(entry.z) } : undefined
}
async function arrows() {
  const record = await query({ x: 242, y: 201, z: -30 }, 18, ['minecraft:arrow'])
  return (record?.entities ?? []).map(arrow => ({ x: Number(arrow.x), y: Number(arrow.y), z: Number(arrow.z) }))
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

// Wait for the cart to turn at the north end, then fire at once.
let last = await cartState()
let direction = 0
let turn
const started = Date.now()
while (Date.now() - started < 14000) {
  await sleep(100)
  const now = await cartState()
  if (!now)
    continue
  const step = now.z - last.z
  if (Math.abs(step) > 0.02) {
    const next = Math.sign(step)
    if (direction !== 0 && next !== direction) { turn = now; break }
    direction = next
    last = now
  }
}
console.log('turn at:', JSON.stringify(turn))
await evalJs(`window.__trace = 'pending'
window.__AIRI_GAME_HOST_SMOKE__.executeGameTool('game_shoot', { target: '${TARGET}', weapon: 'bow', maxShots: 1, chargeTicks: 20 }).then(r => { window.__trace = r }).catch(e => { window.__trace = { error: String(e) } })
'go'`)

const trace = []
const traceStart = Date.now()
let done = false
while (Date.now() - traceStart < 6000) {
  const [arrowList, sheepNow, cartNow] = await Promise.all([arrows(), targetState(), cartState()])
  const state = await evalJs('typeof window.__trace === "string" ? window.__trace : JSON.stringify(window.__trace)')
  done = state !== 'pending'
  trace.push({ t: Date.now() - traceStart, arrows: arrowList.map(a => `${a.x.toFixed(2)},${a.y.toFixed(2)},${a.z.toFixed(2)}`), sheep: sheepNow && `${sheepNow.x.toFixed(2)},${sheepNow.y.toFixed(2)},${sheepNow.z.toFixed(2)} hp=${sheepNow.health}`, cart: cartNow && cartNow.z.toFixed(2), done })
  if (done && trace.length > 6)
    break
  await sleep(100)
}
console.log('trace:')
for (const row of trace) console.log(JSON.stringify(row))
const receipt = typeof (await evalJs('typeof window.__trace === "string" ? window.__trace : JSON.stringify(window.__trace)')) === 'string' ? JSON.parse(await evalJs('window.__trace')) : undefined
console.log('receipt:', JSON.stringify({ endReason: receipt?.endReason, shot: receipt?.shot }).slice(0, 600))
await sleep(800)
console.log('target after:', JSON.stringify(await targetState()))
await run('kill @e[type=minecraft:arrow]')
ws.close()
await game.close()
await server.close()
