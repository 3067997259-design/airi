import type { ChatProvider } from '@xsai-ext/providers/utils'

export type MirrorDiagnosticPhase
  = | 'capture'
    | 'tool-result'
    | 'prepare-step'
    | 'provider-request'
    | 'provider-response'
    | 'provider-error'

export type MirrorFrameClassification = 'black' | 'transparent' | 'unavailable' | 'visible'

/** Redacted evidence for one stage of a transient mirror frame. */
export interface MirrorDiagnosticEvent {
  at: number
  phase: MirrorDiagnosticPhase
  frameId?: string
  toolCallId?: string
  stepNumber?: number
  requestId?: string
  requestPath?: string
  requestBodyBytes?: number
  messageCount?: number
  messageIndex?: number
  partIndex?: number
  imageDataUrlLength?: number
  responseStatus?: number
  errorName?: string
  imageBytes?: number
  imageSha256?: string
  width?: number
  height?: number
  sampleWidth?: number
  sampleHeight?: number
  sampledPixelCount?: number
  alphaPixelRatio?: number
  nonBlackPixelRatio?: number
  averageLuma?: number
  classification?: MirrorFrameClassification
  analysisError?: string
}

/** Safe diagnostic state. Raw image data is available only through an explicit frame lookup. */
export interface MirrorDiagnosticsSnapshot {
  enabled: boolean
  events: MirrorDiagnosticEvent[]
  retainedFrameIds: string[]
}

/** Session-only debug controls exposed as `window.__AIRI_MIRROR_DIAGNOSTICS__`. */
export interface MirrorDiagnosticsApi {
  enable: () => void
  disable: () => void
  clear: () => void
  isEnabled: () => boolean
  snapshot: () => MirrorDiagnosticsSnapshot
  getFrameDataUrl: (frameId: string) => string | undefined
}

interface MirrorPixelSummary {
  width: number
  height: number
  sampleWidth: number
  sampleHeight: number
  sampledPixelCount: number
  alphaPixelRatio: number
  nonBlackPixelRatio: number
  averageLuma: number
  classification: MirrorFrameClassification
}

interface MirrorRequestImage {
  dataUrl: string
  messageCount: number
  messageIndex: number
  partIndex: number
}

const MAX_EVENTS = 80
const MAX_RETAINED_FRAMES = 3
const MAX_SAMPLE_EDGE = 256
const VISIBLE_ALPHA_THRESHOLD = 8
const NON_BLACK_CHANNEL_THRESHOLD = 8

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function roundRatio(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000
}

function safeErrorName(error: unknown): string {
  if (error instanceof Error)
    return error.name
  return typeof error
}

function safeAnalysisError(error: unknown): string {
  if (error instanceof Error)
    return `${error.name}: ${error.message}`.slice(0, 160)
  return String(error).slice(0, 160)
}

async function sha256Hex(value: Blob | string): Promise<string> {
  const bytes = typeof value === 'string'
    ? new TextEncoder().encode(value)
    : await value.arrayBuffer()
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)]
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('')
}

async function inspectMirrorPixels(blob: Blob): Promise<MirrorPixelSummary> {
  if (typeof document === 'undefined' || typeof createImageBitmap !== 'function') {
    throw new TypeError('Image pixel inspection is unavailable in this runtime.')
  }

  const bitmap = await createImageBitmap(blob)
  try {
    const scale = Math.min(1, MAX_SAMPLE_EDGE / Math.max(bitmap.width, bitmap.height))
    const sampleWidth = Math.max(1, Math.round(bitmap.width * scale))
    const sampleHeight = Math.max(1, Math.round(bitmap.height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = sampleWidth
    canvas.height = sampleHeight
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context)
      throw new Error('The 2D canvas context is unavailable.')

    context.clearRect(0, 0, sampleWidth, sampleHeight)
    context.drawImage(bitmap, 0, 0, sampleWidth, sampleHeight)
    const pixels = context.getImageData(0, 0, sampleWidth, sampleHeight).data
    const sampledPixelCount = sampleWidth * sampleHeight
    let alphaPixels = 0
    let nonBlackPixels = 0
    let totalLuma = 0

    for (let index = 0; index < pixels.length; index += 4) {
      const red = pixels[index]
      const green = pixels[index + 1]
      const blue = pixels[index + 2]
      const alpha = pixels[index + 3]
      if (alpha <= VISIBLE_ALPHA_THRESHOLD)
        continue

      alphaPixels += 1
      if (Math.max(red, green, blue) > NON_BLACK_CHANNEL_THRESHOLD)
        nonBlackPixels += 1
      totalLuma += (0.2126 * red + 0.7152 * green + 0.0722 * blue) * (alpha / 255)
    }

    const classification: MirrorFrameClassification = alphaPixels === 0
      ? 'transparent'
      : nonBlackPixels === 0
        ? 'black'
        : 'visible'

    return {
      width: bitmap.width,
      height: bitmap.height,
      sampleWidth,
      sampleHeight,
      sampledPixelCount,
      alphaPixelRatio: roundRatio(alphaPixels / sampledPixelCount),
      nonBlackPixelRatio: roundRatio(nonBlackPixels / sampledPixelCount),
      averageLuma: roundRatio(totalLuma / sampledPixelCount),
      classification,
    }
  }
  finally {
    bitmap.close()
  }
}

function requestImages(body: BodyInit | null | undefined): MirrorRequestImage[] {
  if (typeof body !== 'string')
    return []

  let payload: unknown
  try {
    payload = JSON.parse(body)
  }
  catch {
    return []
  }

  if (!isRecord(payload) || !Array.isArray(payload.messages))
    return []

  const images: MirrorRequestImage[] = []
  const messageCount = payload.messages.length
  for (const [messageIndex, message] of payload.messages.entries()) {
    if (!isRecord(message) || !Array.isArray(message.content))
      continue

    for (const [partIndex, part] of message.content.entries()) {
      if (!isRecord(part) || part.type !== 'image_url' || !isRecord(part.image_url))
        continue
      const dataUrl = part.image_url.url
      if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/'))
        continue
      images.push({ dataUrl, messageCount, messageIndex, partIndex })
    }
  }

  return images
}

function requestPath(input: RequestInfo | URL): string {
  try {
    if (input instanceof URL)
      return input.pathname
    if (typeof input === 'string')
      return new URL(input).pathname
    return new URL(input.url).pathname
  }
  catch {
    return 'unknown'
  }
}

class MirrorDiagnosticsController implements MirrorDiagnosticsApi {
  private enabled = false
  private readonly events: MirrorDiagnosticEvent[] = []
  private readonly frameDataUrls = new Map<string, string>()
  private readonly frameIdsByDataUrl = new Map<string, string>()
  private fallbackId = 0

  enable(): void {
    this.clear()
    this.enabled = true
  }

  disable(): void {
    this.enabled = false
    this.clear()
  }

  clear(): void {
    this.events.splice(0)
    this.frameDataUrls.clear()
    this.frameIdsByDataUrl.clear()
  }

  isEnabled(): boolean {
    return this.enabled
  }

  snapshot(): MirrorDiagnosticsSnapshot {
    return {
      enabled: this.enabled,
      events: this.events.map(event => ({ ...event })),
      retainedFrameIds: [...this.frameDataUrls.keys()],
    }
  }

  getFrameDataUrl(frameId: string): string | undefined {
    if (!this.enabled)
      return undefined
    return this.frameDataUrls.get(frameId)
  }

  push(event: Omit<MirrorDiagnosticEvent, 'at'>): void {
    if (!this.enabled)
      return
    this.events.push({ ...event, at: Date.now() })
    if (this.events.length > MAX_EVENTS)
      this.events.splice(0, this.events.length - MAX_EVENTS)
  }

  rememberFrame(frameId: string, dataUrl: string): void {
    if (!this.enabled)
      return

    const previousFrameId = this.frameIdsByDataUrl.get(dataUrl)
    if (previousFrameId && previousFrameId !== frameId)
      this.frameDataUrls.delete(previousFrameId)

    this.frameIdsByDataUrl.set(dataUrl, frameId)
    this.frameDataUrls.delete(frameId)
    this.frameDataUrls.set(frameId, dataUrl)
    while (this.frameDataUrls.size > MAX_RETAINED_FRAMES) {
      const oldest = this.frameDataUrls.entries().next().value as [string, string] | undefined
      if (!oldest)
        break
      this.frameDataUrls.delete(oldest[0])
      this.frameIdsByDataUrl.delete(oldest[1])
    }
  }

  frameIdForDataUrl(dataUrl: string): string | undefined {
    return this.frameIdsByDataUrl.get(dataUrl)
  }

  nextFallbackFrameId(): string {
    this.fallbackId += 1
    return `fallback-${Date.now()}-${this.fallbackId}`
  }
}

/** In-memory mirror diagnostics. Disabled by default and cleared when disabled. */
export const mirrorDiagnostics = new MirrorDiagnosticsController()

async function resolveFrameId(dataUrl: string): Promise<string> {
  const existing = mirrorDiagnostics.frameIdForDataUrl(dataUrl)
  if (existing)
    return existing

  let frameId: string
  try {
    frameId = `transport-${(await sha256Hex(dataUrl)).slice(0, 16)}`
  }
  catch {
    frameId = mirrorDiagnostics.nextFallbackFrameId()
  }
  mirrorDiagnostics.rememberFrame(frameId, dataUrl)
  return frameId
}

/** Records source pixels and the exact encoded frame before the tool receives it. */
export async function recordMirrorCapture(blob: Blob, dataUrl: string): Promise<void> {
  if (!mirrorDiagnostics.isEnabled())
    return

  let frameId = mirrorDiagnostics.nextFallbackFrameId()
  let imageSha256: string | undefined
  try {
    imageSha256 = await sha256Hex(blob)
    frameId = `image-${imageSha256.slice(0, 16)}`
  }
  catch {
    // The fallback id still correlates later phases through the exact data URL.
  }
  mirrorDiagnostics.rememberFrame(frameId, dataUrl)

  try {
    const pixels = await inspectMirrorPixels(blob)
    mirrorDiagnostics.push({
      phase: 'capture',
      frameId,
      imageBytes: blob.size,
      imageSha256,
      imageDataUrlLength: dataUrl.length,
      ...pixels,
    })
  }
  catch (error) {
    mirrorDiagnostics.push({
      phase: 'capture',
      frameId,
      imageBytes: blob.size,
      imageSha256,
      imageDataUrlLength: dataUrl.length,
      classification: 'unavailable',
      analysisError: safeAnalysisError(error),
    })
  }
}

/** Records one in-memory image handoff without writing the image to the transcript. */
export async function recordMirrorVisualPhase(
  phase: 'prepare-step' | 'tool-result',
  dataUrl: string,
  details: { stepNumber?: number, toolCallId?: string } = {},
): Promise<void> {
  if (!mirrorDiagnostics.isEnabled())
    return
  const frameId = await resolveFrameId(dataUrl)
  mirrorDiagnostics.push({
    phase,
    frameId,
    imageDataUrlLength: dataUrl.length,
    ...details,
  })
}

/**
 * Wraps an OpenAI-compatible provider fetch and records only redacted image
 * metadata from the serialized request body.
 */
export function withMirrorRequestDiagnostics(
  provider: ChatProvider,
  correlation: { roundId?: string } = {},
): ChatProvider {
  if (!mirrorDiagnostics.isEnabled())
    return provider

  let requestSequence = 0
  return {
    ...provider,
    chat(model: string) {
      const config = provider.chat(model)
      return {
        ...config,
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          requestSequence += 1
          const requestId = `${correlation.roundId ?? 'uncorrelated'}:${requestSequence}`
          const images = requestImages(init?.body)
          const bodyBytes = typeof init?.body === 'string'
            ? new TextEncoder().encode(init.body).byteLength
            : undefined
          const path = requestPath(input)
          const resolvedImages = await Promise.all(images.map(async image => ({
            ...image,
            frameId: await resolveFrameId(image.dataUrl),
          })))

          for (const image of resolvedImages) {
            mirrorDiagnostics.push({
              phase: 'provider-request',
              frameId: image.frameId,
              requestId,
              requestPath: path,
              requestBodyBytes: bodyBytes,
              messageCount: image.messageCount,
              messageIndex: image.messageIndex,
              partIndex: image.partIndex,
              imageDataUrlLength: image.dataUrl.length,
            })
          }

          try {
            const response = config.fetch
              ? await config.fetch(input as URL, init ?? {})
              : await globalThis.fetch(input, init)
            for (const image of resolvedImages) {
              mirrorDiagnostics.push({
                phase: 'provider-response',
                frameId: image.frameId,
                requestId,
                responseStatus: response.status,
              })
            }
            return response
          }
          catch (error) {
            for (const image of resolvedImages) {
              mirrorDiagnostics.push({
                phase: 'provider-error',
                frameId: image.frameId,
                requestId,
                errorName: safeErrorName(error),
              })
            }
            throw error
          }
        },
      }
    },
  }
}

if (typeof window !== 'undefined') {
  const debugGlobal = globalThis as typeof globalThis & {
    __AIRI_MIRROR_DIAGNOSTICS__?: MirrorDiagnosticsApi
  }
  Object.defineProperty(debugGlobal, '__AIRI_MIRROR_DIAGNOSTICS__', {
    configurable: true,
    value: mirrorDiagnostics,
  })
}
