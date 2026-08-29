<script setup lang="ts">
import type { ChatOrchestratorCompactionSnapshot } from '@proj-airi/core-agent'

import type { ChatHistoryItem } from '../../../../types/chat'

import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps<{
  compaction: ChatOrchestratorCompactionSnapshot
  messages: ChatHistoryItem[]
}>()

const { t } = useI18n()
const originalMessages = computed(() => {
  const boundary = props.messages.findIndex(message => message.id === props.compaction.keepFromMessageId)
  if (boundary <= 0)
    return []

  return props.messages
    .slice(0, boundary)
    .filter(message => message.role === 'user' || message.role === 'assistant')
})

function messageText(message: ChatHistoryItem): string {
  if (typeof message.content === 'string')
    return message.content

  if (!Array.isArray(message.content))
    return ''

  return message.content
    .filter((part): part is { type: 'text', text: string } => typeof part === 'object' && part !== null && part.type === 'text' && typeof part.text === 'string')
    .map(part => part.text)
    .join('\n')
}
</script>

<template>
  <div
    data-testid="chat-compaction-notice"
    class="mx-2 mb-2 border border-primary-200/60 rounded-xl bg-primary-50/70 px-3 py-2 text-xs text-primary-700 dark:border-primary-800/60 dark:bg-primary-950/50 dark:text-primary-200"
  >
    <details>
      <summary class="cursor-pointer select-none font-medium">
        {{ t('stage.chat.memory.compacted', { count: compaction.removedTurnCount }) }}
      </summary>
      <div class="mt-2 flex flex-col gap-1 text-primary-700/80 dark:text-primary-200/80">
        <p>{{ compaction.summary }}</p>
        <p>{{ t('stage.chat.memory.original-available') }}</p>
        <details v-if="originalMessages.length" class="mt-1">
          <summary class="cursor-pointer select-none">
            {{ t('stage.chat.memory.show-original', { count: originalMessages.length }) }}
          </summary>
          <ol class="mt-1 list-decimal pl-4">
            <li v-for="(message, index) in originalMessages" :key="message.id ?? index">
              {{ messageText(message) }}
            </li>
          </ol>
        </details>
      </div>
    </details>
  </div>
</template>
