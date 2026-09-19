import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { dedupeGlideRecording } from '../../../../apps/stage-tamagotchi/src/main/services/airi/game-host/flight/calibration'
import { FLIGHT_PROFILE_1_21_1 } from '../../../../apps/stage-tamagotchi/src/main/services/airi/game-host/flight/profile'
import { simulateFlight } from '../../../../apps/stage-tamagotchi/src/main/services/airi/game-host/flight/simulation'

// Compares the rocket impulse itself, tick by tick, against the model.
//
// A trajectory residual is the wrong instrument for a single impulsive event
// here: the boost audit reported 5.6 blocks at tick 40 in the same recording
// whose speed curve the model reproduces to 0.06 blocks/tick, which says the
// window phase is the problem, not the physics. The impulse is measured by SPEED,
// where phase only shifts the comparison by a tick instead of integrating it.
//
// Usage: E01_BOOST=<path> pnpm exec vitest run --config docs/fork/evidence/e01-flight-calibration-20260918/vitest.config.ts -t 'compares the rocket impulse'
const boostPath = process.env.E01_BOOST

describe('E-01 rocket impulse comparison', () => {
  it.skipIf(!boostPath)('compares the recorded burn with the model burn', () => {
    const recording = JSON.parse(readFileSync(boostPath!, 'utf8'))
    const ticks = dedupeGlideRecording(recording.samples)
    const speed = sample => Math.hypot(sample.motion.x, sample.motion.y, sample.motion.z)

    // Burn onset: the first tick whose speed jumps. The model is then started
    // from the tick BEFORE the burn, so both series share a pre-impulse state.
    let burn = -1
    for (let index = 1; index < ticks.length; index++) {
      if (speed(ticks[index]!) - speed(ticks[index - 1]!) > 0.3) {
        burn = index
        break
      }
    }
    expect(burn).toBeGreaterThan(0)
    if (burn <= 0)
      return

    const yaw = ticks[burn]!.yaw
    const pitch = recording.inputs.pitch
    const lastTick = Math.min(burn + 30, ticks.length - 1)
    const schedule = Array.from({ length: lastTick - burn + 1 }, (_, index) => ({
      yaw,
      pitch,
      useRocket: index === 0,
      rocketAvailable: index === 0,
    }))
    const start = ticks[burn - 1]!
    const trajectory = simulateFlight(FLIGHT_PROFILE_1_21_1, {
      position: { ...start.position },
      velocity: { ...start.motion },
      yaw,
      pitch,
      rocketTicksRemaining: 0,
      onGround: false,
      inWater: false,
    }, schedule)

    console.log(`burn at distinct tick ${burn}; yaw=${yaw} pitch=${pitch}`)
    console.log('tick | recorded speed | model speed | delta')
    let worst = 0
    for (let offset = 0; offset <= lastTick - burn; offset++) {
      const recorded = ticks[burn + offset]
      const modelled = trajectory.samples[offset]
      if (!recorded || !modelled)
        continue
      const recordedSpeed = speed(recorded)
      const modelSpeed = Math.hypot(modelled.velocity.x, modelled.velocity.y, modelled.velocity.z)
      const delta = modelSpeed - recordedSpeed
      worst = Math.max(worst, Math.abs(delta))
      console.log(`${String(offset).padStart(4)} | ${recordedSpeed.toFixed(4).padStart(14)} | ${modelSpeed.toFixed(4).padStart(11)} | ${delta.toFixed(4).padStart(7)}`)
    }
    console.log(`worst |Δspeed| over the burn and 30 ticks after: ${worst.toFixed(4)} blocks/tick`)
    expect(worst).toBeLessThan(1)
  })
})
