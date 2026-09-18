/**
 * B-08 potions: splash and lingering potions aimed at a target, effects read back.
 */
import { writeFileSync } from 'node:fs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const CASES = [
  { name: 'splash-poison', item: 'minecraft:splash_potion[potion_contents={potion:"poison"}]', base: 'minecraft:splash_potion', expect: 'minecraft:poison' },
  { name: 'lingering-slowness', item: 'minecraft:lingering_potion[potion_contents={potion:"slowness"}]', base: 'minecraft:lingering_potion', expect: 'minecraft:slowness' },
]
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
const server = new Client({ name: 'pot-server', version: '1.0.0' })
await server.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:25602/mcp')))
const game = new Client({ name: 'pot-game', version: '1.0.0' })
await game.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:25600/mcp')))
async function run(command) {
  const result = await server.callTool({ name: 'run_command', arguments: { command } })
  const record = structuredOf(result)
  return record?.output?.join('\n') ?? ''
}
async function targetState(name) {
  const record = structuredOf(await server.callTool({ name: 'query_entities', arguments: { center: { x: 258, y: 201, z: -20 }, radius: 10, includePlayers: false, maxResults: 30, types: ['minecraft:sheep'] } }))
  const matches = (record?.entities ?? []).filter(candidate => candidate.name === name)
  const alive = matches.find(candidate => Number(candidate.health) > 0)
  return alive ? { uuid: alive.uuid, health: Number(alive.health) } : undefined
}
async function effects(uuid) {
  const detail = structuredOf(await server.callTool({ name: 'get_entity', arguments: { uuid } }))
  return { health: detail?.health, effects: detail?.effects }
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
async function tool(name, payload) {
  await evalJs(`window.__pot = 'pending'
window.__AIRI_GAME_HOST_SMOKE__.executeGameTool('${name}', ${JSON.stringify(payload)}).then(r => { window.__pot = r }).catch(e => { window.__pot = { error: String(e) } })
'go'`)
  let state = 'pending'
  for (let i = 0; i < 80 && state === 'pending'; i++) { await sleep(250); state = await evalJs('typeof window.__pot === "string" ? window.__pot : JSON.stringify(window.__pot)') }
  return typeof state === 'string' ? JSON.parse(state) : state
}
await evalJs(`location.hash = '#/devtools/game-host'; 'ok'`)
await sleep(1000)

const evidence = { id: 'B-08 splash and lingering potions', cases: [] }
for (const [index, testCase] of CASES.entries()) {
  const name = `MPot${index}`
  console.log('kill:', await run(`kill @e[type=minecraft:sheep,name=${name}]`))
  console.log('summon:', await run(`summon minecraft:sheep 258 201 -20 {CustomName:'"${name}"',CustomNameVisible:1b,NoAI:1b,Silent:1b,PersistenceRequired:1b,Health:45f,attributes:[{id:"minecraft:generic.max_health",base:45},{id:"minecraft:generic.knockback_resistance",base:1.0}]}`))
  await run('tp airitest 258 201 -26 180 0')
  await run('clear airitest minecraft:splash_potion')
  await run('clear airitest minecraft:lingering_potion')
  console.log('give:', await run(`give airitest ${testCase.item} 4`))
  let target
  for (let attempt = 0; attempt < 6 && !target; attempt++) {
    await sleep(600)
    target = await targetState(name)
  }
  if (!target) {
    console.log(`${testCase.name}: no live target found`)
    continue
  }
  const before = await effects(target.uuid)
  const equip = await tool('game_equip', { itemId: testCase.base, target: 'main_hand' })
  const use = await tool('game_use', { mode: 'entity', uuid: target.uuid, holdTicks: 2 })
  await sleep(1600)
  const after = await effects(target.uuid)
  const record = {
    name: testCase.name,
    target,
    expect: testCase.expect,
    equip: { status: equip?.status, endReason: equip?.endReason },
    use: { status: use?.status, endReason: use?.endReason, error: use?.error },
    before,
    after,
    matched: Array.isArray(after?.effects) && after.effects.some(effect => effect.id === testCase.expect),
  }
  evidence.cases.push(record)
  console.log(`${testCase.name}:`, JSON.stringify({ equip: record.equip.endReason, use: record.use.endReason, hp: `${before?.health}->${after?.health}`, effects: after?.effects, matched: record.matched }).slice(0, 340))
  await run(`kill @e[type=minecraft:sheep,name=${name}]`)
}
writeFileSync(new URL('./b08-potions.json', import.meta.url), JSON.stringify(evidence, null, 2))
await run('clear airitest minecraft:splash_potion')
await run('clear airitest minecraft:lingering_potion')
ws.close()
await game.close()
await server.close()
