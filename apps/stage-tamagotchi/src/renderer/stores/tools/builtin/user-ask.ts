import type { Tool } from '@xsai/shared-chat'

import { useUserAskStore } from '@proj-airi/stage-ui/stores/user-ask'
import { tool } from '@xsai/tool'
import { z } from 'zod'

// -- LLM Tool: user_ask --
// Lets the model get information mid-turn without ending it: the question
// card renders in the conversation, the turn suspends on the tool call, and
// the answer flows back as the tool result (COMMAND-PLAN §3.2). Dismissed
// cards resolve with an explicit no-answer so the model continues under a
// stated assumption instead of hanging.

export async function executeUserAsk(input: { question: string, choices?: string[] }): Promise<string> {
  const store = useUserAskStore()
  const answer = await store.ask(input.question, input.choices)

  if (answer.channel === 'dismissed')
    return 'The user dismissed the question without answering. Continue with your best assumption and state that assumption explicitly in your reply.'

  return `The user answered: ${JSON.stringify(answer.answer)}`
}

const tools: Promise<Tool>[] = [
  tool({
    name: 'user_ask',
    description: 'Ask the user one question and wait for the answer without ending the turn. Use it when a plan step or task is missing a decision only the user can make. Keep it to one question; offer choices when possible. Do not use it for approvals — approval-required plan steps raise their own approval card.',
    execute: executeUserAsk,
    parameters: z.object({
      question: z.string().describe('The single question to ask, one sentence.'),
      choices: z.array(z.string()).max(4).optional().describe('Optional short answer options the user can tap instead of typing.'),
    }),
  }),
]

export const userAskTools = async () => Promise.all(tools)
