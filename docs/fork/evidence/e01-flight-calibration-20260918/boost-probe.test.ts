import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { dedupeGlideRecording } from '../../../../apps/stage-tamagotchi/src/main/services/airi/game-host/flight/calibration'
import { FLIGHT_PROFILE_1_21_1 } from '../../../../apps/stage-tamagotchi/src/main/services/airi/game-host/flight/profile'
import { simulateFlight } from '../../../../apps/stage-tamagotchi/src/main/services/airi/game-host/flight/simulation'

// Probes the rocket impulse constants against a live burn.
//
// The v1 boost capture sampled during a burn that was still decaying (its window
// opened after the fire and closed inside the decay), so the burn is measured by
// fitting rather than by an onset: simulate a burn at a range of offsets and see
// which offset reproduces the recorded decay curve.
//
// Usage: E01_BOOST=<path> pnpm exec vitest run --config docs/fork/evidence/e01-flight-calibration-20260918/vitest.config.ts -t 'fits'
const boostPath = process.env.E01_BOOST

describe('E-01 rocket impulse probe', () => {
  it.skipIf(!boostPath)('fits the recorded boost decay to the model', () => {
    const recording = JSON.parse(readFileSync(boostPath!, 'utf8'))
    const ticks = dedupeGlideRecording(recording.samples)
    const pitch = recording.inputs.pitch
    const yaw = ticks[0]!.yaw
    const speedOf = s => Math.hypot(s.motion.x, s.motion.y, s.motion.z)

    console.log(`distinct ticks=${ticks.length} yaw=${yaw} pitch=${pitch}`)
    console.log('recorded speed by tick (every 4th):')
    const recorded = []
    for (let i = 0; i < Math.min(ticks.length, 80); i += 4)
      recorded.push(`${i}:${speedOf(ticks[i]!).toFixed(4)}`)
    console.log(`  ${recorded.join('  ')}`)
    console.log(`  first sample motion=(${ticks[0]!.motion.x.toFixed(4)}, ${ticks[0]!.motion.y.toFixed(4)}, ${ticks[0]!.motion.z.toFixed(4)})`)

    // Simulate a burn at each candidate offset and compare the decay shape.
    let best
    for (let burnAtTick = 1; burnAtTick <= 12; burnAtTick++) {
      const schedule = Array.from({ length: 40 }, (_, index) => ({
        yaw,
        pitch,
        useRocket: index + 1 === burnAtTick,
        rocketAvailable: index + 1 === burnAtTick,
      }))
      const trajectory = simulateFlight(FLIGHT_PROFILE_1_21_1, {
        position: { ...ticks[0]!.position },
        velocity: { ...ticks[0]!.motion },
        yaw,
        pitch,
        rocketTicksRemaining: 0,
        onGround: false,
        inWater: false,
      }, schedule)
      // Compare only the shape: the vertical decay against the recording's.
      let error = 0
      let count = 0
      for (let tick = 1; tick <= 40; tick++) {
        const predicted = trajectory.samples[tick - 1]
        const actual = ticks[tick]
        if (!predicted || !actual)
          continue
        error += Math.abs(predicted.velocity.y - actual.motion.y)
        count++
      }
      const mean = count === 0 ? Number.NaN : error / count
      console.log(`  burn at tick ${burnAtTick}: mean |Δvy| over ${count} ticks = ${mean.toFixed(5)}`)
      if (!best || mean < best.mean)
        best = { burnAtTick, mean }
    }
    console.log(`best offset: burn at tick ${best.burnAtTick} (mean |Δvy| = ${best.mean.toFixed(5)})`)
    if (best.burnAtTick === 1)
      console.log('=> the recording starts AT the burn: the window is a pure post-burn decay')
    else
      console.log(`=> the recording starts ${best.burnAtTick - 1} tick(s) before the burn`)
    expect(best.burnAtTick).toBeGreaterThan(0)
  })
})
