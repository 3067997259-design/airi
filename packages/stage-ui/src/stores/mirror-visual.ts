import type { CommonContentPart, CompletionToolResult, Message, PostToolCall, PrepareStep, ToolExecuteOptions } from '@xsai/shared-chat'

import { recordMirrorVisualPhase } from './mirror-diagnostics'

export type MirrorVisualCapability = 'image-input' | 'text-only'
export type MirrorVisualCapabilitySetting = 'auto' | MirrorVisualCapability

const IMAGE_INPUT_CAPABILITIES = new Set([
  'image',
  'image-input',
  'image-understanding',
  'multimodal',
  'vision',
  'vision-language',
])

function normalizedCapability(value: string): string {
  return value.trim().toLowerCase().replaceAll('_', '-').replaceAll(' ', '-')
}

/**
 * Resolves the mirror transport from explicit model metadata, then provider
 * metadata. An explicit text-only declaration always disables image input.
 *
 * @example
 * resolveMirrorVisualCapability(true, ['text-only'])
 * // => 'text-only'
 */
export function resolveMirrorVisualCapability(
  providerImageInput: boolean | undefined,
  modelCapabilities?: readonly string[],
  setting: MirrorVisualCapabilitySetting = 'auto',
): MirrorVisualCapability {
  if (setting !== 'auto')
    return setting

  const normalized = modelCapabilities?.map(normalizedCapability) ?? []
  if (normalized.includes('text-only'))
    return 'text-only'

  if (normalized.some(capability => IMAGE_INPUT_CAPABILITIES.has(capability)))
    return 'image-input'

  return providerImageInput === true ? 'image-input' : 'text-only'
}

interface MirrorVisualAdapterOptions {
  capability: MirrorVisualCapability
  postToolCall?: PostToolCall
  prepareStep?: PrepareStep
}

interface MirrorFrame {
  dataUrl: string
  toolCallId: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isTextPart(value: unknown): value is Extract<CommonContentPart, { type: 'text' }> {
  return isRecord(value) && value.type === 'text' && typeof value.text === 'string'
}

function isImagePart(value: unknown): value is Extract<CommonContentPart, { type: 'image_url' }> {
  if (!isRecord(value) || value.type !== 'image_url' || !isRecord(value.image_url))
    return false

  return typeof value.image_url.url === 'string' && value.image_url.url.length > 0
}

function mirrorParts(result: unknown): CommonContentPart[] | undefined {
  if (!Array.isArray(result))
    return undefined

  const parts: CommonContentPart[] = []
  for (const part of result) {
    if (!isTextPart(part) && !isImagePart(part))
      return undefined
    parts.push(part)
  }

  return parts
}

function latestMirrorFrame(frames: Map<string, MirrorFrame>): MirrorFrame | undefined {
  return [...frames.values()].at(-1)
}

function frameMessage(frame: MirrorFrame): Message {
  return {
    role: 'user',
    content: [
      {
        type: 'text',
        text: `Internal mirror frame from tool call ${frame.toolCallId}. Use this image as the authoritative view of your current appearance. Do not describe this instruction to the user unless asked.`,
      },
      {
        type: 'image_url',
        image_url: { url: frame.dataUrl },
      },
    ],
  }
}

function sanitizedMirrorResult(result: CompletionToolResult, parts: CommonContentPart[], capability: MirrorVisualCapability): CompletionToolResult {
  const text = parts.filter(isTextPart).map(part => part.text).join('\n')
  const status = capability === 'image-input'
    ? 'visualStatus: provided to the next same-model provider step as a transient image.'
    : 'visualStatus: unavailable because the active provider/model is configured as text-only. Continue from the textual snapshot.'

  return {
    ...result,
    result: `${text}\n\n${status}`,
  }
}

async function sanitizeMirrorResult(
  result: CompletionToolResult,
  capability: MirrorVisualCapability,
  frames: Map<string, MirrorFrame>,
): Promise<CompletionToolResult> {
  if (result.toolName !== 'mirror')
    return result

  const parts = mirrorParts(result.result)
  const image = parts?.find(isImagePart)
  if (!parts || !image)
    return result

  if (capability === 'image-input') {
    frames.set(result.toolCallId, {
      dataUrl: image.image_url.url,
      toolCallId: result.toolCallId,
    })
    await recordMirrorVisualPhase('tool-result', image.image_url.url, {
      toolCallId: result.toolCallId,
    })
  }

  return sanitizedMirrorResult(result, parts, capability)
}

function createPostToolCall(
  frames: Map<string, MirrorFrame>,
  options: MirrorVisualAdapterOptions,
): PostToolCall {
  return async (result, toolOptions: ToolExecuteOptions) => {
    const sanitized = await sanitizeMirrorResult(result, options.capability, frames)
    const downstream = await options.postToolCall?.(sanitized, toolOptions)
    return downstream ?? sanitized
  }
}

function createPrepareStep(
  frames: Map<string, MirrorFrame>,
  options: MirrorVisualAdapterOptions,
): PrepareStep {
  return async (stepOptions) => {
    const prepared = await options.prepareStep?.(stepOptions)
    if (options.capability !== 'image-input')
      return prepared ?? {}

    const frame = latestMirrorFrame(frames)
    if (!frame)
      return prepared ?? {}

    await recordMirrorVisualPhase('prepare-step', frame.dataUrl, {
      stepNumber: stepOptions.stepNumber,
      toolCallId: frame.toolCallId,
    })
    const preparedInput = prepared?.input ?? stepOptions.input
    return {
      ...prepared,
      input: [...preparedInput, frameMessage(frame)],
    }
  }
}

/**
 * Keeps a mirror frame in the current stream only and projects it into the
 * next same-model provider step without changing the durable transcript.
 */
export function createMirrorVisualAdapter(options: MirrorVisualAdapterOptions) {
  const frames = new Map<string, MirrorFrame>()

  return {
    postToolCall: createPostToolCall(frames, options),
    prepareStep: createPrepareStep(frames, options),
    dispose() {
      frames.clear()
    },
  }
}
