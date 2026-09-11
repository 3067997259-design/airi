<script setup lang="ts">
import type { PlanSurfaceLane, PlanView } from '../../../../stores/plans'

import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import ChatPlanCard from './plan-card.vue'

import { planSurfaceLanes } from '../../../../stores/plans'

/**
 * The global entry for work the timeline does not carry.
 *
 * The chat body only shows live work of the conversation it displays, so this
 * panel is where another conversation's long goal, an unattributed plan (no
 * session binding), and the terminal records of this window's scope stay
 * reachable. Session-horizon plans of other conversations stay with their own
 * timeline because `start()` supersedes them in-lane; only long goals are
 * meant to be watched across conversations. Archiving is a move between
 * surfaces, never a deletion: the history section keeps the full card,
 * including evidence and unverified step marks.
 */
const props = withDefaults(defineProps<{
  plans: readonly PlanView[]
  /** Display label per session id, so another conversation's goal names its source. */
  sessionLabels?: Readonly<Record<string, string>>
  /** The conversation this window shows; live work of it stays in the timeline. */
  sessionId?: string
}>(), {
  sessionLabels: () => ({}),
  sessionId: undefined,
})

const emit = defineEmits<{
  openSession: [sessionId: string]
}>()

const { t } = useI18n()
const expanded = ref(false)
const historyExpanded = ref(false)

const lanes = computed(() => planSurfaceLanes(props.plans, props.sessionId))

function lanePlans(lane: PlanSurfaceLane): PlanView[] {
  return props.plans.filter(plan => lanes.value.get(plan.id) === lane)
}

const currentPlans = computed(() => lanePlans('current'))
const otherSessionPlans = computed(() => lanePlans('other-session'))
const unattributedPlans = computed(() => lanePlans('unattributed'))
const archivedPlans = computed(() => lanePlans('archived')
  .sort((left, right) => right.updatedAt - left.updatedAt))
const activeCount = computed(() => currentPlans.value.length + otherSessionPlans.value.length + unattributedPlans.value.length)
const waitingCount = computed(() => [...currentPlans.value, ...otherSessionPlans.value, ...unattributedPlans.value]
  .filter(plan => plan.status === 'blocked')
  .length)
// Completed plans whose steps were closed without evidence keep their amber
// marks on the card, which would be easy to miss inside the collapsed history.
// Counting them on the bar keeps the unverified state visible (invariant 6).
const unverifiedCount = computed(() => props.plans.filter(plan =>
  plan.status === 'completed' && (plan.state.unverifiedSteps ?? []).length > 0)
  .length)

/**
 * Names the owner of another conversation's goal.
 *
 * A missing label means the meta was pruned while the plan row survived; the
 * row still shows its plan identity and a generic owner so the source is
 * never silently attributed to the current session.
 */
function sourceLabel(plan: PlanView): string {
  if (!plan.sessionId)
    return t('stage.chat.plan-center.unknown-session')
  return props.sessionLabels[plan.sessionId] ?? t('stage.chat.plan-center.unknown-session')
}
</script>

<template>
  <div
    v-if="plans.length > 0"
    data-testid="chat-plan-center"
    :class="['flex w-full flex-col rounded-lg px-2 py-1', 'bg-primary-50/40 dark:bg-primary-950/25']"
  >
    <button
      type="button"
      data-testid="chat-plan-center-toggle"
      :aria-expanded="expanded"
      :class="[
        'flex min-h-7 w-full min-w-0 items-center gap-2 text-start text-xs',
        'text-neutral-600 dark:text-neutral-300',
      ]"
      @click="expanded = !expanded"
    >
      <span class="i-solar:checklist-minimalistic-bold-duotone shrink-0" aria-hidden="true" />
      <span class="shrink-0 font-medium">{{ t('stage.chat.plan-center.title') }}</span>
      <span v-if="activeCount" class="min-w-0 truncate text-neutral-500 dark:text-neutral-400">
        {{ t('stage.chat.plan-center.active-count', { count: activeCount }) }}
      </span>
      <span v-if="waitingCount" class="min-w-0 truncate text-amber-700 dark:text-amber-300">
        {{ t('stage.chat.plan-center.waiting-count', { count: waitingCount }) }}
      </span>
      <span v-if="unverifiedCount" class="min-w-0 truncate text-amber-700 dark:text-amber-300" data-testid="chat-plan-center-unverified-count">
        {{ t('stage.chat.plan-center.unverified-count', { count: unverifiedCount }) }}
      </span>
      <span v-if="archivedPlans.length" class="min-w-0 truncate text-neutral-500 dark:text-neutral-400">
        {{ t('stage.chat.plan-center.history-count', { count: archivedPlans.length }) }}
      </span>
      <span class="flex-1" />
      <span
        :class="expanded ? 'i-solar:alt-arrow-up-line-duotone' : 'i-solar:alt-arrow-down-line-duotone'"
        class="shrink-0 text-neutral-400"
        aria-hidden="true"
      />
    </button>

    <div
      v-if="expanded"
      data-testid="chat-plan-center-panel"
      :class="['mt-1 flex max-h-80 flex-col gap-2 overflow-y-auto rounded-md p-2', 'bg-neutral-100/70 dark:bg-neutral-900/60']"
    >
      <p v-if="activeCount === 0 && archivedPlans.length === 0" class="text-xs text-neutral-500 dark:text-neutral-400">
        {{ t('stage.chat.plan-center.empty') }}
      </p>

      <section v-if="currentPlans.length" class="flex flex-col gap-1.5" data-testid="chat-plan-center-current">
        <h4 class="px-1 text-xs text-neutral-500 font-medium dark:text-neutral-400">
          {{ t('stage.chat.plan-center.current-session') }}
        </h4>
        <ChatPlanCard v-for="plan in currentPlans" :key="plan.id" :plan="plan" />
      </section>

      <section v-if="otherSessionPlans.length" class="flex flex-col gap-1.5" data-testid="chat-plan-center-other-sessions">
        <h4 class="px-1 text-xs text-neutral-500 font-medium dark:text-neutral-400">
          {{ t('stage.chat.plan-center.other-sessions') }}
        </h4>
        <div v-for="plan in otherSessionPlans" :key="plan.id" class="flex flex-col gap-1">
          <button
            type="button"
            data-testid="chat-plan-open-source"
            :class="[
              'self-start rounded px-1.5 py-0.5 text-[10px] font-medium',
              'bg-sky-100 text-sky-700 hover:bg-sky-200 dark:bg-sky-900/70 dark:text-sky-200 dark:hover:bg-sky-900',
            ]"
            @click="plan.sessionId && emit('openSession', plan.sessionId)"
          >
            {{ t('stage.chat.plan-center.open-source', { name: sourceLabel(plan) }) }}
          </button>
          <ChatPlanCard :plan="plan" />
        </div>
      </section>

      <section v-if="unattributedPlans.length" class="flex flex-col gap-1.5" data-testid="chat-plan-center-unattributed">
        <h4 class="px-1 text-xs text-neutral-500 font-medium dark:text-neutral-400">
          {{ t('stage.chat.plan-center.unattributed') }}
        </h4>
        <ChatPlanCard v-for="plan in unattributedPlans" :key="plan.id" :plan="plan" />
      </section>

      <section v-if="archivedPlans.length" class="flex flex-col gap-1.5" data-testid="chat-plan-center-history">
        <button
          type="button"
          data-testid="chat-plan-history-toggle"
          :aria-expanded="historyExpanded"
          :class="[
            'flex items-center gap-1 self-start rounded px-1 py-0.5 text-xs font-medium',
            'text-neutral-500 hover:bg-neutral-200/60 dark:text-neutral-400 dark:hover:bg-neutral-800/60',
          ]"
          @click="historyExpanded = !historyExpanded"
        >
          <span
            :class="historyExpanded ? 'i-solar:alt-arrow-up-line-duotone' : 'i-solar:alt-arrow-down-line-duotone'"
            aria-hidden="true"
          />
          {{ t('stage.chat.plan-center.history') }}
        </button>
        <template v-if="historyExpanded">
          <ChatPlanCard v-for="plan in archivedPlans" :key="plan.id" :plan="plan" />
        </template>
      </section>
    </div>
  </div>
</template>
