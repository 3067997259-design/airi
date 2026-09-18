/**
 * M-04a: the user mines one block of the shared patch and leaves its drop; the
 * bot then mines the adjacent block with a required cobblestone product. The
 * ledger must credit only the bot's own drop, never the user's item.
 */
import { writeFileSync } from 'node:fs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const USER_BLOCK = { x: 259, y: 201, z: -33 }
const BOT_BLOCK = { x: 259, y: 201, z: -32 }
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
const server = new Client({ name: 'm04-server', version: '1.0.0' })
await server.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:25602/mcp')))
const game = new Client({ name: 'm04-game', version: '1.0.0' })
await game.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:25600/mcp')))
async function run(command) {
  return await server.callTool({ name: 'run_command', arguments: { command } })
}
async function blockAt(x, y, z) {
  const record = structuredOf(await server.callTool({ name: 'get_block', arguments: { x, y, z } }))
  return record?.id ?? record?.block
}
async function itemsNear(x, y, z, radius = 5) {
  const record = structuredOf(await server.callTool({ name: 'query_entities', arguments: { center: { x, y, z }, radius, includePlayers: false, maxResults: 40, types: ['minecraft:item'] } }))
  return (record?.entities ?? []).map(item => ({ name: item.name, x: Number(item.x), y: Number(item.y), z: Number(item.z) }))
}
async function cobblestoneCount() {
  const inventory = structuredOf(await game.callTool({ name: 'get_inventory', arguments: {} }))
  const slots = [...(inventory?.hotbar ?? []), ...(inventory?.main ?? [])].filter(Boolean)
  return slots.filter(slot => slot.id === 'minecraft:cobblestone').reduce((sum, slot) => sum + Number(slot.count ?? 0), 0)
}

const evidence = { id: 'M-04a shared patch, user mines alongside', startedAt: new Date().toISOString() }
console.log('patch before:', JSON.stringify(await Promise.all([USER_BLOCK, BOT_BLOCK].map(p => blockAt(p.x, p.y, p.z)))))

// Wait for the user to mine their block (their drop stays on the ground).
let userBroke = false
for (let attempt = 0; attempt < 180 && !userBroke; attempt++) {
  await sleep(500)
  userBroke = (await blockAt(USER_BLOCK.x, USER_BLOCK.y, USER_BLOCK.z)) !== 'minecraft:stone'
}
if (!userBroke) {
  console.log('user block never disappeared; aborting')
  process.exit(1)
}
await sleep(600)
evidence.userDrop = await itemsNear(258, 201, -32, 4)
evidence.botCobbleBefore = await cobblestoneCount()
console.log('user drop on ground:', JSON.stringify(evidence.userDrop), 'bot cobble before:', evidence.botCobbleBefore)

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
await sleep(1200)
await evalJs(`window.__m04 = 'pending'
window.__AIRI_GAME_HOST_SMOKE__.executeGameTool('game_break', { x: ${BOT_BLOCK.x}, y: ${BOT_BLOCK.y}, z: ${BOT_BLOCK.z}, itemId: 'minecraft:cobblestone' }).then(r => { window.__m04 = r }).catch(e => { window.__m04 = { error: String(e) } })
'go'`)
let state = 'pending'
for (let attempt = 0; attempt < 120 && state === 'pending'; attempt++) {
  await sleep(250)
  state = await evalJs('typeof window.__m04 === "string" ? window.__m04 : JSON.stringify(window.__m04)')
}
await sleep(800)
const receipt = typeof state === 'string' ? JSON.parse(state) : state
evidence.receipt = receipt
evidence.botCobbleAfter = await cobblestoneCount()
evidence.itemsAfter = await itemsNear(258, 201, -32, 5)
evidence.botBlockAfter = await blockAt(BOT_BLOCK.x, BOT_BLOCK.y, BOT_BLOCK.z)
console.log('receipt:', JSON.stringify({ status: receipt.status, endReason: receipt.endReason, broken: receipt.broken, brokenCount: receipt.brokenCount }).slice(0, 700))
console.log('bot cobble after:', evidence.botCobbleAfter, 'items left:', JSON.stringify(evidence.itemsAfter))
writeFileSync(new URL('./m04a.json', import.meta.url), JSON.stringify(evidence, null, 2))
ws.close()
await game.close()
await server.close()
