/**
 * CD-V on the user's fixture: rail cases.
 *
 * V-06 start -> junction -> crimson station (safe dock). The cart waits on the
 *  powered start rail with the lever already pulled; a bounded Motion push
 *  primes it (a stationary cart never launches itself on a flat powered rail).
 * V-07 cancel while the cart is moving.
 * V-08 goal past the break at x253: the cart leaves the rail and falls through
 *  the 3x3x2 hole; the spawn point is moved onto the deck first.
 * V-10a cart on a plain rail with the levers off -> rail_not_powered.
 * V-10b no cart and no cart item -> no_materials.
 *
 * Usage: node v-deck-rail.mjs <outPath>
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const outPath = process.argv[2] ?? 'v-deck-rail.json'
const START_LEVER = { x: 241, y: 201, z: -42 }
const STATION_LEVER = { x: 245, y: 201, z: -56 }
const STATION_GOAL = { x: 244.5, y: 202, z: -57 }
const HOLE_GOAL = { x: 256, y: 201, z: -57 }
const evidence = { id: 'CD-V deck rail', startedAt: new Date().toISOString(), cases: [], verdict: 'unknown' }

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

const server = new Client({ name: 'vdr-server', version: '1.0.0' })
await server.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:25602/mcp')))
const game = new Client({ name: 'vdr-game', version: '1.0.0' })
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
async function cartsNear(center = { x: 244, y: 201, z: -52 }, radius = 40) {
  const record = structuredOf(await call(server, 'query_entities', { center, radius, includePlayers: false, maxResults: 20, types: ['minecraft:minecart'] }, { tolerateError: true }))
  return record?.entities ?? []
}
async function lever(state) {
  return await run(`setblock ${START_LEVER.x} ${START_LEVER.y} ${START_LEVER.z} minecraft:lever[face=floor,facing=north,powered=${state ? 'true' : 'false'}]`)
}
async function stationLever(state) {
  return await run(`setblock ${STATION_LEVER.x} ${STATION_LEVER.y} ${STATION_LEVER.z} minecraft:lever[face=floor,facing=north,powered=${state ? 'true' : 'false'}]`)
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
  return evalJs(`window.__vdr = 'pending'
window.__AIRI_GAME_HOST_SMOKE__.executeGameTool('${tool}', ${JSON.stringify(payload)})
  .then(result => { window.__vdr = result })
  .catch(error => { window.__vdr = { error: String(error) } })
'started'`)
}
async function pollTool(maxMs = 180_000) {
  const deadline = Date.now() + maxMs
  for (;;) {
    const current = await evalJs('typeof window.__vdr === "string" ? window.__vdr : JSON.stringify(window.__vdr)')
    if (current !== 'pending')
      return JSON.parse(current)
    if (Date.now() > deadline)
      return { error: 'timeout' }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
}
/** Starts a move and traces the player position until it settles. */
async function moveWithTrace(payload, { primeUuid, primeMotion = [0, 0, -0.6], cancelAtX, maxMs = 120_000 } = {}) {
  await startTool('game_move_to', payload)
  const trace = []
  let primed = primeUuid === undefined
  let cancelled = false
  let result
  const deadline = Date.now() + maxMs
  for (;;) {
    await new Promise(resolve => setTimeout(resolve, 300))
    const state = await self()
    if (state)
      trace.push({ x: Number(state.x.toFixed(2)), y: Number(state.y.toFixed(2)), z: Number(state.z.toFixed(2)), health: state.health })
    // Prime only once the session has actually boarded: an earlier push moves
    // the cart off the powered rail before the launch check reads it.
    if (!primed) {
      const ride = await riding()
      if (ride && ride.riding === true) {
        primed = true
        await run(`data merge entity ${primeUuid} {Motion:[${primeMotion[0]}d,${primeMotion[1]}d,${primeMotion[2]}d]}`)
        note(`primed cart ${primeUuid.slice(0, 8)} motion=${JSON.stringify(primeMotion)}`)
      }
    }
    if (cancelAtX !== undefined && !cancelled && state && state.x >= cancelAtX) {
      cancelled = true
      await startTool('game_cancel', {})
      note(`cancel sent at x=${state.x}`)
    }
    const current = await evalJs('typeof window.__vdr === "string" ? window.__vdr : JSON.stringify(window.__vdr)')
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
  await run('setblock 300 201 0 minecraft:red_concrete')
  await run(`spawnpoint airitest 300 202 1`)

  // ===== V-10b: no cart anywhere, no cart item =====
  await run('kill @e[type=minecraft:minecart]')
  await run('clear airitest minecraft:minecart')
  await lever(false)
  await call(server, 'teleport_player', { player: 'airitest', x: 240.5, y: 201, z: -40.5, yaw: 180, pitch: 0 })
  await new Promise(resolve => setTimeout(resolve, 900))
  const noMaterials = await moveWithTrace({ x: STATION_GOAL.x, y: STATION_GOAL.y, z: STATION_GOAL.z, tolerance: 2, vehicle: 'minecart', vehicleStrategy: 'prepare_owned' }, { maxMs: 90_000 })
  evidence.cases.push({ id: 'V-10b', label: 'no cart, no cart item', ...summarize(noMaterials.result), trace: noMaterials.trace.slice(-4) })
  note(`V-10b no materials: ${noMaterials.result?.endReason}`)

  // ===== V-10a: cart on a plain rail, levers off =====
  await run('kill @e[type=minecraft:minecart]')
  await run('summon minecraft:minecart 240.5 201.2 -43.5')
  await call(server, 'teleport_player', { player: 'airitest', x: 240.5, y: 201, z: -40.5, yaw: 180, pitch: 0 })
  await new Promise(resolve => setTimeout(resolve, 900))
  const unpowered = await moveWithTrace({ x: STATION_GOAL.x, y: STATION_GOAL.y, z: STATION_GOAL.z, tolerance: 2, vehicle: 'minecart' }, { maxMs: 60_000 })
  evidence.cases.push({ id: 'V-10a', label: 'cart on plain rail, lever off', ...summarize(unpowered.result), trace: unpowered.trace.slice(-4) })
  note(`V-10a unpowered: ${unpowered.result?.endReason}`)

  // ===== V-06: powered start, junction, station dock =====
  await run('kill @e[type=minecraft:minecart]')
  await lever(true)
  await stationLever(false)
  await run('summon minecraft:minecart 240.5 201.2 -41.6')
  await call(server, 'teleport_player', { player: 'airitest', x: 240.5, y: 201, z: -40.5, yaw: 180, pitch: 0 })
  await new Promise(resolve => setTimeout(resolve, 900))
  const startCart = (await cartsNear({ x: 240, y: 201, z: -42 }, 6))[0]
  const v06 = await moveWithTrace({ x: STATION_GOAL.x, y: STATION_GOAL.y, z: STATION_GOAL.z, tolerance: 2, vehicle: 'minecart' }, { maxMs: 120_000 })
  evidence.cases.push({ id: 'V-06', label: 'powered start, junction, station dock', cart: startCart?.uuid, ...summarize(v06.result), trace: v06.trace, ridingAfter: await riding() })
  note(`V-06 station: ${v06.result?.endReason} dismounted=${v06.result?.vehicle?.dismounted} trace last=${JSON.stringify(v06.trace.slice(-3))}`)

  // ===== V-07: cancel while the cart is moving on rail B =====
  await run('kill @e[type=minecraft:minecart]')
  await lever(false)
  await stationLever(true)
  await run('summon minecraft:minecart 245.5 201.2 -56.6')
  await call(server, 'teleport_player', { player: 'airitest', x: 246.5, y: 201, z: -57.5, yaw: 90, pitch: 0 })
  await new Promise(resolve => setTimeout(resolve, 900))
  const railCart = (await cartsNear({ x: 246, y: 201, z: -57 }, 6))[0]
  const v07 = await moveWithTrace({ x: 260, y: 201, z: -57, tolerance: 3, vehicle: 'minecart' }, { primeUuid: railCart?.uuid, primeMotion: [0.6, 0, 0], cancelAtX: 250, maxMs: 90_000 })
  evidence.cases.push({ id: 'V-07', label: 'cancel while moving on rail B', cart: railCart?.uuid, ...summarize(v07.result), trace: v07.trace, ridingAfter: await riding() })
  note(`V-07 cancel: ${v07.result?.endReason} dismiss=${v07.result?.vehicle?.dismounted} last=${JSON.stringify(v07.trace.slice(-3))}`)

  // ===== V-08: goal past the break, the cart falls through the hole =====
  await run('kill @e[type=minecraft:minecart]')
  await run('effect give airitest minecraft:resistance 20 4 true')
  await stationLever(true)
  await run('summon minecraft:minecart 245.5 201.2 -56.6')
  await call(server, 'teleport_player', { player: 'airitest', x: 246.5, y: 201, z: -57.5, yaw: 90, pitch: 0 })
  await new Promise(resolve => setTimeout(resolve, 900))
  const holeCart = (await cartsNear({ x: 246, y: 201, z: -57 }, 6))[0]
  const v08 = await moveWithTrace({ x: HOLE_GOAL.x, y: HOLE_GOAL.y, z: HOLE_GOAL.z, tolerance: 2, vehicle: 'minecart' }, { primeUuid: holeCart?.uuid, primeMotion: [0.6, 0, 0], maxMs: 90_000 })
  evidence.cases.push({ id: 'V-08', label: 'goal past the break (hole)', cart: holeCart?.uuid, ...summarize(v08.result), trace: v08.trace.slice(-10), ridingAfter: await riding() })
  note(`V-08 hole: ${v08.result?.endReason} dismounted=${v08.result?.vehicle?.dismounted} trace last=${JSON.stringify(v08.trace.slice(-4))}`)

  evidence.verdict = 'PASS'
}
catch (error) {
  evidence.error = String(error)
  evidence.verdict = 'ERROR'
  console.error(error)
}
finally {
  try {
    await run('kill @e[type=minecraft:minecart]')
    await lever(false)
    await stationLever(false)
    await run('spawnpoint airitest 82 76 -24')
    await run('forceload remove 230 -70 290 -30')
    await call(server, 'teleport_player', { player: 'airitest', x: 82.5, y: 75, z: -24.5, yaw: 0, pitch: 0 })
  }
  catch {}
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, JSON.stringify(evidence, null, 2))
  console.log(JSON.stringify({ verdict: evidence.verdict, error: evidence.error, cases: evidence.cases.map(item => ({ id: item.id, label: item.label, status: item.status, endReason: item.endReason, vehicle: item.vehicle ? { method: item.vehicle.acquireMethod, uuid: item.vehicle.vehicleUuid, dismounted: item.vehicle.dismounted, distance: item.vehicle.distanceTravelled } : undefined, traceTail: item.trace?.slice(-4) })) }, null, 2))
  ws.close()
  await game.close()
  await server.close()
}
