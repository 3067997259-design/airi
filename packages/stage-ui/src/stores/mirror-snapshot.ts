import type { MirrorSnapshotResult } from '@proj-airi/stage-ui-live2d/tools/mirror-tools'

import type { ChatSendPayload } from './chat'

import { useBackgroundStore } from './background'
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
 * The most recent mirror selfie attachment, consumed by the chat store
 * (方案 B) so the next user send rides on the captured frame. Held in
 * stage-ui because the background store lives here; the live2d mirror tool
 * only relays the frame.
 */
let lastMirrorAttachment: ChatSendPayload['attachments'] | undefined

/** Reads and clears the most recent mirror selfie attachment. */
export function takeLastMirrorAttachment(): ChatSendPayload['attachments'] | undefined {
  const attachment = lastMirrorAttachment
  lastMirrorAttachment = undefined
  return attachment
}

/**
 * Captures the current stage frame as a "selfie" and persists it to the
 * background store, returning the combined mirror snapshot.
 *
 * Wired to the `mirror` LLM tool via `options.getSnapshot`. Lives in stage-ui
 * because the stage model renderers (capture) and the background store
 * (selfie persistence) both live here; the live2d mirror tool only relays
 * the result. When no stage frame is available (e.g. the Stage is not
 * mounted in this window) it returns null, and the tool falls back to the
 * text-only snapshot.
 */
export async function captureMirrorSnapshot(): Promise<MirrorSnapshotResult | null> {
  if (!hasStageCapture())
    return null

  const blob = await captureStageFrame()
  if (!blob)
    return null

  let entryId: string | undefined
  let imageDataUrl: string | undefined
  let attachment: ChatSendPayload['attachments'] | undefined
  try {
    const backgroundStore = useBackgroundStore()
    const persistedId = await backgroundStore.addBackground('selfie', blob, `Mirror selfie ${new Date().toLocaleString()}`)
    entryId = persistedId
    imageDataUrl = await blobToDataUrl(blob)
    attachment = attachmentFromDataUrl(imageDataUrl)
  }
  catch (error) {
    // Persisting the selfie is a convenience; a failure must not break the
    // mirror call. Falling back to the text snapshot is always safe.
    console.warn('[Mirror] Failed to persist selfie, returning text-only snapshot.', error)
  }

  if (attachment)
    lastMirrorAttachment = attachment

  return {
    ...(imageDataUrl ? { imageDataUrl } : {}),
    ...(entryId ? { entryId } : {}),
    capturedAt: Date.now(),
  }
}

/**
 * Converts a base64 data-URL into the chat image-attachment shape
 * `{ type, data, mimeType }`. Decomposes `data:image/<mime>;base64,<b64>`; it
 * performs no execution of any kind.
 */
function attachmentFromDataUrl(dataUrl: string): ChatSendPayload['attachments'] {
  const comma = dataUrl.indexOf(',')
  const header = dataUrl.slice(0, comma >= 0 ? comma : dataUrl.length)
  const body = comma >= 0 ? dataUrl.slice(comma + 1) : ''
  const mimeType = header.replace(/^data:/i, '').replace(/;base64.*$/i, '') || 'image/png'
  return [{ type: 'image', data: body, mimeType }]
}
