import type { TodoItem } from '@proj-airi/core-agent'

import { defineStore } from 'pinia'
import { computed } from 'vue'

import { useJournalStore } from './journal'

/**
 * The model's own task list (HARNESS-PLAN §4.2).
 *
 * Two jobs that the fork keeps apart: the plan card decides what counts as
 * done (evidence gate), this list says what she is doing. Nothing here can
 * complete a plan step, and no gate can block a write — the gate stalled once
 * it also had to carry progress reporting, and a task list that can stall is
 * worse than none.
 *
 * State is derived, never stored: the list is the newest `todo/write` after
 * the newest `turn/start`, so a new turn starts empty with no clearing write,
 * and the last write of a turn wins.
 */
/** Shared empty list: a fresh array per read would retrigger every watcher. */
const EMPTY_TODOS: readonly TodoItem[] = Object.freeze([])

export const useTodoStore = defineStore('runtime-todos', () => {
  const journal = useJournalStore()

  const todos = computed<readonly TodoItem[]>(() => {
    const events = journal.events
    let latest: readonly TodoItem[] = EMPTY_TODOS

    for (const event of events) {
      if (event.type === 'turn/start')
        latest = EMPTY_TODOS
      else if (event.type === 'todo/write')
        latest = event.todos
    }

    return latest
  })

  const summary = computed(() => ({
    total: todos.value.length,
    completed: todos.value.filter(todo => todo.status === 'completed').length,
    inProgress: todos.value.filter(todo => todo.status === 'in_progress').length,
  }))

  /** Replaces the whole list; the newest write of a turn is the whole truth. */
  function write(next: readonly TodoItem[]): void {
    journal.appendActive({
      type: 'todo/write',
      todos: next.map(todo => ({ content: todo.content, status: todo.status })),
      timestamp: Date.now(),
    })
  }

  return {
    todos,
    summary,
    write,
  }
})
