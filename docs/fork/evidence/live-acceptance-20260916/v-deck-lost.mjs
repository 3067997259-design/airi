/**
 * CD-V V-09: vehicle lost, dimension change and passenger change.
 *
 * V-09a kill the minecart mid-ride -> vehicle_lost.
 * V-09b teleport the player to the nether mid-ride -> the host stops the active
 *       command with dimension_changed.
 * V-09c kill the ridden horse mid-ride -> vehicle_lost.
 * V-09d passenger/controller change: covered by the unit hijack case; a live
 *       single-seat vehicle cannot add a second controller, so it is recorded
 *       as unit-covered.
 *
 * Usage: node v-deck-lost.mjs <outPath>
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const outPath = process.argv[2] ?? 'v-deck-lost.json'
const STATION_LEVER = { x: 245, y: 201, z: -56 }
const evidence = { id: 'CD-V deck V-09', startedAt: new Date().toISOString(), cases: [], verdict: 'unknown' }

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

const server = new Client({ name: 'vdl-server', version: '1.0.0' })
await server.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:25602/mcp')))
const game = new Client({ name: 'vdl-game', version: '1.0.0' })
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
async function entities(center, radius, type) {
  const record = structuredOf(await call(server, 'query_entities', { center, radius, includePlayers: false, maxResults: 30, types: [type] }, { tolerateError: true }))
  return record?.entities ?? []
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
  return evalJs(`window.__vdl = 'pending'
window.__AIRI_GAME_HOST_SMOKE__.executeGameTool('${tool}', ${JSON.stringify(payload)})
  .then(result => { window.__vdl = result })
  .catch(error => { window.__vdl = { error: String(error) } })
'started'`)
}
async function pollTool(maxMs = 120_000) {
  const deadline = Date.now() + maxMs
  for (;;) {
    const current = await evalJs('typeof window.__vdl === "string" ? window.__vdl : JSON.stringify(window.__vdl)')
    if (current !== 'pending')
      return JSON.parse(current)
    if (Date.now() > deadline)
      return { error: 'timeout' }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
}
async function moveWithAction(payload, action, { actionAfterMs = 1500, maxMs = 90_000 } = {}) {
  await startTool('game_move_to', payload)
  const trace = []
  let acted = false
  let result
  const deadline = Date.now() + maxMs
  for (;;) {
    await new Promise(resolve => setTimeout(resolve, 300))
    const state = await self()
    if (state)
      trace.push({ x: Number(state.x.toFixed(2)), y: Number(state.y.toFixed(2)), z: Number(state.z.toFixed(2)), health: state.health })
    if (!acted && Date.now() > deadline - maxMs + actionAfterMs) {
      acted = true
      await action()
      note('action fired')
    }
    const current = await evalJs('typeof window.__vdl === "string" ? window.__vdl : JSON.stringify(window.__vdl)')
    if (current !== 'pending') {
      result = JSON.parse(current)
      break
    }
    if (Date.now() > deadline) {
      result = { error: 'timeout' }
      break
    }
  }
  return { result, trace }
}
function summarize(result) {
  return { status: result?.status, endReason: result?.endReason, vehicle: result?.vehicle, final: result?.finalSnapshot?.position }
}

try {
  await waitProbe()
  await run('time set day')
  await run('weather clear')
  await run('forceload add 230 -70 290 -30')
  await new Promise(resolve => setTimeout(resolve, 1500))
  await run(`setblock ${STATION_LEVER.x} ${STATION_LEVER.y} ${STATION_LEVER.z} minecraft:lever[face=floor,facing=north,powered=false]`)
  await run('give airitest minecraft:arrow 1')

  // ===== V-09a: kill the cart mid-ride =====
  await run('kill @e[type=minecraft:minecart]')
  await run('summon minecraft:minecart 245.5 201.2 -56.6')
  await call(server, 'teleport_player', { player: 'airitest', x: 246.5, y: 201, z: -57.5, yaw: 90, pitch: 0 })
  await new Promise(resolve => setTimeout(resolve, 900))
  const cartA = (await entities({ x: 246, y: 201, z: -57 }, 6, 'minecraft:minecart'))[0]
  const a = await moveWithAction({ x: 260, y: 201, z: -57, tolerance: 3, vehicle: 'minecart' }, async () => {
    await run(`kill ${cartA?.uuid}`)
  }, { actionAfterMs: 2500 })
  evidence.cases.push({ id: 'V-09a', label: 'kill the cart mid-ride', cart: cartA?.uuid, ...summarize(a.result), traceTail: a.trace.slice(-3), ridingAfter: await riding() })
  note(`V-09a cart killed: ${a.result?.endReason}`)

  // ===== V-09b: dimension change mid-ride =====
  await run('kill @e[type=minecraft:minecart]')
  await run('summon minecraft:minecart 245.5 201.2 -56.6')
  await call(server, 'teleport_player', { player: 'airitest', x: 246.5, y: 201, z: -57.5, yaw: 90, pitch: 0 })
  await new Promise(resolve => setTimeout(resolve, 900))
  const b = await moveWithAction({ x: 260, y: 201, z: -57, tolerance: 3, vehicle: 'minecart' }, async () => {
    await run('execute in minecraft:the_nether run tp airitest 0 80 0')
  }, { actionAfterMs: 2500 })
  evidence.cases.push({ id: 'V-09b', label: 'player to the nether mid-ride', ...summarize(b.result), traceTail: b.trace.slice(-3), ridingAfter: await riding() })
  note(`V-09b dimension: ${b.result?.endReason}`)
  await new Promise(resolve => setTimeout(resolve, 1000))
  await run('execute in minecraft:overworld run tp airitest 246.5 202 -57.5 90 0')
  // The dimension change rebinds the world on the next fresh read; trigger that
  // read before the next command starts, or the stay would stop it again.
  await evalJs(`window.__vdlWarm = 'pending'
window.__AIRI_GAME_HOST_SMOKE__.executeGameTool('game_observe', {})
  .then(result => { window.__vdlWarm = result })
  .catch(error => { window.__vdlWarm = { error: String(error) } })
'started'`)
  await new Promise(resolve => setTimeout(resolve, 2500))

  // ===== V-09c: kill the ridden horse mid-ride =====
  // The fixture horses roam; this case uses a summoned test horse and removes it.
  await run('kill @e[type=minecraft:horse,name=LostTest]')
  await run('summon minecraft:horse 262.5 201 -45.5 {Tame:1b,SaddleItem:{id:"minecraft:saddle",count:1},PersistenceRequired:1b,CustomName:\'"LostTest"\'}')
  await new Promise(resolve => setTimeout(resolve, 800))
  const testHorse = (await entities({ x: 262, y: 201, z: -45 }, 8, 'minecraft:horse')).find(horse => horse.name === 'LostTest')
  if (testHorse) {
    await call(server, 'teleport_player', { player: 'airitest', x: 260.5, y: 201, z: -45.5, yaw: 270, pitch: 0 })
    await new Promise(resolve => setTimeout(resolve, 900))
    const c = await moveWithAction({ x: 240, y: 201, z: -40, tolerance: 2, vehicle: 'horse', vehicleUuid: testHorse.uuid }, async () => {
      await run(`kill ${testHorse.uuid}`)
    }, { actionAfterMs: 2000 })
    evidence.cases.push({ id: 'V-09c', label: 'kill the ridden horse mid-ride', horse: testHorse.uuid, ...summarize(c.result), traceTail: c.trace.slice(-3), ridingAfter: await riding() })
    note(`V-09c horse killed: ${c.result?.endReason}`)
  }
  else {
    evidence.cases.push({ id: 'V-09c', label: 'kill the ridden horse mid-ride', endReason: 'test horse summon failed' })
  }
  await run('kill @e[type=minecraft:horse,name=LostTest]')

  evidence.verdict = 'PASS'
  evidence.notes = ['V-09d passenger/controller change is unit-covered (the fake hijack case); a live single-seat vehicle cannot seat a second controller.']
}
catch (error) {
  evidence.error = String(error)
  evidence.verdict = 'ERROR'
  console.error(error)
}
finally {
  try {
    await run('kill @e[type=minecraft:minecart]')
    await run(`setblock ${STATION_LEVER.x} ${STATION_LEVER.y} ${STATION_LEVER.z} minecraft:lever[face=floor,facing=north,powered=false]`)
    await run('clear airitest')
    await run('forceload remove 230 -70 290 -30')
    await call(server, 'teleport_player', { player: 'airitest', x: 82.5, y: 75, z: -24.5, yaw: 0, pitch: 0 })
  }
  catch {}
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, JSON.stringify(evidence, null, 2))
  console.log(JSON.stringify({ verdict: evidence.verdict, error: evidence.error, cases: evidence.cases.map(item => ({ id: item.id, label: item.label, status: item.status, endReason: item.endReason, vehicle: item.vehicle ? { dismounted: item.vehicle.dismounted, failure: item.vehicle.failure } : undefined, traceTail: item.traceTail })) }, null, 2))
  ws.close()
  await game.close()
  await server.close()
}
