import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const server = new Client({ name: 'b7b-server', version: '1.0.0' })
await server.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:25602/mcp')))
const game = new Client({ name: 'b7b-game', version: '1.0.0' })
await game.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:25600/mcp')))

function textOf(result) {
  return (result?.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n')
}
function structuredOf(result) {
  if (result?.structuredContent && typeof result.structuredContent === 'object')
    return result.structuredContent
  try {
    return JSON.parse(textOf(result))
  }
  catch {
    return undefined
  }
}
async function run(command) {
  return await server.callTool({ name: 'run_command', arguments: { command } })
}
async function tridents() {
  const inventory = structuredOf(await game.callTool({ name: 'get_inventory', arguments: {} }))
  return [...(inventory?.hotbar ?? []), ...(inventory?.main ?? [])].filter(slot => slot.id === 'minecraft:trident').reduce((total, slot) => total + slot.count, 0)
}

await run('kill @e[type=minecraft:sheep,name=Target]')
await run('summon minecraft:sheep 96.5 75 -29.5 {CustomName:\'"Target"\',NoAI:1b,Silent:1b,PersistenceRequired:1b,Health:400f,attributes:[{id:"minecraft:generic.max_health",base:400}]}')
await run('clear airitest minecraft:trident')
await run('give airitest minecraft:trident[minecraft:enchantments={"minecraft:loyalty":3}] 1')
await run('tp airitest 86.5 75 -29.5 -90 0')
await new Promise(resolve => setTimeout(resolve, 800))
console.log('tridents before:', await tridents())

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
await evalJs(`location.hash = '#/devtools/game-host'; 'ok'`)
await new Promise(resolve => setTimeout(resolve, 1200))

await evalJs(`window.__b7b = 'pending'
window.__AIRI_GAME_HOST_SMOKE__.executeGameTool('game_shoot', { target: 'Target', weapon: 'trident', maxShots: 1 })
  .then(result => { window.__b7b = result })
  .catch(error => { window.__b7b = { error: String(error) } })
'started'`)

let fired = false
let firedAt
const start = Date.now()
for (let index = 0; index < 60; index++) {
  await new Promise(resolve => setTimeout(resolve, 200))
  const status = structuredOf(await game.callTool({ name: 'combat_status', arguments: {} }))
  if ((status?.shotsFired ?? 0) >= 1) {
    fired = true
    firedAt = Date.now() - start
    break
  }
  const current = await evalJs('typeof window.__b7b === "string" ? window.__b7b : JSON.stringify(window.__b7b)')
  if (current !== 'pending')
    break
}
console.log(`fired=${fired} at=${firedAt}ms; tridents mid=${await tridents()}`)
if (fired) {
  await evalJs(`window.__AIRI_GAME_HOST_SMOKE__.executeGameTool('game_cancel', {}).catch(() => {})`)
}
const deadline = Date.now() + 25_000
for (;;) {
  const current = await evalJs('typeof window.__b7b === "string" ? window.__b7b : JSON.stringify(window.__b7b)')
  if (current !== 'pending') {
    console.log('receipt:', current.slice(0, 760))
    break
  }
  if (Date.now() > deadline) {
    console.log('receipt: timeout')
    break
  }
  await new Promise(resolve => setTimeout(resolve, 300))
}
await new Promise(resolve => setTimeout(resolve, 6_000))
console.log('tridents after 6s:', await tridents())
ws.close()
await game.close()
await server.close()
