/**
 * B-08 firework fire path: the user pre-loaded the crossbow, so this verifies
 * the shot itself (profile, projectile recognition, explosion damage).
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
const server = new Client({ name: 'fwf-server', version: '1.0.0' })
await server.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:25602/mcp')))
const game = new Client({ name: 'fwf-game', version: '1.0.0' })
await game.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:25600/mcp')))
async function run(command) {
  const result = await server.callTool({ name: 'run_command', arguments: { command } })
  const record = structuredOf(result)
  return record?.output?.join('\n') ?? JSON.stringify(record).slice(0, 200)
}
async function sheep() {
  const record = structuredOf(await server.callTool({ name: 'query_entities', arguments: { center: { x: 258, y: 201, z: -20 }, radius: 10, includePlayers: false, maxResults: 30, types: ['minecraft:sheep'] } }))
  const entry = (record?.entities ?? []).find(candidate => candidate.name === TARGET)
  return entry ? { health: Number(entry.health) } : undefined
}
const equipmentOf = async () => {
  const record = structuredOf(await game.callTool({ name: 'get_equipment', arguments: {} }))
  return { mainHand: record?.mainHand?.id, offHand: record?.offHand?.id }
}
const statusOf = async () => structuredOf(await game.callTool({ name: 'combat_status', arguments: {} }))

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
await sleep(900)
const before = { equipment: await equipmentOf(), projectiles: (await statusOf())?.projectiles, sheep: await sheep() }
console.log('before:', JSON.stringify(before))
await evalJs(`window.__fwf = 'pending'
window.__AIRI_GAME_HOST_SMOKE__.executeGameTool('game_shoot', { target: '${TARGET}', weapon: 'crossbow', maxShots: 1, chargeTicks: 20 }).then(r => { window.__fwf = r }).catch(e => { window.__fwf = { error: String(e) } })
'go'`)
let state = 'pending'
for (let i = 0; i < 100 && state === 'pending'; i++) { await sleep(250); state = await evalJs('typeof window.__fwf === "string" ? window.__fwf : JSON.stringify(window.__fwf)') }
await sleep(1200)
const receipt = typeof state === 'string' ? JSON.parse(state) : state
const after = { sheep: await sheep(), equipment: await equipmentOf(), status: await statusOf() }
console.log('receipt:', JSON.stringify({ endReason: receipt?.endReason, fired: receipt?.shot?.shots?.length ?? 0, profile: receipt?.shot?.profileId, verifiedBy: receipt?.shot?.shots?.[0]?.verifiedBy, closest: receipt?.shot?.closestDistance, observedSpeed: receipt?.shot?.observedSpeed, refusal: receipt?.shot?.refusalReason }).slice(0, 400))
console.log('after:', JSON.stringify({ sheep: after.sheep, equipment: after.equipment, charged: after.status?.charged, endReason: after.status?.endReason }).slice(0, 300))
writeFileSync(new URL('./b08-firework-fire.json', import.meta.url), JSON.stringify({ before, receipt, after: { sheep: after.sheep, equipment: after.equipment, status: after.status } }, null, 2))
await run(`kill @e[type=minecraft:sheep,name=${TARGET}]`)
await run('kill @e[type=minecraft:firework_rocket]')
ws.close()
await game.close()
await server.close()
