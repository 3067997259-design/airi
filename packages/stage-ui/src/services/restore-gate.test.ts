import { beforeEach, describe, expect, it } from 'vitest'

import { areRestoreEffectsHeld, beginRestoreGate, completeRestoreGate, isRestoreActive, releaseRestoreEffectHold, restoredOwner, setRestoredOwner, waitForRestore } from './restore-gate'

describe('restore gate', () => {
  it('releases local initialization but retains the restored profile effect hold', async () => {
    beginRestoreGate()
    const waiting = waitForRestore()
    completeRestoreGate(true)
    await waiting
    expect(isRestoreActive()).toBe(false)
    expect(areRestoreEffectsHeld()).toBe(true)
    // Later launches receive restored:true from the same durable host marker.
    beginRestoreGate()
    completeRestoreGate(true)
    expect(areRestoreEffectsHeld()).toBe(true)
    releaseRestoreEffectHold()
    expect(areRestoreEffectsHeld()).toBe(false)
  })

  it('keeps the restored owner for the onboarding surface and clears it without a restore', () => {
    beginRestoreGate()
    completeRestoreGate(true)
    setRestoredOwner('restored-owner')
    expect(restoredOwner.value).toBe('restored-owner')

    // A later non-restored boot must not reuse the previous owner.
    beginRestoreGate()
    completeRestoreGate(false)
    expect(restoredOwner.value).toBeUndefined()
  })

  beforeEach(() => {
    completeRestoreGate()
  })

  it('releases immediately when no restore is active', async () => {
    await expect(waitForRestore()).resolves.toBeUndefined()
    expect(isRestoreActive()).toBe(false)
  })

  it('holds initialization until restore completion', async () => {
    beginRestoreGate()
    let released = false
    const waiting = waitForRestore().then(() => {
      released = true
    })
    await Promise.resolve()
    expect(released).toBe(false)
    expect(isRestoreActive()).toBe(true)
    completeRestoreGate()
    await waiting
    expect(released).toBe(true)
    expect(isRestoreActive()).toBe(false)
  })

  it('does not replace an existing gate when started twice', async () => {
    beginRestoreGate()
    const waiting = waitForRestore()
    beginRestoreGate()
    completeRestoreGate()
    await expect(waiting).resolves.toBeUndefined()
  })
})
