import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const server = new Client({ name: 'one-shot-server', version: '1.0.0' })
await server.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:25602/mcp')))

async function run(command) {
  return await server.callTool({ name: 'run_command', arguments: { command } })
}

const TARGET_NBT = `{CustomName:'"Target"',CustomNameVisible:1b,NoAI:1b,Silent:1b,PersistenceRequired:1b,Health:400f,attributes:[{id:"minecraft:generic.max_health",base:400}]}`
await run('kill @e[type=minecraft:sheep,name=Target]')
await run(`summon minecraft:sheep 43.5 141 -37.5 ${TARGET_NBT}`)
await run('give airitest minecraft:arrow 32')
await run('tp airitest 43.5 141 -57.5 180 0')
await new Promise(resolve => setTimeout(resolve, 800))

const targets = await (await fetch('http://127.0.0.1:9222/json/list')).json()
const target = targets.find(item => item.type === 'page' && item.url.includes('synced-leader=true'))
const ws = new WebSocket(target.webSocketDebuggerUrl)
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
await new Promise(resolve => setTimeout(resolve, 1500))
console.log('probe:', await evalJs('window.__AIRI_GAME_HOST_SMOKE__ ? "ready" : "missing"'))

const result = await evalJs(`window.__oneShot = 'pending'
window.__AIRI_GAME_HOST_SMOKE__.executeGameTool('game_shoot', { target: 'Target', weapon: 'bow', maxShots: 1, chargeTicks: 20 })
  .then(r => { window.__oneShot = r })
  .catch(e => { window.__oneShot = { error: String(e) } })
'started'`)
let current = 'pending'
for (let attempt = 0; attempt < 90 && current === 'pending'; attempt++) {
  current = await evalJs('typeof window.__oneShot === "string" ? window.__oneShot : JSON.stringify(window.__oneShot)')
  if (current === 'pending')
    await new Promise(resolve => setTimeout(resolve, 500))
}
console.log('game_shoot result:')
console.log(JSON.stringify(JSON.parse(current), null, 1).slice(0, 2500))

await run('kill @e[type=minecraft:sheep,name=Target]')
ws.close()
await server.close()
