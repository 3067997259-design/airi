/**
 * CD-B2: a uniformly moving target on the user's proven A-line.
 *
 * The A-line launches a cart from the slope when the lever is powered (verified
 * in the CD-V batch). The shooter stands east of the line and fires west at the
 * cart as it passes: the receipt's prediction, the cart's traced position and
 * the stuck-arrow impact are recorded for the intercept comparison.
 *
 * Usage: node b-moving-target2.mjs <outPath>
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const outPath = process.argv[2] ?? 'b-moving-target2.json'
const SHOTS = Number(process.argv[3] ?? 6)
const BOT = 'airitest'
const LEVER = { x: 241, y: 201, z: -42 }
const CART_START = { x: 240.5, y: 201.2, z: -41.6 }
const SHOOTER = { x: 246.5, y: 201, z: -52 }
const evidence = { id: 'B-02 moving target (A-line)', startedAt: new Date().toISOString(), shotsPerCase: SHOTS, cases: [], verdict: 'unknown' }

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

const server = new Client({ name: 'bm2-server', version: '1.0.0' })
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
async function cartAt() {
  const record = structuredOf(await call(server, 'query_entities', { center: { x: 240, y: 201, z: -52 }, radius: 30, includePlayers: false, maxResults: 10, types: ['minecraft:minecart'] }, { tolerateError: true }))
  const cart = (record?.entities ?? []).find(entry => entry.name === 'MCart')
  return cart ? { x: Number(cart.x), y: Number(cart.y), z: Number(cart.z) } : undefined
}
async function stuckArrow() {
  const record = structuredOf(await call(server, 'query_entities', { center: { x: 245, y: 201, z: -48 }, radius: 12, includePlayers: false, maxResults: 30, types: ['minecraft:arrow'] }, { tolerateError: true }))
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
  await evalJs(`window.__bm2 = 'pending'
window.__AIRI_GAME_HOST_SMOKE__.executeGameTool('${tool}', ${JSON.stringify(payload)})
  .then(result => { window.__bm2 = result })
  .catch(error => { window.__bm2 = { error: String(error) } })
'started'`)
  const deadline = Date.now() + maxMs
  for (;;) {
    const current = await evalJs('typeof window.__bm2 === "string" ? window.__bm2 : JSON.stringify(window.__bm2)')
    if (current !== 'pending')
      return JSON.parse(current)
    if (Date.now() > deadline)
      return { error: 'timeout' }
    await new Promise(resolve => setTimeout(resolve, 150))
  }
}

try {
  await waitProbe()
  await run('time set day')
  await run('weather clear')
  await run('give airitest minecraft:bow 1')
  await run('clear airitest minecraft:arrow')
  await run('give airitest minecraft:arrow 256')
  await run(`setblock ${LEVER.x} ${LEVER.y} ${LEVER.z} minecraft:lever[face=floor,facing=north,powered=false]`)
  // The shooter stands east of the line (facing west means yaw 90).
  await call(server, 'teleport_player', { player: BOT, x: SHOOTER.x, y: SHOOTER.y, z: SHOOTER.z, yaw: 90, pitch: 0 })
  await new Promise(resolve => setTimeout(resolve, 800))

  const shots = []
  for (let index = 0; index < SHOTS; index++) {
    await run('kill @e[type=minecraft:arrow]')
    await run('kill @e[type=minecraft:minecart]')
    await run(`summon minecraft:minecart ${CART_START.x} ${CART_START.y} ${CART_START.z} {CustomName:'"MCart"',CustomNameVisible:1b,Rotation:[180f,0f]}`)
    await new Promise(resolve => setTimeout(resolve, 500))
    const shotPromise = evalTool('game_shoot', { target: 'MCart', weapon: 'bow', maxShots: 1, chargeTicks: 20 })
    // Launch the cart about half a second in, so it is moving at the release.
    await new Promise(resolve => setTimeout(resolve, 500))
    await run(`setblock ${LEVER.x} ${LEVER.y} ${LEVER.z} minecraft:lever[face=floor,facing=north,powered=true]`)
    const trace = []
    const timer = setInterval(() => {
      void cartAt().then((now) => { if (now) trace.push({ t: Date.now(), x: now.x, z: now.z }) })
    }, 120)
    const receipt = await shotPromise
    await new Promise(resolve => setTimeout(resolve, 900))
    clearInterval(timer)
    await run(`setblock ${LEVER.x} ${LEVER.y} ${LEVER.z} minecraft:lever[face=floor,facing=north,powered=false]`)
    const arrow = await stuckArrow()
    const first = trace[0]
    const last = trace.at(-1)
    const speed = first && last && last.t > first.t ? Number((Math.hypot(last.x - first.x, last.z - first.z) / ((last.t - first.t) / 1000)).toFixed(2)) : undefined
    const miss = arrow && last ? Number(Math.hypot(arrow.x - last.x, arrow.z - last.z).toFixed(2)) : undefined
    shots.push({
      index: index + 1,
      status: receipt?.status,
      endReason: receipt?.endReason,
      error: receipt?.error,
      fired: receipt?.shot?.shots?.length ?? 0,
      predictedFlightTicks: receipt?.shot?.predictedFlightTicks,
      closestDistance: receipt?.shot?.closestDistance,
      arc: receipt?.shot?.arc,
      aimTarget: receipt?.shot?.aimTarget,
      cartFirst: first ? { x: first.x, z: first.z } : undefined,
      cartLast: last ? { x: last.x, z: last.z } : undefined,
      cartSpeed: speed,
      arrow,
      missDistance: miss,
    })
    process.stdout.write(`shot ${index + 1}/${SHOTS} fired=${shots.at(-1).fired} speed=${speed} miss=${miss}\r`)
  }
  evidence.cases.push({ id: 'B-02', label: 'A-line cart crossing the shot line', shots })
  const speeds = shots.map(shot => Number(shot.cartSpeed)).filter(v => Number.isFinite(v))
  const misses = shots.map(shot => shot.missDistance).filter(v => typeof v === 'number')
  evidence.analysis = {
    fired: shots.reduce((sum, shot) => sum + (shot.fired ?? 0), 0),
    meanSpeed: speeds.length > 0 ? Number((speeds.reduce((a, b) => a + b, 0) / speeds.length).toFixed(2)) : undefined,
    meanMiss: misses.length > 0 ? Number((misses.reduce((a, b) => a + b, 0) / misses.length).toFixed(2)) : undefined,
    predictions: shots.map(shot => ({ ticks: shot.predictedFlightTicks, closest: shot.closestDistance })),
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
    await run(`setblock ${LEVER.x} ${LEVER.y} ${LEVER.z} minecraft:lever[face=floor,facing=north,powered=false]`)
    await run('give airitest minecraft:arrow 64')
    await call(server, 'teleport_player', { player: BOT, x: 82.5, y: 75, z: -24.5, yaw: 0, pitch: 0 })
  }
  catch {}
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, JSON.stringify(evidence, null, 2))
  console.log(JSON.stringify({ verdict: evidence.verdict, error: evidence.error, analysis: evidence.analysis, shots: evidence.cases[0]?.shots?.map(shot => ({ i: shot.index, ticks: shot.predictedFlightTicks, closest: shot.closestDistance, speed: shot.cartSpeed, miss: shot.missDistance, aim: shot.aimTarget })) }, null, 2))
  ws.close()
  await server.close()
}
