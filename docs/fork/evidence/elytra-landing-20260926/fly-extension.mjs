import process from 'node:process'

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

/**
 * Fly one frozen, geometrically verified local passage from natural ground.
 * Call stack: main -> flight_submit -> native launch and flight controller;
 * flight_status -> append-only native samples -> interpolated passage gates.
 * Recovery crossings never count. Reset effects expire before takeoff.
 */
async function main() {
  const root = new URL('./', import.meta.url)
  const tag = process.argv[2] ?? `extension-${Date.now()}`
  const testEnding = true
  const output = new URL(`${tag}.jsonl`, root)
  const route = JSON.parse(readFileSync(new URL('geometric-route.json', root), 'utf8')).points
  if (route.at(-1).z + 6 > -158.5 - 2)
    throw new Error('The terminal arrival sphere overlaps the required exit section')
  const start = process.env.LOCAL_START
    ? Object.fromEntries(process.env.LOCAL_START.split(',').map((v, i) => [['x', 'y', 'z'][i], Number(v)]))
    : { x: -984.5, y: 63, z: -48.5 }
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
  const clients = []
  for (const port of [25600, 25602]) {
    const client = new Client({ name: 'local-passage', version: '1.0.0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)))
    clients.push(client)
  }
  async function call(side, name, args = {}) {
    const result = await clients[side].callTool({ name, arguments: args })
    const data = result.structuredContent ?? JSON.parse(result.content.find(p => p.type === 'text').text)
    if (result.isError)
      throw new Error(`${name}: ${JSON.stringify(data)}`)
    return data
  }
  function log(kind, data) {
    appendFileSync(output, `${JSON.stringify({ at: new Date().toISOString(), kind, ...data })}\n`)
  }
  const command = command => call(1, 'run_command', { command })
  const samples = []
  let submittedSession
  const sections = [
    { name: 'upper-wool', cx: -971.5, cz: -80.5, nx: 22, nz: -20, width: 10, minY: 72.15, maxY: 74.05 },
    { name: 'lower-wool', cx: -967.5, cz: -97, nx: 7, nz: -18, width: 8, minY: 72.15, maxY: 74.05 },
    { name: 'slab-approach', cx: -952, cz: -115, nx: 0, nz: -1, width: 22, minY: 64, maxY: 73.05 },
    { name: 'slab-entry', cx: -950, cz: -123, nx: 0, nz: -1, width: 24, minY: 64, maxY: 73.05 },
    { name: 'slab-exit', cx: -930, cz: -158.5, nx: 0, nz: -1, width: 27, minY: 64, maxY: 73.05 },
    { name: 'second-roof-exit', cx: -881, cz: -216.5, nx: 0, nz: -1, width: 16, minY: 64, maxY: 77.05 },
    { name: 'last-roof-exit', cx: -861, cz: -246.5, nx: 0, nz: -1, width: 9, minY: 64, maxY: 79.05 },
    { name: 'cave-approach', cx: -848, cz: -258.5, nx: 0, nz: -1, width: 6, minY: 64, maxY: 74 },
  ]
  try {
    const old = await call(0, 'flight_status', { sinceTick: 0 })
    if (old.sessionId)
      await call(0, 'flight_revoke', { sessionId: old.sessionId })
    const before = await call(0, 'get_self')
    if (before.health <= 0)
      await call(0, 'respawn')
    await command('effect give airitest minecraft:resistance 5 5 true')
    await command('clear airitest minecraft:elytra')
    const inventory = await call(0, 'get_inventory')
    const slots = [...inventory.hotbar, ...inventory.main]
    if (slots.filter(slot => slot.count > 0).length >= 36) {
      // Repeated unconditional resupply filled every slot in local-08. A
      // newly given elytra then dropped on the ground instead of equipping.
      await command('clear airitest minecraft:firework_rocket 64')
      log('supply_space', { removedRockets: 64, reason: 'full_inventory_prevented_elytra' })
    }
    await command('give airitest minecraft:elytra 1')
    await call(1, 'teleport_player', { player: 'airitest', ...start })
    await command('effect give airitest minecraft:instant_health 1 20 true')
    await command('effect give airitest minecraft:saturation 5 10 true')
    if (slots.reduce((total, slot) => total + (slot.id === 'minecraft:firework_rocket' ? slot.count : 0), 0) < 16)
      await command('give airitest minecraft:firework_rocket 64')
    await sleep(6_000)
    const self = await call(0, 'get_self')
    if (!self.onGround)
      throw new Error(`Local start is not grounded: ${JSON.stringify(self)}`)
    const prepared = await call(0, 'get_inventory')
    const equipment = await call(0, 'get_equipment')
    if (![...prepared.hotbar, ...prepared.main, equipment.chest].some(slot => slot.id === 'minecraft:elytra'))
      throw new Error('Preflight failed: no elytra was received')
    const priming = await call(0, 'flight_status', { sinceTick: 0 })
    let cursor = Math.max(0, ...(priming.trajectory ?? []).map(s => s.tick))
    const runId = `${tag}-${Date.now()}`
    const submission = {
      sessionId: runId,
      controlSessionId: `ctl-${runId}`,
      generation: 1,
      revision: 1,
      deadlineMs: Date.now() + 35_000,
      channel: { path: route, entryReach: 6, kind: 'stop' },
    }
    log('start', { build: priming.build, start: self, sections, submission, testEnding, equipment })
    const receipt = await call(0, 'flight_submit', submission)
    log('receipt', { receipt })
    if (!receipt.accepted)
      throw new Error(`Submission refused: ${JSON.stringify(receipt)}`)
    submittedSession = runId
    const started = Date.now()
    let settled = 0
    let lastStatus
    let stopReason = 'observation_timeout'
    while (Date.now() - started < 50_000) {
      const status = await call(0, 'flight_status', { sinceTick: cursor })
      log('status', { status })
      lastStatus = status
      for (const sample of status.trajectory ?? []) {
        if (sample.tick <= cursor)
          continue
        cursor = sample.tick
        samples.push(sample)
        // Water plus fallFlying is not a stable landing: local-02 kept sinking
        // after this fixture had incorrectly declared its ending settled.
        const stable = sample.onGround && !sample.gliding && !sample.inWater
          && Math.hypot(sample.velocity.x, sample.velocity.y, sample.velocity.z) < 0.1
        settled = stable && sample.inputOwner !== 'launch-macro' && samples.some(s => s.inputOwner === 'flight-session') ? settled + 1 : 0
      }
      const latest = samples.at(-1)
      if (latest && (latest.position.x < -1012 || latest.position.x > -830
        || latest.position.z < -278 || latest.position.z > -35)) {
        stopReason = 'fixture_boundary_abort'
        break
      }
      if (status.routeOutcome === 'FAILED') {
        stopReason = 'route_failed'
        break
      }
      if (samples.some(s => ['flight-recovery', 'flight-undecided'].includes(s.inputOwner)
        && s.gliding && (s.safeEmergency || !(s.safeVerified > 0)))) {
        stopReason = 'unverified_recovery_abort'
        break
      }
      if (settled >= 20) {
        stopReason = 'settled_ground'
        break
      }
      if (status.state === 'TERMINATED' && status.phase === 'RELEASED') {
        stopReason = 'control_released'
        break
      }
      if (latest?.inWater) {
        stopReason = 'water_abort'
        break
      }
      // This experiment measures passage continuity. Do not let its terminal
      // hold drift out of the venue while waiting for an unrelated landing.
      // The following reset is cleanup, never evidence of a successful ending.
      if (!testEnding && latest && latest.position.z < -160) {
        stopReason = 'local_measurement_complete'
        break
      }
      await sleep(100)
    }
    const crossings = []
    for (const section of sections) {
      const length = Math.hypot(section.nx, section.nz)
      const nx = section.nx / length
      const nz = section.nz / length
      const distance = p => (p.x - section.cx) * nx + (p.z - section.cz) * nz
      const events = []
      for (let i = 1; i < samples.length; i++) {
        const a = samples[i - 1]
        const b = samples[i]
        const pa = a.position
        const pb = b.position
        const da = distance(pa)
        const db = distance(pb)
        if (!(da <= 0) || !(db > 0))
          continue
        const t = -da / (db - da)
        const p = { x: pa.x + (pb.x - pa.x) * t, y: pa.y + (pb.y - pa.y) * t, z: pa.z + (pb.z - pa.z) * t }
        const inside = Math.abs((p.x - section.cx) * -nz + (p.z - section.cz) * nx) <= section.width
          && p.y >= section.minY && p.y <= section.maxY
        events.push({ tick: b.tick, position: p, inside, controlled: a.inputOwner === 'flight-session' && b.inputOwner === 'flight-session'
          && !a.holding && !b.holding && a.routeOutcome !== 'FAILED' && b.routeOutcome !== 'FAILED'
          && a.gliding && b.gliding && !a.inWater && !b.inWater && b.tick === a.tick + 1 })
      }
      crossings.push({ name: section.name, events, passed: events.some(e => e.inside && e.controlled) })
    }
    const controlled = samples.filter(s => s.inputOwner === 'flight-session')
    const damage = samples.slice(1).reduce((total, s, i) => total + Math.max(0, samples[i].health - s.health), 0)
    const allCrossed = crossings.every(c => c.passed)
    const valid = crossings.map(c => c.events.find(e => e.inside && e.controlled))
    const ordered = allCrossed && valid.every((e, i) => i === 0 || e.tick > valid[i - 1].tick)
    const interval = ordered ? samples.filter(s => s.tick >= valid[0].tick && s.tick <= valid.at(-1).tick) : []
    const continuous = ordered && interval.every((s, i) => s.inputOwner === 'flight-session' && !s.holding
      && s.routeOutcome !== 'FAILED' && s.gliding && !s.inWater
      && (i === 0 || s.tick === interval[i - 1].tick + 1))
    const summary = { tag, build: priming.build, crossings, continuous, damage, minHealth: Math.min(...samples.map(s => s.health)), samples: samples.length, controlledTicks: controlled.length, budgetExhausted: controlled.filter(s => s.budgetExhausted).length, settled, stopReason, endReason: lastStatus?.endReason, endDetail: lastStatus?.endDetail, localPass: continuous && damage < 0.01 && controlled.every(s => !s.budgetExhausted), endingVerified: stopReason === 'settled_ground' && damage < 0.01
      && samples.filter(s => s.inputOwner === 'flight-recovery').every(s => !s.gliding || !s.safeEmergency), fullCoursePass: false }
    log('summary', summary)
    writeFileSync(new URL(`${tag}-summary.json`, root), `${JSON.stringify(summary, null, 2)}\n`)
    console.info(JSON.stringify(summary))
  }
  finally {
    try {
      if (submittedSession) {
        await call(0, 'flight_revoke', { sessionId: submittedSession })
        await call(0, 'stop_navigation')
        await call(0, 'stop_movement')
        await command('effect give airitest minecraft:resistance 8 5 true')
        // A teleport does not stop an attached boost or gliding momentum.
        // Remove the fixture elytra first; this happens after measurement,
        // never during an accepted passage or a claimed autonomous landing.
        await command('clear airitest minecraft:elytra')
        await sleep(2_000)
        await call(1, 'teleport_player', { player: 'airitest', x: -1006.5, y: 74, z: 79.5 })
        await command('effect give airitest minecraft:instant_health 1 20 true')
        await sleep(2_000)
        await call(1, 'teleport_player', { player: 'airitest', x: -1006.5, y: 74, z: 79.5 })
        await sleep(1_000)
        const self = await call(0, 'get_self')
        log('cleanup_reset', { self, countsAsFlightAcceptance: false })
        if (!self.onGround || self.fallFlying)
          throw new Error('Cleanup did not confirm a grounded bot at the bridge')
      }
    }
    finally {
      await Promise.all(clients.map(client => client.close()))
    }
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
