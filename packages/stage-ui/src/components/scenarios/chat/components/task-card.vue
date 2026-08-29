<script setup lang="ts">
import type { AttentionTask } from '../../../../stores/tasks'

import { Collapsible } from '@proj-airi/ui'
import { useNow } from '@vueuse/core'
import { computed, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps<{
  task: AttentionTask
}>()

const { t } = useI18n()
const visible = shallowRef(props.task.status === 'blocked')
const now = useNow({ interval: 30_000 })

watch(() => props.task.status, (status, previousStatus) => {
  if (status === 'blocked' && previousStatus !== 'blocked')
    visible.value = true
})

const statusLabel = computed(() => t(`stage.chat.attention.task.status.${props.task.status}`))
const elapsedLabel = computed(() => {
  const endedAt = props.task.status === 'done' ? props.task.updatedAt : now.value.getTime()
  const elapsedMs = Math.max(0, endedAt - props.task.startedAt)
  const elapsedMinutes = Math.floor(elapsedMs / 60_000)
  if (elapsedMinutes < 1)
    return '<1m'
  if (elapsedMinutes < 60)
    return `${elapsedMinutes}m`
  return `${Math.floor(elapsedMinutes / 60)}h ${elapsedMinutes % 60}m`
})

const statusIcon = computed(() => {
  if (props.task.status === 'blocked')
    return 'i-solar:danger-circle-bold-duotone text-red-500'
  if (props.task.status === 'done')
    return 'i-solar:check-circle-bold-duotone text-emerald-500'
  return 'i-eos-icons:loading op-50'
})
</script>

<template>
  <Collapsible
    v-model="visible"
    :default="task.status === 'blocked'"
    :class="[
      'rounded-lg bg-primary-100/40 px-2 py-1 dark:bg-primary-900/60',
      'flex flex-col items-start',
    ]"
    data-testid="chat-task-card"
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
        <span class="min-w-0 flex-1 truncate">{{ task.goal }}</span>
        <span class="shrink-0 text-xs text-neutral-500 dark:text-neutral-400">
          [{{ statusLabel }} · {{ elapsedLabel }}]
        </span>
      </button>
    </template>

    <div
      :class="[
        'mt-1 w-full rounded-md p-2 text-xs',
        'bg-neutral-100/80 text-neutral-800 dark:bg-neutral-900/80 dark:text-neutral-200',
      ]"
    >
      <dl class="grid grid-cols-[auto_1fr] gap-x-2 gap-y-1">
        <template v-if="task.memory.goal">
          <dt class="text-neutral-500 dark:text-neutral-400">
            {{ t('stage.chat.attention.task.goal') }}
          </dt>
          <dd>{{ task.memory.goal }}</dd>
        </template>
        <template v-if="task.memory.currentStep">
          <dt class="text-neutral-500 dark:text-neutral-400">
            {{ t('stage.chat.attention.task.current-step') }}
          </dt>
          <dd>{{ task.memory.currentStep }}</dd>
        </template>
        <template v-if="task.memory.blockers.length">
          <dt class="text-neutral-500 dark:text-neutral-400">
            {{ t('stage.chat.attention.task.blockers') }}
          </dt>
          <dd>{{ task.memory.blockers.join(', ') }}</dd>
        </template>
        <template v-if="task.memory.nextStep">
          <dt class="text-neutral-500 dark:text-neutral-400">
            {{ t('stage.chat.attention.task.next-step') }}
          </dt>
          <dd>{{ task.memory.nextStep }}</dd>
        </template>
        <template v-if="task.needsInput">
          <dt class="text-neutral-500 dark:text-neutral-400">
            {{ statusLabel }}
          </dt>
          <dd>{{ task.needsInput }}</dd>
        </template>
        <template v-if="task.conclusion">
          <dt class="text-neutral-500 dark:text-neutral-400">
            {{ statusLabel }}
          </dt>
          <dd>{{ task.conclusion }}</dd>
        </template>
        <template v-if="task.logRef">
          <dt class="text-neutral-500 dark:text-neutral-400">
            {{ t('stage.chat.attention.task.log-reference') }}
          </dt>
          <dd class="truncate">
            {{ task.logRef }}
          </dd>
        </template>
      </dl>
    </div>
  </Collapsible>
</template>
