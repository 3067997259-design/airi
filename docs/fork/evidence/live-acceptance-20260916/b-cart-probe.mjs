/** One shot at a stationary cart on the A-line: isolates the corridor from the mover. */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const server = new Client({ name: 'probe-server', version: '1.0.0' })
await server.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:25602/mcp')))

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

await run('kill @e[type=minecraft:minecart]')
await run('setblock 241 201 -42 minecraft:lever[face=floor,facing=north,powered=false]')
await run(`summon minecraft:minecart 240.5 201.2 -41.6 {CustomName:'"MCart"',CustomNameVisible:1b}`)
await run('gamerule sendCommandFeedback true')
await new Promise(resolve => setTimeout(resolve, 600))
await server.callTool({ name: 'teleport_player', arguments: { player: 'airitest', x: 252.5, y: 201, z: -41.5, yaw: 90, pitch: 0 } })
await new Promise(resolve => setTimeout(resolve, 900))

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
await evalJs(`window.__probe = 'pending'
window.__AIRI_GAME_HOST_SMOKE__.executeGameTool('game_shoot', { target: 'MCart', weapon: 'bow', maxShots: 1, chargeTicks: 20 })
  .then(result => { window.__probe = result })
  .catch(error => { window.__probe = { error: String(error) } })
'started'`)
await new Promise(resolve => setTimeout(resolve, 6000))
const result = await evalJs('typeof window.__probe === "string" ? window.__probe : JSON.stringify(window.__probe)')
console.log('stationary cart shot:', String(result).slice(0, 700))
await run('kill @e[type=minecraft:minecart]')
ws.close()
await server.close()
