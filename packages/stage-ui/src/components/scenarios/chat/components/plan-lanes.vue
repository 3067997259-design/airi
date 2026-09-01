<script setup lang="ts">
import type { PlanPersistenceState, PlanView } from '../../../../stores/plans'

import { Button } from '@proj-airi/ui'
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import ChatPlanCard from './plan-card.vue'

import { usePlanStore } from '../../../../stores/plans'

const props = defineProps<{
  plans: readonly PlanView[]
}>()

const { t } = useI18n()
const sessionPlans = computed(() => props.plans.filter(plan => plan.spec.horizon === 'session'))
const longPlans = computed(() => props.plans.filter(plan => plan.spec.horizon === 'long'))

const retrying = ref(false)

/** Stable idle state for hosts that run this card without a Pinia instance. */
const IDLE_PERSISTENCE: PlanPersistenceState = Object.freeze({ status: 'idle' })

/**
 * Whether plans are being kept.
 *
 * Only a failure is shown: a working store needs no chip, and a follower
 * window owns no writes by design. The store is resolved lazily for the same
 * reason as the approval card — component tests mount the history without an
 * active Pinia (HARNESS-PLAN §4.3).
 */
const persistence = computed<PlanPersistenceState>(() => {
  try {
    return usePlanStore().persistence
  }
  catch {
    return IDLE_PERSISTENCE
  }
})

async function retryPersistence() {
  retrying.value = true
  try {
    await usePlanStore().retryPersistence()
  }
  finally {
    retrying.value = false
  }
}
</script>

<template>
  <div
    :class="[
      'flex w-full flex-col gap-3 rounded-xl p-2',
      'bg-primary-50/35 dark:bg-primary-950/20',
    ]"
    data-testid="chat-plan-lanes"
  >
    <div
      v-if="persistence.status === 'failed'"
      data-testid="chat-plan-persistence-chip"
      :class="['flex items-center justify-between gap-2 rounded-lg px-2 py-1', 'bg-amber-100/70 dark:bg-amber-500/10']"
    >
      <span class="min-w-0 text-xs text-amber-800 dark:text-amber-300">
        {{ t('stage.chat.plan.persistence.failed') }}
      </span>
      <Button size="sm" variant="secondary" color="neutral" :loading="retrying" @click="retryPersistence">
        {{ t('stage.chat.plan.persistence.retry') }}
      </Button>
    </div>

    <section v-if="sessionPlans.length" class="flex flex-col gap-1.5">
      <h3 class="px-1 text-xs text-neutral-500 font-medium dark:text-neutral-400">
        {{ t('stage.chat.plan.horizon.session') }}
      </h3>
      <ChatPlanCard v-for="plan in sessionPlans" :key="plan.id" :plan="plan" />
    </section>

    <section v-if="longPlans.length" class="flex flex-col gap-1.5">
      <h3 class="px-1 text-xs text-neutral-500 font-medium dark:text-neutral-400">
        {{ t('stage.chat.plan.horizon.long') }}
      </h3>
      <ChatPlanCard v-for="plan in longPlans" :key="plan.id" :plan="plan" />
    </section>
  </div>
</template>
