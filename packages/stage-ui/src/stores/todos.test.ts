import type { TodoItem } from '@proj-airi/core-agent'

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { useJournalStore } from './journal'
import { useTodoStore } from './todos'

const LIST: TodoItem[] = [
  { content: 'read the failing test', status: 'completed' },
  { content: 'fix the parser', status: 'in_progress' },
  { content: 'run the suite', status: 'pending' },
]

describe('todo store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    useJournalStore().ensureSession('todo-session')
  })

  it('keeps the last write of the turn and counts its states', () => {
    const store = useTodoStore()

    store.write(LIST)
    store.write([{ content: 'fix the parser', status: 'completed' }])

    expect(store.todos.map(todo => todo.content)).toEqual(['fix the parser'])
    expect(store.summary).toEqual({ total: 1, completed: 1, inProgress: 0 })
  })

  it('starts every turn with an empty list without a clearing write', () => {
    const journal = useJournalStore()
    const store = useTodoStore()

    store.write(LIST)
    expect(store.todos).toHaveLength(3)

    journal.appendActive({
      type: 'turn/start',
      turnId: 'turn-2',
      source: 'text',
      timestamp: Date.now(),
      maxSteps: 10,
    })

    expect(store.todos).toHaveLength(0)
    expect(store.summary.total).toBe(0)
  })

  it('returns the same empty list every read so watchers do not fire', () => {
    const store = useTodoStore()

    expect(store.todos).toBe(store.todos)
  })
})
