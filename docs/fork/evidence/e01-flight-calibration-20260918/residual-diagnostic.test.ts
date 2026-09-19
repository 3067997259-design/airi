import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { computeGlideResiduals } from '../../../../apps/stage-tamagotchi/src/main/services/airi/game-host/flight/calibration'
import { FLIGHT_PROFILE_1_21_1 } from '../../../../apps/stage-tamagotchi/src/main/services/airi/game-host/flight/profile'
import { simulateFlight } from '../../../../apps/stage-tamagotchi/src/main/services/airi/game-host/flight/simulation'

// Diagnostic, not a pass/fail check: a live glide reported exactly zero error at
// 10/20/40 ticks, which is implausible against real MC data. This prints the
// predicted-vs-actual numbers side by side so the zero can be explained instead
// of trusted.
//
// Usage: E01_RECORDING=<path> pnpm exec vitest run --config docs/fork/evidence/e01-flight-calibration-20260918/vitest.config.ts -t 'prints'
const recordingPath = process.env.E01_RECORDING

describe('E-01 residual diagnostic', () => {
  it.skipIf(!recordingPath)('prints the raw series behind the residuals', () => {
    const recording = JSON.parse(readFileSync(recordingPath!, 'utf8'))
    const samples = recording.samples
    const pitch = recording.inputs.pitch
    const yaw = recording.inputs.yaw

    console.log(`samples=${samples.length} yaw=${yaw} pitch=${pitch}`)
    console.log('first 6 recorded samples:')
    for (const s of samples.slice(0, 6))
      console.log(`  at=${s.at} pos=(${s.position.x.toFixed(3)}, ${s.position.y.toFixed(3)}, ${s.position.z.toFixed(3)}) motion=(${s.motion.x.toFixed(4)}, ${s.motion.y.toFixed(4)}, ${s.motion.z.toFixed(4)})`)

    const motionUnchanged = samples.slice(0, 12).every(s =>
      Math.abs(s.motion.x - samples[0].motion.x) < 1e-9
      && Math.abs(s.motion.y - samples[0].motion.y) < 1e-9
      && Math.abs(s.motion.z - samples[0].motion.z) < 1e-9)
    console.log(`motion identical across the first 12 samples: ${motionUnchanged}`)

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

    console.log(`simulated ${trajectory.samples.length} ticks, endReason=${trajectory.endReason}`)
    for (const tick of [1, 5, 10, 20, 40]) {
      const predicted = trajectory.samples[tick - 1]
      const targetMs = first.at + tick * 50
      let best = samples[1]
      let bestJitter = Infinity
      for (const s of samples) {
        const jitter = Math.abs(s.at - targetMs)
        if (jitter < bestJitter) { best = s; bestJitter = jitter }
      }
      const d = Math.hypot(
        predicted.position.x - best.position.x,
        predicted.position.y - best.position.y,
        predicted.position.z - best.position.z,
      )
      console.log(`tick ${String(tick).padStart(2)}: predicted=(${predicted.position.x.toFixed(3)}, ${predicted.position.y.toFixed(3)}, ${predicted.position.z.toFixed(3)}) `
        + `actual=(${best.position.x.toFixed(3)}, ${best.position.y.toFixed(3)}, ${best.position.z.toFixed(3)}) diff=${d.toFixed(4)} jitter=${bestJitter}ms`)
      console.log(`         simulated motion=(${predicted.velocity.x.toFixed(4)}, ${predicted.velocity.y.toFixed(4)}, ${predicted.velocity.z.toFixed(4)}) recorded motion=(${best.motion.x.toFixed(4)}, ${best.motion.y.toFixed(4)}, ${best.motion.z.toFixed(4)})`)
    }

    const report = computeGlideResiduals(FLIGHT_PROFILE_1_21_1, samples, { yaw, pitch })
    console.log(`report: ${JSON.stringify(report.points.map(p => ({ tick: p.tick, errorBlocks: p.errorBlocks })))}`)
    expect(report.points).toHaveLength(3)
  })
})
