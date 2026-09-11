import type { ChatReasoningCapability, ChatRequestOptions } from '../../types'

import { createGoogleGenerativeAI } from '@xsai-ext/providers/create'
import { z } from 'zod'

import { ProviderValidationCheck } from '../../types'
import { createOpenAICompatibleValidators } from '../../validators'
import { defineProvider } from '../registry'

const googleGenerativeConfigSchema = z.object({
  apiKey: z
    .string('API Key'),
  baseUrl: z
    .string('Base URL')
    .optional()
    .default('https://generativelanguage.googleapis.com/v1beta/openai/'),
})

type GoogleGenerativeConfig = z.input<typeof googleGenerativeConfigSchema>

function resolveGoogleReasoningCapability(model: string): ChatReasoningCapability | undefined {
  const normalizedModel = model.trim().toLowerCase()
  if (!/^gemini-3\.8-flash(?:-preview)?$/.test(normalizedModel))
    return { modes: ['enabled', 'disabled'] }

  return {
    modes: ['enabled'],
    efforts: ['low', 'medium', 'high'],
    defaultEffort: 'medium',
    mandatory: true,
  }
}

export const providerGoogleGenerativeAI = defineProvider<GoogleGenerativeConfig>({
  id: 'google-generative-ai',
  order: 8,
  name: 'Google Gemini',
  nameLocalize: ({ t }) => t('settings.pages.providers.provider.google-generative-ai.title'),
  description: 'ai.google.dev',
  descriptionLocalize: ({ t }) => t('settings.pages.providers.provider.google-generative-ai.description'),
  tasks: ['chat'],
  capabilities: {
    chat: {
      reasoning: resolveGoogleReasoningCapability,
      imageInput: true,
    },
  },
  icon: 'i-lobe-icons:gemini',
  iconColor: 'i-lobe-icons:gemini-color',

  createProviderConfig: ({ t }) => googleGenerativeConfigSchema.extend({
    apiKey: googleGenerativeConfigSchema.shape.apiKey.meta({
      labelLocalized: t('settings.pages.providers.catalog.edit.config.common.fields.field.api-key.label'),
      descriptionLocalized: t('settings.pages.providers.catalog.edit.config.common.fields.field.api-key.description'),
      placeholderLocalized: t('settings.pages.providers.catalog.edit.config.common.fields.field.api-key.placeholder'),
      type: 'password',
    }),
    baseUrl: googleGenerativeConfigSchema.shape.baseUrl.meta({
      labelLocalized: t('settings.pages.providers.catalog.edit.config.common.fields.field.base-url.label'),
      descriptionLocalized: t('settings.pages.providers.catalog.edit.config.common.fields.field.base-url.description'),
      placeholderLocalized: t('settings.pages.providers.catalog.edit.config.common.fields.field.base-url.placeholder'),
    }),
  }),
  createProvider(config) {
    const provider = createGoogleGenerativeAI(config.apiKey, config.baseUrl)
    return {
      ...provider,
      chat(model: string, options?: ChatRequestOptions) {
        const request = provider.chat(model)
        const capability = resolveGoogleReasoningCapability(model)
        if (capability?.mandatory === true) {
          if (options?.reasoning !== 'enabled' || !options.reasoningEffort || options.reasoningEffort === 'auto')
            return request

          return { ...request, reasoningEffort: options.reasoningEffort }
        }

        if (!options?.reasoning)
          return request

        return { ...request, reasoningEffort: options.reasoning === 'enabled' ? 'medium' : 'none' }
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
