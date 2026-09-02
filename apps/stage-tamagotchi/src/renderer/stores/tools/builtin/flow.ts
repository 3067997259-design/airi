import type { Tool } from '@xsai/shared-chat'

import { useBtwStore } from '@proj-airi/stage-ui/stores/btw'
import { tool } from '@xsai/tool'
import { z } from 'zod'

const flowUpdateParams = z.object({
  action: z.enum(['start', 'done', 'blocked']).describe('start: enter flow. done: end after the task is complete. blocked: end after you ask the user through btw_ask or user_ask.'),
  detail: z.string().optional().describe('Short reason for the declaration.'),
})

/** Handles the model declaration that starts or ends a flow. */
export function executeFlowUpdate(input: { action: 'start' | 'done' | 'blocked', detail?: string }): string {
  if (input.action === 'start')
    return 'Flow declared. Continue until the task is done or blocked.'
  if (input.action === 'blocked')
    return `Flow blocker declared${input.detail ? `: ${input.detail}` : ''}.`
  return `Flow complete${input.detail ? `: ${input.detail}` : ''}.`
}

const btwAskParams = z.object({
  question: z.string().min(1).describe('One short question for the user. The work flow continues while the user answers.'),
  choices: z.array(z.string()).max(4).optional().describe('Optional short answer choices.'),
})

/** Sends a non-blocking user question from an active flow. */
export function executeBtwAsk(input: { question: string, choices?: string[] }): string {
  const requestId = useBtwStore().askUser(input.question, input.choices)
  return requestId
    ? `Question sent through btw as ${requestId}. Continue other work without waiting.`
    : 'The question was empty and was not sent.'
}

const tools: Promise<Tool>[] = [
  tool({
    name: 'flow_update',
    description: 'Declare flow control. Use start when work needs more than one turn. Use done only after the task is complete. Use blocked only after you ask the user with btw_ask or user_ask.',
    execute: executeFlowUpdate,
    parameters: flowUpdateParams,
  }),
  tool({
    name: 'btw_ask',
    description: 'Ask the user a non-blocking question during a flow. The flow continues with other work, and the answer appears in the next flow context.',
    execute: executeBtwAsk,
    parameters: btwAskParams,
  }),
]

export const flowTools = async () => Promise.all(tools)
