/**
 * B-02 hit verification on the user's short oscillating rail (x=240.5, z -36.5..-23.5).
 *
 * The target is a high-health sheep mounted on the moving minecart (the mod
 * resolves targets by custom name). The shooter is the bot on the platform east
 * of the track. Shots are triggered at the cart's turn points so the arrow
 * release lands mid-leg, where the target velocity is constant.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const outPath = process.argv[2] ?? 'b02-moving-hit.json'
const SHOTS = Number(process.argv[3] ?? 12)
const BOT = 'airitest'
const TARGET = 'MTarget'
const SHEEP_HEALTH = 45
const SHOOTER = { x: 248, y: 201, z: -35 }
const TARGET_SPAWN = { x: 246.5, y: 201, z: -30 }
const CART_VOLUME = 'x=239,y=200,z=-40,dx=3,dy=8,dz=22,limit=1'
const evidence = {
  id: 'B-02 moving target hit verification',
  startedAt: new Date().toISOString(),
  shooter: SHOOTER,
  target: { name: TARGET, health: SHEEP_HEALTH, mount: 'minecart on the short oscillating rail' },
  shots: [],
  verdict: 'unknown',
}

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

const server = new Client({ name: 'b02-server', version: '1.0.0' })
await server.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:25602/mcp')))
const game = new Client({ name: 'b02-game', version: '1.0.0' })
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
  return structuredOf(await call(game, 'get_self', {}, { tolerateError: true }))
}
async function cartState() {
  const record = structuredOf(await call(server, 'query_entities', { center: { x: 240, y: 201, z: -30 }, radius: 22, includePlayers: false, maxResults: 20, types: ['minecraft:minecart'] }, { tolerateError: true }))
  const entry = (record?.entities ?? [])[0]
  return entry ? { uuid: entry.uuid, x: Number(entry.x), y: Number(entry.y), z: Number(entry.z) } : undefined
}
async function targetState() {
  const record = structuredOf(await call(server, 'query_entities', { center: { x: 240.5, y: 201, z: -30 }, radius: 22, includePlayers: false, maxResults: 40, types: ['minecraft:sheep'] }, { tolerateError: true }))
  const entry = (record?.entities ?? []).find(candidate => candidate.name === TARGET)
  return entry ? { health: Number(entry.health), x: Number(entry.x), y: Number(entry.y), z: Number(entry.z) } : undefined
}
async function spawnTarget() {
  await run(`kill @e[type=minecraft:sheep,name=${TARGET}]`)
  await run(`summon minecraft:sheep ${TARGET_SPAWN.x} ${TARGET_SPAWN.y} ${TARGET_SPAWN.z} {CustomName:'"${TARGET}"',CustomNameVisible:1b,NoAI:1b,Silent:1b,PersistenceRequired:1b,Health:${SHEEP_HEALTH}f,attributes:[{id:"minecraft:generic.max_health",base:${SHEEP_HEALTH}},{id:"minecraft:generic.knockback_resistance",base:1.0}]}`)
  await sleep(500)
}
async function mountTarget() {
  await run(`ride @e[type=minecraft:sheep,name=${TARGET},limit=1] mount @e[type=minecraft:minecart,${CART_VOLUME}]`)
  await sleep(400)
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
    return `EXC ${message.result.exceptionDetails.exception?.description ?? 'eval failed'}`
  return message.result?.result?.value
}
await evalJs(`location.hash = '#/devtools/game-host'; 'ok'`)
await sleep(1200)

async function shootOnce() {
  await evalJs(`window.__shot = 'pending'
window.__AIRI_GAME_HOST_SMOKE__.executeGameTool('game_shoot', { target: '${TARGET}', weapon: 'bow', maxShots: 1, chargeTicks: 20 }).then(result => { window.__shot = result }).catch(error => { window.__shot = { error: String(error) } })
'go'`)
  let out = 'pending'
  for (let attempt = 0; attempt < 100 && out === 'pending'; attempt++) {
    await sleep(250)
    out = await evalJs('typeof window.__shot === "string" ? window.__shot : JSON.stringify(window.__shot)')
  }
  if (typeof out !== 'string')
    return out
  try {
    return JSON.parse(out)
  }
  catch {
    return { raw: out }
  }
}

/** Waits for the cart to reach a turn point (z direction flip) and returns the fresh state. */
async function waitForTurn(previousDirection) {
  let last = await cartState()
  let direction = previousDirection
  const started = Date.now()
  while (Date.now() - started < 12000) {
    await sleep(100)
    const now = await cartState()
    if (!now)
      continue
    const step = now.z - last.z
    if (Math.abs(step) > 0.02) {
      const next = Math.sign(step)
      if (direction !== 0 && next !== direction)
        return now
      direction = next
      last = now
    }
  }
  return last
}

const boot = await self()
const cart0 = await cartState()
evidence.botBefore = boot ? { x: boot.x, y: boot.y, z: boot.z, heldItem: boot.heldItem } : undefined
evidence.cartAtStart = cart0
console.log(`bot ${JSON.stringify(evidence.botBefore)} cart ${JSON.stringify(cart0)}`)

await run(`tp ${BOT} ${SHOOTER.x} ${SHOOTER.y} ${SHOOTER.z} 90 0`)
await sleep(800)
await spawnTarget()
await mountTarget()
const mounted = await targetState()
evidence.targetMounted = mounted
console.log(`target mounted: ${JSON.stringify(mounted)}`)

let direction = 0
for (let shot = 1; shot <= SHOTS; shot++) {
  const turn = await waitForTurn(direction)
  direction = 0
  const cartAtCall = await cartState()
  const before = await targetState()
  const calledAt = Date.now()
  const receipt = await shootOnce()
  await sleep(600)
  const after = await targetState()
  const cartAfter = await cartState()
  const combat = structuredOf(await call(game, 'combat_status', {}, { tolerateError: true }))
  const record = {
    shot,
    calledAt: new Date(calledAt).toISOString(),
    cartAtCall,
    cartAfter,
    before,
    after,
    endReason: receipt?.endReason,
    fired: receipt?.shot?.shots?.length ?? 0,
    closestDistance: receipt?.shot?.closestDistance,
    predictedFlightTicks: receipt?.shot?.predictedFlightTicks,
    arc: receipt?.shot?.arc,
    aimTarget: receipt?.shot?.aimTarget,
    targetUuid: receipt?.shot?.targetUuid,
    hitEvidence: receipt?.shot?.hitEvidence,
    unobservedTargetDeath: receipt?.shot?.unobservedTargetDeath,
    refusalDetail: receipt?.shot?.refusalDetail,
    clientAim: combat?.aimTarget,
    aimLead: combat?.aimLead,
    release: combat?.release,
    receipt,
  }
  evidence.shots.push(record)
  const damaged = before && after ? (before.health - after.health) : undefined
  console.log(`shot ${shot}: fired=${record.fired} closest=${record.closestDistance} ticks=${record.predictedFlightTicks} hp ${before?.health} -> ${after?.health ?? 'dead'} (dmg ${damaged ?? '-'}) cart z ${cartAtCall?.z?.toFixed(2)} -> ${cartAfter?.z?.toFixed(2)}`)
  if (!after) {
    const deathReceipt = evidence.shots[evidence.shots.length - 1]
    deathReceipt.targetDied = true
    await run('kill @e[type=minecraft:arrow]')
    await spawnTarget()
    await mountTarget()
    const remounted = await targetState()
    console.log(`target re-summoned + mounted: ${JSON.stringify(remounted)}`)
    if (shot === SHOTS)
      break
  }
}

const finalCart = await cartState()
evidence.cartAtEnd = finalCart
const fired = evidence.shots.filter(record => (record.fired ?? 0) > 0).length
const damaged = evidence.shots.filter(record => record.before && record.after && record.after.health < record.before.health).length
const killed = evidence.shots.filter(record => record.targetDied).length
evidence.summary = { shots: evidence.shots.length, fired, damaged, killed }
evidence.verdict = fired >= 6 && (damaged + killed) >= 4 ? 'hit-verified' : 'needs-review'
evidence.finishedAt = new Date().toISOString()

await run('kill @e[type=minecraft:arrow]')
await run(`kill @e[type=minecraft:sheep,name=${TARGET}]`)
await run(`tp ${BOT} 82.5 75 -23.5 0 0`)
mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, JSON.stringify(evidence, null, 2))
console.log('verdict', JSON.stringify(evidence.summary), evidence.verdict)
ws.close()
await game.close()
await server.close()
