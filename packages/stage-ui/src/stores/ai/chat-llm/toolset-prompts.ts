import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

export interface LlmToolsetPromptContribution {
  id: string
  title?: string
  content: string
  /** Prompt consumers may restrict a contribution to one turn profile. */
  profiles?: readonly ('social' | 'work')[]
}

function renderToolsetPrompts(prompts: LlmToolsetPromptContribution[], profile: 'social' | 'work') {
  const activePrompts = prompts.filter(prompt => (prompt.profiles === undefined || prompt.profiles.includes(profile)) && prompt.content.trim().length > 0)
  if (activePrompts.length === 0) {
    return ''
  }

  const lines = ['## Toolset', '']

  for (const prompt of activePrompts) {
    if (prompt.title) {
      lines.push(`### ${prompt.title}`, '')
    }

    lines.push(prompt.content.trim())
    lines.push('')
  }

  return lines.join('\n').trim()
}

export const useLlmToolsetPromptsStore = defineStore('llm-toolset-prompts', () => {
  const promptsByProvider = ref<Record<string, LlmToolsetPromptContribution[]>>({})

  function registerToolsetPrompts(provider: string, prompts: LlmToolsetPromptContribution[]) {
    promptsByProvider.value = {
      ...promptsByProvider.value,
      [provider]: structuredClone(prompts),
    }
  }

  function clearToolsetPrompts(provider: string) {
    const { [provider]: _removed, ...remaining } = promptsByProvider.value
    promptsByProvider.value = remaining
  }

  function renderFor(profile: 'social' | 'work'): string {
    return renderToolsetPrompts(Object.values(promptsByProvider.value).flat(), profile)
  }

  const activeToolsetPrompt = computed(() => renderFor('social'))

  return {
    activeToolsetPrompt,
    clearToolsetPrompts,
    promptsByProvider,
    renderFor,
    registerToolsetPrompts,
  }
})
