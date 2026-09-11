<script setup lang="ts">
import type { LifeModeRuntimeSnapshot, LifeModeTestHeartbeatResult } from '@proj-airi/stage-ui/stores/modules/life-mode'

import { Button } from '@proj-airi/ui'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps<{
  snapshot: LifeModeRuntimeSnapshot
  testing: boolean
  testResult?: LifeModeTestHeartbeatResult
}>()

const emit = defineEmits<{
  test: []
}>()

const { t, locale } = useI18n()
const budgetText = computed(() => props.snapshot.config.dailyBudget === 0
  ? t('settings.pages.modules.life-mode.sections.status.unlimited', { used: props.snapshot.budgetUsed })
  : t('settings.pages.modules.life-mode.sections.status.budget-value', {
      used: props.snapshot.budgetUsed,
      total: props.snapshot.config.dailyBudget,
    }))

function formatTime(value?: number): string {
  if (!value)
    return t('settings.pages.modules.life-mode.sections.status.never')
  return new Intl.DateTimeFormat(locale.value, {
    dateStyle: 'short',
    timeStyle: 'medium',
  }).format(value)
}

function gateLabel(gate?: string): string {
  if (!gate)
    return t('settings.pages.modules.life-mode.sections.status.none')
  return t(`settings.pages.modules.life-mode.sections.status.gates.${gate}`)
}
</script>

<template>
  <section :class="['rounded-xl', 'bg-neutral-50', 'p-4', 'dark:bg-[rgba(0,0,0,0.3)]']">
    <div :class="['flex', 'flex-col', 'gap-4']">
      <div :class="['flex', 'flex-wrap', 'items-start', 'justify-between', 'gap-3']">
        <div>
          <h2 :class="['text-lg', 'text-neutral-500', 'md:text-2xl', 'dark:text-neutral-400']">
            {{ t('settings.pages.modules.life-mode.sections.status.title') }}
          </h2>
          <p :class="['text-sm', 'text-neutral-400', 'dark:text-neutral-500']">
            {{ t('settings.pages.modules.life-mode.sections.status.description') }}
          </p>
        </div>
        <Button
          icon="i-solar:play-bold-duotone"
          color="primary"
          :loading="testing"
          :disabled="snapshot.config.mode !== 'autonomous'"
          @click="emit('test')"
        >
          {{ t('settings.pages.modules.life-mode.sections.status.test') }}
        </Button>
      </div>

      <dl :class="['grid', 'grid-cols-1', 'gap-3', 'text-sm', 'sm:grid-cols-2']">
        <div :class="['rounded-lg', 'bg-white/70', 'p-3', 'dark:bg-neutral-900/50']">
          <dt :class="['text-neutral-400', 'dark:text-neutral-500']">
            {{ t('settings.pages.modules.life-mode.sections.status.next-heartbeat') }}
          </dt>
          <dd mt-1 font-medium>
            {{ formatTime(snapshot.nextHeartbeatAt) }}
          </dd>
        </div>
        <div :class="['rounded-lg', 'bg-white/70', 'p-3', 'dark:bg-neutral-900/50']">
          <dt :class="['text-neutral-400', 'dark:text-neutral-500']">
            {{ t('settings.pages.modules.life-mode.sections.status.budget') }}
          </dt>
          <dd mt-1 font-medium>
            {{ budgetText }}
          </dd>
        </div>
        <div :class="['rounded-lg', 'bg-white/70', 'p-3', 'dark:bg-neutral-900/50']">
          <dt :class="['text-neutral-400', 'dark:text-neutral-500']">
            {{ t('settings.pages.modules.life-mode.sections.status.last-heartbeat') }}
          </dt>
          <dd mt-1 font-medium>
            {{ formatTime(snapshot.lastHeartbeatAt) }}
          </dd>
        </div>
        <div :class="['rounded-lg', 'bg-white/70', 'p-3', 'dark:bg-neutral-900/50']">
          <dt :class="['text-neutral-400', 'dark:text-neutral-500']">
            {{ t('settings.pages.modules.life-mode.sections.status.last-decision') }}
          </dt>
          <dd mt-1 font-medium>
            {{ formatTime(snapshot.lastDecisionAt) }}
          </dd>
        </div>
      </dl>

      <div :class="['flex', 'items-center', 'gap-2', 'text-sm']">
        <span :class="['text-neutral-400', 'dark:text-neutral-500']">{{ t('settings.pages.modules.life-mode.sections.status.last-gate') }}</span>
        <span :class="['rounded-full', 'bg-neutral-100', 'px-2', 'py-1', 'font-medium', 'dark:bg-neutral-800']">
          {{ gateLabel(snapshot.lastGate) }}
        </span>
      </div>

      <p v-if="testResult" :class="['text-sm', testResult.emitted ? 'text-emerald-600 dark:text-emerald-300' : 'text-amber-700 dark:text-amber-300']">
        {{ testResult.emitted
          ? t('settings.pages.modules.life-mode.sections.status.test-emitted')
          : t('settings.pages.modules.life-mode.sections.status.test-gated', { gate: gateLabel(testResult.gate) }) }}
      </p>
      <p :class="['text-xs', 'text-neutral-400', 'dark:text-neutral-500']">
        {{ t('settings.pages.modules.life-mode.sections.status.test-hint') }}
      </p>
    </div>
  </section>
</template>
