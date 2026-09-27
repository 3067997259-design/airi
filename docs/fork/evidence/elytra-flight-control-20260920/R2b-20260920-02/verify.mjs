import process from 'node:process'

/**
 * R2b live verification (execution plan §7), rewritten after the 2026-09-20
 * diagnosis (../r2b-diagnosis-20260920-103351/diagnosis.md).
 *
 * Gates this script asserts:
 * - tool responses are checked (isError, accepted, echoed sessionId)
 * - preconditions are measured and reported (health, elytra, rockets, busy task)
 * - applyingStarted flips true and the input owner becomes flight-session
 * - the session ends with a typed reason; a completion lands inside entryReach
 * - rocketFiredThisTick covers real ignitions (launch macro and driver)
 * - an MCP read stall does not stop the client drive or grow trajectoryLost
 * - the script's own session is revoked at the end and the release is confirmed
 * - any failed gate exits non-zero and writes a unique evidence file
 *
 * The channel path is hand-written diagnostics unless R2B_CHANNEL_JSON points
 * to an R1-verified channel file ({ path, entryReach, deadlineMs }). Do not
 * call a hand-written path a verified channel.
 *
 * Run from the AIRI repo root (the evidence dir has a node_modules junction
 * to D:\mcpfabric\mcp-server\node_modules):
 *   node docs/fork/evidence/elytra-flight-control-20260920/R2b-20260920-02/verify.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const CLIENT_URL = process.env.MCPFABRIC_URL ?? 'http://127.0.0.1:25600/mcp'
const SERVER_URL = process.env.MCPFABRIC_SERVER_URL ?? 'http://127.0.0.1:25602/mcp'
const PLAYER = process.env.R2B_PLAYER ?? 'airitest'
const BATCH = process.env.R2B_BATCH ?? new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
const OUT_PATH = process.env.R2B_OUT ?? `r2b-fixed-${BATCH}.json`
const START = { x: -1007, y: 74, z: 79 }
const HARD_TIMEOUT_MS = Number(process.env.R2B_BUDGET_MS ?? 60_000)
const STALL_MS = 3_500
const VERIFIED_CHANNEL = process.env.R2B_CHANNEL_JSON
  ? JSON.parse(readFileSync(process.env.R2B_CHANNEL_JSON, 'utf8'))
  : null
const CHANNEL = VERIFIED_CHANNEL ?? {
  // Hand-written diagnostic path along the river corridor. Sourced from the
  // surface map of probe-surface.mjs (river water surface y=62; banks rise to
  // 70+). Not an R1-verified channel.
  path: [
    { x: -1000, y: 72, z: 40 },
    { x: -992, y: 70, z: -20 },
    { x: -975, y: 68, z: -80 },
    { x: -955, y: 66, z: -115 },
  ],
  entryReach: 12,
  deadlineMs: 60_000,
}

function textOf(result) {
  return (result?.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('')
}

function structured(result) {
  if (result?.isError)
    throw new Error(`tool error: ${textOf(result)}`)
  if (result?.structuredContent && typeof result.structuredContent === 'object')
    return result.structuredContent
  const text = textOf(result)
  return text ? JSON.parse(text) : {}
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function main() {
  const records = []
  const gates = []
  const log = (record) => {
    records.push(record)
    console.info(JSON.stringify(record))
  }
  const gate = (name, ok, detail) => {
    gates.push({ name, ok, detail })
    log({ gate: name, ok, detail })
    return ok
  }

  const client = new Client({ name: 'r2b-verify-fixed', version: '1.1.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(CLIENT_URL)))
  const world = new Client({ name: 'r2b-world', version: '1.1.0' })
  await world.connect(new StreamableHTTPClientTransport(new URL(SERVER_URL)))

  const call = async (name, args = {}) => structured(await client.callTool({ name, arguments: args }))
  const worldCall = async (name, args = {}) => structured(await world.callTool({ name, arguments: args }))

  async function precheck() {
    const equipment = await call('get_equipment')
    const inventory = await call('get_inventory')
    const before = await call('flight_observe')
    const chest = equipment?.chest
    const elytras = [...(inventory?.hotbar ?? []), ...(inventory?.main ?? [])]
      .filter(item => item?.id === 'minecraft:elytra')
    // The worn chest elytra is the operative one; its durability is not
    // readable client-side (recorded limitation). A spare counts only when it
    // has useful headroom.
    const chestElytra = chest?.id === 'minecraft:elytra'
    const usableElytra = chestElytra || elytras.some(item => (item.maxDamage ?? 0) - (item.damage ?? 0) >= 20)
    const rockets = (inventory?.hotbar ?? []).find(item => item?.id === 'minecraft:firework_rocket')?.count ?? 0
    const busy = before?.launch?.state === 'running' || ['ACCEPTED', 'RUNNING'].includes(before?.session?.state)
    log({
      precheck: {
        health: before?.health,
        chest: chest?.id ?? 'empty',
        chestElytra,
        chestDurability: 'unreadable client-side',
        usableSpareElytra: elytras.some(item => (item.maxDamage ?? 0) - (item.damage ?? 0) >= 20),
        rocketsInHotbar: rockets,
        busy,
        launch: before?.launch?.state,
        session: before?.session,
      },
    })
    return { before, chest, usableElytra, rockets, busy }
  }

  async function restore() {
    await worldCall('teleport_player', { player: PLAYER, x: START.x, y: START.y, z: START.z })
    await sleep(1_500)
    await worldCall('run_command', { command: `effect give ${PLAYER} minecraft:instant_health 1 10` })
    await worldCall('run_command', { command: `effect give ${PLAYER} minecraft:regeneration 5 4` })
    await worldCall('run_command', { command: `clear ${PLAYER} minecraft:firework_rocket` })
    await worldCall('run_command', { command: `give ${PLAYER} minecraft:firework_rocket 16` })
    await sleep(1_200)
  }

  const sessionId = `r2b-fixed-${Date.now()}`
  let submitted = null
  let finalStatus = null
  let stallChecked = false
  let stallSamples = 0
  let firedSamples = 0
  const ownerSamples = { 'none': 0, 'launch-macro': 0, 'flight-session': 0 }
  let cursor = 0
  let baselineLost = null
  let maxCursorLag = 0
  let completionDistance = null
  const distanceSeries = []

  try {
    await restore()
    const pre = await precheck()
    gate('precondition-not-busy', !pre.busy, { launch: pre.before?.launch?.state, session: pre.before?.session?.state })
    gate('precondition-health', (pre.before?.health ?? 0) >= 8, { health: pre.before?.health })
    gate('precondition-elytra', pre.usableElytra, { chest: pre.chest })
    gate('precondition-rockets', pre.rockets >= 4, { rockets: pre.rockets })
    if (gates.some(g => !g.ok))
      throw new Error('preconditions failed; refusing to submit')

    submitted = await call('flight_submit', {
      sessionId,
      generation: Number(process.env.R2B_GENERATION ?? 3),
      revision: 1,
      deadlineMs: Date.now() + (CHANNEL.deadlineMs ?? 60_000),
      dimension: 'minecraft:overworld',
      channel: {
        path: CHANNEL.path,
        entryReach: CHANNEL.entryReach ?? 12,
        source: VERIFIED_CHANNEL ? 'r1-verified' : 'hand-written-diagnostic',
      },
    })
    log({ submit: submitted, channelSource: VERIFIED_CHANNEL ? 'r1-verified' : 'hand-written-diagnostic' })
    gate('submit-accepted', submitted?.accepted === true, submitted)
    gate('submit-session-id', submitted?.sessionId === sessionId, { echo: submitted?.sessionId })
    if (!gates.every(g => g.ok))
      throw new Error('submit gates failed')

    const startedAt = Date.now()
    while (Date.now() - startedAt < HARD_TIMEOUT_MS) {
      await sleep(1_000)

      // One poll deliberately stalls MCP reads for ~3.5 s after the driver
      // owns input. The client drive must continue; samples since the cursor
      // prove it. trajectoryLost grows whenever the 600-tick ring wraps, so
      // the gate is the cursor lag, not the raw lost counter.
      if (!stallChecked && ownerSamples['flight-session'] > 0) {
        await sleep(STALL_MS)
        stallChecked = true
      }

      const status = await call('flight_status', { sinceTick: cursor })
      const observation = await call('flight_observe')
      const samples = status?.trajectory ?? []
      for (const sample of samples) {
        cursor = Math.max(cursor, sample.tick ?? 0)
        if (sample.rocketFiredThisTick)
          firedSamples += 1
        const owner = sample.inputOwner ?? 'none'
        ownerSamples[owner] = (ownerSamples[owner] ?? 0) + 1
      }
      maxCursorLag = Math.max(maxCursorLag, (observation?.tick ?? cursor) - cursor)
      if (baselineLost === null)
        baselineLost = status?.trajectoryLost ?? 0
      if (stallChecked && stallSamples === 0) {
        stallSamples = samples.length
        log({ stallCheck: { samplesAfterStall: samples.length, trajectoryLost: status?.trajectoryLost } })
      }

      const self = await call('get_self')
      const last = CHANNEL.path.at(-1)
      const distance = Math.hypot(self.x - last.x, self.z - last.z)
      distanceSeries.push(+distance.toFixed(1))
      log({
        poll: cursor,
        session: observation?.session,
        launch: observation?.launch?.state,
        endReason: status?.endReason,
        applyingStarted: status?.applyingStarted,
        entryReach: status?.entryReach,
        selfPosition: { x: +self.x.toFixed(1), y: +self.y.toFixed(1), z: +self.z.toFixed(1) },
        distanceToGoal: +distance.toFixed(1),
        newSamples: samples.length,
        trajectoryLost: status?.trajectoryLost,
        firedSamples,
        ownerSamples: { ...ownerSamples },
      })

      if (status?.state === 'TERMINATED') {
        finalStatus = status
        completionDistance = distance
        break
      }
    }

    const applied = (finalStatus?.applyingStarted ?? false) || ownerSamples['flight-session'] > 0
    gate('applying-started', applied, ownerSamples)
    gate('driver-owned-input', ownerSamples['flight-session'] > 0, ownerSamples)
    gate('rocket-fires-recorded', firedSamples > 0, { firedSamples })
    gate('stall-kept-flying', stallChecked && stallSamples > 50, { stallChecked, stallSamples, cursor })
    gate('cursor-caught-up', maxCursorLag <= 5, { maxCursorLag, cursor, trajectoryLost: finalStatus?.trajectoryLost })
    gate('session-terminated', Boolean(finalStatus), { state: finalStatus?.state, endReason: finalStatus?.endReason })

    const firstHalf = distanceSeries.slice(0, Math.max(1, Math.floor(distanceSeries.length / 2)))
    const lastHalf = distanceSeries.slice(-Math.max(1, Math.floor(distanceSeries.length / 2)))
    const avg = list => list.reduce((a, b) => a + b, 0) / Math.max(1, list.length)
    gate('approached-goal', avg(lastHalf) < avg(firstHalf), { firstHalf: avg(firstHalf), lastHalf: avg(lastHalf) })
    const landInside = completionDistance !== null && completionDistance <= (CHANNEL.entryReach ?? 12) + 1
    gate('channel-complete', finalStatus?.endReason === 'channel_complete' && landInside, { endReason: finalStatus?.endReason, completionDistance, entryReach: CHANNEL.entryReach })
  }
  catch (error) {
    gate('run-completed', false, { error: String(error) })
  }
  finally {
    // Cleanup only the session this script created, then confirm the release.
    if (submitted?.accepted) {
      try {
        const revoke = await call('flight_revoke', { sessionId })
        await sleep(1_000)
        const after = await call('flight_status', { sinceTick: cursor })
        log({ cleanup: { revoke, after: { state: after?.state, endReason: after?.endReason, applyingStarted: after?.applyingStarted } } })
        gate('cleanup-released', revoke?.revoked === true, revoke)
        gate('cleanup-no-drive', after?.state !== 'RUNNING', { state: after?.state })
      }
      catch (error) {
        gate('cleanup-released', false, { error: String(error) })
      }
    }
    const failed = gates.filter(g => !g.ok)
    const verdict = {
      batch: BATCH,
      channelSource: VERIFIED_CHANNEL ? 'r1-verified' : 'hand-written-diagnostic',
      jarSha256: process.env.R2B_JAR_SHA256 ?? 'unknown',
      records,
      gates,
      pass: failed.length === 0,
      failed: failed.map(g => g.name),
    }
    writeFileSync(OUT_PATH, `${JSON.stringify(verdict, null, 2)}\n`)
    console.info(`verdict: ${verdict.pass ? 'PASS' : 'FAIL'} -> ${OUT_PATH}`)
    await client.close().catch(() => {})
    await world.close().catch(() => {})
    process.exit(verdict.pass ? 0 : 1)
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
