import type { ElytraLaunchStatus, ElytraLaunchTask, MovementControlPort } from './port'

import { describe, expect, it } from 'vitest'

import { launchFromGround } from './launch'

const FAST = { sleep: async () => {}, now: () => Date.now() }

/** The launch members alone; every other port member is irrelevant here. */
interface LaunchFake {
  startLaunch?: (task: ElytraLaunchTask) => Promise<ElytraLaunchStatus>
  launchStatus?: () => Promise<ElytraLaunchStatus>
  cancelLaunch?: () => Promise<ElytraLaunchStatus>
}

function portOf(fake: LaunchFake): MovementControlPort {
  return fake as unknown as MovementControlPort
}

function scriptedPort(script: ElytraLaunchStatus[], options: { onStart?: () => void } = {}): { fake: LaunchFake, calls: { start: number, status: number, cancel: number, tasks: ElytraLaunchTask[] } } {
  const calls = { start: 0, status: 0, cancel: 0, tasks: [] as ElytraLaunchTask[] }
  let index = 0
  const fake: LaunchFake = {
    startLaunch: async (task) => {
      calls.start++
      calls.tasks.push(task)
      options.onStart?.()
      return { state: 'running', endReason: 'running', ticks: 0, phase: 'prepare' }
    },
    launchStatus: async () => {
      calls.status++
      const next = script[Math.min(index, script.length - 1)]!
      index++
      return next
    },
    cancelLaunch: async () => {
      calls.cancel++
      return { state: 'cancelled', endReason: 'cancelled', ticks: 3, deployed: false }
    },
  }
  return { fake, calls }
}

describe('launchFromGround', () => {
  it('returns undefined when the bridge exposes no launch macro', async () => {
    const result = await launchFromGround({
      port: portOf({}),
      goal: { x: 10, y: 70, z: 0 },
      fireworks: 5,
      shouldStop: () => false,
      ...FAST,
    })
    expect(result).toBeUndefined()
  })

  it('submits one ignition, polls it, and reports the handoff', async () => {
    // ROOT CAUSE the double-submit guard exists for: the macro spends at most
    // one rocket per run, so a caller that re-submitted on a slow reply would
    // burn a second rocket on the same takeoff.
    const { fake, calls } = scriptedPort([
      { state: 'running', endReason: 'running', ticks: 8, phase: 'boost', deployed: true },
      { state: 'done', endReason: 'launched', ticks: 14, phase: 'handoff', deployed: true, airborne: true, climb: 4.2, fireworksUsed: 1 },
    ])
    const result = await launchFromGround({
      port: portOf(fake),
      goal: { x: 10, y: 70, z: 0 },
      fireworks: 5,
      shouldStop: () => false,
      ...FAST,
    })
    expect(result?.outcome).toBe('launched')
    expect(result?.deployed).toBe(true)
    expect(result?.climb).toBe(4.2)
    expect(calls.start).toBe(1)
    expect(calls.status).toBeGreaterThanOrEqual(1)
    expect(calls.tasks[0]).toEqual({ goal: { x: 10, y: 70, z: 0 }, deadlineMs: expect.any(Number), withFireworks: true })
  })

  it('tells the macro to skip the boost when no rocket is left', async () => {
    const { fake, calls } = scriptedPort([
      { state: 'failed', endReason: 'no_fireworks', ticks: 20, phase: 'boost', deployed: true },
    ])
    const result = await launchFromGround({
      port: portOf(fake),
      goal: { x: 0, y: 64, z: 0 },
      fireworks: 0,
      shouldStop: () => false,
      ...FAST,
    })
    expect(calls.tasks[0]?.withFireworks).toBe(false)
    // A deploy without a boost is still a glide: the caller must not repeat a
    // takeoff that already opened the glider.
    expect(result?.outcome).toBe('deployed-no-boost')
    expect(result?.deployed).toBe(true)
    expect(result?.detail).toContain('no_fireworks')
  })

  it('reports a typed failure when the glider never opened', async () => {
    const { fake } = scriptedPort([
      { state: 'failed', endReason: 'not_deployed', ticks: 22, phase: 'deploy', deployed: false },
    ])
    const result = await launchFromGround({
      port: portOf(fake),
      goal: { x: 0, y: 64, z: 0 },
      fireworks: 3,
      shouldStop: () => false,
      ...FAST,
    })
    expect(result?.outcome).toBe('failed')
    expect(result?.deployed).toBe(false)
    expect(result?.detail).toContain('not_deployed')
  })

  it('cancels the running macro instead of leaving it pressing keys', async () => {
    const { fake, calls } = scriptedPort([
      { state: 'running', endReason: 'running', ticks: 4, phase: 'jump' },
    ])
    const result = await launchFromGround({
      port: portOf(fake),
      goal: { x: 0, y: 64, z: 0 },
      fireworks: 3,
      shouldStop: () => calls.status >= 1,
      ...FAST,
    })
    expect(result?.outcome).toBe('cancelled')
    expect(calls.cancel).toBe(1)
  })

  it('aborts the macro when a newer command takes the input', async () => {
    const { fake, calls } = scriptedPort([
      { state: 'running', endReason: 'running', ticks: 4, phase: 'deploy' },
    ])
    const result = await launchFromGround({
      port: portOf(fake),
      goal: { x: 0, y: 64, z: 0 },
      fireworks: 3,
      shouldStop: () => false,
      stillOwnsControl: () => calls.status === 0,
      ...FAST,
    })
    expect(result?.outcome).toBe('cancelled')
    expect(calls.cancel).toBe(1)
  })

  it('does not submit anything when the command was cancelled first', async () => {
    const { fake, calls } = scriptedPort([])
    const result = await launchFromGround({
      port: portOf(fake),
      goal: { x: 0, y: 64, z: 0 },
      fireworks: 3,
      shouldStop: () => true,
      ...FAST,
    })
    expect(result?.outcome).toBe('cancelled')
    expect(calls.start).toBe(0)
  })

  it('reports unavailable when the macro stops answering', async () => {
    const { fake } = scriptedPort([
      { state: 'running', endReason: 'running', ticks: 4, phase: 'deploy', deployed: true },
    ])
    // A clock that runs far faster than the no-op sleep: the transport grace
    // expires while the macro keeps reporting `running`.
    let clock = 0
    const result = await launchFromGround({
      port: portOf(fake),
      goal: { x: 0, y: 64, z: 0 },
      fireworks: 3,
      shouldStop: () => false,
      sleep: async () => {},
      now: () => {
        clock += 10_000
        return clock
      },
    })
    expect(result?.outcome).toBe('unavailable')
    expect(result?.deployed).toBe(true)
  })
})
