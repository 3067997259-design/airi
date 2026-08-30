<script setup lang="ts">
import { Button } from '@proj-airi/ui'
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'

import { useUserAskStore } from '../../../../stores/user-ask'

// In-flight `user_ask` question (COMMAND-PLAN §3.2): rendered from the
// synced user-ask store, so the card shows in whichever window hosts the
// conversation while the tool call suspends in the leader.
const store = useUserAskStore()
const { t } = useI18n()
const freeText = ref('')

function answerText() {
  const pending = store.pending
  const text = freeText.value.trim()
  if (!pending || !text)
    return
  store.answer({ requestId: pending.requestId, answer: text, channel: 'text' })
  freeText.value = ''
}

function answerChoice(choice: string) {
  const pending = store.pending
  if (!pending)
    return
  store.answer({ requestId: pending.requestId, answer: choice, channel: 'choice' })
}

function dismiss() {
  const pending = store.pending
  if (!pending)
    return
  store.dismiss(pending.requestId)
  freeText.value = ''
}
</script>

<template>
  <div
    v-if="store.pending"
    :class="[
      'mb-2 w-full rounded-xl border p-3 backdrop-blur-md',
      'border-violet-200/60 bg-violet-50/80 dark:border-violet-800/60 dark:bg-violet-950/60',
    ]"
    data-testid="chat-question-card"
  >
    <div class="mb-1 flex items-center justify-between gap-2">
      <span class="text-xs text-violet-600 font-semibold dark:text-violet-300">
        {{ t('stage.chat.question-card.title') }}
      </span>
      <button
        type="button"
        :class="['rounded p-1 text-neutral-400 outline-none transition-colors hover:text-neutral-600 dark:hover:text-neutral-200']"
        :title="t('stage.chat.question-card.dismiss')"
        :aria-label="t('stage.chat.question-card.dismiss')"
        @click="dismiss"
      >
        <div class="i-solar:close-circle-bold text-base" />
      </button>
    </div>
    <p class="mb-2 text-sm text-neutral-800 dark:text-neutral-100">
      {{ store.pending.question }}
    </p>
    <div v-if="store.pending.choices?.length" class="mb-2 flex flex-wrap gap-2">
      <Button
        v-for="choice in store.pending.choices"
        :key="choice"
        size="sm"
        variant="secondary"
        @click="answerChoice(choice)"
      >
        {{ choice }}
      </Button>
    </div>
    <div class="flex items-center gap-2">
      <input
        v-model="freeText"
        type="text"
        :placeholder="t('stage.chat.question-card.placeholder')"
        :class="[
          'min-h-7 w-full rounded-md border-2 border-solid px-2 py-1 text-sm outline-none',
          'border-violet-200/50 bg-white/70 text-neutral-800 dark:border-violet-800/50 dark:bg-neutral-900/70 dark:text-neutral-100',
        ]"
        @keydown.enter="answerText"
      >
      <Button size="sm" :disabled="!freeText.trim()" @click="answerText">
        {{ t('stage.chat.question-card.send') }}
      </Button>
    </div>
  </div>
</template>
