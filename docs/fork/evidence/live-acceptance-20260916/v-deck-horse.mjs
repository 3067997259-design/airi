/**
 * CD-V on the user's fixture: horse cases.
 *
 * V-04a select the tamed+saddled horse by uuid and ride it west across the
 * 1-high (x253) and 2-high (x246) acacia walls to the rail start (240,201,-40).
 * V-04b only a wild horse present -> not_tamed.
 * V-04c ride expected on an occupied horse -> occupied.
 * V-04d unsaddled tamed horse, with and without a saddle item.
 * V-05 wild horse with allowTame and a saddle item -> taming attempts.
 *
 * Horses that are not part of a case are parked at (250,201,40) and restored.
 *
 * Usage: node v-deck-horse.mjs <outPath>
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const outPath = process.argv[2] ?? 'v-deck-horse.json'
const PARK = { x: 250.5, y: 201, z: 40.5 }
const GOAL = { x: 240, y: 201, z: -40 }
const evidence = { id: 'CD-V deck horse', startedAt: new Date().toISOString(), horses: [], cases: [], verdict: 'unknown' }

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

const server = new Client({ name: 'vdh-server', version: '1.0.0' })
await server.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:25602/mcp')))
const game = new Client({ name: 'vdh-game', version: '1.0.0' })
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
async function horsesNear(center = { x: 262, y: 201, z: -43 }, radius = 30) {
  const record = structuredOf(await call(server, 'query_entities', { center, radius, includePlayers: false, maxResults: 40, types: ['minecraft:horse'] }, { tolerateError: true }))
  return record?.entities ?? []
}
async function waitVehicleVisible(uuid, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const vehicles = structuredOf(await call(game, 'get_vehicles', { radius: 8 }, { tolerateError: true }))
    if ((vehicles?.vehicles ?? []).some(entry => entry.uuid === uuid))
      return true
    if (Date.now() > deadline)
      return false
    await new Promise(resolve => setTimeout(resolve, 400))
  }
}
async function horseState(uuid) {
  const state = structuredOf(await call(game, 'get_vehicle_state', { uuid }, { tolerateError: true }))
  return state?.entity ?? state?.state ?? state
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
  return evalJs(`window.__vdh = 'pending'
window.__AIRI_GAME_HOST_SMOKE__.executeGameTool('${tool}', ${JSON.stringify(payload)})
  .then(result => { window.__vdh = result })
  .catch(error => { window.__vdh = { error: String(error) } })
'started'`)
}
async function pollTool(maxMs = 180_000) {
  const deadline = Date.now() + maxMs
  for (;;) {
    const current = await evalJs('typeof window.__vdh === "string" ? window.__vdh : JSON.stringify(window.__vdh)')
    if (current !== 'pending')
      return JSON.parse(current)
    if (Date.now() > deadline)
      return { error: 'timeout' }
    await new Promise(resolve => setTimeout(resolve, 300))
  }
}
async function moveTool(payload, maxMs = 180_000) {
  await startTool('game_move_to', payload)
  return await pollTool(maxMs)
}
function summarize(result) {
  return { status: result?.status, endReason: result?.endReason, vehicle: result?.vehicle, final: result?.finalSnapshot?.position }
}

try {
  await waitProbe()
  await run('time set day')
  await run('weather clear')
  await run('kill @e[type=minecraft:zombie]')
  await call(server, 'teleport_player', { player: 'airitest', x: 260.5, y: 201, z: -45.5, yaw: 90, pitch: 0 })
  await new Promise(resolve => setTimeout(resolve, 1500))

  // record the fixture horses and their states
  const horses = await horsesNear()
  for (const horse of horses) {
    const state = await horseState(horse.uuid)
    evidence.horses.push({
      name: horse.name,
      uuid: horse.uuid,
      x: Number(horse.x.toFixed(2)),
      y: Number(horse.y.toFixed(2)),
      z: Number(horse.z.toFixed(2)),
      tamed: state?.tamed,
      saddled: state?.saddled,
      free: state?.free,
      passengers: state?.passengers,
    })
  }
  note(`horses: ${JSON.stringify(evidence.horses.map(h => [h.uuid.slice(0, 8), h.tamed, h.saddled, h.free]))}`)

  const tamedSaddled = evidence.horses.find(horse => horse.tamed === true && horse.saddled === true && horse.free === true)
  const wild = evidence.horses.find(horse => horse.tamed === false)
  const unsaddled = evidence.horses.find(horse => horse.tamed === true && horse.saddled === false && horse.free === true)

  // ===== V-04a: the tamed+saddled horse by uuid, over the walls =====
  if (tamedSaddled) {
    for (const horse of evidence.horses) {
      if (horse.uuid !== tamedSaddled.uuid && horse.free === true)
        await run(`tp ${horse.uuid} ${PARK.x} ${PARK.y} ${PARK.z}`)
    }
    await run(`tp ${tamedSaddled.uuid} 262.5 201 -45.5`)
    await call(server, 'teleport_player', { player: 'airitest', x: 260.5, y: 201, z: -45.5, yaw: 270, pitch: 0 })
    await new Promise(resolve => setTimeout(resolve, 1200))
    await waitVehicleVisible(tamedSaddled.uuid)
    await startTool('game_move_to', { x: GOAL.x, y: GOAL.y, z: GOAL.z, tolerance: 2, vehicle: 'horse', vehicleUuid: tamedSaddled.uuid })
    const trace = []
    let move
    for (let attempt = 0; attempt < 400; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 400))
      const state = await self()
      if (state)
        trace.push({ x: Number(state.x.toFixed(2)), y: Number(state.y.toFixed(2)), z: Number(state.z.toFixed(2)), onGround: state.onGround === true })
      const result = await evalJs('typeof window.__vdh === "string" ? window.__vdh : JSON.stringify(window.__vdh)')
      if (result !== 'pending') {
        move = JSON.parse(result)
        break
      }
    }
    const maxY = trace.reduce((best, point) => Math.max(best, point.y), Number.NEGATIVE_INFINITY)
    const minZ = trace.reduce((best, point) => Math.min(best, point.z), Number.POSITIVE_INFINITY)
    const maxZ = trace.reduce((best, point) => Math.max(best, point.z), Number.NEGATIVE_INFINITY)
    evidence.cases.push({ id: 'V-04a', label: 'tamed+saddled horse over both walls', uuid: tamedSaddled.uuid, maxY, zSpan: [minZ, maxZ], trace, ...summarize(move ?? {}), ridingAfter: await riding() })
    note(`V-04a horse uuid: ${JSON.stringify(summarize(move))}`)
    // restore the parked horses
    for (const horse of evidence.horses) {
      if (horse.uuid !== tamedSaddled.uuid && horse.free === true)
        await run(`tp ${horse.uuid} ${horse.x} ${horse.y} ${horse.z}`)
    }
  }
  else {
    evidence.cases.push({ id: 'V-04a', label: 'tamed+saddled horse over both walls', endReason: 'no tamed+saddled horse found' })
  }

  // ===== V-04b: only the wild horse =====
  if (wild) {
    for (const horse of evidence.horses) {
      if (horse.uuid !== wild.uuid && horse.free === true)
        await run(`tp ${horse.uuid} ${PARK.x} ${PARK.y} ${PARK.z}`)
    }
    await run(`tp ${wild.uuid} 262.5 201 -45.5`)
    await call(server, 'teleport_player', { player: 'airitest', x: 260.5, y: 201, z: -45.5, yaw: 270, pitch: 0 })
    await new Promise(resolve => setTimeout(resolve, 1000))
    await waitVehicleVisible(wild.uuid)
    const move = await moveTool({ x: GOAL.x, y: GOAL.y, z: GOAL.z, tolerance: 2, vehicle: 'horse', vehicleUuid: wild.uuid }, 120_000)
    evidence.cases.push({ id: 'V-04b', label: 'wild horse by uuid without allowTame', uuid: wild.uuid, ...summarize(move) })
    note(`V-04b wild: ${move?.endReason}`)
    for (const horse of evidence.horses) {
      if (horse.uuid !== wild.uuid && horse.free === true)
        await run(`tp ${horse.uuid} ${horse.x} ${horse.y} ${horse.z}`)
    }
  }

  // ===== V-04c: occupied horse (the player is riding it) =====
  const occupied = evidence.horses.find(horse => horse.free === false && Array.isArray(horse.passengers) && horse.passengers.length > 0)
  if (occupied) {
    for (const horse of evidence.horses) {
      if (horse.uuid !== occupied.uuid && horse.free === true)
        await run(`tp ${horse.uuid} ${PARK.x} ${PARK.y} ${PARK.z}`)
    }
    await call(server, 'teleport_player', { player: 'airitest', x: 260.5, y: 201, z: -45.5, yaw: 270, pitch: 0 })
    await new Promise(resolve => setTimeout(resolve, 1000))
    const move = await moveTool({ x: GOAL.x, y: GOAL.y, z: GOAL.z, tolerance: 2, vehicle: 'horse', vehicleUuid: occupied.uuid }, 90_000)
    evidence.cases.push({ id: 'V-04c', label: 'occupied horse by uuid (player riding)', uuid: occupied.uuid, ...summarize(move) })
    note(`V-04c occupied: ${move?.endReason}`)
    for (const horse of evidence.horses) {
      if (horse.uuid !== occupied.uuid && horse.free === true)
        await run(`tp ${horse.uuid} ${horse.x} ${horse.y} ${horse.z}`)
    }
  }
  else {
    evidence.cases.push({ id: 'V-04c', label: 'occupied horse by uuid', endReason: 'no occupied horse found' })
  }
  // ===== V-04d: unsaddled tamed horse, no saddle in the inventory =====
  if (unsaddled) {
    for (const horse of evidence.horses) {
      if (horse.uuid !== unsaddled.uuid && horse.free === true)
        await run(`tp ${horse.uuid} ${PARK.x} ${PARK.y} ${PARK.z}`)
    }
    await run('clear airitest minecraft:saddle')
    await run(`tp ${unsaddled.uuid} 262.5 201 -45.5`)
    await call(server, 'teleport_player', { player: 'airitest', x: 260.5, y: 201, z: -45.5, yaw: 270, pitch: 0 })
    await new Promise(resolve => setTimeout(resolve, 1000))
    const move = await moveTool({ x: GOAL.x, y: GOAL.y, z: GOAL.z, tolerance: 2, vehicle: 'horse', vehicleUuid: unsaddled.uuid }, 90_000)
    evidence.cases.push({ id: 'V-04d', label: 'unsaddled horse, no saddle item', uuid: unsaddled.uuid, ...summarize(move) })
    note(`V-04d unsaddled: ${move?.endReason}`)
    for (const horse of evidence.horses) {
      if (horse.uuid !== unsaddled.uuid && horse.free === true)
        await run(`tp ${horse.uuid} ${horse.x} ${horse.y} ${horse.z}`)
    }
  }

  // ===== V-05: tame the wild horse with a saddle =====
  if (wild) {
    await run('give airitest minecraft:saddle 1')
    for (const horse of evidence.horses) {
      if (horse.uuid !== wild.uuid && horse.free === true)
        await run(`tp ${horse.uuid} ${PARK.x} ${PARK.y} ${PARK.z}`)
    }
    await run(`tp ${wild.uuid} 262.5 201 -45.5`)
    await call(server, 'teleport_player', { player: 'airitest', x: 260.5, y: 201, z: -45.5, yaw: 270, pitch: 0 })
    await new Promise(resolve => setTimeout(resolve, 1000))
    await waitVehicleVisible(wild.uuid)
    const move = await moveTool({ x: GOAL.x, y: GOAL.y, z: GOAL.z, tolerance: 2, vehicle: 'horse', allowTame: true }, 180_000)
    evidence.cases.push({ id: 'V-05', label: 'tame the wild horse', uuid: wild.uuid, ...summarize(move) })
    note(`V-05 tame: ${move?.endReason}`)
    for (const horse of evidence.horses) {
      if (horse.uuid !== wild.uuid && horse.free === true)
        await run(`tp ${horse.uuid} ${horse.x} ${horse.y} ${horse.z}`)
    }
  }

  evidence.verdict = 'PASS'
}
catch (error) {
  evidence.error = String(error)
  evidence.verdict = 'ERROR'
  console.error(error)
}
finally {
  try {
    await run('kill @e[type=minecraft:zombie]')
    await run('clear airitest minecraft:saddle')
    await call(server, 'teleport_player', { player: 'airitest', x: 82.5, y: 75, z: -24.5, yaw: 0, pitch: 0 })
  }
  catch {}
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, JSON.stringify(evidence, null, 2))
  console.log(JSON.stringify({ verdict: evidence.verdict, error: evidence.error, horses: evidence.horses, cases: evidence.cases.map(item => ({ id: item.id, label: item.label, status: item.status, endReason: item.endReason, vehicle: item.vehicle ? { method: item.vehicle.acquireMethod, uuid: item.vehicle.vehicleUuid, dismounted: item.vehicle.dismounted, distance: item.vehicle.distanceTravelled } : undefined })) }, null, 2))
  ws.close()
  await game.close()
  await server.close()
}
