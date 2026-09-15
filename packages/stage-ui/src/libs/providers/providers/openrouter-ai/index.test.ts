import type { ChatProviderWithExtraOptions } from '@xsai-ext/providers/utils'
import type { JsonSchema } from 'xsschema'

import type { ChatRequestOptions } from '../../types'

import { rawTool } from '@xsai/tool'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { toJsonSchema } from 'xsschema'
import { z } from 'zod/v4'

import { providerOpenRouterAI } from './index'

// Fixture that preserves the nested nullable schema shape of the retired
// spark-command tool: `contexts[]` -> `metadata[]` -> nullable `value`. The
// provider adapters convert only this union; the canonical schema stays an
// `anyOf` on OpenRouter.
async function createNestedNullableToolFixture() {
  const metadataValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()])
  const metadataItemSchema = z.object({ key: z.string(), value: metadataValueSchema }).strict()
  const contextItemSchema = z.object({
    lane: z.union([z.string(), z.null()]),
    metadata: z.union([z.array(metadataItemSchema), z.null()]),
  }).strict()

  const parameters = await toJsonSchema(z.object({
    contexts: z.union([z.array(contextItemSchema), z.null()]),
  }).strict())

  return [
    rawTool({
      name: 'builtIn_emitSparkCommand',
      description: 'Fixture: nested nullable schema for provider conversion.',
      parameters,
      execute: async () => 'fixture ok',
    }),
  ]
}

interface ChatRequestBody {
  tools: Array<{
    function: {
      name: string
      parameters: JsonSchema
    }
  }>
}

function isJsonSchema(value: JsonSchema | boolean | undefined): value is JsonSchema {
  return Boolean(value && typeof value === 'object')
}

function getArraySchema(schema?: JsonSchema): JsonSchema | undefined {
  if (!schema)
    return undefined

  if (schema.type === 'array')
    return schema

  return schema.anyOf?.filter(isJsonSchema).find(candidate => candidate.type === 'array')
}

describe('providerOpenRouterAI tool schemas', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('maps AIRI reasoning modes to OpenRouter request fields', async () => {
    const provider = await providerOpenRouterAI.createProvider({
      apiKey: 'test-key',
    }) as ChatProviderWithExtraOptions<string, ChatRequestOptions>

    expect(provider.chat('openai/gpt-test', { reasoning: 'disabled' })).toMatchObject({
      reasoning: { effort: 'none' },
    })
    expect(provider.chat('openai/gpt-test', { reasoning: 'enabled' })).toMatchObject({
      reasoning: { effort: 'medium' },
    })
  })

  it('keeps the canonical nullable anyOf when it sends a chat request', async () => {
    const tools = await createNestedNullableToolFixture()
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}'))
    vi.stubGlobal('fetch', fetchMock)

    const provider = await providerOpenRouterAI.createProvider({
      apiKey: 'test-key',
    })
    if (!('chat' in provider))
      throw new Error('OpenRouter did not create a chat provider.')

    const providerFetch = provider.chat('google/gemini-test').fetch
    if (!providerFetch)
      throw new Error('OpenRouter did not create a fetch adapter.')

    await providerFetch(new URL('https://openrouter.ai/api/v1/chat/completions'), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'google/gemini-test',
        messages: [],
        tools,
      }),
    })

    const requestBody = fetchMock.mock.calls[0]?.[1]?.body
    if (typeof requestBody !== 'string')
      throw new Error('OpenRouter did not send a JSON request body.')

    const body = JSON.parse(requestBody) as ChatRequestBody
    const sparkTool = body.tools.find(tool => tool.function.name === 'builtIn_emitSparkCommand')
    const contexts = getArraySchema(sparkTool?.function.parameters.properties?.contexts as JsonSchema)
    const contextItem = contexts?.items as JsonSchema
    const metadata = getArraySchema(contextItem.properties?.metadata as JsonSchema)
    const metadataItem = metadata?.items as JsonSchema
    const metadataValue = metadataItem.properties?.value as JsonSchema

    expect(metadataValue.type).toBeUndefined()
    expect(metadataValue.anyOf).toEqual([
      { type: 'string' },
      { type: 'number' },
      { type: 'boolean' },
      { type: 'null' },
    ])
  })
})
