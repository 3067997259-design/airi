/** dy-10 probe: where do the arrows actually land? */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const server = new Client({ name: 'dy10-server', version: '1.0.0' })
await server.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:25602/mcp')))
const TARGET_NBT = `{CustomName:'"Target"',CustomNameVisible:1b,NoAI:1b,Silent:1b,PersistenceRequired:1b,Health:400f,attributes:[{id:"minecraft:generic.max_health",base:400}]}`

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

const SHEEP = { x: 43.5, y: 131, z: -15.5 }
await run('kill @e[type=minecraft:sheep,name=Target]')
await run(`summon minecraft:sheep ${SHEEP.x} ${SHEEP.y} ${SHEEP.z} ${TARGET_NBT}`)
await run('clear airitest minecraft:arrow')
await run('give airitest minecraft:arrow 64')
await run('tp airitest 43.5 141 -25.5 180 0')
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
async function evalTool(tool, payload, maxMs = 60_000) {
  await evalJs(`window.__dy10 = 'pending'
window.__AIRI_GAME_HOST_SMOKE__.executeGameTool('${tool}', ${JSON.stringify(payload)})
  .then(result => { window.__dy10 = result })
  .catch(error => { window.__dy10 = { error: String(error) } })
'started'`)
  const deadline = Date.now() + maxMs
  for (;;) {
    const current = await evalJs('typeof window.__dy10 === "string" ? window.__dy10 : JSON.stringify(window.__dy10)')
    if (current !== 'pending')
      return JSON.parse(current)
    if (Date.now() > deadline)
      return { error: 'timeout' }
    await new Promise(resolve => setTimeout(resolve, 200))
  }
}

await evalJs(`location.hash = '#/devtools/game-host'; 'ok'`)
await new Promise(resolve => setTimeout(resolve, 1500))

const health = async () => {
  const record = structuredOf(await server.callTool({ name: 'query_entities', arguments: { center: SHEEP, radius: 8, includePlayers: false, maxResults: 20, types: ['minecraft:sheep'] } }))
  return (record?.entities ?? []).find(candidate => candidate.name === 'Target')?.health
}

for (let shot = 1; shot <= 3; shot++) {
  const before = await health()
  const receipt = await evalTool('game_shoot', { target: 'Target', weapon: 'bow', maxShots: 1, chargeTicks: 20 })
  await new Promise(resolve => setTimeout(resolve, 1200))
  const after = await health()
  console.log(`shot ${shot}: health ${before} -> ${after}`, 'receipt:', JSON.stringify({ endReason: receipt?.endReason, closestDistance: receipt?.shot?.closestDistance, predictedFlightTicks: receipt?.shot?.predictedFlightTicks, aimTarget: receipt?.shot?.aimTarget }))
}

const arrows = structuredOf(await server.callTool({ name: 'query_entities', arguments: { center: { x: 43, y: 136, z: -15.5 }, radius: 10, includePlayers: false, maxResults: 50, types: ['minecraft:arrow'] } }))
console.log('arrows near dy-10 corridor:', JSON.stringify((arrows?.entities ?? []).map(arrow => ({ x: Number(arrow.x?.toFixed?.(2) ?? arrow.x), y: Number(arrow.y?.toFixed?.(2) ?? arrow.y), z: Number(arrow.z?.toFixed?.(2) ?? arrow.z) }))))

await run('kill @e[type=minecraft:sheep,name=Target]')
await run('tp airitest 82.5 75 -24.5 0 0')
ws.close()
await server.close()
