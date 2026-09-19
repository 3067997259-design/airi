import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { dedupeGlideRecording } from '../../../../apps/stage-tamagotchi/src/main/services/airi/game-host/flight/calibration'

// Measures how long one firework boost actually lasts, from the recorded speed.
//
// `FLIGHT_PROFILE_1_21_1` fixes the boost at 10 ticks (`ROCKET_BOOST_TICKS`,
// `live-port.ts`) and the model follows that. A live burn held its plateau speed
// from the impulse past tick 30 while the model started decaying at tick 10, so
// the constant is the first candidate for a real defect. This reports the plateau
// end and the decay curve so the number can be fitted.
//
// Usage: E01_BOOST=<path> pnpm exec vitest run --config docs/fork/evidence/e01-flight-calibration-20260918/vitest.config.ts -t 'measures the boost lifetime'
const boostPath = process.env.E01_BOOST

describe('E-01 boost lifetime', () => {
  it.skipIf(!boostPath)('measures the boost lifetime from the recorded speed', () => {
    const recording = JSON.parse(readFileSync(boostPath!, 'utf8'))
    const ticks = dedupeGlideRecording(recording.samples)
    const speed = sample => Math.hypot(sample.motion.x, sample.motion.y, sample.motion.z)
    const speeds = ticks.map(speed)

    let burn = -1
    for (let index = 1; index < speeds.length; index++) {
      if (speeds[index]! - speeds[index - 1]! > 0.3) {
        burn = index
        break
      }
    }
    expect(burn).toBeGreaterThan(0)
    if (burn <= 0)
      return

    // Plateau end: the last tick whose speed is within 0.5% of the maximum
    // reached soon after the burn.
    const peak = Math.max(...speeds.slice(burn, burn + 30))
    let plateauEnd = burn
    for (let index = burn; index < speeds.length; index++) {
      if (speeds[index]! >= peak * 0.995)
        plateauEnd = index
      else if (index > plateauEnd + 5)
        break
    }
    const plateauTicks = plateauEnd - burn

    console.log(`burn at tick ${burn}; peak speed ${peak.toFixed(4)}`)
    console.log(`plateau (speed >= ${(peak * 0.995).toFixed(4)}) runs to tick ${plateauEnd} = ${plateauTicks} ticks after the impulse`)
    console.log('speed trace, burn-2 .. burn+45:')
    for (let index = Math.max(0, burn - 2); index <= Math.min(speeds.length - 1, burn + 45); index++) {
      const relative = index - burn
      const marker = index === plateauEnd ? '  <- plateau end' : ''
      console.log(`  t+${String(relative).padStart(3)}  ${speeds[index]!.toFixed(4)}${marker}`)
    }
    // Post-plateau decay per tick, which is what a wrong boost lifetime shows up
    // as: the model decays while the game still holds the plateau.
    if (plateauEnd + 5 < speeds.length) {
      const drop = speeds[plateauEnd]! - speeds[plateauEnd + 5]!
      console.log(`decay over the 5 ticks after the plateau: ${drop.toFixed(4)} (${(drop / 5).toFixed(4)}/tick)`)
    }
    expect(plateauTicks).toBeGreaterThan(0)
  })
})
