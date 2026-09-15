import type { TargetObservation } from './target-observation'
import type { TrajectorySample } from './target-tracking'

import { describe, expect, it } from 'vitest'

import {
  COARSE_BACKOFF_MS,
  COARSE_FINE_MIN_SAMPLES,
  COARSE_POLL_INTERVAL_MS,
  createCoalescedReader,
  createCoarseLocateGate,
  createTargetTracker,
  createTrajectoryHistory,
  FINE_MAX_MISSES,
  isNewerTargetSample,
  WAITING_BUDGET_MS,
  WAITING_START_MS,
} from './target-tracking'

function observation(overrides: Partial<TargetObservation> = {}): TargetObservation {
  return {
    targetUuid: 'u-1',
    worldId: 'world-1',
    dimension: 'minecraft:overworld',
    position: { x: 0, y: 64, z: 0 },
    onGround: 'unobserved',
    fallFlying: 'unobserved',
    riding: 'unobserved',
    alive: 'unobserved',
    source: 'server-entity',
    receivedAt: 0,
    requestStartedAt: 0,
    requestEndedAt: 0,
    requestDurationMs: 0,
    connectionGeneration: 1,
    visibility: 'loaded',
    completeness: 'complete',
    positionUncertainty: 0,
    ...overrides,
  }
}

describe('target sample ordering', () => {
  it('accepts a newer source tick and drops a duplicate or older one', () => {
    expect(isNewerTargetSample(undefined, { sourceTick: 1, receivedAt: 10 })).toBe(true)
    expect(isNewerTargetSample({ sourceTick: 1, receivedAt: 10 }, { sourceTick: 2, receivedAt: 20 })).toBe(true)
    expect(isNewerTargetSample({ sourceTick: 2, receivedAt: 20 }, { sourceTick: 2, receivedAt: 30 })).toBe(false)
    expect(isNewerTargetSample({ sourceTick: 3, receivedAt: 30 }, { sourceTick: 2, receivedAt: 40 })).toBe(false)
  })

  it('falls back to the receive time when no source tick is present', () => {
    expect(isNewerTargetSample({ receivedAt: 20 }, { receivedAt: 30 })).toBe(true)
    expect(isNewerTargetSample({ receivedAt: 30 }, { receivedAt: 30 })).toBe(false)
  })
})

describe('fine to coarse hysteresis', () => {
  it(`switches to coarse after ${FINE_MAX_MISSES} consecutive misses`, () => {
    const tracker = createTargetTracker()
    tracker.acceptFine(observation({ receivedAt: 0 }), 0)
    expect(tracker.missFine(0)).toBe('fine')
    expect(tracker.missFine(1)).toBe('fine')
    expect(tracker.missFine(2)).toBe('coarse')
    expect(tracker.outcome(2)).toBe('coarse')
  })

  it('switches to coarse when the last fine sample is older than the limit', () => {
    const tracker = createTargetTracker()
    tracker.acceptFine(observation({ receivedAt: 0 }), 0)
    expect(tracker.missFine(600)).toBe('coarse')
  })

  it(`needs ${COARSE_FINE_MIN_SAMPLES} increasing fresh samples to recover to fine`, () => {
    const tracker = createTargetTracker()
    tracker.missFine(0)
    tracker.missFine(1)
    tracker.missFine(2)
    expect(tracker.outcome(2)).toBe('coarse')

    expect(tracker.acceptFine(observation({ sourceTick: 10, receivedAt: 100 }), 100)).toBe(true)
    expect(tracker.outcome(100)).toBe('coarse')
    tracker.acceptFine(observation({ sourceTick: 11, receivedAt: 150 }), 150)
    expect(tracker.outcome(150)).toBe('fine')
  })

  it('drops a stale fine sample while recovering', () => {
    const tracker = createTargetTracker()
    tracker.acceptFine(observation({ sourceTick: 5, receivedAt: 0 }), 0)
    tracker.missFine(0)
    tracker.missFine(1)
    tracker.missFine(2)
    tracker.acceptFine(observation({ sourceTick: 6, receivedAt: 100 }), 100)
    // The duplicate of the accepted sample must not count as the second one.
    expect(tracker.acceptFine(observation({ sourceTick: 6, receivedAt: 120 }), 120)).toBe(false)
    expect(tracker.outcome(120)).toBe('coarse')
    tracker.acceptFine(observation({ sourceTick: 7, receivedAt: 160 }), 160)
    expect(tracker.outcome(160)).toBe('fine')
  })
})

describe('coarse staleness and bounded waiting', () => {
  it(`reports waiting_for_target after ${WAITING_START_MS} ms without a fresh coarse sample`, () => {
    const tracker = createTargetTracker()
    tracker.missFine(0)
    tracker.missFine(0)
    tracker.missFine(0)
    expect(tracker.outcome(0)).toBe('coarse')
    expect(tracker.outcome(WAITING_START_MS + 1)).toBe('waiting_for_target')
    expect(tracker.waitingBudgetExceeded(WAITING_START_MS + 1)).toBe(false)
    expect(tracker.waitingBudgetExceeded(WAITING_START_MS + 1 + WAITING_BUDGET_MS)).toBe(true)
  })

  it('clears the waiting window with a fresh coarse sample', () => {
    const tracker = createTargetTracker()
    tracker.missFine(0)
    tracker.missFine(0)
    tracker.missFine(0)
    expect(tracker.outcome(WAITING_START_MS + 1)).toBe('waiting_for_target')
    expect(tracker.acceptCoarse(observation({ receivedAt: 4000 }), 4000)).toBe(true)
    expect(tracker.outcome(4000)).toBe('coarse')
  })

  it('returns forced typed outcomes until they are cleared by recovery', () => {
    const tracker = createTargetTracker()
    tracker.forceOutcome('target_dimension_changed')
    expect(tracker.outcome(100)).toBe('target_dimension_changed')
    expect(tracker.outcome(999)).toBe('target_dimension_changed')
  })
})

describe('coarse locate gate', () => {
  it(`allows at most one request per ${COARSE_POLL_INTERVAL_MS} ms and never overlaps`, () => {
    const gate = createCoarseLocateGate()
    expect(gate.tryAcquire(0)).toBe(true)
    // In flight: a second request must wait, not stack.
    expect(gate.tryAcquire(10)).toBe(false)
    gate.release('success')
    expect(gate.tryAcquire(500)).toBe(false)
    expect(gate.tryAcquire(COARSE_POLL_INTERVAL_MS)).toBe(true)
  })

  it('backs off after consecutive failures up to the schedule', () => {
    const gate = createCoarseLocateGate()
    gate.tryAcquire(0)
    gate.release('failure')
    expect(gate.state().consecutiveFailures).toBe(1)
    expect(gate.tryAcquire(COARSE_BACKOFF_MS[0] - 1)).toBe(false)
    expect(gate.tryAcquire(COARSE_BACKOFF_MS[0])).toBe(true)
    gate.release('failure')
    expect(gate.state().consecutiveFailures).toBe(2)
    expect(gate.tryAcquire(COARSE_BACKOFF_MS[0] + COARSE_BACKOFF_MS[1] - 1)).toBe(false)
    expect(gate.tryAcquire(COARSE_BACKOFF_MS[0] + COARSE_BACKOFF_MS[1])).toBe(true)
    gate.release('success')
    expect(gate.state().consecutiveFailures).toBe(0)
  })
})

describe('shared coarse sample', () => {
  it('serves several consumers from one read within the ttl', async () => {
    let calls = 0
    const reader = createCoalescedReader(async (key: string) => {
      calls += 1
      return `sample:${key}`
    }, { ttlMs: 1000, now: () => 0 })
    const [a, b] = await Promise.all([reader.read('u-1'), reader.read('u-1')])
    expect(a).toBe('sample:u-1')
    expect(b).toBe('sample:u-1')
    expect(calls).toBe(1)
    await reader.read('u-1')
    expect(calls).toBe(1)
    await reader.read('u-2')
    expect(calls).toBe(2)
  })
})

describe('trajectory history resets', () => {
  it('records takeoff and landing as resets', () => {
    const history = createTrajectoryHistory()
    history.push({ receivedAt: 0, position: { x: 0, y: 64, z: 0 }, fallFlying: false })
    const takeoff = history.push({ receivedAt: 50, position: { x: 0, y: 64, z: 0 }, fallFlying: true })
    expect(takeoff?.reason).toBe('takeoff')
    expect(history.samples()).toHaveLength(1)
    const landing = history.push({ receivedAt: 100, position: { x: 10, y: 70, z: 0 }, fallFlying: false })
    expect(landing?.reason).toBe('landing')
  })

  it('resets on a ride switch', () => {
    const history = createTrajectoryHistory()
    history.push({ receivedAt: 0, position: { x: 0, y: 64, z: 0 }, riding: false })
    const reset = history.push({ receivedAt: 50, position: { x: 0, y: 64, z: 0 }, riding: true })
    expect(reset?.reason).toBe('ride-switch')
  })

  it('resets on a teleport jump inside the window', () => {
    const history = createTrajectoryHistory()
    history.push({ receivedAt: 0, position: { x: 0, y: 64, z: 0 } })
    const reset = history.push({ receivedAt: 50, position: { x: 100, y: 64, z: 0 } })
    expect(reset?.reason).toBe('teleport')
    expect(history.samples()).toHaveLength(1)
  })

  it('does not reset on a distance a slow sample can explain', () => {
    const history = createTrajectoryHistory()
    history.push({ receivedAt: 0, position: { x: 0, y: 64, z: 0 } })
    const reset = history.push({ receivedAt: 900, position: { x: 4, y: 64, z: 0 } })
    expect(reset).toBeUndefined()
    expect(history.samples()).toHaveLength(2)
  })

  it('drops an out-of-order sample instead of resetting', () => {
    const history = createTrajectoryHistory()
    history.push({ receivedAt: 100, position: { x: 0, y: 64, z: 0 } })
    const reset = history.push({ receivedAt: 50, position: { x: 100, y: 64, z: 0 } })
    expect(reset).toBeUndefined()
    expect(history.samples()).toHaveLength(1)
  })

  it('never infers landing from repeated identical coordinates', () => {
    const history = createTrajectoryHistory()
    history.push({ receivedAt: 0, position: { x: 0, y: 64, z: 0 }, fallFlying: true })
    const reset = history.push({ receivedAt: 50, position: { x: 0, y: 64, z: 0 }, fallFlying: true })
    expect(reset).toBeUndefined()
    expect(history.lastReset()).toBeUndefined()
  })

  it('derives a mean velocity in blocks per tick over the recent window', () => {
    const history = createTrajectoryHistory()
    const base: Omit<TrajectorySample, 'receivedAt' | 'position'> = {}
    history.push({ ...base, receivedAt: 0, position: { x: 0, y: 64, z: 0 } })
    history.push({ ...base, receivedAt: 1_000, position: { x: 10, y: 64, z: 0 } })
    const velocity = history.averageVelocity()
    expect(velocity?.x).toBeCloseTo(0.5)
    expect(velocity?.z).toBeCloseTo(0)
  })
})
