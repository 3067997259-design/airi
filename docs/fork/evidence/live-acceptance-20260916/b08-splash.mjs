/**
 * B-08 splash potion: throw a splash potion at a target and read the effect back.
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
const server = new Client({ name: 'splash-server', version: '1.0.0' })
await server.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:25602/mcp')))
const game = new Client({ name: 'splash-game', version: '1.0.0' })
await game.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:25600/mcp')))
async function run(command) {
  const result = await server.callTool({ name: 'run_command', arguments: { command } })
  const record = structuredOf(result)
  return record?.output?.join('\n') ?? ''
}
async function sheep() {
  const record = structuredOf(await server.callTool({ name: 'query_entities', arguments: { center: { x: 258, y: 201, z: -20 }, radius: 10, includePlayers: false, maxResults: 30, types: ['minecraft:sheep'] } }))
  const entry = (record?.entities ?? []).find(candidate => candidate.name === TARGET)
  return entry ? { health: Number(entry.health), uuid: entry.uuid } : undefined
}
async function effects(uuid) {
  const detail = structuredOf(await server.callTool({ name: 'get_entity', arguments: { uuid } }))
  return { health: detail?.health, effects: detail?.effects }
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
await run('tp airitest 258 201 -26 180 0')
await run('clear airitest minecraft:splash_potion')
console.log('give:', await run('give airitest minecraft:splash_potion[potion_contents={potion:"poison"}] 4'))
await sleep(800)
const target = await sheep()
const before = target?.uuid ? await effects(target.uuid) : undefined
console.log('target before:', JSON.stringify(before))
await evalJs(`window.__sp = 'pending'
window.__AIRI_GAME_HOST_SMOKE__.executeGameTool('game_equip', { itemId: 'minecraft:splash_potion', target: 'main_hand' }).then(r => { window.__sp = r }).catch(e => { window.__sp = { error: String(e) } })
'go'`)
let state = 'pending'
for (let i = 0; i < 60 && state === 'pending'; i++) { await sleep(250); state = await evalJs('typeof window.__sp === "string" ? window.__sp : JSON.stringify(window.__sp)') }
console.log('equip:', String(state).slice(0, 200))
await evalJs(`window.__sp2 = 'pending'
window.__AIRI_GAME_HOST_SMOKE__.executeGameTool('game_use', { mode: 'entity', uuid: '${target?.uuid}', holdTicks: 2 }).then(r => { window.__sp2 = r }).catch(e => { window.__sp2 = { error: String(e) } })
'go'`)
state = 'pending'
for (let i = 0; i < 80 && state === 'pending'; i++) { await sleep(250); state = await evalJs('typeof window.__sp2 === "string" ? window.__sp2 : JSON.stringify(window.__sp2)') }
console.log('use:', String(state).slice(0, 260))
await sleep(1500)
const after = target?.uuid ? await effects(target.uuid) : undefined
console.log('target after:', JSON.stringify(after))
writeFileSync(new URL('./b08-splash.json', import.meta.url), JSON.stringify({ equip: state, before, after }, null, 2))
await run('clear airitest minecraft:splash_potion')
await run(`kill @e[type=minecraft:sheep,name=${TARGET}]`)
ws.close()
await game.close()
await server.close()
