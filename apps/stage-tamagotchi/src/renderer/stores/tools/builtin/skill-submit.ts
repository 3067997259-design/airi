import type { StaticFindings, ToolDeclaration, ToolRiskLevel } from '@proj-airi/skill-forge'
import type { ReviewQueueSubmission } from '@proj-airi/stage-ui/stores/skills'
import type { Tool } from '@xsai/shared-chat'

import { errorMessageFrom } from '@moeru/std'
import { analyzeSkillSource, classifyToolRisk, contentHashOf, validateDeclaration } from '@proj-airi/skill-forge'
import { useSkillsReviewStore } from '@proj-airi/stage-ui/stores/skills'
import { tool } from '@xsai/tool'
import { z } from 'zod'

import { createCodingHostClient } from '../../../bridges/coding-host'

// -- LLM Tool: skill_submit --
// First tooth of the self-authored tool loop (CAPABILITY-PLAN §五): SHE hands
// in a self-contained JS capability; this tool runs deterministic static
// analysis, persists the artifact to the workspace, optionally runs her
// sandbox self-test, and only then moves the skill into probation where the
// user reviews it. Nothing enters the LLM-visible tool table before approval.

const TOOL_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/
const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/
const MAX_SOURCE_CHARS = 60_000
const MAX_SELFTEST_CHARS = 20_000

const declarationSchema = z.object({
  networkEgress: z.boolean().optional().describe('True when the tool sends or receives data over the network.'),
  workspaceWrites: z.boolean().optional().describe('True when the tool creates, modifies, or deletes workspace files.'),
  subprocess: z.boolean().optional().describe('True when the tool launches external commands or programs.'),
  credentialedAccess: z.boolean().optional().describe('True when the tool reads or uses API keys, tokens, or passwords.'),
  destructiveOps: z.boolean().optional().describe('True when the tool deletes data or forces remote changes.'),
}).describe('Honest disclosure of what the tool touches. Omitted capabilities are treated as denied; a contradiction with the static analysis rejects the submission.')

const params = z.object({
  toolId: z.string().regex(TOOL_ID_PATTERN, 'toolId must be a lowercase kebab-case slug, e.g. "clipboard-last-copy"').describe('Stable id for this skill.'),
  name: z.string().regex(TOOL_NAME_PATTERN, 'name must start with a lowercase letter and contain only lowercase letters, digits, and underscores').describe('The tool name the LLM will call, e.g. "clipboard_last_copy".'),
  description: z.string().min(10).max(500).describe('One or two sentences: what this tool does and when to use it.'),
  source: z.string().min(1).max(MAX_SOURCE_CHARS).describe('The complete self-contained JavaScript implementation. It runs inside the Code Mode sandbox, so it may use bridge("read"/"write"/"edit"/"bash", ...) like any sandbox program.'),
  declaration: declarationSchema.optional(),
  activationKeywords: z.array(z.string().min(1).max(40)).max(10).optional().describe('Keywords in user text that should suggest this skill, e.g. ["clipboard"].'),
  activationPatterns: z.array(z.string().min(1).max(120)).max(5).optional().describe('Regex patterns that match user requests for this skill, e.g. ["\\\\bclipboard\\\\b"].'),
  promptContent: z.string().max(800).optional().describe('Short guidance injected into the system prompt when the skill is activated.'),
  parameters: z.record(z.string(), z.unknown()).optional().describe('JSON Schema properties for the tool input; keys and required go in "properties" / "required". Omit for an empty input object.'),
  selftest: z.string().max(MAX_SELFTEST_CHARS).optional().describe('A sandbox program that proves the tool works: it should read the persisted source with bridge("read", ["skills/<toolId>/source.mjs"]) and exercise it with sample input. The submission is rejected when this program fails.'),
  externalSources: z.array(z.string().url()).max(5).optional().describe('URLs the tool depends on or documents.'),
})

type SkillSubmitInput = z.infer<typeof params>

export interface SkillSubmitDeps {
  writeFile: (params: { path: string, content: string }) => Promise<unknown>
  runProgram: (params: { program: string, timeoutMs?: number }) => Promise<{
    ok: true
    value?: unknown
    logs: string[]
    traces: Array<{ toolName: string, args: unknown[], ok: boolean, resultSummary: string }>
  } | {
    ok: false
    failure: { kind: string, message: string, logs: string[], traces: Array<{ toolName: string, args: unknown[], ok: boolean, resultSummary: string }> }
  }>
}

const SELF_TEST_TIMEOUT_MS = 30_000

function serializeMeta(entry: { toolId: string, name: string, description: string, sourcePath: string, contentHash: string, riskLevel: ToolRiskLevel, staticAnalysis: StaticFindings, declared: ToolDeclaration, externalSources: string[], selftestPath?: string, selftestEvidence?: unknown }): string {
  return JSON.stringify({ ...entry, submittedAt: Date.now() }, null, 2)
}

/**
 * Executes one skill submission. Exported so behavioral tests can drive it
 * without the xsAI tool shell (same pattern as the plan_update executor).
 */
export async function executeSkillSubmit(input: SkillSubmitInput, deps: SkillSubmitDeps): Promise<string> {
  const skillsStore = useSkillsReviewStore()

  if (skillsStore.queue.some(entry => entry.toolId === input.toolId))
    return `skill_submit rejected: toolId "${input.toolId}" is already in the review queue.`

  // Risk is decided by rules, never by the model's self-report.
  const staticAnalysis = analyzeSkillSource(input.source)
  const declared = input.declaration ?? {}
  const declarationCheck = validateDeclaration(staticAnalysis, declared)
  if (!declarationCheck.consistent) {
    return [
      `skill_submit rejected: your declaration contradicts the static analysis.`,
      ...declarationCheck.mismatches.map(mismatch => `- ${mismatch}`),
      'Fix the declaration (or the source) and resubmit.',
    ].join('\n')
  }

  const riskLevel = classifyToolRisk(staticAnalysis)
  const contentHash = contentHashOf(input.source)
  const artifactDir = `skills/${input.toolId}`

  try {
    await deps.writeFile({ path: `${artifactDir}/source.mjs`, content: input.source })
  }
  catch (error) {
    return `skill_submit failed: could not persist the source: ${errorMessageFrom(error) ?? 'write error'}`
  }

  // Tooth 2 — sandbox self-test: the model proves the tool moves before it
  // ever lands in probation. A failing self-test returns the sandbox trace to
  // the model and does NOT submit.
  let selftestEvidence: { ok: true, logs: string[], traceCount: number } | undefined
  if (input.selftest?.trim()) {
    try {
      await deps.writeFile({ path: `${artifactDir}/selftest.mjs`, content: input.selftest })
    }
    catch (error) {
      return `skill_submit failed: could not persist the self-test: ${errorMessageFrom(error) ?? 'write error'}`
    }

    const run = await deps.runProgram({ program: input.selftest, timeoutMs: SELF_TEST_TIMEOUT_MS })
    if (!run.ok) {
      const failure = run.failure
      const traceSummary = failure.traces
        .map(trace => `  - ${trace.toolName}: ${trace.ok ? 'ok' : 'FAILED'} ${trace.resultSummary.slice(0, 160)}`)
        .join('\n')
      return [
        `skill_submit rejected: the self-test failed in the sandbox.`,
        `[${failure.kind}] ${failure.message}`,
        ...(failure.logs.slice(-8).map(line => `  ${line.slice(0, 300)}`)),
        ...(traceSummary ? [traceSummary] : []),
        'Fix the tool or its self-test and resubmit.',
      ].join('\n')
    }
    selftestEvidence = { ok: true, logs: run.logs.slice(-8), traceCount: run.traces.length }
  }

  const sourcePath = `${artifactDir}/source.mjs`
  await deps.writeFile({
    path: `${artifactDir}/meta.json`,
    content: serializeMeta({
      toolId: input.toolId,
      name: input.name,
      description: input.description,
      sourcePath,
      contentHash,
      riskLevel,
      staticAnalysis,
      declared,
      externalSources: input.externalSources ?? [],
      ...(input.selftest?.trim() ? { selftestPath: `${artifactDir}/selftest.mjs` } : {}),
      ...(selftestEvidence ? { selftestEvidence } : {}),
    }),
  }).catch((error) => {
    // A failed meta write leaves the source on disk but no queue entry; the
    // error must reach the model instead of a half-submitted state.
    throw new Error(`skill_submit failed: could not persist metadata: ${errorMessageFrom(error) ?? 'write error'}`)
  })

  const entry: ReviewQueueSubmission = {
    toolId: input.toolId,
    name: input.name,
    description: input.description,
    tool: {
      ownerExtensionId: 'airi',
      name: input.name,
      description: input.description,
      parameters: (input.parameters as { type: 'object', properties: Record<string, unknown>, required: string[], additionalProperties: boolean } | undefined) ?? {
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false,
      },
    },
    activation: {
      keywords: input.activationKeywords ?? [],
      patterns: input.activationPatterns ?? [],
    },
    prompt: {
      id: `skill:${input.toolId}`,
      content: input.promptContent ?? input.description,
    },
    contentHash,
    riskLevel,
    staticAnalysis,
    externalSources: input.externalSources ?? [],
    reason: 'self_tested',
  }

  const outcome = skillsStore.submit(entry)
  if (!outcome.accepted)
    return `skill_submit rejected: ${outcome.reason ?? 'unknown reason'}`

  const selfTestLine = selftestEvidence
    ? ` Self-test passed in the sandbox (${selftestEvidence.traceCount} bridge call(s)).`
    : ' No self-test was provided, so the source is submitted without runtime evidence.'
  return [
    `Skill "${input.name}" (${input.toolId}) submitted to probation for review.`,
    `Risk tier: ${riskLevel}. Artifacts: workspace ${artifactDir}/ (source.mjs, meta.json${input.selftest?.trim() ? ', selftest.mjs' : ''}).`,
    selfTestLine,
    'Until the user reviews it, the skill is NOT callable — do not call your own unreviewed skill. The review card appears in the chat timeline.',
  ].join('\n')
}

const tools: Promise<Tool>[] = [
  tool({
    name: 'skill_submit',
    description: [
      'Submit a self-contained JavaScript capability you wrote for review. The gate runs deterministic static analysis on your source and compares it against your declaration; a contradiction or a failed sandbox self-test rejects the submission before it reaches the queue.',
      'After approval by the user, the skill becomes a callable LLM tool. Never call a skill that is still in probation.',
    ].join(' '),
    execute: async (input: unknown) => {
      const client = createCodingHostClient()
      return executeSkillSubmit(input as SkillSubmitInput, {
        writeFile: params => client.writeFile(params),
        runProgram: params => client.runProgram(params),
      })
    },
    parameters: params,
  }),
]

export const skillSubmitTools = async () => Promise.all(tools)
