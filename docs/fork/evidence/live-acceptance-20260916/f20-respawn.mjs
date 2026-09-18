/** F-20 verification: kill the bot, then revive it through the host domain respawn action. */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const server = new Client({ name: 'respawn-server', version: '1.0.0' })
await server.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:25602/mcp')))
const game = new Client({ name: 'respawn-game', version: '1.0.0' })
await game.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:25600/mcp')))

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
async function run(command) {
  const result = await server.callTool({ name: 'run_command', arguments: { command } })
  return structuredOf(result)?.success === true
}
async function self() {
  return structuredOf(await game.callTool({ name: 'get_self', arguments: {} }))
}

await call_(server, 'run_command', { command: 'tp airitest 82.5 75 -24.5' })
// kill the bot in survival
await run('gamemode survival airitest')
await run('kill airitest')
await new Promise(resolve => setTimeout(resolve, 1500))
const dead = await self()
console.log('after kill:', JSON.stringify({ health: dead?.health, x: dead?.x, y: dead?.y, z: dead?.z }))

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
    return `EXC: ${message.result.exceptionDetails.exception?.description ?? 'eval failed'}`
  return message.result?.result?.value
}
await evalJs(`location.hash = '#/devtools/game-host'; 'ok'`)
await new Promise(resolve => setTimeout(resolve, 1400))
await evalJs(`window.__rp = 'pending'
window.__AIRI_GAME_HOST_SMOKE__.executeGameTool('game_respawn', {})
  .then(result => { window.__rp = result })
  .catch(error => { window.__rp = { error: String(error) } })
'started'`)
let result = 'pending'
for (let attempt = 0; attempt < 60 && result === 'pending'; attempt++) {
  await new Promise(resolve => setTimeout(resolve, 300))
  result = await evalJs('typeof window.__rp === "string" ? window.__rp : JSON.stringify(window.__rp)')
}
console.log('game_respawn result:', String(result).slice(0, 500))
await new Promise(resolve => setTimeout(resolve, 1500))
const alive = await self()
console.log('after respawn:', JSON.stringify({ health: alive?.health, x: alive?.x, y: alive?.y, z: alive?.z }))
await run('effect give airitest minecraft:resistance 120 4 true')
ws.close()
await game.close()
await server.close()

function call_(client, name, args) {
  return client.callTool({ name, arguments: args })
}
