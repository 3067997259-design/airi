/**
 * MC-0b deterministic protocol smoke (no LLM).
 *
 * Drives the mcpfabric client bridge over raw RPC and checks the P2 navigation
 * contract plus the P1 heartbeat cleanup. Run against a live game:
 *
 * ```powershell
 * $env:MCPFABRIC_BRIDGE_TOKEN = '<client config token>'
 * pnpm -F @proj-airi/stage-tamagotchi exec tsx scripts/mc-0b-protocol-smoke.ts
 * ```
 *
 * Optional env: `MCPFABRIC_BRIDGE_URL` (default http://127.0.0.1:25599).
 */

import { env, exit } from 'node:process'

const bridgeUrl = env.MCPFABRIC_BRIDGE_URL ?? 'http://127.0.0.1:25599'
const token = env.MCPFABRIC_BRIDGE_TOKEN
if (!token) {
  console.error('MCPFABRIC_BRIDGE_TOKEN is required (client config token).')
  exit(2)
}

interface RpcErrorBody {
  code: string
  message: string
  data?: unknown
}

interface RpcEnvelope<T> {
  ok: boolean
  result?: T
  error?: RpcErrorBody
}

class RpcFailure extends Error {
  readonly code: string
  readonly data: unknown

  constructor(body: RpcErrorBody) {
    super(`${body.code}: ${body.message}`)
    this.code = body.code
    this.data = body.data
  }
}

async function rpc<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const response = await fetch(`${bridgeUrl}/rpc`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const body = await response.json() as RpcEnvelope<T>
  if (!body.ok)
    throw new RpcFailure(body.error ?? { code: 'unknown', message: 'no error body' })
  return body.result as T
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

interface PlayerState {
  x: number
  y: number
  z: number
  health: number
  dimension?: string
}

interface NavStatus {
  active: boolean
  state: string
  endReason: string
  finalDistance?: number
  finalPosition?: { x: number, y: number, z: number }
  distance?: number
}

interface ScenarioResult {
  name: string
  status: 'PASS' | 'FAIL'
  detail: Record<string, unknown>
}

const results: ScenarioResult[] = []

function record(name: string, pass: boolean, detail: Record<string, unknown>): void {
  results.push({ name, status: pass ? 'PASS' : 'FAIL', detail })
  console.info(`[${pass ? 'PASS' : 'FAIL'}] ${name}`, JSON.stringify(detail))
}

async function playerState(): Promise<PlayerState> {
  return await rpc<PlayerState>('player.getState')
}

async function waitForNavEnd(timeoutMs: number): Promise<NavStatus> {
  const deadline = Date.now() + timeoutMs
  let last: NavStatus | undefined
  while (Date.now() < deadline) {
    last = await rpc<NavStatus>('nav.status')
    if (!last.active && last.endReason !== 'navigating')
      return last
    await sleep(400)
  }
  return last ?? { active: false, state: 'unknown', endReason: 'unknown' }
}

async function positionsStable(samples = 3, gapMs = 700, tolerance = 0.5): Promise<{ stable: boolean, delta: number }> {
  const first = await playerState()
  await sleep(gapMs)
  const second = await playerState()
  let maxDelta = Math.hypot(second.x - first.x, second.y - first.y, second.z - first.z)
  for (let index = 2; index < samples; index++) {
    await sleep(gapMs)
    const next = await playerState()
    maxDelta = Math.max(maxDelta, Math.hypot(next.x - second.x, next.y - second.y, next.z - second.z))
  }
  return { stable: maxDelta <= tolerance, delta: Number(maxDelta.toFixed(3)) }
}

async function scenario(name: string, run: () => Promise<{ pass: boolean, detail: Record<string, unknown> }>): Promise<void> {
  try {
    const result = await run()
    record(name, result.pass, result.detail)
  }
  catch (error) {
    record(name, false, { error: error instanceof RpcFailure ? `${error.code}: ${error.message}` : String(error) })
  }
}

async function main(): Promise<void> {
  const info = await rpc<{ capabilities: string[] }>('info.status')
  const preflightState = await playerState()
  record('preflight', info.capabilities.includes('control') && preflightState.health > 0, { capabilities: info.capabilities, health: preflightState.health })
  if (preflightState.health <= 0) {
    console.error('player is dead; respawn before running the protocol smoke')
    exit(2)
  }

  // P2-a: a short move reaches inside the tolerance. Walk away first, then
  // navigate back to the block the player already stood on: that goal is
  // standable, so the path ends exactly on it and `reached` is deterministic.
  await scenario('p2-reached', async () => {
    const start = await playerState()
    const home = { x: Math.floor(start.x), y: Math.floor(start.y), z: Math.floor(start.z) }
    for (const dx of [4, -4, 6]) {
      try {
        await rpc('nav.pathTo', { x: home.x + dx, y: home.y, z: home.z, reachRadius: 2.0, timeoutSeconds: 15 })
        break
      }
      catch {
        continue
      }
    }
    await waitForNavEnd(20_000)
    await rpc('nav.pathTo', { ...home, reachRadius: 1.5, timeoutSeconds: 20 })
    const outcome = await waitForNavEnd(25_000)
    return {
      pass: outcome.endReason === 'reached' && (outcome.finalDistance ?? Infinity) <= 1.7,
      detail: { endReason: outcome.endReason, finalDistance: outcome.finalDistance, target: home },
    }
  })

  // P2-b: cancel stops the walk and reports cancelled.
  await scenario('p2-cancel', async () => {
    const start = await playerState()
    // Plainsworld targets are not always standable; scan a few offsets until
    // one produces a path, then cancel while it is running.
    let started = false
    for (const dx of [16, -16, 8, -8, 24]) {
      try {
        await rpc('nav.pathTo', { x: Math.floor(start.x) + dx, y: Math.floor(start.y), z: Math.floor(start.z), reachRadius: 1.0, timeoutSeconds: 60 })
        started = true
        break
      }
      catch {
        continue
      }
    }
    if (!started)
      return { pass: false, detail: { error: 'no startable target for cancel' } }
    await sleep(1_500)
    await rpc('nav.stop')
    const cancelled = await waitForNavEnd(10_000)
    const afterCancel = await positionsStable()
    return {
      pass: cancelled.endReason === 'cancelled' && afterCancel.stable,
      detail: { endReason: cancelled.endReason, stoppedDelta: afterCancel.delta },
    }
  })

  // P2-c: the lease deadline ends the walk with a final position.
  await scenario('p2-deadline', async () => {
    const start = await playerState()
    let started = false
    // A short lease on a near target: the walk takes ~2s, so the deadline
    // fires mid-walk while pathability stays likely.
    for (const dx of [16, -16, 12, -12, 8, -8]) {
      try {
        await rpc('nav.pathTo', { x: Math.floor(start.x) + dx, y: Math.floor(start.y), z: Math.floor(start.z), reachRadius: 1.0, timeoutSeconds: 1 })
        started = true
        break
      }
      catch {
        continue
      }
    }
    if (!started)
      return { pass: false, detail: { error: 'no startable target for deadline' } }
    const expired = await waitForNavEnd(12_000)
    const afterDeadline = await positionsStable()
    return {
      pass: expired.endReason === 'deadline' && expired.finalPosition !== undefined && afterDeadline.stable,
      detail: { endReason: expired.endReason, finalPosition: expired.finalPosition, stoppedDelta: afterDeadline.delta },
    }
  })

  // P2-d: an unreachable target is a bounded failure that carries position data.
  await scenario('p2-unreachable', async () => {
    const start = await playerState()
    let code = ''
    let data: unknown
    try {
      await rpc('nav.pathTo', { x: start.x, y: start.y - 100, z: start.z, reachRadius: 1.0, timeoutSeconds: 15 })
    }
    catch (error) {
      if (error instanceof RpcFailure) {
        code = error.code
        data = error.data
      }
    }
    return { pass: code === 'unreachable' && data !== undefined, detail: { code, data } }
  })

  // P2-e: an exhausted path is not a reached target. A near target with a tight
  // tolerance usually ends adjacent to the node, which must report
  // path_exhausted instead of reached.
  await scenario('p2-path-exhausted', async () => {
    const start = await playerState()
    await rpc('nav.pathTo', { x: Math.floor(start.x) + 4, y: Math.floor(start.y), z: Math.floor(start.z), reachRadius: 1.0, timeoutSeconds: 15 })
    const exhausted = await waitForNavEnd(20_000)
    const finalDistance = exhausted.finalDistance ?? Number.NaN
    const pass = (exhausted.endReason === 'path_exhausted' && finalDistance > 1.0)
      || (exhausted.endReason === 'reached' && finalDistance <= 1.05)
    return { pass, detail: { endReason: exhausted.endReason, finalDistance } }
  })

  // P1: heartbeat cleanup clears held controls after the configured silence.
  await scenario('p1-heartbeat-timeout', async () => {
    await rpc('control.setInput', { jump: true })
    const jumpSamples: number[] = []
    for (let index = 0; index < 4; index++) {
      await sleep(400)
      jumpSamples.push((await playerState()).y)
    }
    const jumped = Math.max(...jumpSamples) - Math.min(...jumpSamples) > 0.1
    // Stay silent longer than heartbeatTimeoutMs (5000 in the test config),
    // then let any residual jump land before sampling.
    await sleep(6_500)
    await sleep(1_000)
    const afterHeartbeat = await positionsStable(3, 600, 0.1)
    const alive = (await playerState()).health > 0
    return {
      pass: jumped && alive && afterHeartbeat.stable,
      detail: {
        jumped,
        alive,
        maxJumpDelta: Number((Math.max(...jumpSamples) - Math.min(...jumpSamples)).toFixed(3)),
        stoppedDelta: afterHeartbeat.delta,
      },
    }
  })

  const failed = results.filter(item => item.status === 'FAIL')
  console.info(`\n${results.length - failed.length}/${results.length} scenarios passed`)
  if (failed.length > 0)
    exit(1)
}

main().catch((error) => {
  console.error('smoke run failed:', error)
  exit(1)
})
