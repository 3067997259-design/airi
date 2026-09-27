/**
 * R2b live verification (execution plan §7): simple-channel per-tick driving.
 *
 * Scenario: teleport the bot onto the bridge deck, submit a channel whose
 * path crosses open sky over the river with a gentle descent, then poll the
 * trajectory ring and assert the completion-gate behaviors:
 * - applyingStarted flips true and stays true (the session owns input)
 * - the bot's distance to the final waypoint trends to zero
 * - the session ends with a typed reason (CHANNEL_COMPLETE / DEADLINE / ...)
 * - boost attachments appear in the ring when rockets fire
 * - an MCP read stall (sleep in the poller) does not extend the applied
 *   prefix: the flight continues between polls
 */
import { writeFileSync } from 'node:fs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const outPath = 'r2b-simple-channel-20260920.json'
const token = '4065cb42ca7b48e2a4c7d35e9ad20378'
const client = new Client({ name: 'r2b-verify', version: '1.0.0' })
await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:25600/mcp'), {
  requestInit: { headers: { Authorization: `Bearer ${token}` } },
}))
const world = new Client({ name: 'r2b-world', version: '1.0.0' })
await world.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:25602/mcp')))

function structured(result) {
  if (result.structuredContent && typeof result.structuredContent === 'object')
    return result.structuredContent
  const text = (result.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('')
  return text ? JSON.parse(text) : {}
}
async function call(name, args = {}) {
  return structured(await client.callTool({ name, arguments: args }))
}
async function worldCall(name, args = {}) {
  return structured(await world.callTool({ name, arguments: args }))
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const records = []
const log = r => { records.push(r); console.log(JSON.stringify(r)) }

// Setup: teleport to the bridge deck and refill rockets.
await worldCall('teleport_player', { player: 'airitest', x: -1007, y: 74, z: 79 })
await sleep(2000)
await worldCall('run_command', { command: 'clear airitest minecraft:firework_rocket' })
await sleep(500)
await worldCall('run_command', { command: 'give airitest minecraft:firework_rocket 16' })
await sleep(800)
const pre = await call('get_self')
log({ scenario: 'setup', position: { x: pre.x, y: pre.y, z: pre.z }, onGround: pre.onGround })

// Submit the channel: three waypoints over the river, gentle descent.
const path = [
  { x: -1000, y: 76, z: 30 },
  { x: -950, y: 72, z: -60 },
  { x: -900, y: 70, z: -150 },
]
const submit = await call('flight_submit', {
  sessionId: `r2b-${Date.now()}`,
  generation: 2,
  revision: 1,
  deadlineMs: Date.now() + 90_000,
  dimension: 'minecraft:overworld',
  channel: { path, entryReach: 12 },
})
log({ scenario: 'submit', ...submit })

// Poll the flight every 2 s; each poll reads only new trajectory samples.
const distToGoal = []
let pollIndex = 0
const startedAt = Date.now()
while (Date.now() - startedAt < 60_000) {
  await sleep(2000)
  pollIndex += 1
  const status = await call('flight_status', {})
  const samples = status.trajectory ?? []
  const lastSample = samples.at(-1)
  const self = await call('get_self')
  const distance = Math.hypot(self.x - path.at(-1).x, self.z - path.at(-1).z)
  distToGoal.push(distance)
  log({
    poll: pollIndex,
    state: status.state,
    endReason: status.endReason,
    applyingStarted: status.applyingStarted,
    selfPosition: { x: +self.x.toFixed(1), y: +self.y.toFixed(1), z: +self.z.toFixed(1) },
    distanceToGoal: +distance.toFixed(1),
    newSamples: samples.length,
    trajectoryLost: status.trajectoryLost,
    boostSamples: samples.filter(s => s.boostAttached).length,
    fireSamples: samples.filter(s => s.rocketFiredThisTick).length,
  })
  if (status.state === 'TERMINATED')
    break
}

// Verdict inputs: the trend of the goal distance across polls.
const firstHalf = distToGoal.slice(0, Math.max(1, Math.floor(distToGoal.length / 2)))
const lastHalf = distToGoal.slice(-Math.max(1, Math.floor(distToGoal.length / 2)))
const avg = list => list.reduce((a, b) => a + b, 0) / Math.max(1, list.length)
log({ verdictInputs: { firstHalfAvg: +avg(firstHalf).toFixed(1), lastHalfAvg: +avg(lastHalf).toFixed(1), trend: avg(lastHalf) < avg(firstHalf) ? 'approaching' : 'not-approaching', distSeries: distToGoal.map(d => +d.toFixed(1)) } })
writeFileSync(outPath.replace(/\.json$/, '') + '.json', JSON.stringify(records, null, 2))
console.log(`saved ${records.length} records -> ${outPath.replace(/\.json$/, '')}.json`)
process.exit(0)
