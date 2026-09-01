<script setup lang="ts">
import { BasicTextarea, Button } from '@proj-airi/ui'
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import { useBtwStore } from '../../../../stores/btw'

/**
 * The side card for asking while she works (HARNESS-PLAN §6).
 *
 * It talks to the btw store only: the question never enters the chat session,
 * the send queue, or the running turn's prompt. Stopping an answer here leaves
 * the work turn alone, which is the whole reason the channel exists.
 */
const props = defineProps<{
  /** Whether a turn is running; the channel exists for that window. */
  active: boolean
}>()

const { t } = useI18n()
const btw = useBtwStore()
const question = ref('')

const state = computed(() => btw.state)
const busy = computed(() => state.value.status === 'asking')
const visible = computed(() => props.active || state.value.exchanges.length > 0 || busy.value)

async function submit() {
  const text = question.value.trim()
  if (!text || busy.value)
    return
  question.value = ''
  await btw.askActive(text)
}

function onKeydown(event: KeyboardEvent) {
  if (event.key !== 'Enter' || event.shiftKey)
    return
  event.preventDefault()
  void submit()
}
</script>

<template>
  <div
    v-if="visible"
    data-testid="chat-btw-card"
    :class="['flex flex-col gap-2 rounded-lg p-2', 'bg-primary-50/40 dark:bg-primary-950/25']"
  >
    <div :class="['flex items-center justify-between gap-2']">
      <span :class="['text-xs font-medium text-neutral-500 dark:text-neutral-400']">
        {{ t('stage.chat.btw-card.title') }}
      </span>
      <Button v-if="busy" size="sm" variant="secondary" color="neutral" @click="btw.cancel()">
        {{ t('stage.chat.btw-card.stop') }}
      </Button>
    </div>

    <div v-for="(exchange, index) in state.exchanges" :key="index" :class="['flex flex-col gap-0.5 text-xs']">
      <span :class="['text-neutral-400 dark:text-neutral-500']">{{ exchange.question }}</span>
      <span :class="['text-neutral-700 dark:text-neutral-200']">{{ exchange.answer }}</span>
    </div>

    <span v-if="busy && state.streaming" :class="['text-xs text-neutral-700 dark:text-neutral-200']">
      {{ state.streaming }}
    </span>
    <span v-if="state.status === 'failed'" :class="['text-xs text-red-600 dark:text-red-400']">
      {{ state.error }}
    </span>

    <BasicTextarea
      v-model="question"
      :rows="1"
      :placeholder="t('stage.chat.btw-card.placeholder')"
      :class="['text-xs']"
      :submit-on-enter="false"
      @keydown="onKeydown"
    />
  </div>
</template>
