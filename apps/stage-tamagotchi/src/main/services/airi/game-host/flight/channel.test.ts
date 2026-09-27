import type { FlightChannelRevokeReceipt, FlightChannelSample, FlightChannelStatus, FlightChannelSubmitReceipt, FlightChannelSubmitRequest } from '../movement/port'
import type { FlightChannelRunnerOptions } from './channel'

import { describe, expect, it } from 'vitest'

import { createFlightChannelRunner } from './channel'

/** One full ring sample; only `tick` matters to the runner. */
function sampleOf(tick: number): FlightChannelSample {
  return {
    tick,
    x: 0,
    y: 0,
    z: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    yaw: 0,
    pitch: 0,
    gliding: true,
    onGround: false,
    boostAttached: false,
    rocketFiredThisTick: false,
    inputOwner: 'flight-session',
  }
}

interface FakeOptions {
  /** Submit script; called once per submit attempt. Defaults to accepted. */
  submit?: (request: FlightChannelSubmitRequest, attempt: number) => Promise<FlightChannelSubmitReceipt>
  /** Status script; called once per poll with the caller's cursor. */
  status?: (sinceTick: number | undefined, poll: number) => Promise<FlightChannelStatus>
  /** Revoke script. Defaults to a confirmed release. */
  revoke?: (sessionId: string) => Promise<FlightChannelRevokeReceipt>
  /** Landing-site script. Defaults to an accepted plan. */
  landingSite?: (request: { sessionId: string }) => Promise<{ accepted: boolean, reason?: string }>
}

function fakeRunner(options: FakeOptions = {}) {
  const submissions: FlightChannelSubmitRequest[] = []
  const revokes: string[] = []
  const landingSites: Array<Record<string, unknown>> = []
  const cursors: Array<number | undefined> = []
  let poll = 0
  let clock = 1_000
  const port: FlightChannelRunnerOptions['port'] = {
    flightSubmit: async (request) => {
      submissions.push(request)
      return options.submit
        ? await options.submit(request, submissions.length)
        : { accepted: true }
    },
    flightStatus: async (sinceTick) => {
      cursors.push(sinceTick)
      poll += 1
      return options.status
        ? await options.status(sinceTick, poll)
        : { state: 'accepted', trajectory: [] }
    },
    flightRevoke: async (sessionId) => {
      revokes.push(sessionId)
      return options.revoke ? await options.revoke(sessionId) : { revoked: true, wasActive: true }
    },
    flightLandingSite: async (request) => {
      landingSites.push({ ...request })
      return options.landingSite ? await options.landingSite(request) : { accepted: true }
    },
  }
  const runner = createFlightChannelRunner({
    port,
    dimension: () => 'minecraft:overworld',
    now: () => clock,
    debug: () => {},
  })
  return {
    runner,
    submissions,
    revokes,
    landingSites,
    cursors,
    advance: (ms: number) => {
      clock += ms
    },
  }
}

function inputOf(overrides: Partial<FlightChannelSubmitRequest> = {}) {
  return {
    sessionId: 'fl-1',
    revision: 1,
    mapVersion: 'map-1',
    deadlineMs: 60_000,
    path: [
      { x: 0, y: 80, z: 0 },
      { x: 100, y: 80, z: 0 },
    ],
    entryReach: 8,
    ...overrides,
  }
}

describe('createFlightChannelRunner', () => {
  it('tracks an accepted channel and reports it active', async () => {
    const fake = fakeRunner()
    const result = await fake.runner.submit(inputOf())

    expect(result.ok).toBe(true)
    expect(fake.submissions).toHaveLength(1)
    expect(fake.submissions[0]?.channel.path).toHaveLength(2)
    expect(fake.submissions[0]?.channel.entryReach).toBe(8)
    expect(fake.runner.isActive()).toBe(true)
    expect(fake.runner.active()?.sessionId).toBe('fl-1')
    expect(fake.runner.active()?.mapVersion).toBe('map-1')
  })

  it('retries a stale generation once with the expected value', async () => {
    const fake = fakeRunner({
      submit: async (_request, attempt) => attempt === 1
        ? { accepted: false, reason: 'stale_generation', expectedGeneration: 7 }
        : { accepted: true },
    })
    const result = await fake.runner.submit(inputOf())

    expect(result.ok).toBe(true)
    expect(fake.submissions).toHaveLength(2)
    expect(fake.submissions[0]?.generation).toBeUndefined()
    expect(fake.submissions[1]?.generation).toBe(7)
  })

  it('revokes a leftover of its own and submits once more', async () => {
    const fake = fakeRunner({
      submit: async (_request, attempt) => attempt === 1
        ? { accepted: false, reason: 'session_active', activeSessionId: 'leftover-9' }
        : { accepted: true },
    })
    const result = await fake.runner.submit(inputOf())

    expect(result.ok).toBe(true)
    expect(fake.revokes).toEqual(['leftover-9'])
    expect(fake.submissions).toHaveLength(2)
  })

  it('surfaces a busy writer as a typed refusal without retrying', async () => {
    const fake = fakeRunner({
      submit: async () => ({ accepted: false, reason: 'control_busy' }),
    })
    const result = await fake.runner.submit(inputOf())

    expect(result.ok).toBe(false)
    if (!result.ok)
      expect(result.refusal).toBe('control_busy')
    expect(fake.submissions).toHaveLength(1)
    expect(fake.runner.isActive()).toBe(false)
  })

  it('advances the poll cursor and reports accepted, applying and ended', async () => {
    const fake = fakeRunner({
      status: async (_cursor, poll) => {
        if (poll === 1)
          return { state: 'accepted', applyingStarted: false, trajectory: [sampleOf(10), sampleOf(12)] }
        if (poll === 2)
          return { state: 'running', applyingStarted: true, trajectory: [sampleOf(20)] }
        return { state: 'terminated', endReason: 'channel_complete', trajectory: [] }
      },
    })
    await fake.runner.submit(inputOf())

    const first = await fake.runner.poll()
    const second = await fake.runner.poll()
    const third = await fake.runner.poll()

    expect(first.phase).toBe('accepted')
    expect(second.phase).toBe('applying')
    expect(third.phase).toBe('ended')
    expect(third.endReason).toBe('channel_complete')
    expect(fake.cursors).toEqual([0, 12, 20])
    expect(fake.runner.isActive()).toBe(false)
  })

  it('expires the channel once the deadline passes', async () => {
    const fake = fakeRunner()
    await fake.runner.submit(inputOf({ deadlineMs: 2_000 }))
    expect(fake.runner.isActive()).toBe(true)

    fake.advance(1_001)
    expect(fake.runner.isActive()).toBe(false)
  })

  it('revokes exactly once and forgets the tracked channel', async () => {
    const fake = fakeRunner()
    await fake.runner.submit(inputOf())

    const first = await fake.runner.revoke()
    const second = await fake.runner.revoke()

    expect(first?.revoked).toBe(true)
    expect(second).toBeUndefined()
    expect(fake.revokes).toEqual(['fl-1'])
    expect(fake.runner.active()).toBeUndefined()
    expect(fake.runner.isActive()).toBe(false)
  })

  it('refuses to submit when the bridge lacks the channel tools', async () => {
    const runner = createFlightChannelRunner({ port: {} })
    const result = await runner.submit(inputOf())

    expect(result.ok).toBe(false)
    if (!result.ok)
      expect(result.refusal).toBe('rejected')
  })
})

/**
 * Recovery ownership (ab-23 repair plan, A3/A5): a failed route can still be
 * under the client's recovery owner. The channel must keep the control claim
 * until the client reports a released phase, must let an explicit revoke
 * cancel the recovery, and must not revoke-and-retry a `recovering` refusal.
 */
describe('createFlightChannelRunner recovery ownership', () => {
  function recoveringStatus(phase: string, recovering: boolean): FlightChannelStatus {
    return {
      state: 'terminated',
      endReason: 'no_viable_trajectory',
      routeOutcome: 'FAILED',
      phase,
      recovering,
      trajectory: [],
    }
  }

  it('keeps the control claim while the client is recovering', async () => {
    const fake = fakeRunner({ status: async () => recoveringStatus('RECOVER', true) })
    await fake.runner.submit(inputOf())
    const poll = await fake.runner.poll()

    expect(poll.phase).toBe('ended')
    expect(poll.routeOutcome).toBe('FAILED')
    expect(poll.controlPhase).toBe('RECOVER')
    expect(poll.recovering).toBe(true)
    expect(poll.controlReleased).toBe(false)
    expect(fake.runner.isActive()).toBe(true)
    expect(fake.runner.active()).toBeDefined()
  })

  it('releases the claim only when the client reports a released phase', async () => {
    let phase = 'RECOVER'
    const fake = fakeRunner({ status: async () => recoveringStatus(phase, phase === 'RECOVER') })
    await fake.runner.submit(inputOf())
    const first = await fake.runner.poll()
    phase = 'SETTLED'
    const second = await fake.runner.poll()

    expect(first.controlReleased).toBe(false)
    expect(second.controlReleased).toBe(true)
    expect(fake.runner.isActive()).toBe(false)
    expect(fake.runner.active()).toBeUndefined()
  })

  it('lets an explicit revoke cancel the recovery', async () => {
    const fake = fakeRunner({ status: async () => recoveringStatus('RECOVER', true) })
    await fake.runner.submit(inputOf())
    await fake.runner.poll()
    const receipt = await fake.runner.revoke()

    expect(receipt?.revoked).toBe(true)
    expect(fake.revokes).toEqual(['fl-1'])
    expect(fake.runner.isActive()).toBe(false)
  })

  it('maps a recovering refusal without revoking the live recovery', async () => {
    const fake = fakeRunner({
      submit: async () => ({ accepted: false, reason: 'recovering' }),
    })
    const result = await fake.runner.submit(inputOf())

    expect(result.ok).toBe(false)
    if (!result.ok)
      expect(result.refusal).toBe('recovering')
    expect(fake.revokes).toEqual([])
  })

  it('offers a landing site without touching the route or the control claim', async () => {
    // C2: the offer is a side channel — it must not revoke, submit or release.
    const fake = fakeRunner({ status: async () => recoveringStatus('RECOVER', true) })
    await fake.runner.submit(inputOf())
    await fake.runner.poll()

    const receipt = await fake.runner.landingSite({
      sessionId: 'fl-1',
      x: 10,
      y: 65,
      z: 20,
      contactY: 64,
    })

    expect(receipt?.accepted).toBe(true)
    expect(fake.landingSites).toEqual([{ sessionId: 'fl-1', x: 10, y: 65, z: 20, contactY: 64 }])
    expect(fake.revokes).toEqual([])
    expect(fake.runner.isActive()).toBe(true)
  })
})
