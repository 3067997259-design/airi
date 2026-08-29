<script setup lang="ts">
import type { PlanView } from '../../../../stores/plans'

import { Collapsible } from '@proj-airi/ui'
import { computed, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps<{
  plan: PlanView
}>()

const { t } = useI18n()
const visible = shallowRef(props.plan.status === 'blocked')

watch(() => props.plan.status, (status, previousStatus) => {
  if (status === 'blocked' && previousStatus !== 'blocked')
    visible.value = true
})

const statusLabel = computed(() => t(`stage.chat.plan.status.${props.plan.status}`))
const statusIcon = computed(() => {
  if (props.plan.status === 'blocked')
    return 'i-solar:danger-circle-bold-duotone text-red-500'
  if (props.plan.status === 'completed')
    return 'i-solar:check-circle-bold-duotone text-emerald-500'
  if (props.plan.status === 'failed')
    return 'i-solar:close-circle-bold-duotone text-red-500'
  return 'i-eos-icons:loading op-50'
})
</script>

<template>
  <Collapsible
    v-model="visible"
    :default="plan.status === 'blocked'"
    :class="[
      'rounded-lg bg-primary-100/40 px-2 py-1 dark:bg-primary-900/60',
      'flex flex-col items-start',
    ]"
    data-testid="chat-plan-card"
  >
    <template #trigger="{ visible: isVisible, setVisible }">
      <button
        type="button"
        :aria-expanded="isVisible"
        :class="[
          'flex min-h-7 w-full min-w-0 items-center gap-1 text-start',
          'text-sm text-neutral-700 dark:text-neutral-200',
        ]"
        @click="setVisible(!isVisible)"
      >
        <span :class="['shrink-0', statusIcon]" aria-hidden="true" />
        <span class="min-w-0 flex-1 truncate">{{ plan.goal }}</span>
        <span class="shrink-0 text-xs text-neutral-500 dark:text-neutral-400">
          [{{ statusLabel }} · {{ plan.state.completedSteps.length }}/{{ plan.spec.steps.length }}]
        </span>
      </button>
    </template>

    <div
      :class="[
        'mt-1 w-full rounded-md p-2 text-xs',
        'bg-neutral-100/80 text-neutral-800 dark:bg-neutral-900/80 dark:text-neutral-200',
      ]"
    >
      <div v-if="plan.state.currentStepId" class="mb-2">
        <span class="text-neutral-500 dark:text-neutral-400">{{ t('stage.chat.plan.current-step') }}:</span>
        {{ plan.state.currentStepId }}
      </div>
      <div v-if="plan.state.blockers.length" class="mb-2 text-red-600 dark:text-red-400">
        <span class="text-neutral-500 dark:text-neutral-400">{{ t('stage.chat.plan.blockers') }}:</span>
        {{ plan.state.blockers.join(', ') }}
      </div>
      <div class="flex flex-col gap-1">
        <div v-for="step in plan.spec.steps" :key="step.id" class="flex items-center gap-2">
          <span :class="plan.state.completedSteps.includes(step.id) ? 'i-solar:check-circle-bold-duotone text-emerald-500' : 'i-solar:minus-circle-bold-duotone text-neutral-400'" aria-hidden="true" />
          <span class="truncate">{{ step.id }} · {{ step.intent }}</span>
        </div>
      </div>
      <div v-if="plan.state.evidenceRefs.length" class="mt-2 border-t border-neutral-200 pt-2 dark:border-neutral-700">
        <div class="text-neutral-500 dark:text-neutral-400">
          {{ t('stage.chat.plan.evidence') }}
        </div>
        <div v-for="evidence in plan.state.evidenceRefs.slice(-4)" :key="`${evidence.stepId}:${evidence.summary}`" class="truncate">
          {{ evidence.source }} · {{ evidence.summary }}
        </div>
      </div>
    </div>
  </Collapsible>
</template>
