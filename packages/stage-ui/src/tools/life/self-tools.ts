import type { Tool } from '@xsai/shared-chat'

import { tool } from '@xsai/tool'
import { z } from 'zod'

/**
 * The only two tools mounted during a consideration turn (LIFE-PLAN §二.2).
 *
 * `self_speak` makes the round's text her own message on screen; `self_note`
 * records intent privately. Calling neither is the first-class "silence"
 * outcome — the turn's journal `life/tick` records whatever was decided.
 */
export async function createSelfTools(): Promise<Tool[]> {
  return Promise.all([
    tool({
      name: 'self_speak',
      description: 'Say something on your own initiative. The text you pass will appear as your own message in the chat. Use this when a consideration turn decides to open your mouth.',
      parameters: z.object({
        text: z.string().min(1).max(2000).describe('What you want to say, exactly as it should appear.'),
      }),
      execute: async () => 'Noted. These words will appear as your own message.',
    }),
    tool({
      name: 'self_note',
      description: 'Keep a private note for your journal without saying anything in chat. Use this when a consideration turn decides to remember something but stay silent.',
      parameters: z.object({
        text: z.string().min(1).max(2000).describe('The private note.'),
        topic: z.string().max(80).optional().describe('Optional topic label, e.g. "mood", "observation".'),
      }),
      execute: async () => 'Noted privately. Nothing appears in chat.',
    }),
  ])
}
