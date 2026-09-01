<script setup lang="ts">
import type { TodoItem } from '@proj-airi/core-agent'

import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import { useTodoStore } from '../../../../stores/todos'

const { t } = useI18n()

/** Shared empty list: a fresh array per read would retrigger every watcher. */
const EMPTY_TODOS: readonly TodoItem[] = Object.freeze([])

/**
 * The model's task list for the current turn.
 *
 * Pure projection of the journal: the card never writes and never blocks a
 * write, because this channel reports progress while the plan card decides
 * what counts as done (HARNESS-PLAN §4.2). The store is resolved lazily inside
 * the computed for the same reason as the approval card: component tests mount
 * the history without an active Pinia, and an empty card beats a thrown setup.
 */
const todos = computed<readonly TodoItem[]>(() => {
  try {
    return useTodoStore().todos
  }
  catch {
    return EMPTY_TODOS
  }
})

const completedCount = computed(() => todos.value.filter(todo => todo.status === 'completed').length)

function iconFor(status: TodoItem['status']): string {
  if (status === 'completed')
    return 'i-solar:check-circle-bold-duotone text-emerald-500'
  if (status === 'in_progress')
    return 'i-solar:play-circle-bold-duotone text-primary-500'
  return 'i-solar:minus-circle-bold-duotone text-neutral-400'
}
</script>

<template>
  <div
    v-if="todos.length > 0"
    data-testid="chat-todo-card"
    :class="['flex', 'flex-col', 'gap-1', 'rounded-lg', 'bg-neutral-100/80', 'p-3', 'dark:bg-neutral-900/70']"
  >
    <div :class="['flex', 'items-center', 'justify-between', 'gap-2']">
      <span :class="['text-sm', 'font-medium', 'text-neutral-600', 'dark:text-neutral-300']">
        {{ t('stage.chat.todo-card.title') }}
      </span>
      <span :class="['text-xs', 'text-neutral-400', 'dark:text-neutral-500']">
        {{ completedCount }}/{{ todos.length }}
      </span>
    </div>
    <div
      v-for="(todo, index) in todos"
      :key="`${index}:${todo.content}`"
      :class="['flex', 'items-start', 'gap-2', 'text-xs']"
    >
      <span :class="[iconFor(todo.status), 'mt-0.5', 'shrink-0']" aria-hidden="true" />
      <span
        :class="[
          'min-w-0',
          todo.status === 'completed' ? 'text-neutral-400 line-through dark:text-neutral-500' : 'text-neutral-600 dark:text-neutral-300',
        ]"
      >
        {{ todo.content }}
      </span>
    </div>
  </div>
</template>
