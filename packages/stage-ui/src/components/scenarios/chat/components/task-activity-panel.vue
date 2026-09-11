<script setup lang="ts">
import type { TaskRun, TaskRunActivity } from '@proj-airi/core-agent'

import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'

/**
 * The task activity projection (TASK-RUN-AND-UI-PLAN batch B).
 *
 * Answers "what is she executing and how far along is it": tool calls and
 * results, narration, steering, and completion reviews of ONE task. The core
 * projection cuts the activity window by the task identity and caps it before
 * the snapshot crosses a renderer boundary. The full ledger stays in the
 * journal and devtools; this panel is bounded.
 */
const props = withDefaults(defineProps<{
  task: TaskRun
  /** Whether the stop control should be offered (desktop, live task). */
  canStop?: boolean
}>(), {
  canStop: true,
})

const emit = defineEmits<{
  (e: 'stop'): void
}>()

const { t } = useI18n()

const ACTIVITY_LIMIT = 40

interface ActivityRow {
  key: string
  tone: 'ok' | 'fail' | 'steering' | 'narration' | 'neutral'
  label: string
}

const isLive = computed(() => props.task.status === 'running' || props.task.status === 'waiting-user')
/** Mobile collapses to the summary line; detailed activity stays one tap away. */
const defaultOpen = ref(!isMobile())

function isMobile(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(max-width: 640px)').matches
}

const activity = computed<ActivityRow[]>(() => {
  return props.task.activity.slice(-ACTIVITY_LIMIT).map(rowForActivity)
})

const toolCallCount = computed(() => props.task.activity.filter(event => event.kind === 'tool-result').length)

function rowForActivity(event: TaskRunActivity): ActivityRow {
  switch (event.kind) {
    case 'tool-call':
      return {
        key: `call-${event.seq}`,
        tone: 'neutral',
        label: `${event.toolName} ${event.args}`,
      }
    case 'tool-result': {
      const outcome = event.ok && (event.outcome ?? 'ok') === 'ok' ? 'ok' : 'fail'
      return {
        key: `result-${event.seq}`,
        tone: outcome,
        label: `${outcome === 'ok' ? '✓' : '✗'} ${event.toolName}: ${event.summary}`,
      }
    }
    case 'narration':
      return {
        key: `narration-${event.seq}`,
        tone: 'narration',
        label: event.text,
      }
    case 'steering':
      return {
        key: `steering-${event.seq}`,
        tone: 'steering',
        label: `${t('stage.task-activity.steering')}: ${event.text.slice(0, 160)}`,
      }
    case 'plan-update':
      return {
        key: `plan-${event.seq}`,
        tone: 'neutral',
        label: `plan ${event.stepId ?? ''} ${event.status ?? ''}${event.unverified ? ' (unverified)' : ''}`.trim(),
      }
    case 'completion-review':
      return {
        key: `review-${event.seq}`,
        tone: event.verdict === 'pass' ? 'ok' : event.verdict === 'rejected' ? 'fail' : 'neutral',
        label: `${event.layer === 'gate' ? 'gate' : 'review'}: ${event.verdict}${event.blockers?.length ? ` — ${event.blockers[0]}` : ''}`,
      }
  }
}
</script>

<template>
  <div
    data-testid="chat-task-activity"
    :class="[
      'mx-2 mb-2 border rounded-xl px-3 py-2 text-xs',
      isLive
        ? 'border-amber-200/60 bg-amber-50/70 text-amber-800 dark:border-amber-800/60 dark:bg-amber-950/40 dark:text-amber-200'
        : 'border-neutral-200/60 bg-neutral-50/70 text-neutral-600 dark:border-neutral-700/60 dark:bg-neutral-900/40 dark:text-neutral-300',
    ]"
  >
    <details :open="defaultOpen">
      <summary :class="['cursor-pointer select-none font-medium', 'flex items-center gap-2']">
        <span class="min-w-0 flex-1 truncate" :title="task.title">{{ task.title }}</span>
        <span :class="['shrink-0', isLive ? 'text-amber-700/80 dark:text-amber-300/80' : 'text-neutral-500/80 dark:text-neutral-400/80']">
          {{ t(`stage.task-activity.status.${task.status}`) }}
          <template v-if="task.currentIteration !== undefined">
            · {{ t('stage.task-activity.iteration', { iteration: task.currentIteration }) }}
          </template>
          · {{ t('stage.task-activity.tool-calls', { count: toolCallCount }) }}
        </span>
        <button
          v-if="canStop && isLive"
          data-testid="chat-task-activity-stop"
          :class="['shrink-0 rounded-md border border-amber-300/70 px-2 py-0.5 hover:bg-amber-100 dark:border-amber-700/70 dark:hover:bg-amber-900/40']"
          :title="t('stage.task-activity.stop')"
          @click.prevent="emit('stop')"
        >
          {{ t('stage.task-activity.stop') }}
        </button>
      </summary>

      <div :class="['mt-2 flex flex-col gap-1', 'max-h-60 overflow-y-auto']">
        <p v-if="task.pendingQuestion" class="break-all font-medium">
          {{ t('stage.task-activity.pending-question') }}: {{ task.pendingQuestion }}
        </p>
        <p v-if="task.lastFailure" class="break-all text-red-700 dark:text-red-300">
          {{ t('stage.task-activity.last-failure') }}: {{ task.lastFailure }}
        </p>
        <p v-if="task.endDetail" class="break-all opacity-80">
          {{ task.endDetail }}
        </p>
        <p v-if="activity.length === 0" class="opacity-70">
          {{ t('stage.task-activity.empty') }}
        </p>
        <template v-else>
          <p
            v-for="row in activity"
            :key="row.key"
            :class="[
              row.tone === 'ok' && 'text-emerald-700 dark:text-emerald-300',
              row.tone === 'fail' && 'text-red-700 dark:text-red-300',
              row.tone === 'steering' && 'font-medium',
              row.tone === 'narration' && 'italic opacity-90',
              'break-all',
            ]"
          >
            {{ row.label }}
          </p>
        </template>
      </div>
    </details>
  </div>
</template>
