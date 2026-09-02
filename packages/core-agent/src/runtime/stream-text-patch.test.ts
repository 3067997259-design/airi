import type { Message } from '@xsai/shared-chat'

import { streamText } from '@xsai/stream-text'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

function sseStream(chunks: unknown[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks)
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`))
      controller.close()
    },
  })
}

describe('@xsai/stream-text post-result stop patch', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(sseStream([{
      choices: [{
        delta: {
          role: 'assistant',
          tool_calls: [{
            function: { arguments: '{}', name: 'write' },
            id: 'call-1',
            index: 0,
            type: 'function',
          }],
        },
        finish_reason: 'tool_calls',
        index: 0,
      }],
      created: 0,
      id: 'chunk-1',
      model: 'model-a',
      object: 'chat.completion.chunk',
      system_fingerprint: 'test',
    }]), { headers: { 'content-type': 'text/event-stream' } })))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('executes the tool and exposes its result before onStepResult can stop the stream', async () => {
    const execute = vi.fn(async () => 'written')

    const onStepResult = vi.fn(({ messages, step, steps, stepNumber }) => {
      expect(step.toolResults).toHaveLength(1)
      expect(steps).toHaveLength(1)
      expect(messages.at(-1)).toMatchObject({ content: 'written', role: 'tool' })
      expect(stepNumber).toBe(1)
      return { stop: true }
    })
    const result = streamText({
      baseURL: 'https://example.com/',
      messages: [{ role: 'user', content: 'write the file' }] as Message[],
      model: 'model-a',
      onStepResult,
      stopWhen: () => false,
      tools: [{
        execute,
        function: { name: 'write', parameters: {} },
        type: 'function',
      }],
    })

    const [messages, steps] = await Promise.all([result.messages, result.steps])

    expect(execute).toHaveBeenCalledTimes(1)
    expect(onStepResult).toHaveBeenCalledTimes(1)
    expect(messages.at(-1)).toMatchObject({ content: 'written', role: 'tool' })
    expect(steps).toHaveLength(1)
    expect(steps[0]?.toolResults).toHaveLength(1)
  })
})
