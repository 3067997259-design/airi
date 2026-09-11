<script setup lang="ts">
import type { PlanView } from '../../../../stores/plans'

import { Collapsible } from '@proj-airi/ui'
import { computed, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'

import { useLongGoalSchedulerStore } from '../../../../stores/modules/long-goals'

const props = defineProps<{
  plan: PlanView
}>()

const { locale, t } = useI18n()
const longGoalScheduler = useLongGoalSchedulerStore()
const visible = shallowRef(props.plan.status === 'blocked')

/** Answers the queue-depth question the scheduler raises on a busy Flow slot. */
const GOAL_QUEUE_CHOICES = Object.freeze([
  { value: 'keep-waiting' as const, label: 'stage.chat.plan.keep-waiting' },
  { value: 'pause' as const, label: 'stage.chat.plan.pause-goal' },
  { value: 'cancel' as const, label: 'stage.chat.plan.cancel-goal' },
])

watch(() => props.plan.status, (status, previousStatus) => {
  if (status === 'blocked' && previousStatus !== 'blocked')
    visible.value = true
})

const statusLabel = computed(() => t(`stage.chat.plan.status.${props.plan.status}`))
const horizonLabel = computed(() => t(`stage.chat.plan.horizon.${props.plan.spec.horizon}`))
const deadlineLabel = computed(() => {
  if (props.plan.spec.horizon !== 'long' || props.plan.spec.deadline === undefined)
    return undefined
  return new Intl.DateTimeFormat(locale.value, { dateStyle: 'medium' }).format(props.plan.spec.deadline)
})
const nextReviewLabel = computed(() => {
  const timestamp = props.plan.state.longGoal?.nextReviewAt
  if (timestamp === undefined)
    return undefined
  return new Intl.DateTimeFormat(locale.value, { dateStyle: 'medium', timeStyle: 'short' }).format(timestamp)
})
const statusIcon = computed(() => {
  if (props.plan.status === 'blocked')
    return 'i-solar:danger-circle-bold-duotone text-red-500'
  if (props.plan.status === 'completed')
    return 'i-solar:check-circle-bold-duotone text-emerald-500'
  if (props.plan.status === 'failed' || props.plan.status === 'cancelled')
    return 'i-solar:close-circle-bold-duotone text-red-500'
  return 'i-eos-icons:loading op-50'
})

/** A silent boolean return made "Run now" indistinguishable from a dead button. */
async function handleRunNow() {
  const queued = await longGoalScheduler.runNow(props.plan.id)
  if (queued)
    toast.success(t('stage.chat.plan.run-now-queued'))
  else
    toast.warning(t('stage.chat.plan.run-now-blocked'))
}
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
        <span
          :class="[
            'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium',
            plan.spec.horizon === 'long'
              ? 'bg-violet-100 text-violet-700 dark:bg-violet-900/70 dark:text-violet-200'
              : 'bg-sky-100 text-sky-700 dark:bg-sky-900/70 dark:text-sky-200',
          ]"
        >
          {{ horizonLabel }}
        </span>
        <!-- Keeps completed-without-evidence records from reading as clean
             success inside the collapsed plan-center history (invariant 6). -->
        <span
          v-if="(plan.state.unverifiedSteps?.length ?? 0) > 0"
          data-testid="chat-plan-unverified-flag"
          :class="[
            'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium',
            'bg-amber-100 text-amber-700 dark:bg-amber-900/70 dark:text-amber-200',
          ]"
        >
          {{ t('stage.chat.plan.unverified') }}
        </span>
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
      <div v-if="deadlineLabel" class="mb-2">
        <span class="text-neutral-500 dark:text-neutral-400">{{ t('stage.chat.plan.deadline') }}:</span>
        <time :datetime="new Date(plan.spec.deadline!).toISOString()">{{ deadlineLabel }}</time>
      </div>
      <div v-if="plan.state.blockers.length" class="mb-2 text-red-600 dark:text-red-400">
        <span class="text-neutral-500 dark:text-neutral-400">{{ t('stage.chat.plan.blockers') }}:</span>
        {{ plan.state.blockers.join(', ') }}
      </div>
      <div v-if="plan.state.longGoal?.waitReason" class="mb-2 text-amber-700 dark:text-amber-300">
        <span class="text-neutral-500 dark:text-neutral-400">{{ t('stage.chat.plan.wait-reason') }}:</span>
        {{ plan.state.longGoal.waitReason }}
      </div>
      <div v-if="nextReviewLabel" class="mb-2 text-neutral-600 dark:text-neutral-300">
        <span class="text-neutral-500 dark:text-neutral-400">{{ t('stage.chat.plan.next-review') }}:</span>
        {{ nextReviewLabel }}
      </div>
      <div v-if="plan.state.longGoal?.pendingQuestion" class="mb-2 text-violet-700 dark:text-violet-300">
        <span class="text-neutral-500 dark:text-neutral-400">{{ t('stage.chat.plan.pending-question') }}:</span>
        {{ plan.state.longGoal.pendingQuestion.question }}
      </div>
      <div
        v-if="plan.state.longGoal?.pendingQuestion"
        class="mb-2 flex flex-wrap gap-1"
        data-testid="chat-plan-pending-answer"
      >
        <button
          v-for="choice in GOAL_QUEUE_CHOICES"
          :key="choice.value"
          type="button"
          :class="[
            'rounded-md px-2 py-1 text-xs font-medium',
            'bg-violet-100 text-violet-700 hover:bg-violet-200 dark:bg-violet-900/70 dark:text-violet-200 dark:hover:bg-violet-900',
          ]"
          @click="void longGoalScheduler.answerPendingQuestion(plan.id, choice.value)"
        >
          {{ t(choice.label) }}
        </button>
      </div>
      <button
        v-if="plan.spec.horizon === 'long'"
        type="button"
        data-testid="chat-plan-run-now"
        :class="[
          'mb-2 rounded-md px-2 py-1 text-xs font-medium',
          'bg-violet-100 text-violet-700 hover:bg-violet-200 dark:bg-violet-900/70 dark:text-violet-200 dark:hover:bg-violet-900',
        ]"
        @click="void handleRunNow()"
      >
        {{ t('stage.chat.plan.run-now') }}
      </button>
      <div class="flex flex-col gap-1">
        <div v-for="step in plan.spec.steps" :key="step.id" class="flex items-center gap-2">
          <span
            :class="[
              plan.state.completedSteps.includes(step.id)
                ? (plan.state.unverifiedSteps?.includes(step.id)
                  ? 'i-solar:warning-circle-bold-duotone text-amber-500'
                  : 'i-solar:check-circle-bold-duotone text-emerald-500')
                : 'i-solar:minus-circle-bold-duotone text-neutral-400',
            ]"
            :title="plan.state.unverifiedSteps?.includes(step.id) ? t('stage.chat.plan.unverified') : undefined"
            aria-hidden="true"
          />
          <span class="truncate">{{ step.id }} · {{ step.intent }}</span>
          <span
            v-if="plan.state.unverifiedSteps?.includes(step.id)"
            :class="[
              'shrink-0 rounded px-1 py-0.5 text-[10px] font-medium',
              'bg-amber-100 text-amber-700 dark:bg-amber-900/70 dark:text-amber-200',
            ]"
          >
            {{ t('stage.chat.plan.unverified') }}
          </span>
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
