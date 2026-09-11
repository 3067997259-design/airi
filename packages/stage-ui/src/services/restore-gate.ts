import { readonly, shallowRef } from 'vue'

/** Shared renderer gate that prevents schedulers from starting during restore. */
const active = shallowRef(false)
// The host's durable restore marker supplies this on every renderer startup,
// including later launches after the archive was imported successfully.
const effectsHeld = shallowRef(false)
export const restoreEffectsHeld = readonly(effectsHeld)
// Local user id recorded in the restored archive. The onboarding surface uses
// it to name the owner an unauthenticated restored profile belongs to.
const restoredOwnerId = shallowRef<string>()
export const restoredOwner = readonly(restoredOwnerId)
let ready: Promise<void> = Promise.resolve()
let release: (() => void) | undefined

export function beginRestoreGate(): void {
  if (active.value)
    return
  active.value = true
  ready = new Promise<void>((resolve) => {
    release = resolve
  })
}

/** Releases owner initialization while restored profiles retain their effect hold. */
export function completeRestoreGate(restored = false): void {
  effectsHeld.value = restored
  if (!restored)
    restoredOwnerId.value = undefined
  active.value = false
  release?.()
  release = undefined
}

/** Records the owner identity a restored profile belongs to. */
export function setRestoredOwner(ownerId: string | undefined): void {
  restoredOwnerId.value = ownerId
}

/** Releases the durable restore profile's external-effect hold after review. */
export function releaseRestoreEffectHold(): void {
  effectsHeld.value = false
}

export async function waitForRestore(): Promise<void> {
  await ready
}

export function isRestoreActive(): boolean {
  return active.value
}

/** Automatic delivery and execution require a normal, fully bootstrapped profile. */
export function areRestoreEffectsHeld(): boolean {
  return active.value || effectsHeld.value
}
