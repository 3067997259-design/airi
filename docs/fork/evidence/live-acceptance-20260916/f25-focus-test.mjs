/**
 * F-25 regression: with the bot window focused (no screen open), a bow charge
 * must complete and the arrow must damage a stationary target.
 *
 * Before the fix the vanilla input path released the use every tick once the
 * window had focus (`!keyUse.isDown()`), so the charge never reached full.
 */
import { execSync } from 'node:child_process'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const TARGET = 'MTarget'
const SHOOTER = { x: 248, y: 201, z: -35 }
const SPOT = { x: 243.5, y: 201, z: -30 }
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
const server = new Client({ name: 'f25-server', version: '1.0.0' })
await server.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:25602/mcp')))
const game = new Client({ name: 'f25-game', version: '1.0.0' })
await game.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:25600/mcp')))
async function run(command) {
  return await server.callTool({ name: 'run_command', arguments: { command } })
}
async function sheep() {
  const record = structuredOf(await server.callTool({ name: 'query_entities', arguments: { center: SPOT, radius: 12, includePlayers: false, types: ['minecraft:sheep'], maxResults: 40 } }))
  const entry = (record?.entities ?? []).find(candidate => candidate.name === TARGET)
  return entry ? { health: Number(entry.health), x: Number(entry.x), y: Number(entry.y), z: Number(entry.z) } : undefined
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
await run(`summon minecraft:sheep ${SPOT.x} ${SPOT.y} ${SPOT.z} {CustomName:'"${TARGET}"',CustomNameVisible:1b,NoAI:1b,Silent:1b,PersistenceRequired:1b,Health:45f,attributes:[{id:"minecraft:generic.max_health",base:45},{id:"minecraft:generic.knockback_resistance",base:1.0}]}`)
await sleep(600)
const before = await sheep()
console.log('target before:', JSON.stringify(before))

const focusOutput = execSync('powershell -NoProfile -ExecutionPolicy Bypass -File focus-bot.ps1', { encoding: 'utf8' })
console.log('focus:', focusOutput.trim().split('\n').join(' | '))

await evalJs(`window.__f25 = 'pending'
window.__AIRI_GAME_HOST_SMOKE__.executeGameTool('game_shoot', { target: '${TARGET}', weapon: 'bow', maxShots: 1, chargeTicks: 20 }).then(r => { window.__f25 = r }).catch(e => { window.__f25 = { error: String(e) } })
'go'`)
let state = 'pending'
for (let attempt = 0; attempt < 90 && state === 'pending'; attempt++) {
  await sleep(200)
  state = await evalJs('typeof window.__f25 === "string" ? window.__f25 : JSON.stringify(window.__f25)')
}
await sleep(1200)
const after = await sheep()
const receipt = typeof state === 'string' ? JSON.parse(state) : state
console.log('target after:', JSON.stringify(after))
console.log('receipt:', JSON.stringify({ status: receipt?.status, endReason: receipt?.endReason, fireReason: receipt?.shot?.fireReason, ticks: receipt?.shot?.predictedFlightTicks, shotEnd: receipt?.shot?.endReason }).slice(0, 300))
const damage = before && after ? before.health - after.health : 0
console.log(damage > 0 ? `F-25 FIXED: focused-window shot dealt ${damage} damage` : 'F-25 STILL BROKEN: no damage with a focused window')
await run('kill @e[type=minecraft:arrow]')
await run(`kill @e[type=minecraft:sheep,name=${TARGET}]`)
ws.close()
await game.close()
await server.close()
