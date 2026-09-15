<script setup lang="ts">
/**
 * Skill adapter devtools probe (EP-1).
 *
 * Exposes the wrap/unwrap actions, the registration table, and the tool face
 * on `window.__AIRI_SKILL_ADAPTER_SMOKE__`, so a CDP session can run the
 * closed loop without adding a product UI.
 */
import { useElectronEventaInvoke } from '@proj-airi/electron-vueuse'
import { resolveEvidenceAuthor, useLlmToolsStore } from '@proj-airi/stage-ui/stores/ai/chat-llm/tools'
import { useJournalStore } from '@proj-airi/stage-ui/stores/journal'
import { useSkillsReviewStore } from '@proj-airi/stage-ui/stores/skills'
import { onMounted, onUnmounted, ref } from 'vue'

import { electronPluginInspect } from '../../../shared/eventa/plugin/host'

declare global {
  interface Window {
    __AIRI_SKILL_ADAPTER_SMOKE__?: {
      reviewedSkills: () => Array<{ toolId: string, name: string, contentHash: string }>
      adapterModes: () => Record<string, 'wrapped' | 'revoked'>
      wrap: (toolId: string) => Promise<void>
      unwrap: (toolId: string) => Promise<void>
      sync: () => Promise<void>
      registrations: () => Array<Record<string, unknown>>
      toolNames: () => string[]
      evidenceAuthorFor: (toolName: string) => string | undefined
      executeTool: (toolName: string, input: unknown) => Promise<unknown>
      journalTail: (limit?: number) => Array<Record<string, unknown>>
      /** Plugin-host capability records (CP-1 consumer visibility). */
      pluginCapabilities: () => Promise<Array<Record<string, unknown>>>
      /** CP-1 observer boundary state from the same inspect snapshot. */
      capabilityConsumerState: () => Promise<{ observed: string[], observerMode: boolean }>
    }
  }
}

const status = ref('idle')

onMounted(() => {
  const llmTools = useLlmToolsStore()
  const skills = useSkillsReviewStore()
  const journal = useJournalStore()
  const inspectPluginHost = useElectronEventaInvoke(electronPluginInspect)

  window.__AIRI_SKILL_ADAPTER_SMOKE__ = {
    reviewedSkills: () => skills.reviewedSkills.map(({ toolId, name, contentHash }) => ({ toolId, name, contentHash })),
    adapterModes: () => ({ ...skills.skillAdapterModes }),
    wrap: toolId => skills.wrapReviewedSkill(toolId),
    unwrap: toolId => skills.unwrapReviewedSkill(toolId),
    sync: () => skills.syncRuntimeTools(),
    registrations: () => llmTools.registrations.map(registration => ({ ...registration })),
    toolNames: () => llmTools.tools.map(tool => tool.function.name),
    evidenceAuthorFor: toolName => resolveEvidenceAuthor(
      llmTools.registrations.findLast(registration => registration.toolName === toolName),
      skills.reviewedSkills,
    ),
    executeTool: async (toolName, input) => {
      const tool = llmTools.getToolsByNames(toolName)[0]
      if (!tool?.execute)
        throw new Error(`Tool "${toolName}" is not registered.`)
      return await tool.execute(input, { messages: [], toolCallId: 'skills-adapter-smoke' })
    },
    journalTail: (limit = 20) => journal.readSession()
      .slice(-limit)
      .map(event => ({ ...event })),
    pluginCapabilities: async () => {
      const snapshot = await inspectPluginHost()
      return (snapshot.capabilities ?? []).map(capability => ({ ...capability }))
    },
    capabilityConsumerState: async () => {
      const snapshot = await inspectPluginHost()
      return { ...snapshot.consumerState }
    },
  }
  status.value = 'probe ready'
})

onUnmounted(() => {
  delete window.__AIRI_SKILL_ADAPTER_SMOKE__
})
</script>

<template>
  <div :class="['p-4', 'space-y-2']">
    <h1 :class="['text-lg', 'font-semibold']">
      Skill Adapter
    </h1>
    <p :class="['text-sm', 'opacity-70']">
      {{ status }}
    </p>
  </div>
</template>
