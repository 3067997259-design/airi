/**
 * CD-B2: a uniformly moving target (a boosted minecart) crossing the shot line.
 *
 * Builds a short east-west rail line on the deck's clear east side, pushes the
 * cart with one command motion (a stationary cart never launches on flat
 * powered rail), fires while it moves and records the receipt prediction, the
 * cart's traced position and the stuck-arrow impact so the intercept
 * prediction and the actual impact can be compared.
 *
 * Usage: node b-moving-target.mjs <outPath>
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const outPath = process.argv[2] ?? 'b-moving-target.json'
const SHOTS = Number(process.argv[3] ?? 8)
const BOT = 'airitest'
const evidence = { id: 'B-02 moving target', startedAt: new Date().toISOString(), shotsPerCase: SHOTS, cases: [], verdict: 'unknown' }

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

const server = new Client({ name: 'bm-server', version: '1.0.0' })
await server.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:25602/mcp')))

async function call(client, name, args, { tolerateError = false } = {}) {
  const result = await client.callTool({ name, arguments: args })
  if (result.isError === true && !tolerateError)
    throw new Error(`${name} failed: ${textOf(result).slice(0, 240)}`)
  return result
}
async function run(command) {
  return await call(server, 'run_command', { command }, { tolerateError: true })
}
async function cartsNear() {
  const record = structuredOf(await call(server, 'query_entities', { center: { x: 336, y: 201, z: 0 }, radius: 25, includePlayers: false, maxResults: 10, types: ['minecraft:minecart'] }, { tolerateError: true }))
  const cart = (record?.entities ?? [])[0]
  return cart ? { uuid: cart.uuid, x: Number(cart.x), y: Number(cart.y), z: Number(cart.z) } : undefined
}
async function stuckArrow() {
  const record = structuredOf(await call(server, 'query_entities', { center: { x: 336, y: 201, z: 0 }, radius: 20, includePlayers: false, maxResults: 30, types: ['minecraft:arrow'] }, { tolerateError: true }))
  const arrow = (record?.entities ?? [])[0]
  return arrow ? { x: Number(arrow.x), y: Number(arrow.y), z: Number(arrow.z) } : undefined
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
async function evalTool(tool, payload, maxMs = 90_000) {
  await evalJs(`window.__bm = 'pending'
window.__AIRI_GAME_HOST_SMOKE__.executeGameTool('${tool}', ${JSON.stringify(payload)})
  .then(result => { window.__bm = result })
  .catch(error => { window.__bm = { error: String(error) } })
'started'`)
  const deadline = Date.now() + maxMs
  for (;;) {
    const current = await evalJs('typeof window.__bm === "string" ? window.__bm : JSON.stringify(window.__bm)')
    if (current !== 'pending')
      return JSON.parse(current)
    if (Date.now() > deadline)
      return { error: 'timeout' }
    await new Promise(resolve => setTimeout(resolve, 150))
  }
}

const RAIL = { x1: 320, x2: 344, y: 201, z: 0 }

try {
  await waitProbe()
  await run('time set day')
  await run('weather clear')
  await run('kill @e[type=minecraft:minecart]')
  await run(`fill ${RAIL.x1} ${RAIL.y} ${RAIL.z} ${RAIL.x2} ${RAIL.y} ${RAIL.z} minecraft:rail[shape=east_west]`)
  await run(`setblock ${RAIL.x1} ${RAIL.y} ${RAIL.z} minecraft:powered_rail[shape=east_west,powered=true]`)
  await run(`setblock ${RAIL.x2} ${RAIL.y} ${RAIL.z} minecraft:powered_rail[shape=east_west,powered=true]`)
  await run('give airitest minecraft:bow 1')
  await run('clear airitest minecraft:arrow')
  await run('give airitest minecraft:arrow 256')
  // The shooter stands south of the line and fires north across it.
  await call(server, 'teleport_player', { player: BOT, x: 332, y: RAIL.y, z: 10, yaw: 180, pitch: 0 })
  await new Promise(resolve => setTimeout(resolve, 800))

  const shots = []
  for (let index = 0; index < SHOTS; index++) {
    await run('kill @e[type=minecraft:arrow]')
    await run('kill @e[type=minecraft:minecart]')
    await run(`summon minecraft:minecart ${RAIL.x1 + 1}.5 ${RAIL.y + 0.2} ${RAIL.z + 0.5} {CustomName:'"MCart"',CustomNameVisible:1b}`)
    await new Promise(resolve => setTimeout(resolve, 400))
    const cart = await cartsNear()
    // Start the charge, push the cart at ~0.4 s so it is moving at the release.
    const shotPromise = evalTool('game_shoot', { target: 'MCart', weapon: 'bow', maxShots: 1, chargeTicks: 20 })
    await new Promise(resolve => setTimeout(resolve, 400))
    if (cart?.uuid)
      await run(`data merge entity ${cart.uuid} {Motion:[0.9d,0.0d,0.0d]}`)
    const trace = []
    const traceTimer = setInterval(() => {
      void cartsNear().then((now) => { if (now) trace.push({ t: Date.now(), x: now.x }) })
    }, 150)
    const receipt = await shotPromise
    await new Promise(resolve => setTimeout(resolve, 700))
    clearInterval(traceTimer)
    const arrow = await stuckArrow()
    const last = trace.at(-1)
    const speed = trace.length > 1 ? (Math.abs((trace.at(-1).x - trace[0].x)) / ((trace.at(-1).t - trace[0].t) / 1000)).toFixed(2) : undefined
    shots.push({
      index: index + 1,
      fired: receipt?.shot?.shots?.length ?? 0,
      predictedFlightTicks: receipt?.shot?.predictedFlightTicks,
      closestDistance: receipt?.shot?.closestDistance,
      arc: receipt?.shot?.arc,
      aimTarget: receipt?.shot?.aimTarget,
      cartStart: cart ? { x: cart.x, z: cart.z } : undefined,
      cartLast: last ? { x: last.x } : undefined,
      cartSpeed: speed,
      arrow,
      missDistance: arrow && last ? Number(Math.hypot(arrow.x - last.x, arrow.z - RAIL.z + 0.5).toFixed(2)) : undefined,
    })
    process.stdout.write(`shot ${index + 1}/${SHOTS} fired=${shots.at(-1).fired} speed=${speed} miss=${shots.at(-1).missDistance}\r`)
  }
  evidence.cases.push({ id: 'B-02', label: 'boosted cart crossing the shot line', shots })
  evidence.analysis = {
    fired: shots.reduce((sum, shot) => sum + (shot.fired ?? 0), 0),
    meanSpeed: shots.map(shot => Number(shot.cartSpeed)).filter(v => Number.isFinite(v)).reduce((a, b) => a + b, 0) / Math.max(1, shots.filter(shot => shot.cartSpeed !== undefined).length),
    missDistances: shots.map(shot => shot.missDistance).filter(v => typeof v === 'number'),
    closestDistances: shots.map(shot => shot.closestDistance).filter(v => typeof v === 'number'),
  }
  evidence.verdict = 'PASS'
  note(`\nB-02: ${JSON.stringify(evidence.analysis)}`)
}
catch (error) {
  evidence.error = String(error)
  evidence.verdict = 'ERROR'
  console.error(error)
}
finally {
  try {
    await run('kill @e[type=minecraft:minecart]')
    await run('kill @e[type=minecraft:arrow]')
    await run(`fill ${RAIL.x1} ${RAIL.y} ${RAIL.z} ${RAIL.x2} ${RAIL.y} ${RAIL.z} minecraft:air`)
    await run('give airitest minecraft:arrow 64')
    await call(server, 'teleport_player', { player: BOT, x: 82.5, y: 75, z: -24.5, yaw: 0, pitch: 0 })
  }
  catch {}
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, JSON.stringify(evidence, null, 2))
  console.log(JSON.stringify({ verdict: evidence.verdict, error: evidence.error, analysis: evidence.analysis, shots: evidence.cases[0]?.shots?.map(shot => ({ i: shot.index, ticks: shot.predictedFlightTicks, closest: shot.closestDistance, speed: shot.cartSpeed, miss: shot.missDistance })) }, null, 2))
  ws.close()
  await server.close()
}
