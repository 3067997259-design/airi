import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { auditGlideWindow, dedupeGlideRecording, findBoostTick, fitYawRatePerTick, startGlideAudit } from '../../../../apps/stage-tamagotchi/src/main/services/airi/game-host/flight/calibration'
import { FLIGHT_PROFILE_1_21_1 } from '../../../../apps/stage-tamagotchi/src/main/services/airi/game-host/flight/profile'

// E-01 manoeuvre audit: the turning and rocket dimensions the steady-glide runs
// did not cover (design §9).
//
// Both manoeuvres reuse `auditGlideWindow`. The turn schedule is a yaw rate
// fitted from the recorded yaw series, so the model is judged against the turn
// the bot actually flew; the boost schedule fires on the tick where the recorded
// vertical velocity jumps, so the audit never trusts the commanded tick over the
// telemetry.
//
// Usage: E01_TURN=<path> E01_BOOST=<path> pnpm exec vitest run --config docs/fork/evidence/e01-flight-calibration-20260918/vitest.config.ts -t 'manoeuvre'
const turnPath = process.env.E01_TURN
const boostPath = process.env.E01_BOOST
const SETTLE_TICKS = 20

describe('E-01 manoeuvre audit', () => {
  it.skipIf(!turnPath)('reports residuals for the steady-yaw turn', () => {
    const recording = JSON.parse(readFileSync(turnPath!, 'utf8'))
    const distinct = dedupeGlideRecording(recording.samples)
    const settled = startGlideAudit(distinct, SETTLE_TICKS)
    // The fitted rate is the fact; `inputs.yawRatePerSecond` is only the plan.
    const fittedRatePerTick = fitYawRatePerTick(settled)
    const plannedRatePerTick = (recording.inputs.yawRatePerSecond ?? 0) / 20
    const startYaw = settled[0]!.yaw
    const pitch = recording.inputs.pitch
    const report = auditGlideWindow(
      FLIGHT_PROFILE_1_21_1,
      settled,
      tick => ({ yaw: startYaw + fittedRatePerTick * tick, pitch }),
    )
    console.log(JSON.stringify({
      mode: 'turn',
      reads: recording.samples.length,
      distinctTicks: distinct.length,
      spanSeconds: Number(((recording.samples.at(-1).at - recording.samples[0].at) / 1000).toFixed(1)),
      plannedYawRatePerSecond: recording.inputs.yawRatePerSecond,
      fittedYawRatePerSecond: Number((fittedRatePerTick * 20).toFixed(3)),
      plannedVersusFitted: Number((plannedRatePerTick === 0 ? 0 : fittedRatePerTick / plannedRatePerTick).toFixed(3)),
      yawTravelDegrees: Number((fittedRatePerTick * settled.length).toFixed(1)),
      residuals: Object.fromEntries(report.points.map(p => [p.tick, Number(p.errorBlocks.toFixed(6))])),
      jitter: Object.fromEntries(report.points.map(p => [p.tick, p.sampleJitterMs])),
      notes: report.notes,
    }, null, 2))
    expect(report.points.length).toBeGreaterThan(0)
  })

  it.skipIf(!boostPath)('reports residuals around the rocket boost', () => {
    const recording = JSON.parse(readFileSync(boostPath!, 'utf8'))
    const all = dedupeGlideRecording(recording.samples)
    const boostTick = findBoostTick(all)
    expect(recording.boost).toBeDefined()
    expect(boostTick).toBeDefined()
    if (boostTick === undefined)
      return

    // The window opens at the pre-burn speed trough, so the compared series is
    // "decelerating glide, one burn, acceleration, plateau, decay". That trough
    // is the speed minimum before the onset: it sits well past the launch
    // transient (`speedBeforeBurn` is around 0.56 against 0.59 at deploy) and it
    // is the only point where the model's initial velocity is not mid-change.
    const speed = sample => Math.hypot(sample.motion.x, sample.motion.y, sample.motion.z)
    let troughIndex = boostTick - 1
    for (let index = boostTick - 1; index > 0; index--) {
      if (speed(all[index]!) <= speed(all[troughIndex]!))
        troughIndex = index
      else
        break
    }

    const pitch = recording.inputs.pitch
    const yaw = all[boostTick]!.yaw
    const BURN_AT_TICK = boostTick - troughIndex + 1
    const window = startGlideAudit(all, troughIndex)
    const report = auditGlideWindow(
      FLIGHT_PROFILE_1_21_1,
      window,
      tick => ({ yaw, pitch, useRocket: tick === BURN_AT_TICK }),
    )
    const before = all[boostTick - 1]!
    const after = all[boostTick]!
    console.log(JSON.stringify({
      mode: 'boost',
      reads: recording.samples.length,
      distinctTicks: all.length,
      telemetryBurnTick: boostTick,
      windowStartTick: troughIndex,
      burnAtWindowTick: BURN_AT_TICK,
      speedBeforeBurn: Number(speed(before).toFixed(4)),
      speedAfterBurn: Number(speed(after).toFixed(4)),
      speedGain: Number((speed(after) - speed(before)).toFixed(4)),
      yawAtBurn: yaw,
      residuals: Object.fromEntries(report.points.map(p => [p.tick, Number(p.errorBlocks.toFixed(6))])),
      jitter: Object.fromEntries(report.points.map(p => [p.tick, p.sampleJitterMs])),
      notes: report.notes,
    }, null, 2))
    expect(report.points.length).toBeGreaterThan(0)
  })
})
