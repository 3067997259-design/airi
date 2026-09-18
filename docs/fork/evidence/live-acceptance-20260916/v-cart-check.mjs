/** V-06 focused: powered rail under the cart's resting cell, latch released after 3 s. */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const server = new Client({ name: 'vc-server', version: '1.0.0' })
await server.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:25602/mcp')))
const game = new Client({ name: 'vc-game', version: '1.0.0' })
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
async function gt(name, args = {}) {
  return structuredOf(await game.callTool({ name, arguments: args }))
}
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
async function moveTool(payload, maxMs = 120_000) {
  await evalJs(`window.__vc = 'pending'
window.__AIRI_GAME_HOST_SMOKE__.executeGameTool('game_move_to', ${JSON.stringify(payload)})
  .then(result => { window.__vc = result })
  .catch(error => { window.__vc = { error: String(error) } })
'started'`)
  const deadline = Date.now() + maxMs
  for (;;) {
    const current = await evalJs('typeof window.__vc === "string" ? window.__vc : JSON.stringify(window.__vc)')
    if (current !== 'pending')
      return JSON.parse(current)
    if (Date.now() > deadline)
      return { error: 'timeout' }
    await new Promise(resolve => setTimeout(resolve, 300))
  }
}

await evalJs(`location.hash = '#/devtools/game-host'; 'ok'`)
await new Promise(resolve => setTimeout(resolve, 1200))

const site = { x: 120, z: -60, floor: 101 }
const railY = site.floor + 1
const railZ = site.z
const railX1 = 110
const railX2 = 126
await run(`fill ${railX1 - 4} ${railY - 1} ${railZ - 2} ${railX2 + 2} ${railY - 1} ${railZ + 2} minecraft:stone`)
await run('kill @e[type=minecraft:minecart]')
await run(`fill ${railX1} ${railY} ${railZ} ${railX2} ${railY} ${railZ} minecraft:rail[shape=east_west]`)
// The cart rests against the latch at railX1+2, so the powered start is its cell.
await run(`setblock ${railX1 + 1} ${railY} ${railZ} minecraft:powered_rail[shape=east_west]`)
await run(`setblock ${railX1 + 1} ${railY - 1} ${railZ} minecraft:redstone_block`)
await run(`setblock ${railX1 + 2} ${railY} ${railZ} minecraft:stone`)
await run(`summon minecraft:minecart ${railX1 + 1}.5 ${railY + 0.2} ${railZ + 0.5}`)
await run(`tp airitest ${railX1 - 1.5} ${railY + 1} ${railZ + 0.5} 90 0`)
await new Promise(resolve => setTimeout(resolve, 900))
const cart = (await gt('get_vehicles', { radius: 8, kind: 'minecraft:minecart' }))?.vehicles?.[0]
console.log('cart before:', JSON.stringify({ uuid: cart?.uuid, x: cart?.x, onRail: cart?.onRail, powered: cart?.powered, railShape: cart?.railShape }))
const movePromise = moveTool({ x: railX2 - 0.5, y: railY + 1, z: railZ + 0.5, tolerance: 2, vehicle: 'minecart' }, 120_000)
await new Promise(resolve => setTimeout(resolve, 3500))
console.log('latch released:', await run(`setblock ${railX1 + 2} ${railY} ${railZ} minecraft:air`))
for (let sample = 0; sample < 8; sample++) {
  await new Promise(resolve => setTimeout(resolve, 1000))
  const self = await gt('get_self')
  console.log(`+${sample + 1}s:`, JSON.stringify({ x: Number(self?.x).toFixed(2), y: Number(self?.y).toFixed(2), z: Number(self?.z).toFixed(2) }))
  if (sample === 6)
    break
}
const result = await movePromise
console.log('move result:', JSON.stringify({ status: result.status, endReason: result.endReason, vehicle: result.vehicle, final: result.finalSnapshot?.position }))
await run('kill @e[type=minecraft:minecart]')
await run(`setblock ${railX1 + 1} ${railY - 1} ${railZ} minecraft:air`)
await run('tp airitest 82.5 75 -24.5 0 0')
ws.close()
await game.close()
await server.close()
