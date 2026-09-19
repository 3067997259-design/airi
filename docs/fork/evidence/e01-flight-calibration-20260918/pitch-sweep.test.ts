import { describe, expect, it } from 'vitest'

import { FLIGHT_PROFILE_1_21_1 } from '../../../../apps/stage-tamagotchi/src/main/services/airi/game-host/flight/profile'
import { simulateFlight } from '../../../../apps/stage-tamagotchi/src/main/services/airi/game-host/flight/simulation'

// Measures what each pitch actually does to an elytra glide in the model.
//
// Used to answer "why can she not dive": the earlier claim was inferred from the
// level-flight glide ratio rather than simulated, and the answer decides whether
// a "dive into a slot canyon" scenario is reachable at all.
//
// Usage: pnpm exec vitest run --config docs/fork/evidence/e01-flight-calibration-20260918/vitest.config.ts -t 'pitch'
describe('E-01 pitch sweep', () => {
  it('reports the sink and advance per pitch', () => {
    const startY = 200
    console.log('pitch | after 40 ticks: advance | sink | glide ratio | vertical speed')
    for (const pitch of [30, 20, 10, 0, -3, -10, -20, -30, -45, -60, -70, -80, -89]) {
      const trajectory = simulateFlight(FLIGHT_PROFILE_1_21_1, {
        position: { x: 0, y: startY, z: 0 },
        velocity: { x: 0, y: 0, z: 0.563 },
        yaw: 90,
        pitch,
        rocketTicksRemaining: 0,
        onGround: false,
        inWater: false,
      }, Array.from({ length: 40 }, () => ({ yaw: 90, pitch, useRocket: false, rocketAvailable: false })))

      const last = trajectory.samples.at(-1)
      const first = trajectory.samples[0]
      if (!last)
        continue
      const advance = Math.abs(last.position.x - 0)
      const sink = startY - last.position.y
      const ratio = sink > 0 ? advance / sink : Number.POSITIVE_INFINITY
      const vertical = last.velocity.y
      console.log(`${String(pitch).padStart(5)} | ${advance.toFixed(1).padStart(19)} | ${sink.toFixed(1).padStart(4)} | ${(Number.isFinite(ratio) ? ratio.toFixed(2) : '∞').padStart(11)} | ${vertical.toFixed(4).padStart(14)}`)
      expect(first).toBeDefined()
    }
  })

  it('reports the steepest descent the model can reach at any pitch', () => {
    // A dive is only useful if it beats level flight at losing altitude, so sweep
    // every pitch the profile allows and keep the best sink.
    let best = { pitch: 0, sink: -Infinity, advance: 0 }
    for (let pitch = -89; pitch <= 89; pitch += 1) {
      const trajectory = simulateFlight(FLIGHT_PROFILE_1_21_1, {
        position: { x: 0, y: 200, z: 0 },
        velocity: { x: 0, y: 0, z: 0.563 },
        yaw: 90,
        pitch,
        rocketTicksRemaining: 0,
        onGround: false,
        inWater: false,
      }, Array.from({ length: 100 }, () => ({ yaw: 90, pitch, useRocket: false, rocketAvailable: false })))
      const last = trajectory.samples.at(-1)
      if (!last)
        continue
      const sink = 200 - last.position.y
      if (sink > best.sink)
        best = { pitch, sink, advance: Math.abs(last.position.x) }
    }
    console.log(`steepest descent over 100 ticks: pitch ${best.pitch}, sink ${best.sink.toFixed(1)} blocks, advance ${best.advance.toFixed(1)} blocks`)
    console.log(`=> to lose 40 blocks takes about ${(40 / (best.sink / 100)).toFixed(0)} ticks at that pitch`)
    expect(best.sink).toBeGreaterThan(0)
  })
})
