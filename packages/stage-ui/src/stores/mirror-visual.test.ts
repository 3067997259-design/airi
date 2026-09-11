import type { CommonContentPart, CompletionToolResult, Message } from '@xsai/shared-chat'

import { describe, expect, it, vi } from 'vitest'

import { createMirrorVisualAdapter, resolveMirrorVisualCapability } from './mirror-visual'

function mirrorToolResult(): CompletionToolResult {
  return {
    args: {},
    result: [
      { type: 'text', text: 'Appearance now: smiling.' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
    ] satisfies CommonContentPart[],
    toolCallId: 'mirror-call-1',
    toolName: 'mirror',
  }
}

function prepareInput(): { input: Message[], model: string, stepNumber: number, steps: never[] } {
  return {
    input: [{ role: 'user', content: 'Look at yourself.' }],
    model: 'gemini-2.5-flash',
    stepNumber: 1,
    steps: [],
  }
}

describe('resolveMirrorVisualCapability', () => {
  it('uses explicit text-only model metadata before provider metadata', () => {
    expect(resolveMirrorVisualCapability(true, ['text-only'])).toBe('text-only')
  })

  it('accepts explicit model image metadata', () => {
    expect(resolveMirrorVisualCapability(false, ['vision'])).toBe('image-input')
  })

  it('falls back to the provider declaration when model metadata is absent', () => {
    expect(resolveMirrorVisualCapability(true)).toBe('image-input')
    expect(resolveMirrorVisualCapability(false)).toBe('text-only')
  })
})

describe('createMirrorVisualAdapter', () => {
  it('sanitizes the durable tool result and injects the raw image into the next step', async () => {
    const downstreamPostToolCall = vi.fn()
    const adapter = createMirrorVisualAdapter({
      capability: 'image-input',
      postToolCall: downstreamPostToolCall,
    })

    const sanitized = await adapter.postToolCall(mirrorToolResult(), {
      messages: [],
      toolCallId: 'mirror-call-1',
    })
    const resultText = typeof sanitized?.result === 'string' ? sanitized.result : ''
    expect(resultText).toContain('Appearance now: smiling.')
    expect(resultText).toContain('visualStatus: provided to the next same-model provider step')
    expect(resultText).not.toContain('data:image/png')
    expect(downstreamPostToolCall).toHaveBeenCalledWith(sanitized, expect.anything())

    const prepared = await adapter.prepareStep(prepareInput())
    const frameMessage = prepared.input?.at(-1)
    expect(frameMessage?.role).toBe('user')
    expect(frameMessage?.content).toEqual([
      expect.objectContaining({ type: 'text' }),
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
    ])
    expect(await adapter.prepareStep(prepareInput())).toEqual({})

    adapter.dispose()
    const afterDispose = await adapter.prepareStep(prepareInput())
    expect(afterDispose).toEqual({})
  })

  it('returns a text-only status and never injects an image for text models', async () => {
    const adapter = createMirrorVisualAdapter({ capability: 'text-only' })
    const sanitized = await adapter.postToolCall(mirrorToolResult(), {
      messages: [],
      toolCallId: 'mirror-call-1',
    })

    expect(sanitized?.result).toContain('visualStatus: unavailable')
    expect(sanitized?.result).toContain('configured as text-only')
    expect(sanitized?.result).not.toContain('data:image/png')
    expect(await adapter.prepareStep(prepareInput())).toEqual({})
  })

  it('does not reuse a previous frame after a later mirror call fails', async () => {
    const adapter = createMirrorVisualAdapter({ capability: 'image-input' })
    await adapter.postToolCall(mirrorToolResult(), {
      messages: [],
      toolCallId: 'mirror-call-1',
    })

    await adapter.postToolCall({
      args: {},
      result: 'mirror timed out',
      toolCallId: 'mirror-call-2',
      toolName: 'mirror',
      isError: true,
    }, {
      messages: [],
      toolCallId: 'mirror-call-2',
    })

    expect(await adapter.prepareStep(prepareInput())).toEqual({})
  })

  it('releases the frame when downstream processing fails', async () => {
    const downstreamPostToolCall = vi.fn().mockRejectedValue(new Error('downstream failed'))
    const adapter = createMirrorVisualAdapter({
      capability: 'image-input',
      postToolCall: downstreamPostToolCall,
    })

    await expect(adapter.postToolCall(mirrorToolResult(), {
      messages: [],
      toolCallId: 'mirror-call-1',
    })).rejects.toThrow('downstream failed')
    expect(await adapter.prepareStep(prepareInput())).toEqual({})
  })
})
