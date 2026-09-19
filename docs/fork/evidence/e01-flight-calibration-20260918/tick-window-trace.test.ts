import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { FLIGHT_PROFILE_1_21_1 } from '../../../../apps/stage-tamagotchi/src/main/services/airi/game-host/flight/profile'
import { simulateFlight } from '../../../../apps/stage-tamagotchi/src/main/services/airi/game-host/flight/simulation'

// Explains the two non-zero E-01 residuals by printing the per-tick series
// around each mark. A physical coefficient error grows monotonically; the live
// runs instead showed a mid-flight jump (pitch -3 run 3) and a large-then-zero
// pattern (pitch -30 run 1), which points at the recording or the tick mapping.
//
// Usage: E01_RECORDING=<path> pnpm exec vitest run --config docs/fork/evidence/e01-flight-calibration-20260918/vitest.config.ts -t 'traces'
const path = process.env.E01_RECORDING

describe('E-01 tick-window trace', () => {
  it.skipIf(!path)('prints the recorded series around the tick marks', () => {
    const recording = JSON.parse(readFileSync(path!, 'utf8'))
    const samples = recording.samples
    const { yaw, pitch } = recording.inputs
    const first = samples[0]

    const trajectory = simulateFlight(FLIGHT_PROFILE_1_21_1, {
      position: { ...first.position },
      velocity: { ...first.motion },
      yaw,
      pitch,
      rocketTicksRemaining: 0,
      onGround: false,
      inWater: false,
    }, Array.from({ length: 40 }, () => ({ yaw, pitch, useRocket: false, rocketAvailable: false })))

    console.log(`samples=${samples.length} yaw=${yaw} pitch=${pitch}`)
    console.log(`first sample at=${first.at} pos=(${first.position.x.toFixed(3)}, ${first.position.y.toFixed(3)}, ${first.position.z.toFixed(3)}) motion=(${first.motion.x.toFixed(4)}, ${first.motion.y.toFixed(4)}, ${first.motion.z.toFixed(4)})`)

    // Byte-identical repeats mean the bridge served a cached read.
    let repeats = 0
    for (let i = 1; i < samples.length; i++) {
      const a = samples[i - 1]
      const b = samples[i]
      if (a.position.x === b.position.x && a.position.y === b.position.y && a.position.z === b.position.z && a.motion.y === b.motion.y)
        repeats++
    }
    console.log(`byte-identical consecutive samples: ${repeats} of ${samples.length - 1}`)

    for (const tick of [10, 20, 40]) {
      const predicted = trajectory.samples[tick - 1]
      const targetMs = first.at + tick * 50
      console.log(`--- tick ${tick} (target ${targetMs}) ---`)
      for (const s of samples) {
        const jitter = s.at - targetMs
        if (Math.abs(jitter) > 260)
          continue
        const d = Math.hypot(
          predicted.position.x - s.position.x,
          predicted.position.y - s.position.y,
          predicted.position.z - s.position.z,
        )
        console.log(`  at+${String(s.at - first.at).padStart(5)}ms jitter=${String(jitter).padStart(5)}ms diff=${d.toFixed(4)}  motion=(${s.motion.x.toFixed(4)}, ${s.motion.y.toFixed(4)}, ${s.motion.z.toFixed(4)})`)
      }
    }
    expect(true).toBe(true)
  })
})
