/** B-08 firework: read the server's view of the off hand and the selected slot. */
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
const server = new Client({ name: 'fw2-server', version: '1.0.0' })
await server.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:25602/mcp')))
const game = new Client({ name: 'fw2-game', version: '1.0.0' })
await game.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:25600/mcp')))
async function run(command) {
  const result = await server.callTool({ name: 'run_command', arguments: { command } })
  const record = structuredOf(result)
  return record?.output?.join('\n') ?? JSON.stringify(record).slice(0, 200)
}
async function equipment() {
  const record = structuredOf(await game.callTool({ name: 'get_equipment', arguments: {} }))
  return { mainHand: record?.mainHand?.id, offHand: record?.offHand?.id }
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
await run(`summon minecraft:sheep 258 201 -20 {CustomName:'"${TARGET}"',CustomNameVisible:1b,NoAI:1b,Silent:1b,PersistenceRequired:1b,Health:45f}`)
await run('tp airitest 258 201 -32 180 0')
await run('clear airitest minecraft:arrow')
await run('clear airitest minecraft:crossbow')
await run('clear airitest minecraft:firework_rocket')
await run('give airitest minecraft:crossbow 1')
await run('give airitest minecraft:firework_rocket 8')
await sleep(900)
console.log('client equipment before:', JSON.stringify(await equipment()))
console.log('server offhand before:', await run('data get entity airitest Inventory[{Slot:-106b}]'))
console.log('server selected before:', await run('data get entity airitest SelectedItemSlot'))
await evalJs(`window.__fw2 = 'pending'
window.__AIRI_GAME_HOST_SMOKE__.executeGameTool('game_shoot', { target: '${TARGET}', weapon: 'crossbow', maxShots: 1, chargeTicks: 20 }).then(r => { window.__fw2 = r }).catch(e => { window.__fw2 = { error: String(e) } })
'go'`)
await sleep(2500)
console.log('client equipment during:', JSON.stringify(await equipment()))
console.log('server offhand during:', await run('data get entity airitest Inventory[{Slot:-106b}]'))
console.log('server selected during:', await run('data get entity airitest SelectedItemSlot'))
let state = 'pending'
for (let i = 0; i < 60 && state === 'pending'; i++) { await sleep(300); state = await evalJs('typeof window.__fw2 === "string" ? window.__fw2 : JSON.stringify(window.__fw2)') }
const receipt = typeof state === 'string' ? JSON.parse(state) : state
console.log('receipt:', JSON.stringify({ endReason: receipt?.endReason, fired: receipt?.shot?.shots?.length ?? 0 }).slice(0, 200))
console.log('server offhand after:', await run('data get entity airitest Inventory[{Slot:-106b}]'))
await run('clear airitest minecraft:crossbow')
await run('clear airitest minecraft:firework_rocket')
await run('give airitest minecraft:arrow 64')
await run('give airitest minecraft:arrow 64')
await run('give airitest minecraft:arrow 64')
await run('give airitest minecraft:arrow 64')
await run(`kill @e[type=minecraft:sheep,name=${TARGET}]`)
ws.close()
await game.close()
await server.close()
