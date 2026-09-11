import type { Tool } from '@xsai/shared-chat'

import { rawTool, tool } from '@xsai/tool'
import { literal, maxLength, minLength, pipe, safeParse, strictObject, string, trim, variant } from 'valibot'
import { z } from 'zod'

export type SelfDecision
  = | { action: 'speak', text: string, reason: string }
    | { action: 'note', text: string, reason: string }
    | { action: 'silence', reason: string }

const decisionTextSchema = pipe(string(), trim(), minLength(1), maxLength(2000))
const decisionReasonSchema = pipe(string(), trim(), minLength(1), maxLength(500))
const selfDecisionSchema = variant('action', [
  strictObject({
    action: literal('speak'),
    text: decisionTextSchema,
    reason: decisionReasonSchema,
  }),
  strictObject({
    action: literal('note'),
    text: decisionTextSchema,
    reason: decisionReasonSchema,
  }),
  strictObject({
    action: literal('silence'),
    reason: decisionReasonSchema,
  }),
])

/** Validates one explicit consideration decision. */
export function parseSelfDecision(input: unknown): SelfDecision {
  const parsed = safeParse(selfDecisionSchema, input)
  if (!parsed.success)
    throw new TypeError('Invalid self decision.')
  return parsed.output
}

/**
 * Creates the single control tool for a social consideration round.
 *
 * The provider schema stays flat for broad tool-call compatibility. Valibot
 * enforces the action-specific text contract inside the execute boundary.
 */
export function createSelfDecisionTool(): Tool {
  return rawTool<SelfDecision>({
    name: 'self_decide',
    description: 'Choose exactly one result for this private consideration: speak publicly, keep a private note, or remain silent.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action', 'reason'],
      properties: {
        action: {
          type: 'string',
          enum: ['speak', 'note', 'silence'],
          description: 'The one result of this consideration.',
        },
        text: {
          type: 'string',
          minLength: 1,
          maxLength: 2000,
          description: 'Required for speak or note. Omit for silence.',
        },
        reason: {
          type: 'string',
          minLength: 1,
          maxLength: 500,
          description: 'A short reason based only on the supplied stimulus.',
        },
      },
    },
    execute: (input) => {
      const decision = parseSelfDecision(input)
      return JSON.stringify({ accepted: true, action: decision.action })
    },
  })
}

/**
 * Creates the social decision tool and the historical self tools.
 *
 * New consideration rounds mount only `self_decide`. The two older tools stay
 * registered while task/blocker callers finish moving to their own channel.
 */
export async function createSelfTools(): Promise<Tool[]> {
  return [
    createSelfDecisionTool(),
    ...await Promise.all([
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
    ]),
  ]
}
