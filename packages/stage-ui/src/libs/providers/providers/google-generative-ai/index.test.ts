import type { ChatProviderWithExtraOptions } from '@xsai-ext/providers/utils'

import type { ChatRequestOptions, ProviderInstance } from '../../types'

import { describe, expect, it } from 'vitest'

import { providerGoogleGenerativeAI } from './index'

type GoogleChatProvider = ChatProviderWithExtraOptions<string, ChatRequestOptions>

function isChatProvider(provider: ProviderInstance): provider is GoogleChatProvider {
  return 'chat' in provider && typeof provider.chat === 'function'
}

describe('providerGoogleGenerativeAI reasoning controls', () => {
  it('keeps legacy toggle mapping for non-Gemini-3.8 models', async () => {
    const created = await providerGoogleGenerativeAI.createProvider({ apiKey: 'test-key' })
    if (!isChatProvider(created))
      throw new Error('Google provider did not create a chat provider.')

    expect(created.chat('gemini-2.5-flash', { reasoning: 'disabled' })).toMatchObject({ reasoningEffort: 'none' })
    expect(created.chat('gemini-2.5-flash', { reasoning: 'enabled' })).toMatchObject({ reasoningEffort: 'medium' })
  })

  it('uses the selected effort for canonical Gemini 3.8 Flash', async () => {
    const created = await providerGoogleGenerativeAI.createProvider({ apiKey: 'test-key' })
    if (!isChatProvider(created))
      throw new Error('Google provider did not create a chat provider.')

    const reasoning = providerGoogleGenerativeAI.capabilities?.chat?.reasoning
    if (typeof reasoning !== 'function')
      throw new Error('Google Gemini reasoning must be model-specific.')

    expect(reasoning('gemini-3.8-flash')).toMatchObject({ mandatory: true })
    expect(created.chat('gemini-3.8-flash', {
      reasoning: 'enabled',
      reasoningEffort: 'high',
    })).toMatchObject({ reasoningEffort: 'high' })
  })
})
