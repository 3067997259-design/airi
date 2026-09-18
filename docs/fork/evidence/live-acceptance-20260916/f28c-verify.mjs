/**
 * F-28 fix verification: the mod loads and fires a firework crossbow on its own,
 * twice in a row, and the explosive payload damages the target.
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
const server = new Client({ name: 'f28c-server', version: '1.0.0' })
await server.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:25602/mcp')))
const game = new Client({ name: 'f28c-game', version: '1.0.0' })
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
async function shoot() {
  await evalJs(`window.__f28c = 'pending'
window.__AIRI_GAME_HOST_SMOKE__.executeGameTool('game_shoot', { target: '${TARGET}', weapon: 'crossbow', maxShots: 1, chargeTicks: 20 }).then(r => { window.__f28c = r }).catch(e => { window.__f28c = { error: String(e) } })
'go'`)
  let state = 'pending'
  for (let i = 0; i < 160 && state === 'pending'; i++) { await sleep(250); state = await evalJs('typeof window.__f28c === "string" ? window.__f28c : JSON.stringify(window.__f28c)') }
  return typeof state === 'string' ? JSON.parse(state) : state
}

await run(`kill @e[type=minecraft:sheep,name=${TARGET}]`)
await run(`summon minecraft:sheep 258 201 -20 {CustomName:'"${TARGET}"',CustomNameVisible:1b,NoAI:1b,Silent:1b,PersistenceRequired:1b,Health:45f,attributes:[{id:"minecraft:generic.max_health",base:45},{id:"minecraft:generic.knockback_resistance",base:1.0}]}`)
await run('tp airitest 258 201 -32 180 0')
await run('clear airitest minecraft:arrow')
await run('clear airitest minecraft:crossbow')
await run('clear airitest minecraft:firework_rocket')
await run('give airitest minecraft:crossbow 1')
await run('give airitest minecraft:firework_rocket[fireworks={explosions:[{shape:"large_ball"},{shape:"large_ball"},{shape:"large_ball"},{shape:"large_ball"},{shape:"large_ball"},{shape:"large_ball"},{shape:"large_ball"}]}] 8')
await sleep(900)
const evidence = { id: 'F-28 verification: autonomous firework crossbow', shots: [] }
for (let shot = 1; shot <= 2; shot++) {
  const before = await sheep()
  const receipt = await shoot()
  await sleep(1500)
  const after = await sheep()
  const record = {
    shot,
    before,
    after,
    endReason: receipt?.endReason,
    fired: receipt?.shot?.shots?.length ?? 0,
    profileId: receipt?.shot?.profileId,
    verifiedBy: receipt?.shot?.shots?.[0]?.verifiedBy,
    closestDistance: receipt?.shot?.closestDistance,
    receipt,
  }
  evidence.shots.push(record)
  console.log(`shot ${shot}:`, JSON.stringify({ endReason: record.endReason, fired: record.fired, profile: record.profileId, verified: record.verifiedBy, closest: record.closestDistance, hp: `${before?.health}->${after?.health}` }).slice(0, 300))
}
writeFileSync(new URL('./f28c-verify.json', import.meta.url), JSON.stringify(evidence, null, 2))
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
