import type {
  SelfAuthoredSkill,
  SkillRevisionProposal,
  StaticFindings,
  ToolRiskLevel,
} from '@proj-airi/skill-forge'

import type { ExecutableTool } from './ai/chat-llm/tools'

import {
  applyLifecycleAction,
  canEnterProbation,
  contentHashOf,
  MAX_PROBATION_TOOLS,
} from '@proj-airi/skill-forge'
import { defineStore } from 'pinia'
import { computed, ref, toRaw } from 'vue'

import { useLlmToolsStore } from './ai/chat-llm/tools'
import { useLlmToolsetPromptsStore } from './ai/chat-llm/toolset-prompts'
import { useJournalStore } from './journal'
import { useMemoryStore } from './modules/memory'

/** Static review data projected beside the canonical skill contract. */
export interface ReviewQueueEntry extends SelfAuthoredSkill {
  toolId: string
  name: string
  description: string
  riskLevel: ToolRiskLevel
  staticAnalysis: StaticFindings
  reason: 'self_tested' | 'compatibility_mismatch'
}

export type ReviewQueueSubmission = Omit<ReviewQueueEntry, 'trust' | 'review' | 'quarantine'>

export interface SkillRuntimeCommandResult {
  tier: 'read-only' | 'medium' | 'high'
  status: 'ok' | 'error' | 'denied' | 'timeout'
  stdout: string
  stderr: string
  exitCode?: number
  requestId?: string
}

export interface SkillRevisionCandidate {
  toolId: string
  toolName: string
  failureSeq: number
  failureSummary: string
}

export interface SkillRuntimePort {
  runCommand: (params: { command: string, approvalRequired?: boolean }) => Promise<SkillRuntimeCommandResult>
}

let skillRuntime: SkillRuntimePort | undefined

/** Installs the host command port used by reviewed self-authored skills. */
export function installSkillRuntime(next: SkillRuntimePort | undefined): void {
  skillRuntime = next
}

/**
 * First review subject: an opencode adapter skeleton. It remains inert until
 * the user submits and reviews it through the queue.
 */
export const OPENCODE_ADAPTER_SKELETON: ReviewQueueSubmission = {
  toolId: 'opencode-adapter',
  name: 'opencode_delegate',
  description: 'Drives the opencode CLI: version probe, task dispatch, structured result.',
  tool: {
    ownerExtensionId: 'airi',
    name: 'opencode_delegate',
    description: 'Drives the opencode CLI: version probe, task dispatch, structured result.',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Task to send to opencode.' },
        args: { type: 'array', items: { type: 'string' }, description: 'Optional extra CLI arguments.' },
      },
      required: ['task'],
      additionalProperties: false,
    },
  },
  activation: {
    keywords: ['opencode'],
    patterns: ['\\bopencode\\b'],
  },
  prompt: {
    id: 'opencode-adapter',
    content: 'Use the reviewed opencode adapter for delegated coding tasks.',
  },
  contentHash: contentHashOf([
    '// opencode adapter skeleton',
    'export async function run(rawArgs: string[]) {',
    '  const args = parseArgs(rawArgs)',
    '  return await execCommand(\'opencode \' + args.join(\' \'))',
    '}',
  ].join('\n')),
  riskLevel: 'high',
  staticAnalysis: {
    networkEgress: false,
    workspaceWrites: true,
    subprocess: true,
    readOnlySubprocess: false,
    credentialedAccess: false,
    destructiveOps: false,
  },
  externalSources: [],
  compatibility: {
    probe: {
      command: 'opencode --version',
      expectedPattern: 'opencode\\s+v?\\d',
    },
    onMismatch: 'quarantine',
  },
  reason: 'self_tested',
}

/** Human review queue for self-authored skills. */
export const useSkillsReviewStore = defineStore('skills-review', () => {
  const llmToolsStore = useLlmToolsStore()
  const toolsetPromptsStore = useLlmToolsetPromptsStore()
  const journalStore = useJournalStore()
  const memoryStore = useMemoryStore()
  const queue = ref<ReviewQueueEntry[]>([])
  const catalog = ref<ReviewQueueSubmission[]>([OPENCODE_ADAPTER_SKELETON])
  const revisionBatch = ref<SkillRevisionCandidate[]>([])
  const runtimeToolIds = new Set<string>()
  const reviewRequestIds = new Map<string, string>()

  const probationCount = computed(() => queue.value.filter(entry => entry.trust === 'probation').length)
  const canSubmitMore = computed(() => canEnterProbation(queue.value))

  function activeEntries() {
    return queue.value.filter(entry => entry.trust === 'reviewed' && !entry.quarantine)
  }

  function syncRuntimeTools() {
    const nextIds = new Set(activeEntries().map(entry => `self-authored:${entry.toolId}`))
    for (const id of runtimeToolIds) {
      if (!nextIds.has(id))
        llmToolsStore.removeToolById(id)
    }
    runtimeToolIds.clear()

    const tools: ExecutableTool[] = activeEntries().map(entry => ({
      id: `self-authored:${entry.toolId}`,
      type: 'function',
      function: {
        name: entry.tool.name,
        description: entry.tool.description,
        parameters: structuredClone(toRaw(entry.tool.parameters)),
      },
      defaultActive: false,
      execute: input => executeSkill(entry, input),
    }))
    if (tools.length > 0)
      llmToolsStore.addTools(...tools)
    for (const id of nextIds)
      runtimeToolIds.add(id)
  }

  function activatedEntries(text: string) {
    const normalized = text.toLocaleLowerCase()
    return activeEntries().filter((entry) => {
      const keywordHit = entry.activation.keywords.some(keyword => normalized.includes(keyword.toLocaleLowerCase()))
      const patternHit = entry.activation.patterns.some((pattern) => {
        try {
          return new RegExp(pattern, 'i').test(text)
        }
        catch {
          return false
        }
      })
      return keywordHit || patternHit
    })
  }

  /** Prepares the model-facing prompt and returns activated tool names. */
  function prepareForPrompt(text: string): string[] {
    const entries = activatedEntries(text)
    toolsetPromptsStore.registerToolsetPrompts('self-authored-skills', entries.map(entry => ({
      id: `skill:${entry.toolId}`,
      title: entry.name,
      content: entry.prompt.content,
    })))
    return entries.map(entry => entry.tool.name)
  }

  async function executeSkill(entry: ReviewQueueEntry, input: unknown): Promise<unknown> {
    if (entry.toolId !== OPENCODE_ADAPTER_SKELETON.toolId)
      return `Skill "${entry.toolId}" has no registered runtime executor.`
    if (!skillRuntime)
      return `Skill "${entry.toolId}" is unavailable because the coding host is not installed.`

    const taskInput = input && typeof input === 'object' ? input as Record<string, unknown> : {}
    const task = typeof taskInput.task === 'string' ? taskInput.task.trim() : ''
    if (!task)
      return 'opencode_delegate requires a non-empty task.'

    const probe = entry.compatibility?.probe
    if (probe) {
      const probeResult = await runSkillCommand(entry, probe.command, ['--version'])
      let compatible = probeResult.status === 'ok'
      if (compatible) {
        try {
          compatible = new RegExp(probe.expectedPattern, 'i').test(probeResult.stdout)
        }
        catch {
          compatible = false
        }
      }
      if (!compatible) {
        quarantine(entry.toolId)
        return {
          status: 'quarantined',
          reason: 'compatibility_mismatch',
          probe: probeResult,
        }
      }
    }

    const extraArgs = Array.isArray(taskInput.args)
      ? taskInput.args.filter((value): value is string => typeof value === 'string')
      : []
    const command = ['opencode', 'run', '--json', quoteCommandArgument(task), ...extraArgs.map(quoteCommandArgument)].join(' ')
    return await runSkillCommand(entry, command, [task, ...extraArgs])
  }

  async function runSkillCommand(entry: ReviewQueueEntry, command: string, args: unknown[]) {
    journalStore.appendActive({
      type: 'tool/call',
      toolName: entry.tool.name,
      args,
    })
    const result = await skillRuntime!.runCommand({ command, approvalRequired: true })
    journalStore.appendActive({
      type: 'tool/result',
      toolName: entry.tool.name,
      ok: result.status === 'ok',
      summary: `${result.status}: ${(result.stdout || result.stderr).slice(0, 500)}`,
      provenance: 'reviewed_self_authored',
    })
    return result
  }

  /** Submits a freshly written tool to probation. */
  function submit(entry: ReviewQueueSubmission): { accepted: boolean, reason?: string } {
    if (queue.value.some(existing => existing.toolId === entry.toolId))
      return { accepted: false, reason: 'duplicate toolId' }

    if (!canEnterProbation(queue.value))
      return { accepted: false, reason: `probation capped at ${MAX_PROBATION_TOOLS}; graduate or reject first` }

    const draft: ReviewQueueEntry = { ...entry, trust: 'draft' }
    queue.value.push(applyLifecycleAction(draft, 'promote_to_probation') as ReviewQueueEntry)
    const reviewRequestId = `review:${entry.toolId}:${Date.now()}`
    reviewRequestIds.set(entry.toolId, reviewRequestId)
    journalStore.appendActive({
      type: 'review/asked',
      reviewRequestId,
      toolId: entry.toolId,
      contentHash: entry.contentHash,
      reason: 'self-authored tool entered probation',
    })
    syncRuntimeTools()
    return { accepted: true }
  }

  /** Applies a content change and invalidates any review bound to the old hash. */
  function applyContentChange(toolId: string, source: string): void {
    const index = queue.value.findIndex(item => item.toolId === toolId)
    const entry = queue.value[index]
    if (!entry)
      return

    queue.value[index] = applyLifecycleAction(entry, 'content_changed', {
      newContentHash: contentHashOf(source),
    }) as ReviewQueueEntry
    syncRuntimeTools()
  }

  /** Binds reviewer approval to the entry's current content hash. */
  function approve(toolId: string, reviewer = 'you', rationale = 'reviewed the source'): void {
    const index = queue.value.findIndex(item => item.toolId === toolId)
    const entry = queue.value[index]
    if (!entry || entry.trust !== 'probation')
      return

    queue.value[index] = applyLifecycleAction(entry, 'approve_review', {
      review: { reviewer, rationale, reviewedAt: Date.now() },
    }) as ReviewQueueEntry
    journalStore.appendActive({
      type: 'review/decided',
      reviewRequestId: reviewRequestIds.get(toolId) ?? `review:${toolId}`,
      toolId,
      decision: 'approved',
      reviewer,
      rationale,
    })
    syncRuntimeTools()
    const triggerPattern = entry.activation.patterns[0] ?? entry.activation.keywords[0] ?? entry.tool.name
    void memoryStore.rememberMuscle({
      content: entry.tool.description,
      triggerPattern,
    }).catch((error) => {
      console.warn('[Skills] Muscle memory write failed.', error)
    })
  }

  /** Removes a rejected entry from the queue. */
  function reject(toolId: string): void {
    if (queue.value.some(item => item.toolId === toolId)) {
      journalStore.appendActive({
        type: 'review/decided',
        reviewRequestId: reviewRequestIds.get(toolId) ?? `review:${toolId}`,
        toolId,
        decision: 'rejected',
        reviewer: 'you',
      })
    }
    queue.value = queue.value.filter(item => item.toolId !== toolId)
    reviewRequestIds.delete(toolId)
    syncRuntimeTools()
  }

  /** Returns a non-draft skill to probation after a compatibility mismatch. */
  function quarantine(toolId: string): void {
    const index = queue.value.findIndex(item => item.toolId === toolId)
    const entry = queue.value[index]
    if (!entry || entry.trust === 'draft')
      return

    queue.value[index] = applyLifecycleAction(entry, 'compatibility_mismatch', {
      detectedAt: Date.now(),
    }) as ReviewQueueEntry
    syncRuntimeTools()
  }

  /** Clears quarantine after the author fixes the compatibility probe. */
  function clearQuarantine(toolId: string): void {
    const index = queue.value.findIndex(item => item.toolId === toolId)
    const entry = queue.value[index]
    if (!entry)
      return

    queue.value[index] = applyLifecycleAction(entry, 'reset_fix', {
      fixedAt: Date.now(),
    }) as ReviewQueueEntry
    syncRuntimeTools()
  }

  /** Batches failed reviewed-tool calls and returns those tools to probation. */
  function dreamRevisionBatch(): SkillRevisionCandidate[] {
    const candidates: SkillRevisionCandidate[] = []
    const seen = new Set<string>()
    for (const event of journalStore.events) {
      if (event.type !== 'tool/result' || event.ok || seen.has(event.toolName))
        continue
      const entry = queue.value.find(item => item.tool.name === event.toolName && item.trust === 'reviewed')
      if (!entry)
        continue
      seen.add(event.toolName)
      candidates.push({
        toolId: entry.toolId,
        toolName: event.toolName,
        failureSeq: event.seq,
        failureSummary: event.summary.slice(0, 500),
      })
    }
    revisionBatch.value = candidates.slice(-5)
    for (const candidate of revisionBatch.value) {
      const index = queue.value.findIndex(item => item.toolId === candidate.toolId)
      const entry = queue.value[index]
      if (!entry || entry.trust !== 'reviewed')
        continue
      const revision: SkillRevisionProposal = {
        sourceEventSeq: candidate.failureSeq,
        reason: candidate.failureSummary,
        proposedAt: Date.now(),
      }
      queue.value[index] = applyLifecycleAction(entry, 'propose_revision', { revision }) as ReviewQueueEntry
      journalStore.appendActive({
        type: 'review/asked',
        reviewRequestId: `revision:${candidate.toolId}:${candidate.failureSeq}`,
        toolId: candidate.toolId,
        contentHash: entry.contentHash,
        reason: `dreaming pass: ${candidate.failureSummary.slice(0, 180)}`,
      })
    }
    syncRuntimeTools()
    return revisionBatch.value
  }

  return {
    queue,
    catalog,
    revisionBatch,
    probationCount,
    canSubmitMore,
    submit,
    applyContentChange,
    approve,
    reject,
    quarantine,
    clearQuarantine,
    dreamRevisionBatch,
    prepareForPrompt,
    syncRuntimeTools,
  }
})

function quoteCommandArgument(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

export { contentHashOf, MAX_PROBATION_TOOLS } from '@proj-airi/skill-forge'
