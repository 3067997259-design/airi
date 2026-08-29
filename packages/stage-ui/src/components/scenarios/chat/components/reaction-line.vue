<script setup lang="ts">
import type { CharacterSparkNotifyReaction } from '../../../../stores/character'

import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps<{
  reaction: CharacterSparkNotifyReaction
}>()

const { t } = useI18n()

function sourceLabel(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim())
    return value.trim()
  if (typeof value !== 'object' || value === null || !('id' in value))
    return undefined

  const id = value.id
  return typeof id === 'string' && id.trim() ? id.trim() : undefined
}

const label = computed(() => sourceLabel(props.reaction.metadata?.source) ?? t('stage.chat.attention.event'))
</script>

<template>
  <div
    class="flex items-center gap-1 px-2 py-1 text-xs text-neutral-500 dark:text-neutral-400"
    data-testid="chat-reaction-line"
  >
    <span aria-hidden="true">·</span>
    <span class="truncate">{{ reaction.message }}</span>
    <span class="shrink-0 opacity-70">[{{ label }}]</span>
  </div>
</template>
