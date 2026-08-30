import type { MirrorSnapshotResult } from '@proj-airi/stage-ui-live2d/tools/mirror-tools'

import { recordMirrorCapture } from './mirror-diagnostics'
import { captureStageFrame, hasStageCapture } from './stage-capture'

/** Converts a Blob to a base64 data URL. */
function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

/**
 * Captures the current stage frame as a temporary mirror snapshot.
 *
 * Wired to the `mirror` LLM tool via `options.getSnapshot`. Lives in stage-ui
 * because the stage model renderer owns capture; the live2d mirror tool only
 * relays the result. The data URL is kept in the current stream's in-memory
 * tool lifecycle and is not added to the gallery or chat history.
 */
export async function captureMirrorSnapshot(): Promise<MirrorSnapshotResult | null> {
  if (!hasStageCapture())
    return null

  const blob = await captureStageFrame()
  if (!blob)
    return null

  try {
    const imageDataUrl = await blobToDataUrl(blob)
    await recordMirrorCapture(blob, imageDataUrl)
    return {
      imageDataUrl,
      capturedAt: Date.now(),
    }
  }
  catch (error) {
    // A capture conversion failure must not break the mirror tool. The textual
    // parameter snapshot remains useful when the transient visual payload is
    // unavailable.
    console.warn('[Mirror] Failed to convert the temporary frame.', error)
    return { capturedAt: Date.now() }
  }
}
