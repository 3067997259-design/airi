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
// A failed `/btw` must stay visible even with no exchanges yet, or the error
// would be swallowed the moment the ask settles.
const visible = computed(() => props.active || state.value.exchanges.length > 0 || busy.value || state.value.status === 'failed' || !!state.value.pendingUserQuestion)

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

function answerUserQuestion(answer: string, channel: 'choice' | 'text' | 'dismissed' = 'text') {
  const pending = state.value.pendingUserQuestion
  if (!pending)
    return
  btw.answerUser(pending.requestId, answer, channel)
}

function answerUserText(event: KeyboardEvent) {
  if (event.key !== 'Enter' || event.shiftKey)
    return
  const target = event.target as HTMLInputElement
  const answer = target.value.trim()
  if (!answer)
    return
  answerUserQuestion(answer)
  target.value = ''
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

    <div
      v-if="state.pendingUserQuestion"
      :class="['flex flex-col gap-2 rounded-md border p-2', 'border-amber-200/60 bg-amber-50/70 dark:border-amber-800/60 dark:bg-amber-950/30']"
      data-testid="chat-btw-user-question"
    >
      <span :class="['text-xs font-medium text-amber-700 dark:text-amber-300']">
        {{ t('stage.chat.question-card.title') }}
      </span>
      <span :class="['text-xs text-neutral-700 dark:text-neutral-200']">{{ state.pendingUserQuestion.question }}</span>
      <div v-if="state.pendingUserQuestion.choices?.length" class="flex flex-wrap gap-2">
        <Button
          v-for="choice in state.pendingUserQuestion.choices"
          :key="choice"
          size="sm"
          variant="secondary"
          @click="answerUserQuestion(choice, 'choice')"
        >
          {{ choice }}
        </Button>
      </div>
      <input
        type="text"
        :placeholder="t('stage.chat.question-card.placeholder')"
        :class="['min-h-7 w-full rounded-md border-2 border-solid px-2 py-1 text-sm outline-none', 'border-amber-200/50 bg-white/70 text-neutral-800 dark:border-amber-800/50 dark:bg-neutral-900/70 dark:text-neutral-100']"
        @keydown="answerUserText"
      >
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
