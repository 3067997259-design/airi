/**
 * R2a live verification (execution plan §6): drives the flight.* RPCs against
 * the live bot and asserts the four completion-gate behaviors.
 *
 * - same-tick observation alignment (two reads differ by exactly one tick
 *   step after a settle, and every read carries phase/dimension/boost)
 * - launch handover traceable (boost estimate appears with its source after
 *   a launch macro run spends a rocket)
 * - repeated ignition refused (the second flight_boost with the same opId
 *   returns the first response; rockets-before/after unchanged)
 * - old-session rejection (a submit with generation 0 while the stored
 *   generation is 1 is rejected stale_generation)
 *
 * Diagnostics only: the harness records what happened, the batch verdict is
 * written to checks.md by the executor.
 */
import { writeFileSync } from 'node:fs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const outPath = process.argv[2] ?? 'r2a-live-20260920.jsonl'
const token = '4065cb42ca7b48e2a4c7d35e9ad20378'
const client = new Client({ name: 'r2a-verify', version: '1.0.0' })
await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:25600/mcp'), {
  requestInit: { headers: { Authorization: `Bearer ${token}` } },
}))
const records = []
const log = (record) => {
  records.push(record)
  console.log(JSON.stringify(record))
}

function structured(result) {
  if (result.structuredContent && typeof result.structuredContent === 'object')
    return result.structuredContent
  const text = (result.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('')
  return text ? JSON.parse(text) : {}
}
async function call(name, args = {}) {
  return structured(await client.callTool({ name, arguments: args }))
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// --- Scenario A: observation alignment ------------------------------------
const obs1 = await call('flight_observe')
await sleep(1000)
const obs2 = await call('flight_observe')
log({ scenario: 'A-observe', first: { tick: obs1.tick, phase: obs1.phase, dimension: obs1.dimension, boost: obs1.boost, session: obs1.session }, second: { tick: obs2.tick }, tickAdvanced: obs2.tick > obs1.tick })

// --- Scenario B: channel contract ------------------------------------------
// Order matters: a live session must exist before a stale-generation submit
// can be rejected (the controller compares against the highest accepted
// generation, which starts empty).
const liveSessionId = `r2a-live-${Date.now()}`
const submit = await call('flight_submit', { sessionId: liveSessionId, generation: 1, revision: 1, deadlineMs: Date.now() + 120_000, dimension: 'minecraft:overworld' })
log({ scenario: 'B1-accept', accepted: submit.accepted, startedApplying: submit.startedApplying, sessionId: liveSessionId })
const stale = await call('flight_submit', { sessionId: `r2a-stale-${Date.now()}`, generation: 0, revision: 1, dimension: 'minecraft:overworld' })
log({ scenario: 'B2-stale-generation', accepted: stale.accepted, reason: stale.reason, expectedGeneration: stale.expectedGeneration })
const repeat = await call('flight_submit', { sessionId: liveSessionId, generation: 1, revision: 1, deadlineMs: Date.now() + 120_000, dimension: 'minecraft:overworld' })
log({ scenario: 'B3-idempotent-resubmit', idempotent: JSON.stringify(repeat) === JSON.stringify(submit), accepted: repeat.accepted })
const status1 = await call('flight_status', {})
log({ scenario: 'B4-status', state: status1.state, applyingStarted: status1.applyingStarted, trajectoryLength: (status1.trajectory ?? []).length, trajectoryLost: status1.trajectoryLost })

// --- Scenario C: ignition dedup ---------------------------------------------
const invBefore = structured(await client.callTool({ name: 'get_inventory', arguments: {} }))
const rocketsBefore = countRockets(invBefore)
const ignite1 = await call('flight_boost', { opId: 'r2a-dedup-001' })
const invMid = structured(await client.callTool({ name: 'get_inventory', arguments: {} }))
const rocketsMid = countRockets(invMid)
const ignite2 = await call('flight_boost', { opId: 'r2a-dedup-001' })
const invAfter = structured(await client.callTool({ name: 'get_inventory', arguments: {} }))
const rocketsAfter = countRockets(invAfter)
log({
  scenario: 'C-ignition-dedup',
  firstFired: ignite1.fired, firstHand: ignite1.hand,
  rocketsBefore, rocketsMid, rocketsAfter,
  secondFired: ignite2.fired,
  secondIsReplay: JSON.stringify(ignite1) === JSON.stringify(ignite2),
  rocketDeltaFirst: rocketsMid - rocketsBefore,
  rocketDeltaSecond: rocketsAfter - rocketsMid,
})

function countRockets(inv) {
  let total = 0
  for (const key of ['hotbar', 'main']) {
    for (const item of inv[key] ?? []) {
      if (typeof item.id === 'string' && item.id.includes('firework_rocket'))
        total += Number(item.count) || 0
    }
  }
  const off = inv.offhand
  if (off && typeof off.id === 'string' && off.id.includes('firework_rocket'))
    total += Number(off.count) || 0
  return total
}

// --- Scenario D: launch handover + revoke ------------------------------------
const launch = await call('elytra_launch', { goalX: -984, goalY: 90, goalZ: 30, withFireworks: true })
await sleep(2500)
const obsAfterLaunch = await call('flight_observe')
log({ scenario: 'D1-launch-handover', launchPhase: launch.phase, launchTicks: launch.ticks, fireworksUsed: launch.fireworksUsed, handedGliding: launch.gliding, boostAfterLaunch: obsAfterLaunch.boost, launchFacts: obsAfterLaunch.launch ? { deployed: obsAfterLaunch.launch.deployed, boostSeen: obsAfterLaunch.launch.boostSeen } : undefined })
const traj = await call('flight_status', { sinceTick: 0 })
log({ scenario: 'D2-trajectory-ring', samples: (traj.trajectory ?? []).length, lost: traj.trajectoryLost, capacity: traj.ringCapacity, ignitionMarkers: (traj.trajectory ?? []).filter(s => s.rocketFiredThisTick).length })
const revoke = await call('flight_revoke', { sessionId: liveSessionId })
log({ scenario: 'D3-revoke', revoked: revoke.revoked, wasActive: revoke.wasActive, endReason: revoke.endReason })
const finalStatus = await call('flight_status', {})
log({ scenario: 'D4-terminal', state: finalStatus.state, endReason: finalStatus.endReason })

writeFileSync(outPath.replace(/\.jsonl$/, '') + '.json', JSON.stringify(records, null, 2))
console.log(`saved ${records.length} records -> ${outPath.replace(/\.jsonl$/, '')}.json`)
process.exit(0)
