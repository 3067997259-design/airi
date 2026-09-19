import type { TargetObservation } from './target-observation'

import { describe, expect, it } from 'vitest'

import {
  AIR_LAUNCH_CONFIRM_TICKS,
  assessAirLaunch,
  createAirFollowController,
} from './air-follow'

function obs(overrides: Partial<TargetObservation> = {}): TargetObservation {
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
    position: { x: 18, y: 80, z: 0 },
    velocity: { x: 0.4, y: 0, z: 0 },
    ...overrides,
  }
}

const self = { position: { x: 0, y: 64, z: 0 }, onGround: false, fallFlying: true, health: 20, fireworks: 16 }

function driveTakeoff() {
  const controller = createAirFollowController({ travelMode: 'auto' })
  let directive = controller.step(obs(), { tick: 1, at: 0, fine: true, self })
  expect(directive.action).toBe('ground-follow')
  directive = controller.step(obs(), { tick: 2, at: 50, fine: true, self })
  expect(directive.action).toBe('ground-follow')
  directive = controller.step(obs(), { tick: 3, at: 100, fine: true, self })
  expect(directive.action).toBe('assess-launch')
  return controller
}

describe('air follow launch assessment', () => {
  it('stays on the ground in ground mode even when the target glides', () => {
    const controller = createAirFollowController({ travelMode: 'ground' })
    for (let tick = 1; tick <= 5; tick++)
      expect(controller.step(obs(), { tick, at: tick * 50, fine: true, self }).action).toBe('ground-follow')
    expect(controller.phase()).toBe('ground-follow')
  })

  it(`needs ${AIR_LAUNCH_CONFIRM_TICKS} consecutive flying samples before assessing`, () => {
    const controller = driveTakeoff()
    expect(controller.phase()).toBe('assess-launch')
  })

  it('does not count an unobserved pose toward the takeoff streak', () => {
    const controller = createAirFollowController({ travelMode: 'auto' })
    controller.step(obs(), { tick: 1, at: 0, fine: true, self })
    controller.step(obs(), { tick: 2, at: 50, fine: true, self })
    const directive = controller.step(obs({ fallFlying: 'unobserved' }), { tick: 3, at: 100, fine: true, self })
    expect(directive.action).toBe('ground-follow')
  })

  it('moves to launching and air tracking after a referenced deploy', () => {
    const controller = driveTakeoff()
    expect(controller.noteLaunchBegan().action).toBe('launch')
    expect(controller.phase()).toBe('launching')
    expect(controller.noteLaunchDeployed(150).action).toBe('track')
    expect(controller.phase()).toBe('air-track')
    const directive = controller.step(obs(), { tick: 4, at: 200, fine: true, self })
    expect(directive.action).toBe('track')
  })

  it('does not re-assess a refused launch while the target keeps gliding', () => {
    const controller = driveTakeoff()
    controller.noteLaunchRefused('cannot_air_follow')
    for (let tick = 4; tick <= 8; tick++) {
      const directive = controller.step(obs(), { tick, at: tick * 50, fine: true, self })
      expect(directive.action).toBe('ground-follow')
    }
    expect(controller.snapshot().cannotAirFollow).toBe(true)
  })

  it('re-assesses after the target lands and takes off again', () => {
    const controller = driveTakeoff()
    controller.noteLaunchRefused('cannot_air_follow')
    controller.step(obs({ fallFlying: false, onGround: true, velocity: { x: 0, y: 0, z: 0 } }), { tick: 4, at: 150, fine: true, self })
    // Three fresh flying samples after the observed touch-down.
    controller.step(obs(), { tick: 5, at: 200, fine: true, self })
    controller.step(obs(), { tick: 6, at: 250, fine: true, self })
    const directive = controller.step(obs(), { tick: 7, at: 300, fine: true, self })
    expect(directive.action).toBe('assess-launch')
  })
})

describe('air follow target landing detection', () => {
  function deploy() {
    const controller = driveTakeoff()
    controller.noteLaunchBegan()
    controller.noteLaunchDeployed(150)
    return controller
  }

  it('requires a grounded low-speed pose over consecutive samples', () => {
    const controller = deploy()
    const landedSample = obs({ fallFlying: false, onGround: true, velocity: { x: 0, y: 0, z: 0 } })
    expect(controller.step(landedSample, { tick: 4, at: 200, fine: true, self }).action).toBe('track')
    expect(controller.step(landedSample, { tick: 5, at: 250, fine: true, self }).action).toBe('track')
    const directive = controller.step(landedSample, { tick: 6, at: 300, fine: true, self })
    expect(directive.action).toBe('approach-landing')
  })

  it('does not treat a glide that stopped midair as a landing', () => {
    const controller = deploy()
    // fallFlying false but not on the ground: the target is falling, not landed.
    const falling = obs({ fallFlying: false, onGround: false, velocity: { x: 0.3, y: -1.2, z: 0 } })
    for (let tick = 4; tick <= 8; tick++) {
      const directive = controller.step(falling, { tick, at: tick * 50, fine: true, self })
      expect(directive.action).not.toBe('approach-landing')
    }
  })
})

describe('air follow cancel, budget and interrupts', () => {
  function deploy(controller: ReturnType<typeof createAirFollowController>) {
    controller.noteLaunchBegan()
    controller.noteLaunchDeployed(150)
    return controller
  }

  it('revokes the pursuit into a bounded safety landing on cancel', () => {
    const controller = deploy(driveTakeoff())
    const directive = controller.cancel()
    expect(directive.action).toBe('safety-landing')
    expect(controller.phase()).toBe('safety-landing')
    const terminal = controller.noteSafetyLandingComplete(true)
    expect(terminal.action).toBe('terminate')
    expect(terminal.reason).toBe('cancelled')
    // A cancel never auto-resumes.
    expect(controller.step(obs(), { tick: 9, at: 400, fine: true, self }).action).toBe('terminate')
  })

  it('aborts to a safety landing when health reaches the floor', () => {
    const controller = deploy(driveTakeoff())
    const directive = controller.step(obs(), { tick: 4, at: 200, fine: true, self: { ...self, health: 6 } })
    expect(directive.action).toBe('safety-landing')
    expect(directive.reason).toBe('low_health')
  })

  it('aborts to a safety landing when only the reserve fireworks remain', () => {
    const controller = deploy(driveTakeoff())
    const directive = controller.step(obs(), { tick: 4, at: 200, fine: true, self: { ...self, fireworks: 2 } })
    expect(directive.action).toBe('safety-landing')
    expect(directive.reason).toBe('low_supply')
  })

  it('interrupts every state on death, dimension change and connection loss', () => {
    for (const [cause, reason] of [['death', 'dead'], ['dimension-change', 'dimension_changed'], ['connection-loss', 'connection_lost']] as const) {
      const controller = deploy(driveTakeoff())
      const directive = controller.interrupt(cause)
      expect(directive.action).toBe('terminate')
      expect(directive.reason).toBe(reason)
    }
  })

  it('reports follow_completed for a normal ground duration end', () => {
    const controller = createAirFollowController({ travelMode: 'auto' })
    const directive = controller.complete()
    expect(directive.action).toBe('terminate')
    expect(directive.reason).toBe('follow_completed')
    expect(controller.snapshot().endReason).toBe('follow_completed')
  })
})

describe('air follow receipt', () => {
  it('records active time, band time, loss count, mode switches and firework spend', () => {
    const controller = driveTakeoff()
    controller.noteLaunchBegan()
    controller.noteLaunchDeployed(100)
    controller.noteFireworkSpent(2)
    // Two samples 100 ms apart, inside the spacing band (distance ~18).
    controller.step(obs(), { tick: 4, at: 200, fine: true, self })
    controller.step(obs(), { tick: 5, at: 300, fine: true, self })
    // A lost fine sample counts one loss and enters reacquire.
    controller.step(undefined, { tick: 6, at: 400, fine: false, self })
    // A fresh sample recovers.
    controller.step(obs(), { tick: 7, at: 500, fine: true, self })
    const receipt = controller.snapshot()
    expect(receipt.activeMs).toBeGreaterThan(0)
    expect(receipt.bandMs).toBeGreaterThan(0)
    expect(receipt.bandRatio).toBeGreaterThan(0)
    expect(receipt.lossCount).toBe(1)
    expect(receipt.modeSwitches).toBe(1)
    expect(receipt.fireworkSpend).toBe(2)
    expect(receipt.launchAttempts).toBe(1)
    expect(receipt.finalTargetObservation).toBeDefined()
  })
})

describe('assessAirLaunch', () => {
  const base = { hasElytra: true, fireworks: 16, health: 20, launchSiteAvailable: true, deadlineReached: false }

  it('accepts a well-equipped launch', () => {
    expect(assessAirLaunch(base)).toEqual({ ok: true })
  })

  it('refuses missing gear, a missing launch edge and thin supply', () => {
    expect(assessAirLaunch({ ...base, hasElytra: false })).toEqual({ ok: false, reason: 'cannot_air_follow' })
    expect(assessAirLaunch({ ...base, launchSiteAvailable: false })).toEqual({ ok: false, reason: 'launch_unavailable' })
    expect(assessAirLaunch({ ...base, fireworks: 2 })).toEqual({ ok: false, reason: 'low_supply' })
    expect(assessAirLaunch({ ...base, health: 6 })).toEqual({ ok: false, reason: 'low_health' })
    expect(assessAirLaunch({ ...base, elytraWornRatio: 0.9 })).toEqual({ ok: false, reason: 'elytra_worn' })
    expect(assessAirLaunch({ ...base, deadlineReached: true })).toEqual({ ok: false, reason: 'timeout' })
  })
})

describe('escort insertion point (LR-1)', () => {
  it('waits in the escort phase while the strategy is still assessing', () => {
    const controller = createAirFollowController({ travelMode: 'auto', escort: { mode: 'on', approve: () => 'assess' } })
    let directive = controller.step(obs(), { tick: 1, at: 0, fine: true, self })
    directive = controller.step(obs(), { tick: 2, at: 50, fine: true, self })
    directive = controller.step(obs(), { tick: 3, at: 100, fine: true, self })
    expect(directive.action).toBe('escort-hold')
    expect(directive.phase).toBe('escort')
  })

  it('proceeds to assess-launch once the strategy permits a chase', () => {
    let verdict: 'assess' | 'launch' | 'hold' = 'assess'
    const controller = createAirFollowController({ travelMode: 'auto', escort: { mode: 'on', approve: () => verdict } })
    let directive = controller.step(obs(), { tick: 1, at: 0, fine: true, self })
    directive = controller.step(obs(), { tick: 2, at: 50, fine: true, self })
    directive = controller.step(obs(), { tick: 3, at: 100, fine: true, self })
    expect(directive.action).toBe('escort-hold')
    verdict = 'launch'
    directive = controller.step(obs(), { tick: 4, at: 150, fine: true, self })
    expect(directive.action).toBe('assess-launch')
  })

  it('keeps the ground follow when the strategy refuses the chase', () => {
    // A refusal is not a hold: the follow keeps walking instead of parking in
    // the escort phase, so the ground leg still makes progress (design D2/D8).
    const controller = createAirFollowController({ travelMode: 'auto', escort: { mode: 'on', approve: () => 'hold' } })
    let directive = controller.step(obs(), { tick: 1, at: 0, fine: true, self })
    directive = controller.step(obs(), { tick: 2, at: 50, fine: true, self })
    directive = controller.step(obs(), { tick: 3, at: 100, fine: true, self })
    expect(directive.action).toBe('ground-follow')
    expect(directive.phase).toBe('ground-follow')
  })

  it('keeps the original flow when escort is off', () => {
    const controller = createAirFollowController({ travelMode: 'auto', escort: { mode: 'off', approve: () => 'hold' } })
    let directive = controller.step(obs(), { tick: 1, at: 0, fine: true, self })
    directive = controller.step(obs(), { tick: 2, at: 50, fine: true, self })
    directive = controller.step(obs(), { tick: 3, at: 100, fine: true, self })
    expect(directive.action).toBe('assess-launch')
  })
})
