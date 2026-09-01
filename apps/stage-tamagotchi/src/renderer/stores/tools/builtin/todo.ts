import type { TodoItem } from '@proj-airi/core-agent'
import type { Tool } from '@xsai/shared-chat'

import { useTodoStore } from '@proj-airi/stage-ui/stores/todos'
import { tool } from '@xsai/tool'
import { z } from 'zod'

// -- LLM Tool: todo_write --
// The model's own task list (HARNESS-PLAN §4.2). It reports progress and
// nothing else: no verification gate reads it, and no gate can reject a write.
// The plan card keeps deciding what counts as done. Keeping the two apart is
// the point — the evidence gate stalled while it also had to carry progress
// reporting, and a task list that can stall is worse than no list.

const MAX_TODOS = 20
const MAX_TODO_LENGTH = 200

const params = z.object({
  todos: z.array(z.object({
    content: z.string().describe('One task, short and concrete.'),
    status: z.enum(['pending', 'in_progress', 'completed']).describe('pending: not started. in_progress: being worked on now. completed: finished.'),
  })).max(MAX_TODOS).describe('The complete list, in order. Every call replaces the previous list.'),
})

/**
 * The todo_write executor. Exported so behavioral tests can drive it without
 * the xsAI tool shell.
 */
export function executeTodoWrite(input: { todos: TodoItem[] }): string {
  const todos = input.todos.slice(0, MAX_TODOS).map(todo => ({
    content: todo.content.slice(0, MAX_TODO_LENGTH),
    status: todo.status,
  }))
  useTodoStore().write(todos)

  const completed = todos.filter(todo => todo.status === 'completed').length
  const current = todos.find(todo => todo.status === 'in_progress')
  return current
    ? `todo list updated (${completed}/${todos.length} done); now: ${current.content}`
    : `todo list updated (${completed}/${todos.length} done)`
}

const tools: Promise<Tool>[] = [
  tool({
    name: 'todo_write',
    description: 'Record the task list for the current work and keep it current. Send the whole list every call; it replaces the previous one. Use it for multi-step work so the user can watch progress: mark a task in_progress when you start it and completed the moment it is done. It reports progress only — it never completes a plan step.',
    execute: executeTodoWrite,
    parameters: params,
  }),
]

export const todoTools = async () => Promise.all(tools)
