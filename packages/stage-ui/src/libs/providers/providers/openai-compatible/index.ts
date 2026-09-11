import type { ChatReasoningCapability, ChatRequestOptions } from '../../types'

import { createOpenAI } from '@xsai-ext/providers/create'
import { z } from 'zod'

import { ProviderValidationCheck } from '../../types'
import { createOpenAICompatibleValidators } from '../../validators'
import { defineProvider } from '../registry'

const openAICompatibleConfigSchema = z.object({
  apiKey: z
    .string('API Key')
    .optional(),
  baseUrl: z
    .string('Base URL')
    .optional()
    .default('https://api.openai.com/v1'),
})

type OpenAICompatibleConfig = z.input<typeof openAICompatibleConfigSchema>

function resolveOpenAICompatibleReasoningCapability(model: string): ChatReasoningCapability | undefined {
  const normalizedModel = model.trim().toLowerCase()
  if (!/^gemini-3\.8-flash(?:-preview)?$/.test(normalizedModel))
    return undefined

  return {
    modes: ['enabled'],
    efforts: ['low', 'medium', 'high'],
    defaultEffort: 'medium',
    mandatory: true,
  }
}

export const providerOpenAICompatible = defineProvider<OpenAICompatibleConfig>({
  id: 'openai-compatible',
  order: 4,
  name: 'OpenAI Compatible',
  nameLocalize: ({ t }) => t('settings.pages.providers.provider.openai-compatible.title'),
  description: 'OpenAI-compatible chat APIs with API key authentication.',
  descriptionLocalize: ({ t }) => t('settings.pages.providers.provider.openai-compatible.description'),
  tasks: ['chat'],
  icon: 'i-lobe-icons:openai',
  capabilities: {
    chat: {
      reasoning: resolveOpenAICompatibleReasoningCapability,
    },
  },

  createProviderConfig: ({ t }) => openAICompatibleConfigSchema.extend({
    apiKey: openAICompatibleConfigSchema.shape.apiKey.meta({
      labelLocalized: t('settings.pages.providers.catalog.edit.config.common.fields.field.api-key.label'),
      descriptionLocalized: t('settings.pages.providers.catalog.edit.config.common.fields.field.api-key.description'),
      placeholderLocalized: t('settings.pages.providers.catalog.edit.config.common.fields.field.api-key.placeholder'),
      type: 'password',
    }),
    baseUrl: openAICompatibleConfigSchema.shape.baseUrl.meta({
      labelLocalized: t('settings.pages.providers.catalog.edit.config.common.fields.field.base-url.label'),
      descriptionLocalized: t('settings.pages.providers.catalog.edit.config.common.fields.field.base-url.description'),
      placeholderLocalized: t('settings.pages.providers.catalog.edit.config.common.fields.field.base-url.placeholder'),
    }),
  }),
  createProvider(config) {
    const provider = createOpenAI(config.apiKey as string, config.baseUrl)
    return {
      ...provider,
      chat(model: string, options?: ChatRequestOptions) {
        const request = provider.chat(model)
        if (options?.reasoning !== 'enabled' || !options.reasoningEffort || options.reasoningEffort === 'auto')
          return request

        return { ...request, reasoningEffort: options.reasoningEffort }
      },
    }
  },

  validationRequiredWhen(config) {
    return !!config.apiKey?.trim()
  },
  validators: {
    ...createOpenAICompatibleValidators({
      checks: [ProviderValidationCheck.Connectivity, ProviderValidationCheck.ModelList, ProviderValidationCheck.ChatCompletions],
    }),
  },
})
