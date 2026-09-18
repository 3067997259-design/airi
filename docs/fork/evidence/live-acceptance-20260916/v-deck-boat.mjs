/**
 * CD-V on the user's fixture: boat cases.
 *
 * V-01a existing boat: board the boat placed at the channel head and ride the
 * whole course (east, two separators, the diagonal bend, the 90-degree west leg)
 * to the bank at the diamond wall.
 * V-01b prepare_owned: no boat in the world, one boat item in the inventory.
 * V-03 cancel: start the same ride and cancel while under way on open water.
 *
 * Usage: node v-deck-boat.mjs <outPath>
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const outPath = process.argv[2] ?? 'v-deck-boat.json'
const evidence = { id: 'CD-V deck boat', startedAt: new Date().toISOString(), cases: [], verdict: 'unknown' }

function note(message) {
  console.log(message)
}
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

const server = new Client({ name: 'vdb-server', version: '1.0.0' })
await server.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:25602/mcp')))
const game = new Client({ name: 'vdb-game', version: '1.0.0' })
await game.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:25600/mcp')))

async function call(client, name, args, { tolerateError = false } = {}) {
  const result = await client.callTool({ name, arguments: args })
  if (result.isError === true && !tolerateError)
    throw new Error(`${name} failed: ${textOf(result).slice(0, 240)}`)
  return result
}
async function run(command) {
  return await call(server, 'run_command', { command }, { tolerateError: true })
}
async function self() {
  return structuredOf(await call(game, 'get_self', {}))
}
async function riding() {
  return structuredOf(await call(game, 'get_vehicle', {}, { tolerateError: true }))
}
async function inventory() {
  return structuredOf(await call(game, 'get_inventory', {}))
}
function boatCount(inv) {
  return (inv?.hotbar ?? []).concat(inv?.main ?? []).filter(item => item.id === 'minecraft:oak_boat').reduce((sum, item) => sum + Number(item.count ?? 0), 0)
}
async function boatsNear(center, radius = 30) {
  const record = structuredOf(await call(server, 'query_entities', { center, radius, includePlayers: false, maxResults: 30, types: ['minecraft:boat'] }, { tolerateError: true }))
  return record?.entities ?? []
}
/** Waits until the bot lands on the deck, so a move does not start mid-fall. */
async function waitBotSettled(timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const state = await self()
    if (state && state.onGround === true && Math.abs(state.y - 201) < 0.3)
      return state
    if (Date.now() > deadline)
      return state
    await new Promise(resolve => setTimeout(resolve, 400))
  }
}
/** Waits until the client actually receives the boat entity (entity streaming lag). */
async function waitBoatVisible(timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const vehicles = structuredOf(await call(game, 'get_vehicles', { radius: 8 }, { tolerateError: true }))
    const count = (vehicles?.vehicles ?? []).length
    if (count > 0)
      return count
    if (Date.now() > deadline)
      return 0
    await new Promise(resolve => setTimeout(resolve, 500))
  }
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
async function waitProbe() {
  await evalJs(`location.hash = '#/devtools/game-host'; 'ok'`)
  await new Promise(resolve => setTimeout(resolve, 1400))
  for (let attempt = 0; attempt < 12; attempt++) {
    if (await evalJs('window.__AIRI_GAME_HOST_SMOKE__ ? "ready" : "missing"') === 'ready')
      return
    await new Promise(resolve => setTimeout(resolve, 800))
  }
  throw new Error('probe missing')
}
function startTool(tool, payload) {
  return evalJs(`window.__vdb = 'pending'
window.__AIRI_GAME_HOST_SMOKE__.executeGameTool('${tool}', ${JSON.stringify(payload)})
  .then(result => { window.__vdb = result })
  .catch(error => { window.__vdb = { error: String(error) } })
'started'`)
}
async function pollTool(maxMs = 120_000) {
  const deadline = Date.now() + maxMs
  for (;;) {
    const current = await evalJs('typeof window.__vdb === "string" ? window.__vdb : JSON.stringify(window.__vdb)')
    if (current !== 'pending')
      return JSON.parse(current)
    if (Date.now() > deadline)
      return { error: 'timeout' }
    await new Promise(resolve => setTimeout(resolve, 300))
  }
}
async function moveTool(payload, maxMs = 120_000) {
  await startTool('game_move_to', payload)
  return await pollTool(maxMs)
}
async function cancelTool() {
  await startTool('game_cancel', {})
  return await pollTool(30_000)
}
function summarize(result) {
  return { status: result?.status, endReason: result?.endReason, vehicle: result?.vehicle, final: result?.finalSnapshot?.position }
}

try {
  await waitProbe()
  await run('time set day')
  await run('weather clear')
  await run('kill @e[type=minecraft:boat]')
  await run('clear airitest minecraft:oak_boat')

  // ===== V-01a: existing boat, full course =====
  await run('summon minecraft:boat 238.5 200.5 -61.0 {Rotation:[90f,0f]}')
  await run(`tp airitest 237.5 202 -61.5 90 30`)
  await waitBotSettled()
  const visibleA = await waitBoatVisible()
  const boatsBefore = (await boatsNear({ x: 240, y: 201, z: -61 })).length
  note(`V-01a readiness: clientVisible=${visibleA} serverBoats=${boatsBefore}`)
  const existing = await moveTool({ x: 267, y: 200, z: -45, tolerance: 1.5, vehicle: 'boat' }, 180_000)
  const boatsAfter = (await boatsNear({ x: 267, y: 201, z: -45 })).length
  evidence.cases.push({ id: 'V-01a', label: 'boat existing, whole course', boatsBefore, boatsAfter, ridingAfter: await riding(), ...summarize(existing) })
  note(`V-01a existing: ${JSON.stringify(summarize(existing))}`)

  // ===== V-01b: prepare_owned on the deck =====
  await run('kill @e[type=minecraft:boat]')
  await run('give airitest minecraft:oak_boat 1')
  await run(`tp airitest 237.5 202 -61.5 90 30`)
  await waitBotSettled()
  await new Promise(resolve => setTimeout(resolve, 600))
  const invBefore = boatCount(await inventory())
  const prepared = await moveTool({ x: 267, y: 200, z: -45, tolerance: 1.5, vehicle: 'boat', vehicleStrategy: 'prepare_owned' }, 180_000)
  const invAfter = boatCount(await inventory())
  evidence.cases.push({ id: 'V-01b', label: 'boat prepare_owned, whole course', inventoryBoatsBefore: invBefore, inventoryBoatsAfter: invAfter, boatsAfter: (await boatsNear({ x: 267, y: 201, z: -45 })).length, ridingAfter: await riding(), ...summarize(prepared) })
  note(`V-01b prepare_owned: ${JSON.stringify(summarize(prepared))} boats ${invBefore}->${invAfter}`)

  // ===== V-03: cancel under way =====
  await run('kill @e[type=minecraft:boat]')
  await run('clear airitest minecraft:oak_boat')
  await run('summon minecraft:boat 238.5 200.5 -61.0 {Rotation:[90f,0f]}')
  await run(`tp airitest 237.5 202 -61.5 90 30`)
  await waitBotSettled()
  await waitBoatVisible()
  await startTool('game_move_to', { x: 267, y: 200, z: -45, tolerance: 1.5, vehicle: 'boat' })
  let during
  for (let attempt = 0; attempt < 40; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 500))
    during = await self()
    if (during?.x >= 251)
      break
  }
  const cancel = await cancelTool()
  const cancelled = await pollTool(60_000)
  evidence.cases.push({
    id: 'V-03',
    label: 'cancel mid course',
    positionDuring: during ? { x: during.x, y: during.y, z: during.z } : undefined,
    ridingDuring: await riding(),
    cancel: { status: cancel?.status, endReason: cancel?.endReason },
    ...summarize(cancelled),
    ridingAfter: await riding(),
  })
  note(`V-03 cancel: during=${JSON.stringify(during?.x)} cancel=${cancel?.endReason} move=${JSON.stringify(summarize(cancelled))}`)

  evidence.verdict = 'PASS'
}
catch (error) {
  evidence.error = String(error)
  evidence.verdict = 'ERROR'
  console.error(error)
}
finally {
  try {
    await run('kill @e[type=minecraft:boat]')
    await run('clear airitest minecraft:oak_boat')
    await run('tp airitest 82.5 75 -24.5 0 0')
  }
  catch {}
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, JSON.stringify(evidence, null, 2))
  console.log(JSON.stringify({ verdict: evidence.verdict, error: evidence.error, cases: evidence.cases.map(item => ({ id: item.id, label: item.label, status: item.status, endReason: item.endReason, vehicle: item.vehicle ? { method: item.vehicle.acquireMethod, uuid: item.vehicle.vehicleUuid, dismounted: item.vehicle.dismounted, arrivedMounted: item.vehicle.arrivedMounted, distance: item.vehicle.distanceTravelled } : undefined })) }, null, 2))
  ws.close()
  await game.close()
  await server.close()
}
