/**
 * M-04a(retry) + M-04b + M-05 in one orchestrated run.
 *
 * 1. The user mined (258,201,-31) and left the drop; the bot breaks the adjacent
 *    (257,201,-31) with a required product so its own drop lands within reach.
 * 2. The user stands on (257,201,-33); the bot breaks it from the north, so the
 *    user's automatic pickup takes the product and the ledger stays fuzzy.
 * 3. The user throws cobblestone onto (257,201,-32); the bot breaks it and the
 *    pickups may include the foreign items, but the ledger must cap at one.
 */
import { writeFileSync } from 'node:fs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

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
const server = new Client({ name: 'm405-server', version: '1.0.0' })
await server.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:25602/mcp')))
const game = new Client({ name: 'm405-game', version: '1.0.0' })
await game.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:25600/mcp')))
async function run(command) {
  return structuredOf(await server.callTool({ name: 'run_command', arguments: { command } }))
}
async function blockAt(x, y, z) {
  const record = structuredOf(await server.callTool({ name: 'get_block', arguments: { x, y, z } }))
  return record?.id ?? record?.block
}
async function itemsNear(x, y, z, radius) {
  const record = structuredOf(await server.callTool({ name: 'query_entities', arguments: { center: { x, y, z }, radius, includePlayers: false, maxResults: 40, types: ['minecraft:item'] } }))
  return (record?.entities ?? []).map(item => `${item.name}@${Number(item.x).toFixed(2)},${Number(item.y).toFixed(2)},${Number(item.z).toFixed(2)}`)
}
async function playerNear(x, y, z, radius) {
  const record = structuredOf(await server.callTool({ name: 'query_entities', arguments: { center: { x, y, z }, radius, includePlayers: true, maxResults: 20, types: ['minecraft:player'] } }))
  return (record?.entities ?? []).filter(entity => entity.name === 'AfterRain').map(entity => ({ x: Number(entity.x), y: Number(entity.y), z: Number(entity.z) }))
}
async function cobble() {
  const inventory = structuredOf(await game.callTool({ name: 'get_inventory', arguments: {} }))
  const slots = [...(inventory?.hotbar ?? []), ...(inventory?.main ?? [])].filter(Boolean)
  return slots.filter(slot => slot.id === 'minecraft:cobblestone').reduce((sum, slot) => sum + Number(slot.count ?? 0), 0)
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

async function breakBlock(x, y, z, label) {
  const before = await cobble()
  const itemsBefore = await itemsNear(x + 0.5, y, z + 0.5, 4)
  await evalJs(`window.__m = 'pending'
window.__AIRI_GAME_HOST_SMOKE__.executeGameTool('game_break', { x: ${x}, y: ${y}, z: ${z}, itemId: 'minecraft:cobblestone' }).then(r => { window.__m = r }).catch(e => { window.__m = { error: String(e) } })
'go'`)
  let state = 'pending'
  for (let attempt = 0; attempt < 120 && state === 'pending'; attempt++) {
    await sleep(250)
    state = await evalJs('typeof window.__m === "string" ? window.__m : JSON.stringify(window.__m)')
  }
  const receipt = typeof state === 'string' ? JSON.parse(state) : state
  await sleep(600)
  const after = await cobble()
  const record = {
    label,
    block: `${x},${y},${z}`,
    cobbleBefore: before,
    cobbleAfter: after,
    itemsBefore,
    itemsAfter: await itemsNear(x + 0.5, y, z + 0.5, 4),
    status: receipt?.status,
    endReason: receipt?.endReason,
    product: receipt?.broken?.product,
    tool: receipt?.broken?.tool,
    rejection: receipt?.broken?.rejection,
  }
  console.log(`${label}:`, JSON.stringify(record).slice(0, 600))
  return record
}

async function waitFor(check, label, attempts = 240) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (await check())
      return true
    await sleep(750)
  }
  console.log(`wait time out for ${label}`)
  return false
}

const evidence = { id: 'M-04/M-05 shared patch with the user', startedAt: new Date().toISOString(), steps: [] }

// Step 1: wait for the user's break of (258,-31), then the bot breaks (257,-31).
await waitFor(async () => (await blockAt(258, 201, -31)) !== 'minecraft:stone', 'user mines (258,-31)')
await sleep(600)
evidence.userDropForStep1 = await itemsNear(258.5, 201, -31.5, 4)
await run('tp airitest 257.5 201 -29.5 0 0')
await sleep(700)
evidence.steps.push(await breakBlock(257, 201, -31, 'M-04a bot breaks (257,-31) beside the user drop'))

// Step 2: wait for the user to stand on (257,-33), then break it under them.
await waitFor(async () => (await playerNear(257.5, 201, -32.5, 2.2)).length > 0, 'user stands on (257,-33)')
await run('tp airitest 257.5 201 -34.5 0 0')
await sleep(700)
evidence.steps.push(await breakBlock(257, 201, -33, 'M-04b bot breaks the block the user stands on'))

// Step 3: wait for the thrown pile near (257,-32), then break it with product.
await waitFor(async () => (await itemsNear(257.5, 201, -32.5, 3)).length >= 3, 'user throws cobblestone onto (257,-32)')
await run('tp airitest 256.5 201 -31.5 0 0')
await sleep(700)
evidence.steps.push(await breakBlock(257, 201, -32, 'M-05 bot breaks (257,-32) beside the thrown pile'))

evidence.finishedAt = new Date().toISOString()
writeFileSync(new URL('./m405.json', import.meta.url), JSON.stringify(evidence, null, 2))
ws.close()
await game.close()
await server.close()
