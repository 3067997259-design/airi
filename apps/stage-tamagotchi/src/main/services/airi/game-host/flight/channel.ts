/**
 * Host-side flight channel runner (R3, elytra-flight-control-r3-channel-loop §2).
 *
 * The client owns per-tick driving; this module owns the exchange: submit a
 * planned path, poll typed receipts with a monotonic tick cursor, revoke, and
 * answer exactly one question for the rest of the mover — is the channel
 * currently valid to fly under. Validity is derived from the exchange facts
 * (submitted, accepted, not ended, not past deadline, current revision), never
 * from a historical "has ever flown a channel" flag.
 *
 * Honesty rules the transport cannot relax:
 *
 * - `accepted` and `startedApplying` are separate facts; a grounded channel
 *   waits for the client's own launch handover, and the runner reports both.
 * - A rejected submit is a typed outcome, not a retry loop: only
 *   `stale_generation` (the receipt names the expected generation) and
 *   `session_active` on a leftover of our own (revoked here first) are
 *   retried, each once.
 * - The status cursor never rewinds. Samples the ring already overwrote are
 *   reported through `trajectoryLost`, so a stalled poll cannot fake progress.
 */
import type { FlightChannelRevokeReceipt, FlightChannelStatus, FlightChannelSubmitReceipt, FlightChannelSubmitRequest, FlightChannelWaypoint, FlightLandingSiteReceipt, FlightLandingSiteRequest, MovementControlPort } from '../movement/port'

/** One submitted channel the runner tracks. */
export interface ActiveChannel {
  sessionId: string
  revision: number
  /** Map identity the path was planned against; a changed value invalidates. */
  mapVersion: string
  submittedAt: number
  deadlineMs: number
  path: FlightChannelWaypoint[]
}

/** Why a submit did not produce a live channel; retried kinds are resolved inside. */
export type FlightChannelSubmitRefusal
  = | 'control_busy'
    | 'stale_control_session'
    | 'session_active'
    | 'recovering'
    | 'rejected'

export type FlightChannelPhase = 'accepted' | 'applying' | 'ended'

export interface FlightChannelPoll {
  phase: FlightChannelPhase
  status: FlightChannelStatus
  /** Terminal end reason, present only once the session ended. */
  endReason?: string
  /**
   * Route outcome and physical phase are separate facts (ab-23 repair plan,
   * A3): a failed route may still be under the client's recovery owner, so
   * callers must not start another controller until `controlReleased`.
   */
  routeOutcome?: string
  controlPhase?: string
  recovering?: boolean
  controlReleased?: boolean
}

export interface FlightChannelRunnerOptions {
  /**
   * The narrow slice the runner calls. A pick instead of the whole movement
   * port: callers and tests provide exactly these three methods.
   */
  port: Pick<MovementControlPort, 'flightSubmit' | 'flightStatus' | 'flightRevoke' | 'flightLandingSite'>
  /** Connection generation stamped on every submit; a stale one is renegotiated from the receipt. */
  generation?: () => number | undefined
  dimension?: () => string | undefined
  now?: () => number
  debug?: (message: string) => void
}

export interface FlightChannelSubmitInput {
  sessionId: string
  revision: number
  mapVersion: string
  deadlineMs: number
  path: FlightChannelWaypoint[]
  entryReach?: number
  terminalReach?: FlightChannelSubmitRequest['channel']['terminalReach']
  terminalPlanning?: FlightChannelSubmitRequest['channel']['terminalPlanning']
  /** What the path's end means for the client (see `FlightChannelSubmitRequest`). */
  kind?: 'through' | 'stop'
  controlSessionId?: string
}

export interface FlightChannelRunner {
  /**
   * Submits one channel and tracks it as active. Throws nothing: a refusal is
   * the typed result, and the caller decides whether it is recoverable.
   */
  submit: (input: FlightChannelSubmitInput) => Promise<{ ok: true } | { ok: false, refusal: FlightChannelSubmitRefusal, receipt: FlightChannelSubmitReceipt }>
  /** Reads receipts newer than the cursor and advances it. */
  poll: () => Promise<FlightChannelPoll>
  /** Revokes the active channel once; further calls are no-ops. */
  revoke: () => Promise<FlightChannelRevokeReceipt | undefined>
  /**
   * Offers a host-selected landing site to a recovering client (C2). It does
   * not revoke, submit or release anything: the client validates the plan and
   * answers with a typed receipt.
   */
  landingSite: (request: FlightLandingSiteRequest) => Promise<FlightLandingSiteReceipt | undefined>
  /**
   * Whether the channel may currently own the flight. False after any typed
   * end, after the deadline, or when a newer revision replaced the tracked one.
   */
  isActive: () => boolean
  /** The tracked channel facts, absent before the first submit and after revoke. */
  active: () => ActiveChannel | undefined
}

/**
 * Creates the single channel-exchange boundary for one flight command.
 *
 * @example
 * const runner = createFlightChannelRunner({ port })
 * const submitted = await runner.submit({ sessionId: 'fl-1', revision: 1, mapVersion, deadlineMs, path })
 * if (submitted.ok) {
 *   const poll = await runner.poll()
 *   // poll.phase: 'accepted' | 'applying' | 'ended'
 * }
 */
export function createFlightChannelRunner(options: FlightChannelRunnerOptions): FlightChannelRunner {
  const now = options.now ?? (() => Date.now())
  let tracked: ActiveChannel | undefined
  let accepted = false
  let ended = false
  /** The physical control claim is over: only then may another owner start. */
  let controlReleased = false
  /** An explicit revoke was already sent; further calls are no-ops. */
  let revoked = false
  let cursorTick = 0
  /**
   * Generation learned from a stale refusal. A repaired submit invalidates the
   * first attempt of every later submit, so the runner remembers the value and
   * stamps it directly (R3 live: three revisions each paid a futile attempt).
   */
  let negotiatedGeneration: number | undefined

  const reset = (): void => {
    tracked = undefined
    accepted = false
    ended = false
    controlReleased = false
    revoked = false
  }

  async function submitOnce(input: FlightChannelSubmitInput, generationOverride?: number): Promise<FlightChannelSubmitReceipt> {
    const generation = generationOverride ?? negotiatedGeneration ?? options.generation?.()
    const request: FlightChannelSubmitRequest = {
      sessionId: input.sessionId,
      ...(generation !== undefined ? { generation } : {}),
      revision: input.revision,
      deadlineMs: input.deadlineMs,
      ...(options.dimension?.() ? { dimension: options.dimension()! } : {}),
      ...(input.controlSessionId ? { controlSessionId: input.controlSessionId } : {}),
      channel: {
        path: input.path,
        ...(input.entryReach !== undefined ? { entryReach: input.entryReach } : {}),
        ...(input.terminalReach !== undefined ? { terminalReach: input.terminalReach } : {}),
        ...(input.terminalPlanning !== undefined ? { terminalPlanning: input.terminalPlanning } : {}),
        ...(input.kind !== undefined ? { kind: input.kind } : {}),
      },
    }
    return await options.port.flightSubmit!(request)
  }

  return {
    async submit(input) {
      if (!options.port.flightSubmit || !options.port.flightStatus || !options.port.flightRevoke)
        return { ok: false, refusal: 'rejected' as const, receipt: { accepted: false, reason: 'channel tools unavailable' } }

      let receipt = await submitOnce(input)
      // The client remembers the highest generation it ever accepted across
      // sessions. A fresh host connection (or another writer's channel) may
      // therefore be ahead of our envelope; the receipt names the expected
      // value, and adopting it once is the honest repair. A second stale
      // answer is a real refusal.
      if (!receipt.accepted && receipt.reason === 'stale_generation' && receipt.expectedGeneration !== undefined) {
        options.debug?.(`flight channel stale generation; retrying with ${receipt.expectedGeneration}`)
        negotiatedGeneration = receipt.expectedGeneration
        receipt = await submitOnce(input, receipt.expectedGeneration)
      }
      // A leftover channel from an earlier attempt of this same command still
      // holds the single writer slot. Revoke it and submit ours once.
      if (!receipt.accepted && receipt.reason === 'session_active' && receipt.activeSessionId) {
        options.debug?.(`flight channel revoking leftover ${receipt.activeSessionId}`)
        await options.port.flightRevoke(receipt.activeSessionId).catch(() => {})
        receipt = await submitOnce(input)
      }
      if (!receipt.accepted) {
        const refusal: FlightChannelSubmitRefusal = receipt.reason === 'control_busy'
          || receipt.reason === 'stale_control_session'
          || receipt.reason === 'session_active'
          || receipt.reason === 'recovering'
          ? receipt.reason
          : 'rejected'
        return { ok: false, refusal, receipt }
      }

      tracked = {
        sessionId: input.sessionId,
        revision: input.revision,
        mapVersion: input.mapVersion,
        submittedAt: now(),
        deadlineMs: input.deadlineMs,
        path: input.path,
      }
      accepted = true
      ended = false
      controlReleased = false
      revoked = false
      cursorTick = 0
      return { ok: true }
    },

    async poll() {
      const status = await options.port.flightStatus!(cursorTick)
      for (const sample of status.trajectory) {
        if (sample.tick > cursorTick)
          cursorTick = sample.tick
      }
      const terminal = status.state === 'terminated' || status.state === 'revoked'
      const routeOutcome = status.routeOutcome
      const routeOver = terminal
        || routeOutcome === 'failed' || routeOutcome === 'completed' || routeOutcome === 'revoked'
      if (routeOver)
        ended = true
      // The route can end while the client's recovery still owns the
      // aircraft: only a RELEASED/SETTLED phase (or an older client without
      // phases, once terminal) releases the physical control claim.
      const controlPhase = typeof status.phase === 'string' ? status.phase.toUpperCase() : undefined
      if (controlPhase !== undefined)
        controlReleased = controlPhase === 'RELEASED' || controlPhase === 'SETTLED'
      else if (terminal)
        controlReleased = true
      const phase: FlightChannelPhase = ended
        ? 'ended'
        : status.applyingStarted === true ? 'applying' : 'accepted'
      return {
        phase,
        status,
        ...(ended ? { endReason: status.endReason ?? 'unknown' } : {}),
        ...(routeOutcome !== undefined ? { routeOutcome } : {}),
        ...(controlPhase !== undefined ? { controlPhase } : {}),
        ...(status.recovering === true ? { recovering: true } : {}),
        controlReleased,
      }
    },

    async revoke() {
      const current = tracked
      if (!current || revoked)
        return undefined
      revoked = true
      // An explicit revoke must reach the client even when the ROUTE already
      // ended: it is what cancels a running recovery (ab-23 repair plan, A3).
      const receipt = await options.port.flightRevoke!(current.sessionId).catch((error) => {
        options.debug?.(`flight channel revoke failed: ${String(error)}`)
        return { revoked: false } satisfies FlightChannelRevokeReceipt
      })
      ended = true
      controlReleased = true
      reset()
      return receipt
    },

    async landingSite(request) {
      const current = tracked
      if (!current || revoked || !options.port.flightLandingSite)
        return undefined
      return await options.port.flightLandingSite(request).catch((error) => {
        options.debug?.(`flight landing site offer failed: ${String(error)}`)
        return undefined
      })
    },

    isActive() {
      const current = tracked
      return current !== undefined
        && accepted
        && !controlReleased
        && now() <= current.deadlineMs
    },

    active() {
      return tracked === undefined || controlReleased ? undefined : tracked
    },
  }
}
