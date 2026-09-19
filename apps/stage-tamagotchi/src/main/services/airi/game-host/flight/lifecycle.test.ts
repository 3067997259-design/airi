import type { FlightIntent, FlightObservation, LandingSite } from './contracts'
import type { LaunchColumnProbe } from './lifecycle'

import { describe, expect, it } from 'vitest'

import {
  buildFlightStatus,
  DEFAULT_LAUNCH_REQUIREMENTS,
  INITIAL_LIFECYCLE,
  planApproach,
  planEmergencyLanding,
  prepareFlight,
  reduceLifecycle,
  selectLaunchPoint,
  stepGoAroundPhase,
} from './lifecycle'

function site(overrides: Partial<LandingSite> = {}): LandingSite {
  return {
    support: { x: 40, y: 63, z: 0, width: 2, depth: 2 },
    contactY: 64,
    entryYaw: 0,
    clearance: 2,
    roughness: 'flat',
    verifiedAt: 0,
    reachCost: 10,
    surface: 'minecraft:stone',
    hazards: [],
    ...overrides,
  }
}

function observation(overrides: Partial<FlightObservation> = {}): FlightObservation {
  return {
    tick: 0,
    position: { x: 0, y: 100, z: 0 },
    velocity: { x: 0.5, y: 0, z: 0 },
    yaw: 0,
    pitch: 0,
    poseBox: { width: 0.6, height: 1.8 },
    health: 20,
    firework: { active: false, ticksRemaining: 0 },
    onGround: false,
    inWater: false,
    ...overrides,
  }
}

describe('reduceLifecycle', () => {
  it('walks the ordered phases', () => {
    let state = reduceLifecycle(INITIAL_LIFECYCLE, { kind: 'enter', phase: 'Launch' })
    expect(state.phase).toBe('Launch')
    state = reduceLifecycle(state, { kind: 'enter', phase: 'Cruise' })
    state = reduceLifecycle(state, { kind: 'enter', phase: 'Approach' })
    state = reduceLifecycle(state, { kind: 'enter', phase: 'Flare' })
    state = reduceLifecycle(state, { kind: 'enter', phase: 'Touchdown' })
    state = reduceLifecycle(state, { kind: 'terminate', reason: 'reached' })
    expect(state.phase).toBe('Terminated')
    expect(state.exitReason).toBe('reached')
  })

  it('refuses an illegal jump', () => {
    const state = reduceLifecycle(INITIAL_LIFECYCLE, { kind: 'enter', phase: 'Touchdown' })
    expect(state.phase).toBe('Prepare')
  })

  it('runs a bounded go-around and blocks an early approach re-entry', () => {
    let state = reduceLifecycle({ ...INITIAL_LIFECYCLE, phase: 'Approach' }, { kind: 'go-around' })
    expect(state.phase).toBe('GoAround')
    expect(state.goAroundPhase).toBe('recover')
    expect(state.goArounds).toBe(1)
    // Still in GoAround: the approach is not allowed before the phases finish.
    state = reduceLifecycle(state, { kind: 'enter', phase: 'Approach' })
    expect(state.phase).toBe('GoAround')
    state = reduceLifecycle(state, { kind: 'go-around-phase', phase: 'leave' })
    state = reduceLifecycle(state, { kind: 'go-around-complete' })
    expect(state.phase).toBe('Approach')
  })

  it('falls back to an emergency landing after the go-around budget', () => {
    const state = reduceLifecycle({ ...INITIAL_LIFECYCLE, phase: 'Approach', goArounds: 1 }, { kind: 'go-around' })
    expect(state.phase).toBe('EmergencyLanding')
  })

  it('honours a lower go-around budget from the session supply', () => {
    const state = reduceLifecycle({ ...INITIAL_LIFECYCLE, phase: 'Approach' }, { kind: 'go-around' }, { maxGoArounds: 0 })
    expect(state.phase).toBe('EmergencyLanding')
  })

  it('ignores events once terminated', () => {
    const terminated = reduceLifecycle(INITIAL_LIFECYCLE, { kind: 'terminate', reason: 'reached' })
    expect(reduceLifecycle(terminated, { kind: 'enter', phase: 'Cruise' }).phase).toBe('Terminated')
  })
})

describe('selectLaunchPoint', () => {
  const requirements = DEFAULT_LAUNCH_REQUIREMENTS
  /** Level ground: one surface height, open sky above it. */
  const level = (y: number) => ({
    surfaceAt: (): LaunchColumnProbe => ({ kind: 'surface', y }),
    clearAt: (): boolean => true,
  })
  /** A pad that ends at `z >= 1` over real air, with open sky above. */
  const cliff = {
    surfaceAt: (_x: number, z: number): LaunchColumnProbe => (z >= 1 ? { kind: 'void' } : { kind: 'surface', y: 64 }),
    clearAt: (): boolean => true,
  }

  it('accepts level ground under open sky as a flat launch', () => {
    // CONTRACT CHANGE (OV-5): level ground used to be refused outright, because
    // the only takeoff was a run off an edge. The bridge's launch macro lifts
    // off in place with a rocket, so a proven ceiling is now the requirement.
    const plan = selectLaunchPoint({
      from: { x: 0, y: 66, z: 0 },
      heading: 0,
      ...level(64),
      requirements,
    })
    expect(plan.ok).toBe(true)
    if (plan.ok) {
      expect(plan.candidate.kind).toBe('flat')
      expect(plan.candidate.drop).toBe(0)
      expect(plan.candidate.clearance).toBeGreaterThanOrEqual(requirements.flatCeiling)
    }
  })

  it('refuses level ground under a ceiling that is too low to boost through', () => {
    const plan = selectLaunchPoint({
      from: { x: 0, y: 66, z: 0 },
      heading: 0,
      surfaceAt: () => ({ kind: 'surface', y: 64 }),
      // A roof two blocks up: a jump fits, the climb after the deploy does not.
      clearAt: (_x, y) => y <= 66,
      requirements,
    })
    expect(plan).toEqual({ ok: false, reason: 'launch_unavailable' })
  })

  it('finds a cliff edge with forward clearance and a drop', () => {
    const plan = selectLaunchPoint({
      from: { x: 0, y: 66, z: 0 },
      heading: 0,
      ...cliff,
      requirements,
    })
    expect(plan.ok).toBe(true)
    if (plan.ok) {
      expect(plan.candidate.kind).toBe('edge')
      expect(plan.candidate.drop).toBeGreaterThanOrEqual(requirements.minDrop)
    }
  })

  it('refuses a cliff whose launch column has no clearance', () => {
    const plan = selectLaunchPoint({
      from: { x: 0, y: 66, z: 0 },
      heading: 0,
      ...cliff,
      clearAt: () => false,
      requirements,
    })
    expect(plan).toEqual({ ok: false, reason: 'launch_unavailable' })
  })

  it('never picks an edge whose drop cannot cover the deploy fall', () => {
    // deployTicks 20 needs ~16 blocks of free fall, but the cliff only offers
    // the minimum 12-block drop, so the edge is out. The same shelf still
    // supports a flat launch under open sky, which is the honest answer.
    const plan = selectLaunchPoint({
      from: { x: 0, y: 66, z: 0 },
      heading: 0,
      ...cliff,
      requirements: { ...requirements, deployTicks: 20 },
    })
    expect(plan.ok).toBe(true)
    if (plan.ok)
      expect(plan.candidate.kind).toBe('flat')
  })

  it('refuses a takeoff whose drop cannot cover the deploy fall under a low ceiling', () => {
    const plan = selectLaunchPoint({
      from: { x: 0, y: 66, z: 0 },
      heading: 0,
      ...cliff,
      clearAt: (_x, y) => y <= 66,
      requirements: { ...requirements, deployTicks: 20 },
    })
    expect(plan).toEqual({ ok: false, reason: 'launch_unavailable' })
  })

  it('refuses a cliff without a post-launch corridor', () => {
    const plan = selectLaunchPoint({
      from: { x: 0, y: 66, z: 0 },
      heading: 0,
      ...cliff,
      corridorFrom: () => false,
      requirements,
    })
    expect(plan).toEqual({ ok: false, reason: 'launch_unavailable' })
  })

  it('never reads an unknown runway end as a cliff', () => {
    // ROOT CAUSE: the scan treated `surfaceAt === undefined` as "air beyond the
    // runway", so an unloaded or unread column satisfied the minimum drop and
    // every fog edge looked like a launch site (OV-D16). The flat takeoff, which
    // needs no forward ground, is the only candidate left.
    const plan = selectLaunchPoint({
      from: { x: 0, y: 66, z: 0 },
      heading: 0,
      surfaceAt: (_x, z) => (z >= 1 ? { kind: 'unknown' } : { kind: 'surface', y: 64 }),
      clearAt: () => true,
      requirements,
    })
    expect(plan.ok).toBe(true)
    if (plan.ok)
      expect(plan.candidate.kind).toBe('flat')
  })

  it('reports unreadable terrain instead of claiming no launch exists', () => {
    const plan = selectLaunchPoint({
      from: { x: 0, y: 66, z: 0 },
      heading: 0,
      surfaceAt: () => ({ kind: 'unknown' }),
      clearAt: () => undefined,
      requirements,
      searchRadius: 1,
    })
    expect(plan.ok).toBe(false)
    if (!plan.ok) {
      expect(plan.reason).toBe('launch_terrain_unknown')
      expect(plan.unknownColumns).toBeGreaterThan(0)
    }
  })

  it('lets the caller ask for the cliff when the rocket supply is empty', () => {
    // Both takeoffs exist here: z=4 is air (a drop four blocks forward) while
    // z=5 and beyond are level ground. A caller with no rockets must not be
    // handed the flat launch, whose only lift is the rocket.
    const mixed = {
      from: { x: 0.5, y: 66, z: 0.5 },
      heading: 0,
      surfaceAt: (_x: number, z: number): LaunchColumnProbe => (z === 4 ? { kind: 'void' } : { kind: 'surface', y: 64 }),
      clearAt: (): boolean => true,
      requirements,
    }
    const flatPreferred = selectLaunchPoint(mixed)
    const edgePreferred = selectLaunchPoint({ ...mixed, prefer: 'edge' })
    expect(flatPreferred.ok).toBe(true)
    expect(edgePreferred.ok).toBe(true)
    if (flatPreferred.ok)
      expect(flatPreferred.candidate.kind).toBe('flat')
    if (edgePreferred.ok)
      expect(edgePreferred.candidate.kind).toBe('edge')
  })
})

describe('planApproach', () => {
  it('accepts a feasible approach', () => {
    const decision = planApproach({ site: site(), observation: observation() })
    expect(decision.ok).toBe(true)
    if (decision.ok)
      expect(decision.plan.requiredDescentDeg).toBeGreaterThan(0)
  })

  it('goes around early when there is not enough height', () => {
    const decision = planApproach({ site: site(), observation: observation({ position: { x: 0, y: 66, z: 0 } }) })
    expect(decision).toEqual({ ok: false, reason: 'go_around' })
  })

  it('goes around when too fast to stop over the remaining distance', () => {
    const decision = planApproach({
      site: site({ support: { x: 10, y: 63, z: 0, width: 2, depth: 2 } }),
      observation: observation({ position: { x: 0, y: 200, z: 0 }, velocity: { x: 2, y: 0, z: 0 } }),
    })
    expect(decision).toEqual({ ok: false, reason: 'go_around' })
  })
})

describe('stepGoAroundPhase', () => {
  const goal = { x: 0, y: 64, z: 0 }

  it('orders recover, leave, re-align and done', () => {
    expect(stepGoAroundPhase({ phase: 'recover', observation: observation({ position: { x: 0, y: 70, z: 0 } }), goal })).toBe('recover')
    expect(stepGoAroundPhase({ phase: 'recover', observation: observation({ position: { x: 0, y: 73, z: 0 } }), goal })).toBe('leave')
    expect(stepGoAroundPhase({ phase: 'leave', observation: observation({ position: { x: 0, y: 80, z: 10 } }), goal })).toBe('leave')
    expect(stepGoAroundPhase({ phase: 'leave', observation: observation({ position: { x: 0, y: 80, z: 70 } }), goal })).toBe('re-align')
    expect(stepGoAroundPhase({ phase: 're-align', observation: observation({ position: { x: 0, y: 80, z: 70 }, yaw: 180 }), goal })).toBe('done')
  })
})

describe('planEmergencyLanding', () => {
  it('picks the cheapest verified site', () => {
    const decision = planEmergencyLanding({ observation: observation(), candidates: [site({ reachCost: 30 }), site({ reachCost: 5 })] })
    expect(decision.ok).toBe(true)
    if (decision.ok)
      expect(decision.site.reachCost).toBe(5)
  })

  it('refuses hazardous sites', () => {
    const decision = planEmergencyLanding({ observation: observation(), candidates: [site({ hazards: ['minecraft:fire'] })] })
    expect(decision.ok).toBe(false)
    if (!decision.ok) {
      expect(decision.reason).toBe('no_reachable_landing')
      expect(decision.minimalRisk.note).toContain('not a landing site')
    }
  })

  it('reports no_reachable_landing with no candidates', () => {
    const decision = planEmergencyLanding({ observation: observation(), candidates: [] })
    expect(decision.ok).toBe(false)
  })
})

describe('prepareFlight', () => {
  const intent: FlightIntent = {
    sessionId: 's1',
    revision: 1,
    type: 'transit',
    target: { center: { x: 0, y: 64, z: 0 }, radius: 4, dimension: 'overworld', worldId: 'w' },
    supply: { fireworks: 8, reserveTicks: 2 },
  }

  it('prepares a session with rockets', () => {
    expect(prepareFlight(intent).ok).toBe(true)
  })

  it('refuses a session with no rockets', () => {
    expect(prepareFlight({ ...intent, supply: { fireworks: 0, reserveTicks: 0 } })).toEqual({ ok: false, reason: 'launch_unavailable' })
  })
})

describe('buildFlightStatus', () => {
  it('carries the phase and budget', () => {
    const status = buildFlightStatus({ state: INITIAL_LIFECYCLE, budget: { fireworks: 8, reserveTicks: 2 }, deviation: 1.5 })
    expect(status.phase).toBe('Prepare')
    expect(status.deviation).toBe(1.5)
  })
})
