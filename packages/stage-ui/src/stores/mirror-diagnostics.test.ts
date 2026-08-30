import type { ChatProvider } from '@xsai-ext/providers/utils'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  mirrorDiagnostics,
  recordMirrorVisualPhase,
  withMirrorRequestDiagnostics,
} from './mirror-diagnostics'

afterEach(() => {
  mirrorDiagnostics.disable()
})

describe('mirror diagnostics', () => {
  it('correlates the transient image with the serialized provider request without exposing request content', async () => {
    const imageDataUrl = 'data:image/png;base64,AAAA'
    const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }))
    const provider: ChatProvider = {
      chat: model => ({
        apiKey: 'secret-api-key',
        baseURL: 'https://example.invalid/v1/',
        fetch: fetchMock,
        model,
      }),
    }

    mirrorDiagnostics.enable()
    await recordMirrorVisualPhase('tool-result', imageDataUrl, {
      toolCallId: 'mirror-call-1',
    })

    const tracedProvider = withMirrorRequestDiagnostics(provider, { roundId: 'round-1' })
    const request = tracedProvider.chat('gemini-test')
    await request.fetch?.(new URL('https://example.invalid/v1/chat/completions'), {
      body: JSON.stringify({
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'private prompt' },
            { type: 'image_url', image_url: { url: imageDataUrl } },
          ],
        }],
        model: 'gemini-test',
      }),
      headers: {
        'Authorization': 'Bearer secret-api-key',
        'Content-Type': 'application/json',
      },
      method: 'POST',
    })

    const snapshot = mirrorDiagnostics.snapshot()
    const toolEvent = snapshot.events.find(event => event.phase === 'tool-result')
    const requestEvent = snapshot.events.find(event => event.phase === 'provider-request')
    const responseEvent = snapshot.events.find(event => event.phase === 'provider-response')

    expect(toolEvent?.frameId).toBeDefined()
    expect(requestEvent?.frameId).toBe(toolEvent?.frameId)
    expect(responseEvent?.frameId).toBe(toolEvent?.frameId)
    expect(requestEvent).toMatchObject({
      imageDataUrlLength: imageDataUrl.length,
      messageIndex: 0,
      partIndex: 1,
      requestId: 'round-1:1',
      requestPath: '/v1/chat/completions',
    })
    expect(responseEvent?.responseStatus).toBe(200)
    expect(mirrorDiagnostics.getFrameDataUrl(toolEvent!.frameId!)).toBe(imageDataUrl)

    const serializedSnapshot = JSON.stringify(snapshot)
    expect(serializedSnapshot).not.toContain(imageDataUrl)
    expect(serializedSnapshot).not.toContain('private prompt')
    expect(serializedSnapshot).not.toContain('secret-api-key')
  })

  it('does not wrap the provider or retain frames while diagnostics are disabled', async () => {
    const provider: ChatProvider = {
      chat: model => ({
        baseURL: 'https://example.invalid/v1/',
        model,
      }),
    }

    await recordMirrorVisualPhase('tool-result', 'data:image/png;base64,AAAA', {
      toolCallId: 'mirror-call-1',
    })

    expect(withMirrorRequestDiagnostics(provider)).toBe(provider)
    expect(mirrorDiagnostics.snapshot()).toEqual({
      enabled: false,
      events: [],
      retainedFrameIds: [],
    })
  })

  it('clears all transient frames when diagnostics stop', async () => {
    mirrorDiagnostics.enable()
    await recordMirrorVisualPhase('prepare-step', 'data:image/png;base64,AAAA', {
      stepNumber: 1,
    })

    const frameId = mirrorDiagnostics.snapshot().retainedFrameIds[0]
    expect(frameId).toBeDefined()
    expect(mirrorDiagnostics.getFrameDataUrl(frameId!)).toBeDefined()

    mirrorDiagnostics.disable()

    expect(mirrorDiagnostics.getFrameDataUrl(frameId!)).toBeUndefined()
    expect(mirrorDiagnostics.snapshot()).toEqual({
      enabled: false,
      events: [],
      retainedFrameIds: [],
    })
  })
})
