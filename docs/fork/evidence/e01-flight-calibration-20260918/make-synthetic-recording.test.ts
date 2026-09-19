import { writeFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { simulateFlight } from '../../../../apps/stage-tamagotchi/src/main/services/airi/game-host/flight/simulation'
import { FLIGHT_PROFILE_1_21_1 } from '../../../../apps/stage-tamagotchi/src/main/services/airi/game-host/flight/profile'

// Harness self-test for the E-01 residual audit.
//
// The live run is the only thing that can prove the model meets reality; this
// file proves the harness itself works, so a NOT-RUN or a broken capture cannot
// be mistaken for a calibration result. It writes a recording produced by the
// model, then the residuals test over that recording must report three tick
// marks with near-zero error. Error here means "the pipeline reads the file,
// resolves the profile and maps tick marks", not "the physics is right".
//
// Usage: pnpm exec vitest run --config docs/fork/evidence/e01-flight-calibration-20260918/vitest.config.ts --testNamePattern 'writes'
const OUT = new URL('./synthetic-glide.json', import.meta.url)

describe('E-01 harness self-test', () => {
  it('writes a model-generated recording for the residuals audit', () => {
    const pitch = -3
    const trajectory = simulateFlight(FLIGHT_PROFILE_1_21_1, {
      position: { x: 0, y: 120, z: 0 },
      velocity: { x: 0.8, y: -0.05, z: 0 },
      yaw: 0,
      pitch,
      rocketTicksRemaining: 0,
      onGround: false,
      inWater: false,
    }, Array.from({ length: 60 }, () => ({ yaw: 0, pitch })))

    const recording = {
      schema: 'e01-glide-recording/v1',
      capturedAt: 0,
      inputs: { yaw: 0, pitch, rockets: 0 },
      launch: { position: { x: 0, y: 120, z: 0 } },
      // One sample per tick at the nominal 50 ms cadence, the best case the
      // live capture can reach on the MCP read cadence.
      samples: trajectory.samples.map(sample => ({
        at: sample.tick * 50,
        position: { ...sample.position },
        motion: { ...sample.velocity },
        yaw: 0,
        pitch,
      })),
    }
    writeFileSync(OUT, `${JSON.stringify(recording, null, 2)}\n`)
    expect(recording.samples.length).toBeGreaterThanOrEqual(40)
  })
})
