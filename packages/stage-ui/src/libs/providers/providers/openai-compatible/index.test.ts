import type { ChatProviderWithExtraOptions } from '@xsai-ext/providers/utils'

import type { ChatRequestOptions, ProviderInstance } from '../../types'

import { describe, expect, it } from 'vitest'

import { providerOpenAICompatible } from './index'

type OpenAICompatibleChatProvider = ChatProviderWithExtraOptions<string, ChatRequestOptions>

function isChatProvider(provider: ProviderInstance): provider is OpenAICompatibleChatProvider {
  return 'chat' in provider && typeof provider.chat === 'function'
}

describe('providerOpenAICompatible Gemini reasoning controls', () => {
  it('advertises effort levels only for the canonical Gemini 3.8 Flash model id', () => {
    const reasoning = providerOpenAICompatible.capabilities?.chat?.reasoning
    if (typeof reasoning !== 'function')
      throw new Error('OpenAI-compatible Gemini reasoning must be model-specific.')

    expect(reasoning('gemini-3.8-flash')).toMatchObject({
      modes: ['enabled'],
      efforts: ['low', 'medium', 'high'],
      defaultEffort: 'medium',
      mandatory: true,
    })
    expect(reasoning('gemini-3.8-flash-high')).toBeUndefined()
  })

  it('maps a selected effort to the OpenAI-compatible request options', async () => {
    const created = await providerOpenAICompatible.createProvider({
      apiKey: 'test-key',
      baseUrl: 'https://example.test/v1',
    })
    if (!isChatProvider(created))
      throw new Error('OpenAI-compatible provider did not create a chat provider.')

    expect(created.chat('gemini-3.8-flash', {
      reasoning: 'enabled',
      reasoningEffort: 'high',
    })).toMatchObject({ reasoningEffort: 'high' })
    expect(created.chat('gemini-3.8-flash', {
      reasoning: 'enabled',
      reasoningEffort: 'auto',
    })).not.toHaveProperty('reasoningEffort')
  })
})
