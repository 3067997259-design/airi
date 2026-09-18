/** dy0 d40 refusal probe: log the target position and the receipt per shot. */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const server = new Client({ name: 'refuse-server', version: '1.0.0' })
await server.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:25602/mcp')))
const TARGET_NBT = `{CustomName:'"Target"',CustomNameVisible:1b,NoAI:1b,Silent:1b,PersistenceRequired:1b,Health:400f,attributes:[{id:"minecraft:generic.max_health",base:400}]}`
const SHEEP = { x: 43.5, y: 141, z: -17.5 }

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

await run('kill @e[type=minecraft:sheep,name=Target]')
await run(`summon minecraft:sheep ${SHEEP.x} ${SHEEP.y} ${SHEEP.z} ${TARGET_NBT}`)
await run('clear airitest minecraft:arrow')
await run('give airitest minecraft:arrow 64')
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
async function evalTool(tool, payload, maxMs = 60_000) {
  await evalJs(`window.__probe = 'pending'
window.__AIRI_GAME_HOST_SMOKE__.executeGameTool('${tool}', ${JSON.stringify(payload)})
  .then(result => { window.__probe = result })
  .catch(error => { window.__probe = { error: String(error) } })
'started'`)
  const deadline = Date.now() + maxMs
  for (;;) {
    const current = await evalJs('typeof window.__probe === "string" ? window.__probe : JSON.stringify(window.__probe)')
    if (current !== 'pending')
      return JSON.parse(current)
    if (Date.now() > deadline)
      return { error: 'timeout' }
    await new Promise(resolve => setTimeout(resolve, 200))
  }
}

await evalJs(`location.hash = '#/devtools/game-host'; 'ok'`)
await new Promise(resolve => setTimeout(resolve, 1500))

const sheepState = async () => {
  const record = structuredOf(await server.callTool({ name: 'query_entities', arguments: { center: SHEEP, radius: 12, includePlayers: false, maxResults: 30, types: ['minecraft:sheep'] } }))
  const entry = (record?.entities ?? []).find(candidate => candidate.name === 'Target')
  return entry ? { x: entry.x, y: entry.y, z: entry.z, health: entry.health } : undefined
}

for (let shot = 1; shot <= 6; shot++) {
  const before = await sheepState()
  const receipt = await evalTool('game_shoot', { target: 'Target', weapon: 'bow', maxShots: 1, chargeTicks: 20 })
  await new Promise(resolve => setTimeout(resolve, 1000))
  const after = await sheepState()
  console.log(`shot ${shot}: sheep before ${JSON.stringify(before)} -> after ${JSON.stringify(after)}`)
  console.log(`   receipt endReason=${receipt?.endReason} fired=${receipt?.shot?.shots?.length ?? 0} closest=${receipt?.shot?.closestDistance} ticks=${receipt?.shot?.predictedFlightTicks} arc=${receipt?.shot?.arc} aim=${JSON.stringify(receipt?.shot?.aimTarget)}`)
}

await run('kill @e[type=minecraft:sheep,name=Target]')
await run('tp airitest 82.5 75 -24.5 0 0')
ws.close()
await server.close()
