import { useJournalStore } from '@proj-airi/stage-ui/stores/journal'
import { useTodoStore } from '@proj-airi/stage-ui/stores/todos'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { executeTodoWrite } from './todo'

describe('executeTodoWrite', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    useJournalStore().ensureSession('todo-tool-session')
  })

  it('replaces the list and reports what she is on now', () => {
    const result = executeTodoWrite({
      todos: [
        { content: 'read the failing test', status: 'completed' },
        { content: 'fix the parser', status: 'in_progress' },
      ],
    })

    expect(result).toBe('todo list updated (1/2 done); now: fix the parser')
    expect(useTodoStore().todos.map(todo => todo.status)).toEqual(['completed', 'in_progress'])
  })

  it('bounds the list so one call cannot flood the card', () => {
    const long = 'x'.repeat(400)
    executeTodoWrite({ todos: Array.from({ length: 30 }, () => ({ content: long, status: 'pending' as const })) })

    const todos = useTodoStore().todos
    expect(todos).toHaveLength(20)
    expect(todos[0]?.content).toHaveLength(200)
  })
})
