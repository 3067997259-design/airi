import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { computeGlideResiduals, type GlideRecordingSample } from '../../../../apps/stage-tamagotchi/src/main/services/airi/game-host/flight/calibration'
import { FLIGHT_PROFILE_VERSION } from '../../../../apps/stage-tamagotchi/src/main/services/airi/game-host/flight/profile'
import { resolveFlightProfile } from '../../../../apps/stage-tamagotchi/src/main/services/airi/game-host/flight/profile'

// E-01 residual audit over a captured glide. Set E01_RECORDING to a JSONL
// written by capture-glide.mjs; without it this file skips (offline runs have
// no recording to judge). The printed residuals are the evidence; the PASS
// threshold is a baseline decision recorded in the checklist, not asserted
// here (design §6: thresholds are first-round suggestions until baselined).

const recordingPath = process.env.E01_RECORDING

describe('E-01 glide residuals', () => {
  it.skipIf(!recordingPath)('computes 10/20/40 tick residuals for the captured glide', () => {
    const recording = JSON.parse(readFileSync(recordingPath!, 'utf8')) as {
      inputs: { yaw: number, pitch: number }
      samples: GlideRecordingSample[]
    }
    const resolution = resolveFlightProfile(FLIGHT_PROFILE_VERSION)
    expect(resolution.ok).toBe(true)
    if (!resolution.ok)
      return

    const report = computeGlideResiduals(resolution.profile, recording.samples, recording.inputs)
    console.log('E-01 residuals:', JSON.stringify({
      notes: report.notes,
      points: report.points.map(point => ({
        tick: point.tick,
        errorBlocks: Number(point.errorBlocks.toFixed(3)),
        sampleJitterMs: point.sampleJitterMs,
      })),
    }, null, 2))

    expect(report.notes).toEqual([])
    expect(report.points).toHaveLength(3)
  })
})
