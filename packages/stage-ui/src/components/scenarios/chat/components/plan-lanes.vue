<script setup lang="ts">
import type { PlanView } from '../../../../stores/plans'

import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import ChatPlanCard from './plan-card.vue'

const props = defineProps<{
  plans: readonly PlanView[]
}>()

const { t } = useI18n()
const sessionPlans = computed(() => props.plans.filter(plan => plan.spec.horizon === 'session'))
const longPlans = computed(() => props.plans.filter(plan => plan.spec.horizon === 'long'))
</script>

<template>
  <div
    :class="[
      'flex w-full flex-col gap-3 rounded-xl p-2',
      'bg-primary-50/35 dark:bg-primary-950/20',
    ]"
    data-testid="chat-plan-lanes"
  >
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
