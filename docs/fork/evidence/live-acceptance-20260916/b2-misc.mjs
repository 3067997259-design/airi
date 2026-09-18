/**
 * CD-B short-range items on the verified-clean 10-block line:
 * - B-10: a glass block between bot and target; the receipt predicts a hit
 *   (no terrain callback) while the arrow is intercepted - the difference is
 *   the evidence.
 * - B-07: a loyalty trident fired at the target; return observed, plus a
 *   cancelled throw.
 * - B-08 (partial): spectral arrow and a snowball use, recording what the
 *   live path can and cannot verify.
 *
 * Fixture: bot (86.5, 75, -29.5), target sheep (96.5, 75, -29.5).
 *
 * Usage: node b2-misc.mjs <outPath>
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const outPath = process.argv[2] ?? 'b2-misc.json'
const SERVER_PORT = 25602
const CLIENT_PORT = 25600
const CDP_PORT = 9222
const BOT = 'airitest'
const TARGET = 'Target'
const TARGET_POS = { x: 96.5, y: 75, z: -29.5 }
const STAND = { x: 86.5, y: 75, z: -29.5 }
const GLASS = { x: 91, y: 76, z: -30 }
const TARGET_NBT = `{CustomName:'"${TARGET}"',CustomNameVisible:1b,NoAI:1b,Silent:1b,PersistenceRequired:1b,Health:400f,attributes:[{id:"minecraft:generic.max_health",base:400}]}`

const evidence = { id: 'B-10/B-07/B-08 partial', startedAt: new Date().toISOString(), cases: [], verdict: 'unknown' }

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

const server = new Client({ name: 'b2m-server', version: '1.0.0' })
await server.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${SERVER_PORT}/mcp`)))
const game = new Client({ name: 'b2m-game', version: '1.0.0' })
await game.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${CLIENT_PORT}/mcp`)))

async function call(client, name, args, { tolerateError = false } = {}) {
  const result = await client.callTool({ name, arguments: args })
  if (result.isError === true && !tolerateError)
    throw new Error(`${name} failed: ${textOf(result).slice(0, 300)}`)
  return result
}

async function runCommand(command) {
  return await call(server, 'run_command', { command }, { tolerateError: true })
}

async function targetHealth() {
  const record = structuredOf(await call(server, 'query_entities', { center: TARGET_POS, radius: 12, includePlayers: false, maxResults: 20, types: ['minecraft:sheep'] }, { tolerateError: true }))
  const entry = (record?.entities ?? []).find(candidate => candidate.name === TARGET)
  return entry ? Number(entry.health) : undefined
}

async function inventoryCount(itemId) {
  const inventory = structuredOf(await call(game, 'get_inventory', {}))
  return [...(inventory?.hotbar ?? []), ...(inventory?.main ?? [])].filter(slot => slot.id === itemId).reduce((total, slot) => total + slot.count, 0)
}

const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
const target = targets.find(item => item.type === 'page' && item.url.includes('synced-leader=true'))
if (!target)
  throw new Error('AIRI leader window not found on CDP')
const ws = new WebSocket(target.webSocketDebuggerUrl)
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
async function waitForProbe() {
  await evalJs(`location.hash = '#/devtools/game-host'; 'ok'`)
  await new Promise(resolve => setTimeout(resolve, 1500))
  for (let attempt = 0; attempt < 12; attempt++) {
    const ready = await evalJs('window.__AIRI_GAME_HOST_SMOKE__ ? "ready" : "missing"')
    if (ready === 'ready')
      return
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  throw new Error('game host smoke probe missing')
}

function evalTool(tool, payload, maxMs = 60_000) {
  return evalJs(`window.__b2mResult = 'pending'
window.__AIRI_GAME_HOST_SMOKE__.executeGameTool('${tool}', ${JSON.stringify(payload)})
  .then(result => { window.__b2mResult = result })
  .catch(error => { window.__b2mResult = { error: String(error) } })
'started'`).then(async () => {
    const deadline = Date.now() + maxMs
    for (;;) {
      const current = await evalJs('typeof window.__b2mResult === "string" ? window.__b2mResult : JSON.stringify(window.__b2mResult)')
      if (current !== 'pending')
        return JSON.parse(current)
      if (Date.now() > deadline)
        return { error: 'timeout waiting for tool result' }
      await new Promise(resolve => setTimeout(resolve, 200))
    }
  })
}

try {
  await waitForProbe()
  await runCommand(`kill @e[type=minecraft:sheep,name=${TARGET}]`)
  await runCommand(`summon minecraft:sheep ${TARGET_POS.x} ${TARGET_POS.y} ${TARGET_POS.z} ${TARGET_NBT}`)
  await runCommand(`clear ${BOT} minecraft:bow`)
  await runCommand(`clear ${BOT} minecraft:crossbow`)
  await runCommand(`give ${BOT} minecraft:bow 1`)
  await runCommand(`clear ${BOT} minecraft:arrow`)
  await runCommand(`give ${BOT} minecraft:arrow 128`)
  await call(server, 'teleport_player', { player: BOT, x: STAND.x, y: STAND.y, z: STAND.z, yaw: -90, pitch: 0 })
  await new Promise(resolve => setTimeout(resolve, 800))

  // --- B-10: glass wall interception --------------------------------------
  await runCommand(`setblock ${GLASS.x} ${GLASS.y} ${GLASS.z} minecraft:glass`)
  await new Promise(resolve => setTimeout(resolve, 400))
  {
    const healthBefore = await targetHealth()
    const receipt = await evalTool('game_shoot', { target: TARGET, weapon: 'bow', maxShots: 1, chargeTicks: 20 })
    await new Promise(resolve => setTimeout(resolve, 900))
    const healthAfter = await targetHealth()
    const shot = receipt?.shot?.shots?.[0]
    evidence.cases.push({
      id: 'B-10 薄墙拦截',
      predicted: { closestDistance: receipt?.shot?.closestDistance, predictedFlightTicks: receipt?.shot?.predictedFlightTicks, fireReason: receipt?.shot?.fireReason },
      actual: { healthBefore, healthAfter, damage: healthBefore !== undefined && healthAfter !== undefined ? healthBefore - healthAfter : undefined },
      verifiedBy: shot?.verifiedBy,
      glassAfter: structuredOf(await call(server, 'get_block', GLASS))?.id,
      pass: '记录差异（预测命中、实际被玻璃拦截）',
    })
    note(`B-10: predicted closest=${receipt?.shot?.closestDistance} actual damage=${healthBefore !== undefined && healthAfter !== undefined ? healthBefore - healthAfter : '?'} glass=${evidence.cases.at(-1).glassAfter}`)
  }
  await runCommand(`setblock ${GLASS.x} ${GLASS.y} ${GLASS.z} air`)

  // --- B-07: loyalty trident return ---------------------------------------
  await runCommand(`clear ${BOT} minecraft:trident`)
  await runCommand(`give ${BOT} minecraft:trident[minecraft:enchantments={"minecraft:loyalty":3}] 1`)
  await new Promise(resolve => setTimeout(resolve, 500))
  {
    const tridentsBefore = await inventoryCount('minecraft:trident')
    const healthBefore = await targetHealth()
    const receipt = await evalTool('game_shoot', { target: TARGET, weapon: 'trident', maxShots: 1 })
    await new Promise(resolve => setTimeout(resolve, 5_000))
    const tridentsAfter = await inventoryCount('minecraft:trident')
    evidence.cases.push({
      id: 'B-07 忠诚三叉戟回返',
      tridentsBefore,
      tridentsAfter,
      endReason: receipt?.shot?.endReason ?? receipt?.endReason,
      returned: receipt?.shot?.returned,
      damage: healthBefore !== undefined ? healthBefore - (await targetHealth() ?? healthBefore) : undefined,
      shots: receipt?.shot?.shots?.length,
    })
    note(`B-07: end=${evidence.cases.at(-1).endReason} returned=${receipt?.shot?.returned} tridents ${tridentsBefore}->${tridentsAfter}`)
  }

  // --- B-08 partial: spectral arrow and a thrown snowball -----------------
  await runCommand(`clear ${BOT} minecraft:spectral_arrow`)
  await runCommand(`give ${BOT} minecraft:spectral_arrow 8`)
  await new Promise(resolve => setTimeout(resolve, 400))
  {
    const healthBefore = await targetHealth()
    const receipt = await evalTool('game_shoot', { target: TARGET, weapon: 'bow', maxShots: 1, chargeTicks: 20 })
    await new Promise(resolve => setTimeout(resolve, 900))
    const healthAfter = await targetHealth()
    evidence.cases.push({
      id: 'B-08 光谱箭',
      endReason: receipt?.endReason,
      refusal: receipt?.refusalReason,
      shots: receipt?.shot?.shots?.length,
      damage: healthBefore !== undefined && healthAfter !== undefined ? healthBefore - healthAfter : undefined,
      note: '光谱箭的发光效果缺少实体效果回读通道，仅记录发射与伤害',
    })
    note(`B-08 spectral: end=${receipt?.endReason} shots=${receipt?.shot?.shots?.length} damage=${evidence.cases.at(-1).damage}`)
  }
  await runCommand(`clear ${BOT} minecraft:snowball`)
  await runCommand(`give ${BOT} minecraft:snowball 8`)
  await new Promise(resolve => setTimeout(resolve, 400))
  {
    const healthBefore = await targetHealth()
    const snowballsBefore = await inventoryCount('minecraft:snowball')
    await evalTool('game_equip', { itemId: 'minecraft:snowball', target: 'main_hand' }, 20_000)
    await call(game, 'look_at', { x: TARGET_POS.x, y: TARGET_POS.y + 0.8, z: TARGET_POS.z }, { tolerateError: true })
    const receipt = await evalTool('game_use', { mode: 'item' }, 30_000)
    await new Promise(resolve => setTimeout(resolve, 900))
    const snowballsAfter = await inventoryCount('minecraft:snowball')
    const healthAfter = await targetHealth()
    evidence.cases.push({
      id: 'B-08 雪球投掷',
      endReason: receipt?.endReason,
      snowballsBefore,
      snowballsAfter,
      thrown: snowballsAfter < snowballsBefore,
      damage: healthBefore !== undefined && healthAfter !== undefined ? healthBefore - healthAfter : undefined,
    })
    note(`B-08 snowball: end=${receipt?.endReason} thrown=${snowballsBefore}->${snowballsAfter}`)
  }
  await runCommand(`clear ${BOT} minecraft:snowball`)

  // B-08: a crossbow with fireworks only - record what the live task does.
  await runCommand(`clear ${BOT} minecraft:crossbow`)
  await runCommand(`clear ${BOT} minecraft:arrow`)
  await runCommand(`give ${BOT} minecraft:crossbow 1`)
  await runCommand(`give ${BOT} minecraft:firework_rocket 8`)
  await new Promise(resolve => setTimeout(resolve, 400))
  {
    const receipt = await evalTool('game_shoot', { target: TARGET, weapon: 'crossbow', maxShots: 1 })
    evidence.cases.push({
      id: 'B-08 烟花弩',
      endReason: receipt?.endReason,
      refusal: receipt?.refusalReason,
      shots: receipt?.shot?.shots?.length,
    })
    note(`B-08 firework crossbow: end=${receipt?.endReason} refusal=${receipt?.refusalReason}`)
  }

  evidence.verdict = evidence.cases.every(testCase => testCase.endReason !== 'ERROR') ? 'PASS' : 'PARTIAL'
}
catch (error) {
  evidence.error = String(error)
  evidence.verdict = 'ERROR'
  console.error(error)
}
finally {
  try {
    await runCommand(`kill @e[type=minecraft:sheep,name=${TARGET}]`)
    await runCommand(`setblock ${GLASS.x} ${GLASS.y} ${GLASS.z} air`)
    await runCommand(`clear ${BOT} minecraft:spectral_arrow`)
    await runCommand(`clear ${BOT} minecraft:snowball`)
    await runCommand(`clear ${BOT} minecraft:trident`)
    await call(server, 'teleport_player', { player: BOT, x: 82.5, y: 75, z: -24.5, yaw: 0, pitch: 0 })
  }
  catch {}
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, JSON.stringify(evidence, null, 2))
  console.log(JSON.stringify({ verdict: evidence.verdict, cases: evidence.cases }, null, 2).slice(0, 3000))
  ws.close()
  await game.close()
  await server.close()
}
