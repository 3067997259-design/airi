import type { Tool } from '@xsai/shared-chat'

import { useDelegationStore } from '@proj-airi/stage-ui/stores/delegation'
import { tool } from '@xsai/tool'
import { z } from 'zod'

// -- LLM Tool: task --
// Delegation (HARNESS-PLAN §9.1). A search that reads twenty files costs the
// parent turn its context; a delegated run reads in its own and returns a
// short report. The child is read-only, and its report is a claim, not
// evidence: the authority order keeps tool output above model text, and a
// report is model text however many tools produced it.

const params = z.object({
  objective: z.string().describe('One question about the workspace, phrased so a short report can answer it. Example: "where is the plan evidence gate evaluated, and which file writes plan/update?"'),
})

/** The task executor. Exported so behavioral tests can drive it directly. */
export async function executeDelegatedTask(input: { objective: string }): Promise<string> {
  const report = await useDelegationStore().delegateActive(input.objective)
  return [
    'Sub-agent report (a claim, not evidence — verify anything you act on):',
    report,
  ].join('\n')
}

const tools: Promise<Tool>[] = [
  tool({
    name: 'task',
    description: 'Delegate one read-only search to a sub-agent that works in its own context and answers with a short report. Use it when finding something would take many reads: you pay for the answer instead of the search. The sub-agent cannot change files, and its report never proves a plan step.',
    execute: executeDelegatedTask,
    parameters: params,
  }),
]

export const delegationTools = async () => Promise.all(tools)
