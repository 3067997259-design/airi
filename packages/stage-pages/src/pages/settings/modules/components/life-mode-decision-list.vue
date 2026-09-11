<script setup lang="ts">
import type { JournalEvent } from '@proj-airi/core-agent'

import { useI18n } from 'vue-i18n'

type LifeDecision = Extract<JournalEvent, { type: 'life/decision' }>

defineProps<{
  decisions: LifeDecision[]
}>()

const { t, locale } = useI18n()

function formatTime(value: number): string {
  return new Intl.DateTimeFormat(locale.value, {
    dateStyle: 'short',
    timeStyle: 'medium',
  }).format(value)
}
</script>

<template>
  <section :class="['rounded-xl', 'bg-neutral-50', 'p-4', 'dark:bg-[rgba(0,0,0,0.3)]']">
    <div :class="['flex', 'flex-col', 'gap-4']">
      <div>
        <h2 :class="['text-lg', 'text-neutral-500', 'md:text-2xl', 'dark:text-neutral-400']">
          {{ t('settings.pages.modules.life-mode.sections.decisions.title') }}
        </h2>
        <p :class="['text-sm', 'text-neutral-400', 'dark:text-neutral-500']">
          {{ t('settings.pages.modules.life-mode.sections.decisions.description') }}
        </p>
      </div>

      <p v-if="decisions.length === 0" :class="['rounded-lg', 'bg-white/70', 'p-3', 'text-sm', 'text-neutral-400', 'dark:bg-neutral-900/50', 'dark:text-neutral-500']">
        {{ t('settings.pages.modules.life-mode.sections.decisions.empty') }}
      </p>
      <ol v-else :class="['flex', 'flex-col', 'gap-2']">
        <li
          v-for="decision in decisions"
          :key="decision.decisionId"
          :class="['rounded-lg', 'bg-white/70', 'p-3', 'dark:bg-neutral-900/50']"
        >
          <div :class="['flex', 'flex-wrap', 'items-center', 'justify-between', 'gap-2']">
            <span :class="['rounded-full', 'bg-primary-50', 'px-2', 'py-1', 'text-xs', 'text-primary-700', 'font-medium', 'dark:bg-primary-950/40', 'dark:text-primary-200']">
              {{ t(`settings.pages.modules.life-mode.sections.decisions.actions.${decision.action}`) }}
            </span>
            <time :class="['text-xs', 'text-neutral-400', 'dark:text-neutral-500']">{{ formatTime(decision.timestamp) }}</time>
          </div>
          <p v-if="decision.text" :class="['mt-2', 'text-sm']">
            {{ decision.text }}
          </p>
          <p v-if="decision.reason" :class="['mt-1', 'text-xs', 'text-neutral-400', 'dark:text-neutral-500']">
            {{ decision.reason }}
          </p>
        </li>
      </ol>
    </div>
  </section>
</template>
