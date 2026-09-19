import type { TargetObservation } from './target-observation'

import { describe, expect, it } from 'vitest'

import { createClosureEvaluator, createEscortPolicy, escortGate, escortSampleFromObservation } from './escort'

describe('escortGate (LR-1 D2)', () => {
  const near = { x: 100, y: 64, z: 0 }
  const here = { x: 0, y: 64, z: 0 }

  it('allows an optimistic chase within the spendable supply', () => {
    // 100 blocks detour ≈ 130 blocks at full boost (30 blocks/s) ≈ 4.4 s ≈
    // 88 ticks ≈ 9 rockets, well under 20 - 2 with margin.
    const outcome = escortGate({
      target: { position: near, speed: 5 },
      self: { position: here, fireworks: 20, reserve: 2, canFly: true },
    })
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.optimisticRockets).toBeGreaterThan(0)
      expect(outcome.optimisticCatchTicks).toBeGreaterThan(0)
    }
  })

  it('refuses when the target outruns the boosted closure', () => {
    const outcome = escortGate({
      // The target flees along the self-to-target axis faster than boost.
      target: { position: near, speed: 40, direction: { x: 1, z: 0 } },
      self: { position: here, fireworks: 200, reserve: 2, canFly: true },
    })
    expect(outcome).toEqual({ ok: false, reason: 'cannot_catch_up' })
  })

  it('refuses when even the optimistic requirement overruns the spendable supply', () => {
    const outcome = escortGate({
      target: { position: { x: 5000, y: 64, z: 0 }, speed: 5 },
      self: { position: here, fireworks: 20, reserve: 2, canFly: true },
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.reason).toBe('cannot_catch_up')
      // The refusal names the requirement so the caller can explain the no.
      expect(outcome.requiredRockets).toBeGreaterThan(20 - 2)
    }
  })

  it('refuses without supply or without an elytra before estimating', () => {
    const base = { target: { position: near, speed: 5 }, self: { position: here, fireworks: 20, reserve: 2, canFly: true } }
    expect(escortGate({ ...base, self: { ...base.self, canFly: false } })).toEqual({ ok: false, reason: 'cannot_fly' })
    expect(escortGate({ ...base, self: { ...base.self, fireworks: 2 } })).toEqual({ ok: false, reason: 'no_supply' })
  })
})

describe('closure evaluator (LR-1 D4)', () => {
  it('reports closing while the distance shrinks', () => {
    const evaluator = createClosureEvaluator()
    expect(evaluator.push({ at: 0, distance: 100 }).status).toBe('closing')
    expect(evaluator.push({ at: 2500, distance: 60 }).closureRatePerSecond).toBeCloseTo(16)
    expect(evaluator.push({ at: 5000, distance: 20 }).status).toBe('closing')
  })

  it('reports a stall after one non-closing window and calls it off after the second', () => {
    const evaluator = createClosureEvaluator()
    expect(evaluator.push({ at: 0, distance: 100 }).status).toBe('closing')
    // First stalled window: the distance flatlines.
    expect(evaluator.push({ at: 5000, distance: 100 }).status).toBe('stalled')
    // Second consecutive stalled window: honest termination (design D4).
    expect(evaluator.push({ at: 10_000, distance: 101 }).status).toBe('escort_inconclusive')
  })

  it('recovers when the gap closes again after a single stall', () => {
    const evaluator = createClosureEvaluator()
    evaluator.push({ at: 0, distance: 100 })
    expect(evaluator.push({ at: 5000, distance: 100 }).status).toBe('stalled')
    expect(evaluator.push({ at: 10_000, distance: 40 }).status).toBe('closing')
    expect(evaluator.push({ at: 15_000, distance: 10 }).status).toBe('closing')
  })
})

describe('escortSampleFromObservation (LR-1 wiring)', () => {
  function observation(overrides: Partial<TargetObservation> = {}): TargetObservation {
    return {
      targetUuid: 'u-1',
      worldId: 'world-1',
      dimension: 'minecraft:overworld',
      onGround: false,
      fallFlying: true,
      riding: false,
      alive: true,
      source: 'server-entity',
      receivedAt: 0,
      requestStartedAt: 0,
      requestEndedAt: 0,
      requestDurationMs: 0,
      connectionGeneration: 1,
      visibility: 'loaded',
      completeness: 'complete',
      positionUncertainty: 0.25,
      position: { x: 100, y: 70, z: 0 },
      velocity: { x: 0.25, y: 0, z: 0 },
      ...overrides,
    }
  }

  it('converts the per-tick delta into blocks per second with a heading', () => {
    const sample = escortSampleFromObservation(observation())
    // 0.25 blocks/tick at 20 tps is 5 blocks per second.
    expect(sample?.speed).toBeCloseTo(5)
    expect(sample?.direction).toEqual({ x: 1, z: 0 })
  })

  it('keeps the gate optimistic when the target is not measurably moving', () => {
    const sample = escortSampleFromObservation(observation({ velocity: { x: 0, y: 0, z: 0 } }))
    expect(sample?.speed).toBe(0)
    // No heading: a still target must not be read as fleeing in some direction.
    expect(sample?.direction).toBeUndefined()
  })

  it('returns undefined without a position instead of inventing one', () => {
    const { position, ...withoutPosition } = observation()
    expect(position).toBeDefined()
    expect(escortSampleFromObservation(withoutPosition as TargetObservation)).toBeUndefined()
  })
})

describe('escort policy (LR-1 wiring)', () => {
  function observation(overrides: Partial<TargetObservation> = {}): TargetObservation {
    return {
      targetUuid: 'u-1',
      worldId: 'world-1',
      dimension: 'minecraft:overworld',
      onGround: false,
      fallFlying: true,
      riding: false,
      alive: true,
      source: 'server-entity',
      receivedAt: 0,
      requestStartedAt: 0,
      requestEndedAt: 0,
      requestDurationMs: 0,
      connectionGeneration: 1,
      visibility: 'loaded',
      completeness: 'complete',
      positionUncertainty: 0.25,
      position: { x: 100, y: 70, z: 0 },
      velocity: { x: 0.25, y: 0, z: 0 },
      ...overrides,
    }
  }

  const self = { position: { x: 0, y: 70, z: 0 }, fireworks: 20, reserve: 2, canFly: true }

  it('permits a chase the optimistic estimate can afford', () => {
    const policy = createEscortPolicy({ mode: 'on', reserve: 2 })
    const outcome = policy.assessLaunch({ observation: observation(), self })
    expect(outcome?.ok).toBe(true)
  })

  it('refuses a chase that outruns the spendable supply and names the requirement', () => {
    const policy = createEscortPolicy({ mode: 'on', reserve: 2 })
    const outcome = policy.assessLaunch({ observation: observation(), self: { ...self, fireworks: 3 } })
    expect(outcome?.ok).toBe(false)
    if (outcome && !outcome.ok) {
      expect(outcome.reason).toBe('cannot_catch_up')
      expect(outcome.requiredRockets).toBeGreaterThan(3 - 2)
    }
  })

  it('leaves the decision to the caller when the target has no position', () => {
    const policy = createEscortPolicy({ mode: 'on', reserve: 2 })
    const { position, ...withoutPosition } = observation()
    expect(position).toBeDefined()
    expect(policy.assessLaunch({ observation: withoutPosition as TargetObservation, self })).toBeUndefined()
  })

  it('keeps the closure series and reports the honest verdict once', () => {
    const policy = createEscortPolicy({ mode: 'on', reserve: 2 })
    expect(policy.feed({ at: 0, distance: 100 }).status).toBe('closing')
    expect(policy.feed({ at: 5000, distance: 100 }).status).toBe('stalled')
    expect(policy.inconclusive()).toBe(false)
    const verdict = policy.feed({ at: 10_000, distance: 101 })
    expect(verdict.status).toBe('escort_inconclusive')
    expect(policy.inconclusive()).toBe(true)
    // The series is kept for the receipt: a failed chase must be explainable.
    expect(verdict.records).toHaveLength(3)
    expect(verdict.records[2]?.closureRatePerSecond).toBeLessThanOrEqual(0)
  })

  it('counts the suggestions it was told about, starting at zero', () => {
    const policy = createEscortPolicy({ mode: 'suggest', reserve: 2 })
    expect(policy.suggestionsSent()).toBe(0)
    policy.noteSuggestionSent()
    expect(policy.suggestionsSent()).toBe(1)
  })
})
