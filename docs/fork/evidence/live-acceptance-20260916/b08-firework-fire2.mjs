/**
 * B-08 firework fire path with an explosive payload: wait for the user to load
 * the crossbow by hand, then fire and verify explosion damage.
 */
import { writeFileSync } from 'node:fs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const TARGET = 'MTarget'
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
const server = new Client({ name: 'fwf2-server', version: '1.0.0' })
await server.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:25602/mcp')))
const game = new Client({ name: 'fwf2-game', version: '1.0.0' })
await game.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:25600/mcp')))
async function run(command) {
  const result = await server.callTool({ name: 'run_command', arguments: { command } })
  const record = structuredOf(result)
  return record?.output?.join('\n') ?? ''
}
async function sheep() {
  const record = structuredOf(await server.callTool({ name: 'query_entities', arguments: { center: { x: 258, y: 201, z: -20 }, radius: 10, includePlayers: false, maxResults: 30, types: ['minecraft:sheep'] } }))
  const entry = (record?.entities ?? []).find(candidate => candidate.name === TARGET)
  return entry ? { health: Number(entry.health) } : undefined
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

await run(`kill @e[type=minecraft:sheep,name=${TARGET}]`)
await run(`summon minecraft:sheep 258 201 -20 {CustomName:'"${TARGET}"',CustomNameVisible:1b,NoAI:1b,Silent:1b,PersistenceRequired:1b,Health:45f,attributes:[{id:"minecraft:generic.max_health",base:45},{id:"minecraft:generic.knockback_resistance",base:1.0}]}`)
await run('tp airitest 258 201 -32 180 0')
await run('clear airitest minecraft:firework_rocket')
await run('give airitest minecraft:firework_rocket[fireworks={explosions:[{shape:"large_ball"},{shape:"large_ball"},{shape:"large_ball"},{shape:"large_ball"},{shape:"large_ball"},{shape:"large_ball"},{shape:"large_ball"}]}] 8')
await sleep(800)
console.log('setup done; waiting for the hand-loaded crossbow (up to 5 min)...')

let charged = false
for (let attempt = 0; attempt < 300 && !charged; attempt++) {
  await sleep(1000)
  const selected = await run('data get entity airitest SelectedItemSlot')
  const slot = Number((selected.match(/(\d+)/) ?? [])[1])
  if (!Number.isFinite(slot)) {
    continue
  }
  const nbt = await run(`data get entity airitest Inventory[{Slot:${slot}b}].components`)
  charged = nbt.includes('charged_projectiles') && nbt.includes('firework_rocket')
}
console.log('crossbow charged:', charged)
if (!charged) {
  console.log('timed out waiting for the manual load')
  ws.close(); await game.close(); await server.close()
  process.exit(1)
}

const before = { sheep: await sheep() }
await evalJs(`window.__fwf2 = 'pending'
window.__AIRI_GAME_HOST_SMOKE__.executeGameTool('game_shoot', { target: '${TARGET}', weapon: 'crossbow', maxShots: 1, chargeTicks: 20 }).then(r => { window.__fwf2 = r }).catch(e => { window.__fwf2 = { error: String(e) } })
'go'`)
let state = 'pending'
for (let i = 0; i < 100 && state === 'pending'; i++) { await sleep(250); state = await evalJs('typeof window.__fwf2 === "string" ? window.__fwf2 : JSON.stringify(window.__fwf2)') }
await sleep(1500)
const receipt = typeof state === 'string' ? JSON.parse(state) : state
const after = { sheep: await sheep() }
console.log('receipt:', JSON.stringify({ endReason: receipt?.endReason, fired: receipt?.shot?.shots?.length ?? 0, profile: receipt?.shot?.profileId, verifiedBy: receipt?.shot?.shots?.[0]?.verifiedBy, closest: receipt?.shot?.closestDistance, observedSpeed: receipt?.shot?.observedSpeed }).slice(0, 400))
console.log('sheep:', JSON.stringify(before), '->', JSON.stringify(after))
writeFileSync(new URL('./b08-firework-fire2.json', import.meta.url), JSON.stringify({ receipt, before, after }, null, 2))
await run(`kill @e[type=minecraft:sheep,name=${TARGET}]`)
ws.close()
await game.close()
await server.close()
