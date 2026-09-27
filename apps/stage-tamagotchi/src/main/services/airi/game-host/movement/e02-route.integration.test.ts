import type { EndingSample } from './ending-stats'
import type { MovementControlPort } from './port'

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { errorMessageFrom } from '@moeru/std'
import { describe, expect, it } from 'vitest'

import { planSpaceRoute } from '../flight/corridor'
import { parseCrossSections, planLowRoute } from '../flight/low-route'
import { FLIGHT_PROFILE_VERSION, resolveFlightPlannerSwitch } from '../flight/profile'
import { runElytraMove } from './elytra'
import { endingStatsOf } from './ending-stats'
import { createMcpMovementPort } from './host-port'
import { shouldOfferNextLeg } from './leg-offer'

/**
 * A stable hash of the legs a record was flown on (D1): two runs are only
 * comparable when their route hash matches.
 */
function routeHashOf(legs: Array<Array<{ x: number, y: number, z: number }>>): string {
  const text = legs.map(leg => leg.map(point => `${point.x.toFixed(3)},${point.y.toFixed(3)},${point.z.toFixed(3)}`).join(';')).join('|')
  let hash = 2166136261
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16)
}

/**
 * Normalizes recorded samples into the ending-stats input shape. Missing
 * fields stay missing: the helper must never read an absent speed or medium as
 * a stopped aircraft (ab-23 repair plan, A4/C4).
 */
function endingSamplesOf(records: Array<Record<string, unknown>>): EndingSample[] {
  return records.map(record => ({
    tick: Number(record.tick),
    ...(typeof record.health === 'number' ? { health: record.health } : {}),
    ...(typeof record.onGround === 'boolean' ? { onGround: record.onGround } : {}),
    ...(typeof record.inWater === 'boolean' ? { inWater: record.inWater } : {}),
    ...(typeof record.gliding === 'boolean' ? { gliding: record.gliding } : {}),
    ...(typeof record.vx === 'number' ? { vx: record.vx } : {}),
    ...(typeof record.vy === 'number' ? { vy: record.vy } : {}),
    ...(typeof record.vz === 'number' ? { vz: record.vz } : {}),
  }))
}

/**
 * Live route runner for the river-canyon fixture (E-02 / E-07 / OV-5 venue).
 *
 * One run = teleport the bot onto the copper bridge deck, fly the whole route
 * with the production elytra mover, and record what happened. It deliberately
 * does NOT assert "reached": the point of an obstacle fixture is to find out
 * whether the mover handles each obstacle, and a typed failure plus its debug
 * trail is the evidence, not a red suite. The only hard assertion is that the
 * harness itself worked (the mover returned, and either flew or gave a reason).
 *
 * Skipped unless `MCPFABRIC_URL` is set.
 *
 * ```powershell
 * $env:MCPFABRIC_URL = 'http://127.0.0.1:25600/mcp'
 * $env:MCPFABRIC_SERVER_URL = 'http://127.0.0.1:25602/mcp'
 * $env:E02_RUNS = '5'
 * $env:E02_OUT = 'D:\airi\docs\fork\evidence\flight-venue-20260918\route-runs.jsonl'
 * pnpm -F @proj-airi/stage-tamagotchi exec vitest run src/main/services/airi/game-host/movement/e02-route.integration.test.ts
 * ```
 *
 * Environment:
 *   E02_START   bridge deck stand point, default `-1007,74,79`
 *   E02_GOAL    cave pad, default `-843,65,-266`
 *   E02_RUNS    how many runs, default 1
 *   E02_BUDGET_MS per-run wall-clock budget, default 150000
 *   E02_OUT     JSONL output path (appended, one line per run)
 */

interface ToolResult { structuredContent?: unknown, content?: Array<{ type: string, text?: string }> }

const liveUrl = process.env.MCPFABRIC_URL
const serverUrl = process.env.MCPFABRIC_SERVER_URL ?? 'http://127.0.0.1:25602/mcp'
const token = process.env.MCPFABRIC_TOKEN
const [startX, startY, startZ] = (process.env.E02_START ?? '-1007,74,79').split(',').map(Number)
const [goalX, goalY, goalZ] = (process.env.E02_GOAL ?? '-843,65,-266').split(',').map(Number)
const runs = Number(process.env.E02_RUNS ?? 1)
const budgetMs = Number(process.env.E02_BUDGET_MS ?? 150_000)
const outPath = process.env.E02_OUT ?? 'e02-route-runs.jsonl'
const acceptanceConfigPath = process.env.E02_CONFIG

/**
 * Frozen acceptance config (R4). Formal mode refuses to run without it: the
 * plan forbids missing values or wide defaults deciding a formal result.
 */
interface AcceptanceConfig {
  schema: string
  dimension: string
  platform: { x: number, y: number, z: number, horizontalTolerance: number, verticalTolerance: number }
  maxTouchdownSpeed: number
  stableGroundMs: number
  minHealth: number
  maxHealthLoss: number
  deadlineMs: number
  minRockets: number
}

function loadAcceptanceConfig(): AcceptanceConfig {
  if (!acceptanceConfigPath)
    throw new Error('formal mode requires E02_CONFIG pointing at the frozen acceptance config')
  const parsed = JSON.parse(readFileSync(acceptanceConfigPath, 'utf8')) as Partial<AcceptanceConfig>
  const platform = parsed.platform
  const numbers = [
    platform?.x,
    platform?.y,
    platform?.z,
    platform?.horizontalTolerance,
    platform?.verticalTolerance,
    parsed.maxTouchdownSpeed,
    parsed.stableGroundMs,
    parsed.minHealth,
    parsed.maxHealthLoss,
    parsed.deadlineMs,
    parsed.minRockets,
  ]
  if (numbers.some(value => typeof value !== 'number' || !Number.isFinite(value)))
    throw new Error(`acceptance config ${acceptanceConfigPath} is missing required numeric fields`)
  if (typeof parsed.schema !== 'string' || typeof parsed.dimension !== 'string')
    throw new Error(`acceptance config ${acceptanceConfigPath} is missing schema/dimension`)
  return parsed as AcceptanceConfig
}

/** Horizontal speed from a `get_self` read; undefined when motion is absent. */
function speedOf(record: Record<string, unknown>): number | undefined {
  const motion = record.motion
  if (!motion || typeof motion !== 'object' || Array.isArray(motion))
    return undefined
  const raw = motion as Record<string, unknown>
  const x = Number(raw.x)
  const z = Number(raw.z)
  return Number.isFinite(x) && Number.isFinite(z) ? Math.hypot(x, z) : undefined
}

function recordOf(result: ToolResult): Record<string, unknown> {
  const structured = result.structuredContent
  if (structured !== null && typeof structured === 'object' && !Array.isArray(structured))
    return structured as Record<string, unknown>
  const text = (result.content ?? [])
    .filter(item => item.type === 'text' && typeof item.text === 'string')
    .map(item => item.text)
    .join('')
  return text.trim() ? JSON.parse(text) as Record<string, unknown> : {}
}

function positionOf(record: Record<string, unknown>): { x: number, y: number, z: number } | undefined {
  const nested = record.position
  const source = nested && typeof nested === 'object' && !Array.isArray(nested)
    ? nested as Record<string, unknown>
    : record
  const x = Number(source.x)
  const y = Number(source.y)
  const z = Number(source.z)
  return Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z) ? { x, y, z } : undefined
}

function rocketCount(inventory: Record<string, unknown>): number {
  let total = 0
  for (const key of ['hotbar', 'main'] as const) {
    const list = Array.isArray(inventory?.[key]) ? inventory[key] as Array<Record<string, unknown>> : []
    for (const item of list) {
      if (typeof item.id === 'string' && item.id.includes('firework_rocket'))
        total += Number(item.count) || 0
    }
  }
  const offhand = inventory?.offhand as Record<string, unknown> | undefined
  if (offhand && typeof offhand.id === 'string' && offhand.id.includes('firework_rocket'))
    total += Number(offhand.count) || 0
  return total
}

/**
 * A/B execution experiment (R4 client review 2026-09-21, section 6).
 *
 * Freezes the route and isolates the failure: the SAME swept river-bend route
 * is flown twice from the same start — once as one full channel and once split
 * into legs joined by handover. If the full delivery also fails, the driver is
 * at fault; if only the segmented run fails, the handover/hold is; only when
 * both pass does the online planner return to the suspect list.
 *
 * The route is used by the experiment only; no production path is special-cased.
 */
async function runRouteAb(input: {
  callTool: (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>
  port: ReturnType<typeof createMcpMovementPort>
  start: { x: number, y: number, z: number }
  goal: { x: number, y: number, z: number }
  outPath: string
  sleep: (ms: number) => Promise<void>
  dimension?: string
}): Promise<void> {
  const budgetMs = Number(process.env.E02_AB_BUDGET_MS ?? 150_000)
  const legSpacing = Number(process.env.E02_AB_LEG_SPACING ?? 24)
  const crossZ = Number(process.env.E02_AB_CROSS_Z ?? 20)
  // The river venue crosses the z=20 section northbound; the aerial-platform
  // lane flies west and crosses an x line instead (E02_AB_CROSS_X).
  const crossX = Number(process.env.E02_AB_CROSS_X ?? Number.NaN)
  const crossAxis: 'x' | 'z' = Number.isFinite(crossX) ? 'x' : 'z'
  const resetToStart = async (): Promise<Record<string, unknown>> => {
    // Revoke the CURRENT session by its id: the client remembers accepted
    // session ids for idempotency, so a stale id would be a no-op and the old
    // session would keep owning the input.
    const status = await input.port.flightStatus!(0).catch(() => undefined)
    if (status?.sessionId)
      await input.port.flightRevoke?.(status.sessionId).catch(() => {})
    // A previous arm can end in death; a corpse cannot launch and its respawn
    // may be far away, which unloads the venue chunks and starves the reads.
    const before = await input.callTool('get_self', {}).catch(() => ({})) as Record<string, unknown>
    if (typeof before.health === 'number' && before.health <= 0)
      await input.callTool('respawn', {}).catch(() => {})
    // Resistance first: a mid-air arm ending leaves the bot falling, and the
    // teleport would otherwise slam it into the bridge (ab-05 segmented arm
    // died on landing with health 0).
    await input.callTool('run_command', { command: 'effect give airitest minecraft:resistance 5 5 true' })
    // A long flight wears the elytra to 1 durability, and a nearly-broken
    // elytra fails to deploy (`launch_not_deployed`, ab-14). Refresh it:
    // clear removes the worn one from the armor slot too, then give a new one
    // (the launch macro equips from the inventory). `item replace` returned
    // success=false on this server, so it is not used.
    await input.callTool('run_command', { command: 'clear airitest minecraft:elytra' })
    await input.callTool('run_command', { command: 'give airitest minecraft:elytra 1' })
    await input.callTool('teleport_player', { player: 'airitest', ...input.start })
    // The reflex controller preempts navigation on low air (water) or hunger,
    // and a preemption kills the launch before it starts (ab-04:
    // `launch_reflex_preempted` on both arms). Restore both and let the air
    // supply refill before submitting.
    await input.callTool('run_command', { command: 'effect give airitest minecraft:instant_health 1 20 true' })
    await input.callTool('run_command', { command: 'effect give airitest minecraft:saturation 5 10 true' })
    await input.callTool('run_command', { command: 'give airitest minecraft:firework_rocket 64' })
    await input.sleep(6_000)
    // The next arm must start grounded; a still-falling bot would take fall
    // damage and could not launch.
    for (let attempt = 0; attempt < 10; attempt++) {
      const self = await input.callTool('get_self', {})
      if (self.onGround === true)
        return self
      await input.sleep(1_000)
    }
    return await input.callTool('get_self', {})
  }

  // The route must be planned with the venue loaded: a bot that died in a
  // previous run respawns far away, and the bridge chunks would be unloaded.
  // The reset also clears the reflex triggers before the launch.
  await resetToStart()
  const routeFile = process.env.E02_AB_ROUTE_FILE
  let route: Array<{ x: number, y: number, z: number }>
  if (routeFile) {
    const saved = JSON.parse(readFileSync(routeFile, 'utf8')) as { points: Array<{ x: number, y: number, z: number }> }
    route = saved.points
  }
  else {
    // Chain bounded local plans so the frozen route actually crosses the
    // agreed section AND finishes past it: the completion radius is
    // `entryReach` (8), so a terminal at z=19.5 could complete at z~27 and
    // never test the crossing (R4 client review 2026-09-21). The route must
    // end at least one completion radius beyond the section.
    const crossZForRoute = Number(process.env.E02_AB_CROSS_Z ?? 20)
    const entryReach = 8
    const requiredEndZ = crossZForRoute - entryReach - 2
    const maxPlans = Number(process.env.E02_AB_ROUTE_PLANS ?? 5)
    const chained: Array<{ x: number, y: number, z: number }> = []
    // Diagnostic must-pass openings (ab-30 plan §1): the A/B control arm leaves
    // E02_MUST_PASS unset, the constrained arm names the slab passage, and the
    // frozen route must actually cross it or the plan refuses with a reason.
    const mustPass = parseCrossSections(process.env.E02_MUST_PASS)
    // A section is a hard constraint for the leg that must fly it, not for the
    // legs still crossing the canyon: applying it to a leg that cannot reach the
    // plane would refuse that leg for the wrong reason (ab-30 plan §2 read
    // ahead). One leg spans ~96 blocks, so 110 blocks is "this leg must do it".
    const sectionAxis = mustPass[0]?.axis
    const sectionAt = mustPass[0]?.at
    const sectionWithinReach = (point: { x: number, z: number }): boolean => {
      if (sectionAxis === undefined || sectionAt === undefined)
        return false
      const value = sectionAxis === 'x' ? point.x : point.z
      return Math.abs(value - sectionAt) <= 110
    }
    let from = input.start
    for (let index = 0; index < maxPlans; index++) {
      const plan = await planLowRoute({
        port: input.port,
        self: from,
        goal: input.goal,
        searchTimeCapMs: 6_000,
        ...(mustPass.length > 0 && sectionWithinReach(from) ? { mustPass } : {}),
      })
      if (plan.status !== 'planned' || !plan.channelPath || plan.channelPath.length < 2)
        throw new Error(`route-ab could not freeze a route (leg ${index}): ${plan.status}${plan.reason ? ` (${plan.reason})` : ''}`)
      const points = index === 0 ? plan.channelPath : plan.channelPath.slice(1)
      chained.push(...points.map(point => ({ ...point })))
      from = plan.channelPath.at(-1)!
      if (from.z <= requiredEndZ)
        break
    }
    if (from.z > requiredEndZ)
      throw new Error(`route-ab route still ends at z=${from.z.toFixed(1)} (needs <= ${requiredEndZ.toFixed(1)}) after ${maxPlans} verified legs`)
    route = chained
  }

  const splitLegs = (points: Array<{ x: number, y: number, z: number }>): Array<Array<{ x: number, y: number, z: number }>> => {
    const legs: Array<Array<{ x: number, y: number, z: number }>> = []
    let current: Array<{ x: number, y: number, z: number }> = [points[0]!]
    let walked = 0
    for (let index = 1; index < points.length; index++) {
      const previous = points[index - 1]!
      const point = points[index]!
      walked += Math.hypot(point.x - previous.x, point.y - previous.y, point.z - previous.z)
      current.push(point)
      if (walked >= legSpacing) {
        legs.push(current)
        current = [point]
        walked = 0
      }
    }
    if (current.length >= 2)
      legs.push(current)
    return legs
  }

  /**
   * Group 4 leg-boundary sweep: the FIRST handover happens at the frozen route
   * point nearest `boundaryZ`, the rest keeps the normal spacing. That places
   * the handover before/at/after the first river bend with the same route.
   */
  const splitLegsAtBoundary = (
    points: Array<{ x: number, y: number, z: number }>,
    boundaryZ: number,
  ): Array<Array<{ x: number, y: number, z: number }>> => {
    let cut = points.findIndex(point => point.z <= boundaryZ)
    if (cut < 1)
      cut = 1
    const first = points.slice(0, cut + 1)
    const rest = points.slice(cut)
    return [first, ...splitLegs(rest)]
  }

  const runArm = async (arm: 'full' | 'segmented') => {
    const startState = await resetToStart()
    const boundaryZ = Number(process.env.E02_AB_LEG_BOUNDARY_Z ?? Number.NaN)
    const legs = arm === 'full'
      ? [route]
      : Number.isFinite(boundaryZ) ? splitLegsAtBoundary(route, boundaryZ) : splitLegs(route)
    const deadlineMs = Date.now() + budgetMs
    // Group 3 timing perturbations (R4 client review): how the next leg is
    // offered relative to the current one.
    const segmentMode = process.env.E02_AB_SEGMENT_MODE ?? 'default'
    const lateMs = Number(process.env.E02_AB_LATE_MS ?? 3_000)
    // Group 3 late-join: the next leg must connect from the ACTUAL position
    // (production prefetch plans from the frontier the glider approaches). A
    // fixed pre-split leg has its entry far behind after a long hold and the
    // client refuses it with `handover_entry_far` (lane-pert-late-2) — honest,
    // but not the positive late case this mode demonstrates.
    const reanchor = process.env.E02_AB_REANCHOR === 'true'
    const reanchorMinX = Number(process.env.E02_AB_REANCHOR_MIN_X ?? Number.NaN)
    const laneLegFrom = (from: { x: number, y: number, z: number }, lengthBlocks: number) => {
      // The re-anchored leg stays inside the verified lane: without a bound a
      // long run flies past the scanned clear box and hits natural terrain
      // (lane-pert-late-3 ended at x~-357 with a collision).
      const cappedLength = Number.isFinite(reanchorMinX)
        ? Math.min(lengthBlocks, Math.max(20, from.x - reanchorMinX))
        : lengthBlocks
      const steps = Math.max(2, Math.round(cappedLength / 40) + 1)
      const points = [{ ...from }]
      for (let index = 1; index < steps; index++) {
        const t = index / (steps - 1)
        points.push({
          x: from.x - cappedLength * t,
          y: from.y - 4 * t,
          z: from.z,
        })
      }
      return points
    }
    const runTag = `${Date.now().toString(36)}-${arm}`
    const controlSessionId = `e02-ab-ctl-${runTag}`
    // Session ids AND the control-session id are unique per run: the client
    // remembers both (idempotency memory and control ownership), so a replayed
    // run is refused as a stale control session.
    let submissions = 0
    let legIndex = 0
    let lastSubmitAt = Date.now()
    let holdingSince: number | undefined
    let duplicateSent = false
    let lastEndReason: string | undefined
    let crossing: Record<string, unknown> | undefined
    // Prime the cursor with the client's CURRENT tick and discard that batch:
    // the ring still holds the previous arm's records, and starting from 0
    // replays them into this arm (the exact trap the R4 review item 1 found in
    // the run harness).
    let cursor = 0
    {
      const priming = await input.port.flightStatus!(0).catch(() => undefined)
      for (const sample of priming?.trajectory ?? []) {
        if (sample.tick > cursor)
          cursor = sample.tick
      }
    }
    const trail: string[] = []
    const samples: Array<Record<string, unknown>> = []
    // The FIRST route failure is frozen here and never reset by later states,
    // revisions or a recovery session (ab-23 repair plan, batch A1). From that
    // tick on the arm is in its ending phase: it keeps recording the same
    // telemetry schema and stops submitting ordinary next legs.
    let routeFailed: { tick: number, state: string, endReason?: string, detail?: string, sessionId?: string, revision?: number } | undefined
    /** D3: ordinary next legs offered after the first route failure (must be 0). */
    let submissionsAfterFailure = 0
    /** D1: the client build observed on the status reads. */
    let clientBuild: string | undefined
    /** Whether the last recovery frame passed the full 3D verification. */
    let recoveryFrameVerified: boolean | undefined
    let recoveryCrossing: Record<string, unknown> | undefined
    /** The previous sample's coordinate on the crossing axis (event detection). */
    let previousAxisValue: number | undefined
    const crossLine = crossAxis === 'x' ? crossX : crossZ
    const seenTicks = new Set<number>()
    /**
     * One sampler for the whole arm, including the ending phase: the same
     * schema is recorded before and after the failure (A1), duplicates are
     * dropped, and the crossing detector runs for every sample.
     */
    const pushSample = (sample: Record<string, unknown>, extra?: Record<string, unknown>) => {
      const tick = Number(sample.tick)
      if (!Number.isFinite(tick) || seenTicks.has(tick))
        return
      seenTicks.add(tick)
      if (tick > cursor)
        cursor = tick
      samples.push({ ...sample, ...extra })
      // A crossing is a GEOMETRIC event first (previous > line, current <=
      // line), then classified by the owner at the event (ab-24 audit section
      // 6.2): "owner=recovery while already past the line" is not a crossing.
      const axisValue = crossAxis === 'x' ? Number(sample.x) : Number(sample.z)
      const crossedForward = previousAxisValue !== undefined && previousAxisValue > crossLine && axisValue <= crossLine
      previousAxisValue = axisValue
      if (crossedForward && sample.inputOwner === 'flight-recovery') {
        if (!recoveryCrossing) {
          recoveryCrossing = {
            tick,
            axis: crossAxis,
            line: crossLine,
            position: { x: sample.x, y: sample.y, z: sample.z },
            horizontalSpeed: Math.hypot(Number(sample.vx), Number(sample.vz)),
            gliding: sample.gliding,
          }
          trail.push(`arm=${arm} recovery crossed ${crossAxis}<=${crossLine} at tick ${tick}`)
        }
      }
      else if (crossedForward && !crossing) {
        crossing = {
          tick,
          axis: crossAxis,
          line: crossLine,
          position: { x: sample.x, y: sample.y, z: sample.z },
          horizontalSpeed: Math.hypot(Number(sample.vx), Number(sample.vz)),
          verticalSpeed: sample.vy,
          yaw: sample.yaw,
          pitch: sample.pitch,
          boostRemaining: sample.boostRemainingEstimate,
          inWater: sample.inWater,
          gliding: sample.gliding,
          inputOwner: sample.inputOwner,
          revision: sample.revision,
          // The acceptance needs a CONTROLLED forward crossing inside the
          // river band, not just a sample past the line (R4 client review 3).
          controlled: sample.inputOwner === 'flight-session' && sample.gliding === true && sample.inWater !== true,
          inRiverBand: Number(sample.x) >= Number(process.env.E02_RIVER_X0 ?? -1006) && Number(sample.x) <= Number(process.env.E02_RIVER_X1 ?? -994),
        }
        trail.push(`arm=${arm} crossed ${crossAxis}<=${crossLine} at tick ${tick} speed=${Math.hypot(Number(sample.vx), Number(sample.vz)).toFixed(3)} inWater=${sample.inWater} owner=${sample.inputOwner}`)
      }
    }

    const postEndBudgetMs = Number(process.env.E02_AB_END_MS ?? 10_000)
    let routeFailedAtMs = 0

    const submitLeg = async (path: Array<{ x: number, y: number, z: number }>) => {
      submissions += 1
      const receipt = await input.port.flightSubmit!({
        sessionId: `e02-ab-${runTag}-${submissions}`,
        generation: 1,
        revision: submissions,
        deadlineMs,
        ...(input.dimension ? { dimension: input.dimension } : {}),
        controlSessionId,
        channel: { path, entryReach: 8 },
      })
      trail.push(`arm=${arm} submit#${submissions} accepted=${receipt.accepted}${receipt.reason ? ` reason=${receipt.reason}` : ''}`)
      return receipt.accepted
    }

    if (!await submitLeg(legs[0]!)) {
      return await finishArm({ arm, startState, legs, submissions, lastEndReason: 'submit_refused', crossing, recoveryCrossing, trail, samples })
    }
    legIndex = 1

    const startedAt = Date.now()
    for (;;) {
      if (Date.now() - startedAt > budgetMs + 10_000) {
        lastEndReason = 'host_budget'
        await input.port.flightRevoke?.(`e02-ab-${runTag}-${submissions}`).catch(() => {})
        break
      }
      const status = await input.port.flightStatus!(cursor).catch(() => undefined)
      if (!status) {
        await input.sleep(500)
        continue
      }
      // D1: the build lives on the status read, not on every sample.
      if (typeof status.build === 'string' && status.build !== '')
        clientBuild = status.build
      if (status.recoveryFrameVerified === true)
        recoveryFrameVerified = true
      for (const sample of status.trajectory) {
        pushSample({
          tick: sample.tick,
          x: sample.x,
          y: sample.y,
          z: sample.z,
          vx: sample.vx,
          vy: sample.vy,
          vz: sample.vz,
          yaw: sample.yaw,
          pitch: sample.pitch,
          boostRemaining: sample.boostRemainingEstimate,
          rocketFiredThisTick: sample.rocketFiredThisTick,
          inWater: sample.inWater,
          gliding: sample.gliding,
          onGround: sample.onGround,
          inputOwner: sample.inputOwner,
          // The client reports recovery-frame verification per status read, not
          // per sample: the samples of one read share it. Without this the
          // universal gate read a field that never exists (ab-30: 205 missing).
          recoveryFrameVerified: status.recoveryFrameVerified === true,
          sessionId: sample.sessionId,
          revision: sample.revision,
          holding: sample.holding,
          rocketsInHands: sample.rocketsInHands,
          rocketsInInventory: sample.rocketsInInventory,
          health: sample.health,
          // Decision telemetry the ab-17 audit asked for (section 6): the
          // per-tick cursor/target, the winning prediction's end and the first
          // rejection, so a live record can explain each tick without the
          // client console.
          cursor: sample.cursor,
          targetX: sample.targetX,
          targetY: sample.targetY,
          targetZ: sample.targetZ,
          predictedEndTicks: sample.predictedEndTicks,
          predictedEndCursor: sample.predictedEndCursor,
          predictedEndReason: sample.predictedEndReason,
          preview: sample.preview,
          terminalAction: sample.terminalAction,
          rejectKind: sample.rejectKind,
          rejectTick: sample.rejectTick,
          rejectBlock: sample.rejectBlock,
          rejectShape: sample.rejectShape,
          rejectCollisions: sample.rejectCollisions,
          rejectFloor: sample.rejectFloor,
          rejectSpeed: sample.rejectSpeed,
          rejectTerminal: sample.rejectTerminal,
          boostCount: sample.boostCount,
          boostEntityIds: sample.boostEntityIds,
          pendingSessionId: sample.pendingSessionId,
          wallMs: sample.wallMs,
          nanoMs: sample.nanoMs,
          // D1 evidence schema: phase/outcome/progress/policy/cost/cooldown.
          controlPhase: sample.controlPhase,
          routeOutcome: sample.routeOutcome,
          progress: sample.progress,
          predictedEndProgress: sample.predictedEndProgress,
          chosenPolicy: sample.chosenPolicy,
          evaluated: sample.evaluated,
          feasible: sample.feasible,
          budgetExhausted: sample.budgetExhausted,
          searchCompleted: sample.searchCompleted,
          physicsSteps: sample.physicsSteps,
          blockQueries: sample.blockQueries,
          cacheHits: sample.cacheHits,
          simMs: sample.simMs,
          cooldownActive: sample.cooldownActive,
          transitionReason: sample.transitionReason,
          safeCandidates: sample.safeCandidates,
          safeVerified: sample.safeVerified,
          safeEmergency: sample.safeEmergency,
          safeContactTicks: sample.safeContactTicks,
        })
      }
      // Terminal states come before any next-leg decision (A1): the first
      // failure is frozen and the arm moves to ending observation.
      if (!routeFailed && (status.state === 'terminated' || status.state === 'revoked')) {
        routeFailed = {
          tick: cursor,
          state: status.state,
          ...(status.endReason ? { endReason: status.endReason } : {}),
          ...(status.endDetail ? { detail: status.endDetail } : {}),
        }
        routeFailedAtMs = Date.now()
        lastEndReason = status.endReason ?? status.state
        trail.push(`arm=${arm} ended: ${lastEndReason}${status.endDetail ? ` detail=${status.endDetail}` : ''}`)
      }
      // Ending observation: keep reading the same telemetry until the ending
      // is stable (20 settled ticks) or the post-end budget expires. No
      // ordinary next leg is submitted once the route failed (A1).
      if (routeFailed) {
        const endStats = endingStatsOf(endingSamplesOf(samples))
        if (endStats.stableSettled || Date.now() - routeFailedAtMs > postEndBudgetMs) {
          trail.push(`arm=${arm} post-end stableTicks=${endStats.stableTicks} observedDamage=${endStats.endingObservedDamage.toFixed(3)}`)
          break
        }
        await input.sleep(250)
        continue
      }
      // Segmented arm: how the next leg is offered (group 3 perturbations).
      //   default   - as soon as the client holds or stops running
      //   early     - immediately, while the current leg still flies
      //   late      - E02_AB_LATE_MS after the hold began
      //   timeout   - never (the hold must expire into a typed failure)
      //   duplicate - offered twice with the same id/revision
      if (arm === 'segmented' && legIndex < legs.length) {
        const nowMs = Date.now()
        if (status.holding === true && holdingSince === undefined)
          holdingSince = nowMs
        // One decision point for offering the next leg (A1/A5): terminal-first
        // and the frozen route failure refuse the offer.
        const offer = shouldOfferNextLeg({
          routeFailed: routeFailed !== undefined,
          state: status.state,
          ...(status.holding !== undefined ? { holding: status.holding } : {}),
          hasNextLeg: legIndex < legs.length,
          segmentMode,
          sinceSubmitMs: nowMs - lastSubmitAt,
          ...(holdingSince !== undefined ? { heldForMs: nowMs - holdingSince } : {}),
          lateMs,
        })
        if (offer.offer) {
          if (routeFailed)
            submissionsAfterFailure += 1
          if (segmentMode === 'duplicate' && !duplicateSent) {
            duplicateSent = true
            // The SAME id and revision again: the client must answer with the
            // remembered receipt and must not take the route over twice.
            const replay = await input.port.flightSubmit!({
              sessionId: `e02-ab-${runTag}-${submissions}`,
              generation: 1,
              revision: submissions,
              deadlineMs,
              ...(input.dimension ? { dimension: input.dimension } : {}),
              controlSessionId,
              channel: { path: legs[legIndex - 1]!, entryReach: 8 },
            })
            trail.push(`arm=${arm} duplicate submit accepted=${replay.accepted}${replay.reason ? ` reason=${replay.reason}` : ''}`)
          }
          else {
            // Re-anchored legs connect from the measured position (the lane
            // case); the default uses the frozen pre-split legs.
            const last = samples.at(-1) as { x: number, y: number, z: number } | undefined
            const nextLeg = reanchor && last && legIndex >= 1
              ? laneLegFrom({ x: last.x, y: last.y, z: last.z }, 60)
              : legs[legIndex]!
            if (await submitLeg(nextLeg)) {
              legIndex += 1
              lastSubmitAt = nowMs
              holdingSince = undefined
            }
            else {
              trail.push(`arm=${arm} handover submit refused at leg ${legIndex}`)
            }
          }
        }
      }
      await input.sleep(500)
    }

    return await finishArm({ arm, startState, legs, submissions, lastEndReason, crossing, recoveryCrossing, submissionsAfterFailure, clientBuild, recoveryFrameVerified, hardDeadlineMs: deadlineMs, trail, samples, routeFailedTick: routeFailed?.tick })
  }

  async function finishArm(arm: {
    arm: string
    startState: Record<string, unknown>
    legs: Array<Array<{ x: number, y: number, z: number }>>
    submissions: number
    lastEndReason: string | undefined
    crossing: Record<string, unknown> | undefined
    recoveryCrossing?: Record<string, unknown>
    submissionsAfterFailure?: number
    clientBuild?: string
    recoveryFrameVerified?: boolean
    hardDeadlineMs?: number
    routeFailedTick?: number
    trail: string[]
    samples: Array<Record<string, unknown>>
  }) {
    const after = await input.callTool('get_self', {}).catch(() => ({})) as Record<string, unknown>
    // Ending facts come from the recorded samples with the A4 rules: cumulative
    // drops (regeneration must not erase an event), native-tick continuity and
    // stable-end runs. The ending starts at the first route failure.
    const endingRecords = typeof arm.routeFailedTick === 'number'
      ? arm.samples.filter(sample => Number(sample.tick) >= arm.routeFailedTick!)
      : arm.samples
    const endStats = endingStatsOf(endingSamplesOf(endingRecords))
    const ending = endStats.settledGround
      ? 'settled_ground'
      : endStats.settledWater
        ? 'stable_water'
        : endStats.stableSettled
          ? 'settled'
          : endStats.unresolvedAirborne ? 'airborne' : 'unknown'
    // The session-end health is the first sample after the last 'flight-session'
    // owner tick; the drop to the final health is kept for comparison, but the
    // authoritative damage is the cumulative observed drop (A4).
    const lastDriven = [...arm.samples].reverse().find(sample => sample.inputOwner === 'flight-session')
    const endHealth = typeof lastDriven?.health === 'number' ? lastDriven.health as number : undefined
    const finalHealth = typeof arm.samples.at(-1)?.health === 'number' ? arm.samples.at(-1)!.health as number : undefined
    const damageDuringEnding = endHealth !== undefined && finalHealth !== undefined
      ? Math.max(0, endHealth - finalHealth)
      : undefined
    const residualSpeed = (() => {
      const last = arm.samples.at(-1)
      if (!last)
        return undefined
      if (typeof last.vx !== 'number' || typeof last.vz !== 'number')
        return undefined
      return Math.hypot(last.vx, last.vz)
    })()
    // D3 staged-release gates: each is an independent fact so the operator can
    // decide whether a diagnostic pair is clean before three repeats. A gate is
    // never inferred from a neighbouring one.
    const drivenSamples = arm.samples.filter(sample => sample.inputOwner === 'flight-session')
    const budgetExhaustedTicks = drivenSamples.filter(sample => sample.budgetExhausted === true).length
    // The wall clock of the last sample of the stable run (the settling time).
    const settledAtWallMs = (() => {
      const tail = arm.samples.slice(-Math.max(1, endStats.stableTicks))
      const last = tail.at(-1)
      return typeof last?.wallMs === 'number' ? last.wallMs : undefined
    })()
    // Recovery-owned airborne ticks with NO input owner and no glide: a phase
    // claim without an action is reported, not counted as controlled (audit 6.5).
    const uncontrolledAirborneTicks = arm.samples.filter(sample =>
      sample.controlPhase === 'RECOVER'
      && sample.inputOwner === 'none'
      && sample.onGround !== true
      && sample.inWater !== true
      && sample.gliding !== true,
    ).length
    // ab-29 review: the statistic above missed still-GLIDING no-input ticks.
    // Every airborne sample without an owner is uncontrolled, gliding or not.
    const airborneNoInputTicks = arm.samples.filter(sample =>
      sample.inputOwner === 'none'
      && sample.onGround !== true
      && sample.inWater !== true,
    ).length
    // The recovery verification is a UNIVERSAL claim over the executed
    // recovery ticks, with the field present: one observed pass is not proof.
    const recoveryAirborne = arm.samples.filter(sample =>
      sample.inputOwner === 'flight-recovery'
      && sample.onGround !== true
      && sample.inWater !== true,
    )
    const recoveryVerifiedEveryTick = recoveryAirborne.length > 0
      && recoveryAirborne.every(sample => sample.recoveryFrameVerified === true)
    const recoveryVerifiedMissing = recoveryAirborne.filter(sample => sample.recoveryFrameVerified === undefined).length
    // The river-band crossing uses the interpolated position at the line, not
    // the discrete sample coordinate (ab-29 review).
    const crossingInBand = (() => {
      const crossLine = crossAxis === 'x' ? crossX : crossZ
      const index = arm.samples.findIndex(sample => sample.tick === arm.crossing?.tick)
      if (index <= 0)
        return false
      const previous = arm.samples[index - 1]
      const current = arm.samples[index]
      if (previous.inputOwner !== current.inputOwner)
        return false
      const span = Number(previous.z) - Number(current.z)
      if (Math.abs(span) < 1.0e-6)
        return false
      const t = (Number(previous.z) - crossLine) / span
      const xAtLine = Number(previous.x) + (Number(current.x) - Number(previous.x)) * t
      return xAtLine >= Number(process.env.E02_RIVER_X0 ?? -1006) && xAtLine <= Number(process.env.E02_RIVER_X1 ?? -994)
    })()
    const minHealth = arm.samples.reduce<number | undefined>((min, sample) => {
      const health = typeof sample.health === 'number' ? sample.health : undefined
      if (health === undefined)
        return min
      return min === undefined ? health : Math.min(min, health)
    }, undefined)
    const gates = {
      // 1. A controlled forward crossing of the acceptance line.
      controlledRouteCrossing: arm.crossing?.controlled === true,
      // 1b. The river-band section rule is its own gate: a controlled crossing
      //     outside the band does not satisfy it (ab-24 audit section 6.1).
      riverBandCrossing: crossingInBand,
      // 2. Search completeness and verified winners are separate facts, and
      //    the recovery trajectory has its own verification (audit 6.3).
      searchCompleted: drivenSamples.length > 0 && drivenSamples.every(sample => sample.searchCompleted === true),
      chosenTrajectoryVerified: drivenSamples.length > 0 && drivenSamples.every(sample => Number(sample.feasible) >= 1),
      recoveryTrajectoryVerified: recoveryVerifiedEveryTick,
      recoveryVerifiedMissing,
      airborneNoInputTicks,
      budgetExhaustedTicks,
      // 3. No ordinary next leg after the frozen route failure.
      noAutoSubmitAfterFailure: (arm.submissionsAfterFailure ?? 0) === 0,
      submissionsAfterFailure: arm.submissionsAfterFailure ?? 0,
      // 4. A stable end BEFORE the hard deadline, with the clocks recorded.
      settledBeforeDeadline: endStats.stableSettled && settledAtWallMs !== undefined && arm.hardDeadlineMs !== undefined && settledAtWallMs <= arm.hardDeadlineMs,
      settledAtWallMs,
      hardDeadlineMs: arm.hardDeadlineMs,
      // 5. Damage-free needs a COMPLETE observation and no visible drop, for
      //    the whole flight and the ending separately (audit 6.4).
      flightDamageFree: minHealth === undefined ? undefined : minHealth >= 20 - 0.0001,
      endingDamageFree: endStats.fullyObserved && endStats.damageEvents.length === 0,
      minHealth,
      // 6. Route and recovery crossings are separate facts.
      routeCrossing: arm.crossing !== undefined,
      recoveryCrossing: arm.recoveryCrossing !== undefined,
      // 7. Uncontrolled airborne ticks (recovery phase with no input owner and
      //    no glide) are reported, not hidden (audit 6.5).
      noUncontrolledAirborne: uncontrolledAirborneTicks === 0,
      uncontrolledAirborneTicks,
    }
    return {
      arm: arm.arm,
      startState: {
        x: arm.startState.x,
        y: arm.startState.y,
        z: arm.startState.z,
        health: arm.startState.health,
      },
      legs: arm.legs.length,
      // The full replay material: every leg's exact points (R4 client review
      // item 2: the old record saved only the count and endpoints).
      legPaths: arm.legs.map(leg => leg.map(point => ({ ...point }))),
      // D1: the route hash and the client build tie a record to its inputs.
      routeHash: routeHashOf(arm.legs),
      ...(typeof arm.clientBuild === 'string' ? { clientBuild: arm.clientBuild } : {}),
      submissions: arm.submissions,
      lastEndReason: arm.lastEndReason,
      crossed: arm.crossing !== undefined,
      crossing: arm.crossing,
      recoveryCrossing: arm.recoveryCrossing,
      gates,
      ending,
      endingStats: endStats,
      finalState: {
        x: after.x,
        y: after.y,
        z: after.z,
        health: after.health,
        onGround: after.onGround,
        inWater: after.inWater,
      },
      endHealth,
      finalHealth,
      damageDuringEnding,
      residualSpeed,
      trail: arm.trail,
      samples: arm.samples,
    }
  }

  const armSelection = (process.env.E02_AB_ARMS ?? 'full,segmented').split(',').map(name => name.trim())
  const arms = []
  for (const name of armSelection) {
    if (name === 'full' || name === 'segmented')
      arms.push(await runArm(name))
  }
  appendFileSync(input.outPath, `${JSON.stringify({
    schema: 'e02-route-ab/v1',
    at: new Date().toISOString(),
    route: { points: route.length, first: route[0], last: route.at(-1) },
    // Full frozen route: the A/B only means something if the exact geometry
    // can be replayed offline (R4 client review item 2).
    routePoints: route.map(point => ({ ...point })),
    crossZ,
    legSpacing,
    arms,
  })}\n`)
  console.info(`[e02] route-ab: ${JSON.stringify(arms.map(arm => ({ arm: arm.arm, legs: arm.legs, submissions: arm.submissions, crossed: arm.crossed, end: arm.lastEndReason, ending: arm.ending })))}`)
}

/** Parses `E02_SNAPSHOT` (x0,y0,z0,x1,y1,z1) or returns the canyon default. */function snapshotBox(): { x0: number, y0: number, z0: number, x1: number, y1: number, z1: number } {
  const raw = process.env.E02_SNAPSHOT
  if (raw) {
    const parts = raw.split(',').map(Number)
    if (parts.length === 6 && parts.every(Number.isFinite))
      return { x0: parts[0]!, y0: parts[1]!, z0: parts[2]!, x1: parts[3]!, y1: parts[4]!, z1: parts[5]! }
  }
  return { x0: -1015, y0: 55, z0: 0, x1: -975, y1: 95, z1: 90 }
}

/**
 * Coverage analysis (R4 review 2026-09-20, item 1).
 *
 * Reads ONE terrain snapshot of the early canyon and compares planner windows
 * over it, so the live run's failure can be attributed to either "the river
 * bypass was never read" or "it was read and the planner chose the bank". It
 * also runs the raw space search over the full snapshot to prove whether a
 * river route exists at all. Output is a single JSON report; the snapshot
 * itself is written next to it for offline replays.
 */
async function runCoverageAnalysis(input: {
  callTool: (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>
  start: { x: number, y: number, z: number }
  goal: { x: number, y: number, z: number }
  outPath: string
  dimension?: string
}): Promise<void> {
  const box = snapshotBox()
  const cells = new Map<string, string>()
  let reads = 0
  const snapshotFile = process.env.E02_SNAPSHOT_FILE
  if (snapshotFile) {
    // Offline replay: compare selection changes on the exact terrain an
    // earlier live read captured, without touching the game.
    const snapshot = JSON.parse(readFileSync(snapshotFile, 'utf8')) as {
      box?: { x0: number, y0: number, z0: number, x1: number, y1: number, z1: number }
      cells?: Array<[string, string]>
    }
    for (const [key, id] of snapshot.cells ?? [])
      cells.set(key, id)
    if (snapshot.box)
      Object.assign(box, snapshot.box)
  }
  else {
    const footprint = (box.x1 - box.x0 + 1) * (box.z1 - box.z0 + 1)
    const bandLayers = Math.max(1, Math.floor(30_000 / footprint))
    for (let y = box.y0; y <= box.y1; y += bandLayers) {
      const bandY1 = Math.min(box.y1, y + bandLayers - 1)
      const record = await input.callTool('get_blocks_region', {
        from: { x: box.x0, y, z: box.z0 },
        to: { x: box.x1, y: bandY1, z: box.z1 },
        includeAir: true,
        ...(input.dimension ? { dimension: input.dimension } : {}),
      })
      reads += 1
      const blocks = Array.isArray(record.blocks) ? record.blocks as Array<Record<string, unknown>> : []
      for (const block of blocks) {
        const x = Number(block.x)
        const yy = Number(block.y)
        const z = Number(block.z)
        const id = typeof block.id === 'string' ? block.id : ''
        if (Number.isFinite(x) && Number.isFinite(yy) && Number.isFinite(z))
          cells.set(`${x},${yy},${z}`, id)
      }
    }
  }

  // An in-memory port over the snapshot: the real planner runs unchanged, it
  // just reads a frozen world instead of the live one.
  const port = {
    async getBlocksRegion(from: { x: number, y: number, z: number }, to: { x: number, y: number, z: number }) {
      const entries: Array<{ x: number, y: number, z: number, id: string }> = []
      for (let x = from.x; x <= to.x; x++) {
        for (let z = from.z; z <= to.z; z++) {
          for (let y = from.y; y <= to.y; y++) {
            const id = cells.get(`${x},${y},${z}`)
            if (id !== undefined)
              entries.push({ x, y, z, id })
          }
        }
      }
      return entries
    },
  } as unknown as MovementControlPort

  const riverMinX = Number(process.env.E02_RIVER_X0 ?? -1006)
  const riverMaxX = Number(process.env.E02_RIVER_X1 ?? -994)
  const summarize = (path: Array<{ x: number, y: number, z: number }> | undefined) => {
    if (!path || path.length === 0)
      return undefined
    let maxClimbSlope = 0
    let minY = Number.POSITIVE_INFINITY
    let maxY = Number.NEGATIVE_INFINITY
    let riverPoints = 0
    for (let index = 0; index < path.length; index++) {
      const point = path[index]!
      minY = Math.min(minY, point.y)
      maxY = Math.max(maxY, point.y)
      if (point.x >= riverMinX && point.x <= riverMaxX)
        riverPoints += 1
      if (index === 0)
        continue
      const previous = path[index - 1]!
      const horizontal = Math.hypot(point.x - previous.x, point.z - previous.z)
      const climb = point.y - previous.y
      if (horizontal > 0.01 && climb > 0)
        maxClimbSlope = Math.max(maxClimbSlope, climb / horizontal)
    }
    return {
      points: path.length,
      minY,
      maxY,
      maxClimbSlope: Number(maxClimbSlope.toFixed(3)),
      riverFraction: Number((riverPoints / path.length).toFixed(3)),
      first: path[0],
      last: path[path.length - 1],
    }
  }

  const windows: Array<Record<string, unknown>> = []
  for (const halfWidth of [4, 8, 12, 16, 24]) {
    const plan = await planLowRoute({
      port,
      self: input.start,
      goal: input.goal,
      halfWidth,
      readBudget: 512,
      searchTimeCapMs: 8_000,
    })
    windows.push({
      halfWidth,
      status: plan.status,
      reason: plan.reason,
      local: plan.local,
      reached: Number((plan.reached ?? 0).toFixed(1)),
      bandY: plan.bandY,
      reads: plan.reads,
      expanded: plan.expanded,
      waypoint: plan.waypoint,
      channel: summarize(plan.channelPath),
      raw: summarize(plan.path),
    })
  }

  // The raw question, independent of frontier selection: with the whole
  // snapshot available, is there a route from the bridge to a point down the
  // river past the bend? `E02_BEND_*` re-points the question at another region
  // (ab-30 §2: the obsidian wall needs the same analysis, and the fixed bend
  // goal cannot answer for it).
  const bendGoal = {
    x: Number(process.env.E02_BEND_X ?? -999),
    y: Number(process.env.E02_BEND_Y ?? 64),
    z: Number(process.env.E02_BEND_Z ?? 10),
  }
  const direct = planSpaceRoute({ cells, start: input.start, goal: bendGoal, clearance: 2, timeCapMs: 15_000, nodeCap: 400_000 })

  const report = {
    schema: 'e02-coverage-analysis/v1',
    at: new Date().toISOString(),
    box,
    reads,
    cells: cells.size,
    start: input.start,
    goal: input.goal,
    bendGoal,
    windows,
    direct: direct.ok
      ? { ok: true, expanded: direct.expanded, ...summarize(direct.path) }
      : { ok: false, reason: direct.reason, expanded: direct.expanded },
  }
  appendFileSync(input.outPath, `${JSON.stringify(report)}\n`)
  appendFileSync(`${input.outPath}.snapshot.json`, `${JSON.stringify({
    schema: 'e02-snapshot/v1',
    box,
    dimension: input.dimension,
    cells: Array.from(cells.entries()),
  })}\n`)
  console.info(`[e02] coverage analysis written to ${input.outPath}: windows=${JSON.stringify(windows.map(w => ({ halfWidth: w.halfWidth, status: w.status, reason: w.reason, river: (w.channel as { riverFraction?: number } | undefined)?.riverFraction })))} direct=${JSON.stringify(report.direct)}`)
}

describe.runIf(Boolean(liveUrl))('river canyon route (E-02 live)', () => {
  it(`flies the fixture route ${runs}x and records each attempt`, async () => {
    const transport = new StreamableHTTPClientTransport(
      new URL(liveUrl!),
      token ? { requestInit: { headers: { Authorization: `Bearer ${token}` } } } : {},
    )
    const client = new Client({ name: 'proj-airi:e02-route', version: '0.0.0' })
    await client.connect(transport)
    const world = new Client({ name: 'proj-airi:e02-world', version: '0.0.0' })
    await world.connect(new StreamableHTTPClientTransport(new URL(serverUrl)))

    const callClient = async (name: string, args: Record<string, unknown>) =>
      recordOf(await client.callTool({ name, arguments: args }) as ToolResult)
    const callWorld = async (name: string, args: Record<string, unknown>) =>
      recordOf(await world.callTool({ name, arguments: args }) as ToolResult)
    /**
     * The production routing rule: a terrain read is a server-side tool.
     *
     * ROOT CAUSE this mirrors: the client bridge answers `get_blocks_region` with
     * `Bridge error [no_server]`, so a port wired to the client alone fails every
     * terrain read. That silently disabled the corridor and the rollout planner in
     * the first fixture runs (`corridor read_failed`, `rollout fell back to
     * heuristics`) and left the mover on the pre-B0 heuristics. `callGameTool` in
     * `game-host/index.ts` sends these names to the server bridge; this harness has
     * to do the same or it is not testing the production path.
     */
    const SERVER_FIRST_TOOLS = new Set([
      'get_block',
      'get_blocks_region',
      'get_break_evidence',
      'list_players',
      'teleport_player',
      'run_command',
    ])
    const callTool = async (name: string, args: Record<string, unknown>) =>
      SERVER_FIRST_TOOLS.has(name) ? await callWorld(name, args) : await callClient(name, args)
    const sleep = (ms: number): Promise<void> => new Promise((resolve) => {
      setTimeout(resolve, ms)
    })

    mkdirSync(dirname(outPath), { recursive: true })
    // R0 lifecycle (execution plan §4): evidence output is unique and never
    // overwritten. A stale file from an earlier batch must be moved aside by
    // the operator, not truncated here — old records are evidence too.
    if (runs > 0 && existsSync(outPath))
      throw new Error(`evidence output already exists, refusing to overwrite: ${outPath}`)

    try {
      const listed = await client.listTools()
      const tools = new Set(listed.tools.map(tool => tool.name))
      const status = await callTool('get_status', {})
      const self = await callTool('get_self', {})
      const dimension = typeof status.dimension === 'string'
        ? status.dimension
        : typeof self.dimension === 'string' ? self.dimension : undefined
      const port = createMcpMovementPort(callTool, {
        dimension: () => dimension,
        connectionGeneration: () => 1,
        hasTool: name => tools.has(name),
      })
      expect(tools.has('elytra_launch')).toBe(true)
      // Coverage analysis short-circuits before any flight: it reads one
      // snapshot and compares planner windows over it (R4 review item 1).
      if (process.env.E02_MODE === 'analysis') {
        await runCoverageAnalysis({
          callTool,
          start: { x: startX, y: startY, z: startZ },
          goal: { x: goalX!, y: goalY!, z: goalZ! },
          outPath,
          ...(dimension ? { dimension } : {}),
        })
        return
      }
      // A/B execution experiment: full delivery vs segmented handover over the
      // same frozen route (R4 client review section 6).
      if (process.env.E02_MODE === 'route-ab') {
        await runRouteAb({
          callTool,
          port,
          start: { x: startX, y: startY, z: startZ },
          goal: { x: goalX!, y: goalY!, z: goalZ! },
          outPath,
          sleep,
          ...(dimension ? { dimension } : {}),
        })
        return
      }
      // The production switch: without it the mover flies the pre-B0 heuristics
      // and no corridor, which is not the path this venue is meant to test.
      // R0: diagnostic mode only proves the harness returned; formal mode
      // asserts real arrival (see the per-run assertion at the bottom).
      const mode = (process.env.E02_MODE ?? 'diagnostic') as 'diagnostic' | 'formal'
      // Formal runs take their deadline from the frozen config; the env budget
      // is the diagnostic default only.
      const formalConfig = mode === 'formal' ? loadAcceptanceConfig() : undefined
      const effectiveBudgetMs = formalConfig?.deadlineMs ?? budgetMs
      const flightPlanner = resolveFlightPlannerSwitch(
        {
          planner: (process.env.E02_PLANNER ?? 'on') as 'off' | 'on',
          rollout: (process.env.E02_ROLLOUT ?? 'on') as 'on' | 'off',
          calibrated: process.env.E02_CALIBRATED !== 'false',
        },
        FLIGHT_PROFILE_VERSION,
      )
      console.info(`[e02] mode=${mode} flight planner: ${flightPlanner ? `on (calibrated=${flightPlanner.calibrated}, rollout=${flightPlanner.rolloutOn ? 'on' : 'off'})` : 'off (heuristics)'}`)
      // The meta line is the first record: mode and config travel in the
      // output itself, never inferred from file names.
      if (runs > 0) {
        appendFileSync(outPath, `${JSON.stringify({
          schema: 'e02-run-log/v2',
          meta: true,
          mode,
          at: new Date().toISOString(),
          config: {
            planner: process.env.E02_PLANNER ?? 'on',
            rollout: process.env.E02_ROLLOUT ?? 'on',
            calibrated: process.env.E02_CALIBRATED !== 'false',
            escort: process.env.E02_ESCORT ?? 'on',
          },
          start: { x: startX, y: startY, z: startZ },
          goal: { x: goalX, y: goalY, z: goalZ },
          runs,
          budgetMs: effectiveBudgetMs,
          ...(formalConfig ? { acceptance: formalConfig } : {}),
        })}\n`)
      }

      for (let run = 1; run <= runs; run++) {
        await callWorld('teleport_player', { player: 'airitest', x: startX, y: startY, z: startZ })
        await sleep(2500)
        await callTool('stop_movement', {})
        // A run that starts below the mover's health floor is an automatic safety
        // landing, not a test of the route: the first fixture run after a crash
        // started at 4 HP and "flew" a 40-block circle back to the bridge.
        const preRun = await callTool('get_self', {})
        if (typeof preRun.health === 'number' && preRun.health <= 0) {
          // The fixture kills a survival bot that clips a bank, and a run on a
          // corpse tests nothing: respawn first, then heal.
          await callClient('respawn', {})
          await sleep(2500)
          await callWorld('teleport_player', { player: 'airitest', x: startX, y: startY, z: startZ })
          await sleep(2000)
        }
        if (typeof preRun.health === 'number' && preRun.health < 20) {
          await callWorld('run_command', { command: 'effect give airitest minecraft:instant_health 1 20 true' })
          await sleep(1500)
        }
        const healthAtStart = (await callTool('get_self', {})).health
        const inventoryBefore = await callTool('get_inventory', {})
        const rocketsBefore = rocketCount(inventoryBefore)
        const trail: string[] = []
        const samples: Array<{ at: number, x: number, y: number, z: number, health?: number, fallFlying?: boolean, onGround?: boolean }> = []
        // Client ring samples (per-tick health + input owner), collected with a
        // cursor so nothing is read twice; proves where damage happened (R4).
        // The cursor is primed with the client's current tick: starting from 0
        // replays the previous run's records into this run's evidence (R4
        // review item 1).
        const ringSamples: Array<Record<string, unknown>> = []
        let ringCursor = 0
        try {
          const priming = await callClient('flight_status', { sinceTick: 0 })
          const primingTrajectory = Array.isArray(priming.trajectory) ? priming.trajectory as Array<Record<string, unknown>> : []
          for (const sample of primingTrajectory) {
            if (typeof sample.tick === 'number' && sample.tick > ringCursor)
              ringCursor = sample.tick
          }
        }
        catch {
          // A priming read is best-effort; the run itself proves liveness.
        }
        const startedAt = Date.now()
        let stopReason: string | undefined
        // Independent sampling: the mover's own debug line has no health or
        // horizontal position, and a fixture run has to show where the damage
        // happened, not only where the flight ended.
        let sampling = { running: true }
        const sampler = (async () => {
          while (sampling.running) {
            try {
              const state = await callTool('get_self', {})
              const position = positionOf(state)
              if (position) {
                samples.push({
                  at: Date.now() - startedAt,
                  ...position,
                  ...(typeof state.health === 'number' ? { health: state.health } : {}),
                  ...(typeof state.fallFlying === 'boolean' ? { fallFlying: state.fallFlying } : {}),
                  ...(typeof state.onGround === 'boolean' ? { onGround: state.onGround } : {}),
                })
              }
              const status = await callClient('flight_status', { sinceTick: ringCursor })
              const trajectory = Array.isArray(status.trajectory) ? status.trajectory as Array<Record<string, unknown>> : []
              // Stamp the read-time session on samples the client did not
              // label itself, so a record can be tied to a leg (R4 review
              // item 1). A sessionId already on the sample wins.
              const statusSessionId = typeof status.sessionId === 'string' ? status.sessionId : undefined
              const statusRevision = typeof status.revision === 'number' ? status.revision : undefined
              for (const sample of trajectory) {
                if (typeof sample.tick === 'number' && sample.tick > ringCursor)
                  ringCursor = sample.tick
                ringSamples.push({
                  ...(statusSessionId !== undefined ? { sessionId: statusSessionId } : {}),
                  ...(statusRevision !== undefined ? { revision: statusRevision } : {}),
                  ...sample,
                })
              }
            }
            catch {
              // A read during a teleport or a reconnect is not evidence; skip it.
            }
            await sleep(300)
          }
        })()

        // R0 lifecycle: a mover exception must not lose the run's evidence or
        // leave the background sampler spinning. The sampler stops in the
        // finally; the failed run is appended as a partial record.
        let result: Awaited<ReturnType<typeof runElytraMove>> | undefined
        let runError: string | undefined
        try {
          result = await runElytraMove({
            port,
            goal: { x: goalX!, y: goalY!, z: goalZ! },
            tolerance: 2,
            ...(flightPlanner ? { flightPlanner } : {}),
            ...(dimension ? { world: { worldId: 'fixture', dimension, mapVersion: 'live' } } : {}),
            shouldStop: () => {
              if (Date.now() - startedAt > effectiveBudgetMs) {
                stopReason = 'budget'
                return true
              }
              return false
            },
            deps: { sleep },
            debug: (message: string) => {
              trail.push(message)
            },
          })
        }
        catch (error) {
          runError = errorMessageFrom(error) ?? 'unknown error'
        }
        finally {
          sampling = { running: false }
          await sampler
        }

        const after = runError === undefined ? await callTool('get_self', {}) : {}
        const inventoryAfter = runError === undefined ? await callTool('get_inventory', {}) : {}
        const finalPosition = positionOf(after)
        const horizontal = finalPosition ? Math.hypot(finalPosition.x - goalX!, finalPosition.z - goalZ!) : undefined
        const vertical = finalPosition ? finalPosition.y - goalY! : undefined

        // R4 formal gate: every frozen criterion is checked and recorded before
        // the batch continues. A violation stops the batch (no success-farming);
        // a collision, death or false success is never reclassified as invalid.
        let acceptance: AcceptanceConfig | undefined
        let acceptanceChecks: Record<string, boolean> | undefined
        let acceptanceViolations: string[] = []
        let supportId: string | undefined
        let stableGround: boolean | undefined
        let touchdownSpeed: number | undefined
        if (mode === 'formal' && formalConfig) {
          const config = formalConfig
          acceptance = config
          touchdownSpeed = speedOf(after)
          const support = finalPosition
            ? await callTool('get_block', {
                x: Math.floor(finalPosition.x),
                y: Math.floor(finalPosition.y) - 1,
                z: Math.floor(finalPosition.z),
              })
            : {}
          supportId = typeof support.id === 'string' ? support.id : undefined
          stableGround = true
          const stableReads = Math.ceil(config.stableGroundMs / 300)
          for (let index = 0; index < stableReads; index++) {
            await sleep(300)
            const sample = await callTool('get_self', {})
            if (sample.onGround !== true) {
              stableGround = false
              break
            }
          }
          acceptanceChecks = {
            status: result!.status === 'reached',
            noFailure: (result as { failure?: string } | undefined)?.failure === undefined,
            horizontal: horizontal !== undefined && horizontal <= config.platform.horizontalTolerance,
            vertical: vertical !== undefined && Math.abs(vertical) <= config.platform.verticalTolerance,
            onGround: after.onGround === true,
            touchdownSpeed: touchdownSpeed !== undefined && touchdownSpeed <= config.maxTouchdownSpeed,
            stableGround,
            support: typeof supportId === 'string' && supportId.length > 0 && !supportId.endsWith('air'),
            dimension: dimension === config.dimension,
            health: typeof after.health === 'number' && after.health >= config.minHealth,
            healthLoss: typeof after.health === 'number' && Number.isFinite(Number(healthAtStart))
              && Number(healthAtStart) - after.health <= config.maxHealthLoss,
            rockets: rocketCount(inventoryAfter) >= config.minRockets,
          }
          acceptanceViolations = Object.entries(acceptanceChecks)
            .filter(([, ok]) => !ok)
            .map(([name]) => name)
        }

        const record = {
          run,
          at: new Date().toISOString(),
          mode,
          startedAt: { x: startX, y: startY, z: startZ },
          healthAtStart,
          initialYaw: typeof preRun.yaw === 'number' ? preRun.yaw : undefined,
          goal: { x: goalX, y: goalY, z: goalZ },
          status: result?.status,
          detail: result?.detail,
          failure: (result as { failure?: string } | undefined)?.failure,
          lowRoute: (result as { lowRoute?: unknown } | undefined)?.lowRoute,
          channel: (result as { channel?: unknown } | undefined)?.channel,
          ...(dimension ? { world: { dimension, mapVersion: 'live' } } : {}),
          error: runError,
          durationMs: Date.now() - startedAt,
          stopReason,
          rocketsBefore,
          rocketsAfter: rocketCount(inventoryAfter),
          finalPosition,
          horizontalGap: horizontal,
          verticalGap: vertical,
          onGround: after.onGround,
          health: after.health,
          minHealth: samples.reduce((min, sample) => sample.health !== undefined ? Math.min(min, sample.health) : min, 20),
          ...(acceptance ? { acceptance: { config: acceptance, checks: acceptanceChecks, violations: acceptanceViolations, supportId, touchdownSpeed, stableGround } } : {}),
          samples,
          ringSamples,
          trail,
        }
        appendFileSync(outPath, `${JSON.stringify(record)}\n`)
        if (runError !== undefined) {
          console.info(`[e02] run ${run}: MOVER EXCEPTION after ${((Date.now() - startedAt) / 1000).toFixed(1)}s: ${runError} (partial record appended)`)
        }
        else {
          console.info(`[e02] run ${run}: status=${result!.status}${result!.detail ? ` (${result!.detail})` : ''} ${((Date.now() - startedAt) / 1000).toFixed(1)}s rockets ${rocketsBefore}->${record.rocketsAfter} final y=${finalPosition?.y} health=${after.health} minHealth=${record.minHealth} gap=${horizontal?.toFixed(1)}/${vertical?.toFixed(1)}`)
        }
        for (const line of trail.slice(0, 6))
          console.info(`[e02]   ${line}`)
        for (const sample of samples.filter((sample, index) => index % 5 === 0 || (sample.health ?? 20) < 20))
          console.info(`[e02]   t=${(sample.at / 1000).toFixed(1)}s  ${sample.x.toFixed(0)},${sample.y.toFixed(0)},${sample.z.toFixed(0)}  hp=${sample.health ?? '?'} fly=${sample.fallFlying} ground=${sample.onGround}`)

        if (runError !== undefined)
          expect.fail(`mover threw: ${runError}`)
        // Diagnostic mode only proves the harness returned a typed result.
        // Formal mode: every frozen criterion was checked above; a violation
        // stops the batch and preserves the record (execution plan §9).
        if (mode === 'formal' && acceptanceViolations.length > 0) {
          expect.fail(`formal batch stopped at run ${run}: ${acceptanceViolations.join(', ')}${acceptanceConfigPath ? ` (config ${acceptanceConfigPath})` : ''}`)
        }
        if (mode !== 'formal')
          expect(result!.status).toBeTruthy()
      }
    }
    finally {
      await client.close()
      await world.close()
    }
  }, 60_000 + runs * (budgetMs + 10_000))
})
