import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { computeGlideResiduals, dedupeGlideRecording, startGlideAudit } from '../../../../apps/stage-tamagotchi/src/main/services/airi/game-host/flight/calibration'
import { FLIGHT_PROFILE_1_21_1 } from '../../../../apps/stage-tamagotchi/src/main/services/airi/game-host/flight/profile'

// E-01 residual table over every captured glide.
//
// The audit collapses repeated reads of one client tick (see
// `dedupeGlideRecording`) and reports the settled-glide window as well as the
// full window, because the capture starts at the elytra deploy while the bot
// still carries the sprint jump's velocity. Thresholds stay a baseline decision
// (design §9, checklist §6): this file reports numbers, it does not pass them.
//
// Usage: E01_RECORDINGS=<comma-separated paths> pnpm exec vitest run --config docs/fork/evidence/e01-flight-calibration-20260918/vitest.config.ts -t 'reports'
const paths = (process.env.E01_RECORDINGS ?? '').split(',').map(p => p.trim()).filter(Boolean)
/** Ticks of launch transient dropped from the settled window. */
const SETTLE_TICKS = 20

describe('E-01 residual table', () => {
  it.skipIf(paths.length === 0)('reports 10/20/40 residuals for every recording', () => {
    const rows = []
    for (const path of paths) {
      const recording = JSON.parse(readFileSync(path, 'utf8'))
      const label = path.split(/[\\/]/).pop()
      const distinct = dedupeGlideRecording(recording.samples)
      const full = computeGlideResiduals(FLIGHT_PROFILE_1_21_1, distinct, recording.inputs)
      const settled = computeGlideResiduals(FLIGHT_PROFILE_1_21_1, startGlideAudit(distinct, SETTLE_TICKS), recording.inputs)
      rows.push({
        label,
        pitch: recording.inputs.pitch,
        reads: recording.samples.length,
        distinctTicks: distinct.length,
        spanSeconds: Number(((recording.samples.at(-1).at - recording.samples[0].at) / 1000).toFixed(1)),
        fullWindow: Object.fromEntries(full.points.map(p => [p.tick, Number(p.errorBlocks.toFixed(6))])),
        settledWindow: Object.fromEntries(settled.points.map(p => [p.tick, Number(p.errorBlocks.toFixed(6))])),
        fullNotes: full.notes,
        settledNotes: settled.notes,
        jitter: Object.fromEntries(settled.points.map(p => [p.tick, p.sampleJitterMs])),
      })
    }
    console.log(JSON.stringify(rows, null, 2))
    expect(rows.length).toBe(paths.length)
  })
})
