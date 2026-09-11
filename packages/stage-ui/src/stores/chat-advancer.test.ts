import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

/**
 * TASK-RUN-AND-UI-PLAN batch C acceptance: the flow is the only automatic
 * advancer of a task. The chat store used to keep a second one — a plan
 * continuation scheduler that fired synthetic self-initiative sends — and
 * this contract keeps it deleted.
 */
const chatStoreSource = readFileSync(fileURLToPath(new URL('./chat.ts', import.meta.url)), 'utf8')

describe('single automatic advancer contract', () => {
  it('keeps the plan continuation scheduler deleted', () => {
    expect(chatStoreSource).not.toContain('schedulePlanContinuation')
    expect(chatStoreSource).not.toContain('Plan continuation (')
    expect(chatStoreSource).not.toContain('MAX_PLAN_CONTINUATIONS_PER_PLAN')
  })

  it('records why the turn-complete hook no longer advances plans', () => {
    expect(chatStoreSource).toContain('only the flow may advance a task automatically')
  })
})
