/**
 * Ground launch through the bridge's per-tick macro (OV-5).
 *
 * The host cannot run this sequence itself. The deploy press counts only on a
 * tick that follows a released jump key, and the boost has to leave the airborne
 * gliding state; both are single ticks, while the host reads the bridge every
 * 150 to 200 ms. A host-side takeoff therefore needs a real drop to run off,
 * which is exactly what the macro removes.
 *
 * Two movers take off: the single-trip elytra mover (`elytra.ts`) and the air
 * follow (`air-track.ts`). They share this module so both call the same launch
 * path, and so the freshness rule below has one owner. The macro writes input
 * while it runs, so this module also owns the rule that a cancel or a lost input
 * lease aborts it instead of leaving it pressing keys (OV-D17).
 */
import type { ElytraLaunchStatus, MovementControlPort } from './port'
import type { Vec3 } from './types'

/** How often the host reads a running macro. */
const LAUNCH_POLL_MS = 200
/**
 * Deadline handed to one launch macro, and the host's transport grace.
 *
 * The macro's own phase budgets add up to 92 ticks (about 4.6 s) in the worst
 * case, so 8 s leaves room for bridge latency. The grace covers a reply that
 * never arrives, never a macro that is still working.
 */
const LAUNCH_TASK_TIMEOUT_MS = 8_000
const LAUNCH_TASK_GRACE_MS = 2_500

/**
 * What one ground launch achieved.
 *
 * `deployed` is separate from `outcome` on purpose: a failed boost still leaves
 * a usable glide, and re-running the takeoff would spend a second rocket and
 * throw away the altitude the cruise needs.
 */
export interface GroundLaunchResult {
  outcome: 'launched' | 'deployed-no-boost' | 'failed' | 'cancelled' | 'unavailable'
  /** The glider was confirmed open, by the macro or by a fresh state read. */
  deployed: boolean
  /** Typed detail for the receipt: the macro's own `state/endReason` pair. */
  detail?: string
  /** Macro phase the launch stopped in, for the receipt. */
  phase?: string
  /** How far the macro climbed above its start height, in blocks. */
  climb?: number
  /** Rockets the macro spent; at most one per launch. */
  fireworksUsed?: number
}

/**
 * Lifts off with the bridge's per-tick launch macro.
 *
 * Returns `undefined` when the bridge exposes no macro, which is the caller's
 * signal to run a host-side edge takeoff instead. The ignition is submitted once
 * and then only polled: the macro spends at most one rocket per run, so a caller
 * that re-submitted on a slow reply would burn a second rocket on one takeoff.
 *
 * @example
 * const launch = await launchFromGround({ port, goal, fireworks, ... })
 * if (launch?.outcome === 'launched') // gliding and climbing
 */
export async function launchFromGround(options: {
  port: MovementControlPort
  /** Aim point for the climb; the macro only turns toward it before the boost. */
  goal: Vec3
  /** Rockets counted in the inventory; false tells the macro to skip the boost. */
  fireworks: number
  shouldStop: () => boolean
  /**
   * Whether this command still owns the input (CD-0 D8).
   *
   * A newer command that took the input must not be disturbed by this session's
   * writes, so a lost lease aborts the macro exactly like a cancel (OV-D17).
   */
  stillOwnsControl?: () => boolean
  now: () => number
  sleep: (ms: number) => Promise<void>
  /** How often the macro is read while it runs. */
  pollMs?: number
  debug?: (message: string) => void
}): Promise<GroundLaunchResult | undefined> {
  const { port, goal, fireworks, now, sleep, debug } = options
  const shouldStop = (): boolean => options.shouldStop() || options.stillOwnsControl?.() === false
  const pollMs = options.pollMs ?? LAUNCH_POLL_MS
  const startLaunch = port.startLaunch
  const readLaunch = port.launchStatus
  if (!startLaunch || !readLaunch)
    return undefined
  if (shouldStop())
    return { outcome: 'cancelled', deployed: false }
  const deadlineMs = now() + LAUNCH_TASK_TIMEOUT_MS
  let status: ElytraLaunchStatus
  try {
    status = await startLaunch({ goal, deadlineMs, withFireworks: fireworks > 0 })
  }
  catch {
    return { outcome: 'unavailable', deployed: false, detail: 'launch macro did not answer' }
  }
  while (status.state === 'running') {
    if (shouldStop()) {
      await port.cancelLaunch?.().catch(() => {})
      return { outcome: 'cancelled', deployed: status.deployed === true, detail: 'cancelled during launch' }
    }
    if (now() > deadlineMs + LAUNCH_TASK_GRACE_MS) {
      // The macro has its own deadline; this only covers the transport, so a
      // wedged bridge cannot hang the run (same rule as the jump task).
      return { outcome: 'unavailable', deployed: status.deployed === true, detail: 'launch macro stopped answering' }
    }
    await sleep(pollMs)
    try {
      status = await readLaunch()
    }
    catch {
      return { outcome: 'unavailable', deployed: status.deployed === true, detail: 'launch macro stopped answering' }
    }
    debug?.(`elytra launch phase=${status.phase ?? '?'} ticks=${status.ticks} deployed=${status.deployed === true} vy=${status.verticalSpeed?.toFixed(3) ?? '?'} climb=${status.climb?.toFixed(2) ?? '?'}`)
  }
  const deployed = status.deployed === true
  const detail = `launch macro ${status.state}/${status.endReason}${status.phase ? ` at ${status.phase}` : ''}`
  const report = {
    deployed,
    detail,
    ...(status.phase ? { phase: status.phase } : {}),
    ...(status.climb !== undefined ? { climb: status.climb } : {}),
    ...(status.fireworksUsed !== undefined ? { fireworksUsed: status.fireworksUsed } : {}),
  }
  if (status.state === 'done') {
    debug?.(`elytra launch handed over after ${status.ticks} ticks, climb ${status.climb?.toFixed(2) ?? '?'}, ${status.fireworksUsed ?? 0} rocket(s)`)
    return { outcome: 'launched', ...report }
  }
  if (status.state === 'cancelled')
    return { outcome: 'cancelled', ...report }
  return { outcome: deployed ? 'deployed-no-boost' : 'failed', ...report }
}
