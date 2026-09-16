import { writeFileSync } from 'node:fs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

// Tracks the local player (client bridge) and all server-side players while a
// human walks a fixture by hand, plus the state of the fixture's circuit blocks.
// Usage: node track-pos.mjs <durationSec> <outPath> [intervalMs]
const [durationRaw, outPath, intervalRaw] = process.argv.slice(2)
const durationMs = Number(durationRaw ?? 300) * 1000
const intervalMs = Number(intervalRaw ?? 150)

async function connect(port) {
  try {
    const client = new Client({ name: 'track-pos', version: '1.0.0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)))
    return client
  }
  catch {
    return undefined
  }
}

const [clientBridge, serverBridge] = await Promise.all([connect(25600), connect(25602)])
const samples = []
const events = []
const started = Date.now()

// Circuit blocks: the plate, the two command blocks, the stone the first
// command places, and the bridge row the chain command fills.
const watched = [
  { label: 'plate', x: 92, y: 83, z: -25 },
  { label: 'stone-blocker', x: 92, y: 84, z: -14 },
  { label: 'bridge-88', x: 88, y: 82, z: -15 },
  { label: 'bridge-89', x: 89, y: 82, z: -15 },
  { label: 'bridge-90', x: 90, y: 82, z: -15 },
  { label: 'bridge-91', x: 91, y: 82, z: -15 },
]
const watchState = new Map()

function textOf(result) {
  return (result?.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n')
}

function numbersOf(text) {
  const record = typeof text === 'string' ? JSON.parse(text) : text
  return record
}

async function sampleSelf() {
  if (!clientBridge)
    return undefined
  const result = await clientBridge.callTool({ name: 'get_self', arguments: {} })
  if (result.isError === true)
    return undefined
  const structured = result.structuredContent
  if (structured && typeof structured === 'object' && 'position' in structured) {
    const position = structured.position
    return {
      name: structured.name ?? 'self',
      x: Number(position?.x ?? structured.x),
      y: Number(position?.y ?? structured.y),
      z: Number(position?.z ?? structured.z),
      vx: Number(structured.motion?.x ?? 0),
      vz: Number(structured.motion?.z ?? 0),
      onGround: structured.onGround === true ? true : structured.onGround === false ? false : undefined,
      airborneTicks: structured.airborneTicks,
    }
  }
  const text = textOf(result)
  const parsed = numbersOf(text)
  const position = parsed.position ?? parsed
  return {
    name: parsed.name ?? 'self',
    x: Number(position.x),
    y: Number(position.y),
    z: Number(position.z),
    vx: Number(parsed.motion?.x ?? 0),
    vz: Number(parsed.motion?.z ?? 0),
    onGround: parsed.onGround === true,
  }
}

async function sampleServer() {
  if (!serverBridge)
    return []
  const result = await serverBridge.callTool({ name: 'list_players', arguments: {} })
  if (result.isError === true)
    return []
  const structured = result.structuredContent ?? {}
  const players = Array.isArray(structured.players) ? structured.players : []
  return players.map(player => ({
    name: player.name,
    x: Number(player.position?.x ?? player.x),
    y: Number(player.position?.y ?? player.y),
    z: Number(player.position?.z ?? player.z),
  }))
}

async function sampleWatched() {
  if (!serverBridge)
    return
  for (const watcher of watched) {
    const result = await serverBridge.callTool({ name: 'get_block', arguments: { x: watcher.x, y: watcher.y, z: watcher.z } })
    const text = textOf(result)
    const id = (text.match(/minecraft:[a-z_]+/) ?? ['?'])[0]
    const previous = watchState.get(watcher.label)
    if (previous !== id) {
      watchState.set(watcher.label, id)
      events.push({ t: Date.now() - started, label: watcher.label, from: previous ?? '(start)', to: id })
    }
  }
}

const timer = setInterval(async () => {
  if (Date.now() - started > durationMs) {
    clearInterval(timer)
    return
  }
  const at = Date.now() - started
  const [self, players] = await Promise.all([sampleSelf().catch(() => undefined), sampleServer().catch(() => [])])
  if (self && Number.isFinite(self.x))
    samples.push({ t: at, source: 'client', ...self })
  for (const player of players) {
    samples.push({ t: at, source: 'server', ...player })
  }
  await sampleWatched().catch(() => {})
  if (samples.length % 60 === 0) {
    writeFileSync(outPath, JSON.stringify({ durationMs, samples, events }, null, 2))
    const last = samples[samples.length - 1]
    console.log(`t=${(at / 1000).toFixed(0)}s samples=${samples.length} last=${last?.name} (${last?.x?.toFixed(1)},${last?.y?.toFixed(1)},${last?.z?.toFixed(1)}) events=${events.length}`)
  }
}, intervalMs)

await new Promise((resolve) => {
  const deadline = Date.now() + durationMs
  const check = setInterval(() => {
    if (Date.now() >= deadline) {
      clearInterval(check)
      clearInterval(timer)
      resolve()
    }
  }, 500)
})

writeFileSync(outPath, JSON.stringify({ durationMs, samples, events }, null, 2))

const clientSamples = samples.filter(sample => sample.source === 'client' && Number.isFinite(sample.x))
const byCell = []
for (const sample of clientSamples) {
  const cell = `${Math.floor(sample.x)},${Math.floor(sample.y)},${Math.floor(sample.z)}`
  if (byCell[byCell.length - 1] !== cell)
    byCell.push(cell)
}
let lastY = null
const cellsWithRise = []
for (const cell of byCell) {
  const [x, y, z] = cell.split(',').map(Number)
  const rise = lastY === null ? 0 : y - lastY
  lastY = y
  cellsWithRise.push(`${x},${y},${z}${rise > 0 ? ` (+${rise})` : rise < 0 ? ` (${rise})` : ''}`)
}
console.log('--- summary ---')
console.log(`client samples=${clientSamples.length} server samples=${samples.length - clientSamples.length}`)
console.log(`distinct cells=${byCell.length}`)
console.log('cell sequence:')
console.log(cellsWithRise.join('\n'))
console.log('events:')
for (const event of events)
  console.log(`  t=${(event.t / 1000).toFixed(1)}s ${event.label}: ${event.from} -> ${event.to}`)
if (clientBridge)
  await clientBridge.close()
if (serverBridge)
  await serverBridge.close()
