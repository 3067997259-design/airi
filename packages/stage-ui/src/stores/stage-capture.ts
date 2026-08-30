import { shallowRef } from 'vue'

/**
 * Stage capture port for the transient mirror frame.
 *
 * The Live2D/VRM/Spine/MMD character frame lives in the Stage component, but
 * the `mirror` tool runs in the leader renderer store and cannot reach the
 * component's `defineExpose` ref. This module-level port bridges the two: the
 * Stage registers its `captureFrame` on mount, and the tool resolves the
 * current frame through it.
 *
 * Kept in stage-ui because it depends on the stage model renderers; the
 * stage-ui-live2d mirror tool consumes it via an injected port to avoid a
 * package cycle.
 */
export type StageCaptureFn = () => Promise<Blob | null | undefined>

let capture: StageCaptureFn | undefined

/** Installs (or clears) the current stage's frame capture. */
export function installStageCapture(next: StageCaptureFn | undefined): void {
  capture = next
}

/** Returns true when a stage frame is currently available. */
export function hasStageCapture(): boolean {
  return capture !== undefined
}

/** Grabs the current rendered character frame as a Blob, or null. */
export function captureStageFrame(): Promise<Blob | null> {
  return (capture?.() ?? Promise.resolve(null)).then(blob => blob ?? null)
}

/**
 * Reactive flag for UI (e.g. whether "mirror" can actually produce an image
 * right now). Mirrors the capture presence without forcing a capture.
 */
export const stageCaptureAvailable = shallowRef(false)

export function syncStageCaptureAvailable(): void {
  stageCaptureAvailable.value = hasStageCapture()
}
