import type { MemoryScope } from '@proj-airi/memory-core'
import type {
  SkillRevisionProposal,
} from '@proj-airi/skill-forge'

import type { ReviewQueueEntry } from '../types/skill-review'
import type { ExecutableTool } from './ai/chat-llm/tools'

import { errorMessageFrom } from '@moeru/std'
import {
  applyLifecycleAction,
  canEnterProbation,
  contentHashOf,
  MAX_PROBATION_TOOLS,
  validateToolInput,
  validateToolInputSchema,
} from '@proj-airi/skill-forge'
import { defineStore, getActivePinia } from 'pinia'
import { computed, ref, shallowRef, toRaw } from 'vue'

import * as v from 'valibot'

import { areRestoreEffectsHeld, waitForRestore } from '../services/restore-gate'
import { builtInSkillArtifact } from '../services/skill-artifacts'
import { skillReviewSchema } from '../types/skill-review'
import { useLlmToolsStore } from './ai/chat-llm/tools'
import { useLlmToolsetPromptsStore } from './ai/chat-llm/toolset-prompts'
import { useJournalStore } from './journal'
import { useMemoryStore } from './modules/memory'

export type { ReviewQueueEntry } from '../types/skill-review'

export type ReviewQueueSubmission = Omit<ReviewQueueEntry, 'trust' | 'review' | 'quarantine'>

export interface SkillRuntimeCommandResult {
  tier: 'read-only' | 'medium' | 'high'
  /**
   * `started` only appears for a background job, which skill self-tests never
   * request: a self-test that does not return output cannot prove anything.
   */
  status: 'ok' | 'error' | 'denied' | 'timeout' | 'started'
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

export type SkillRuntimeProgramResult
  = | { ok: true, value?: unknown, logs: string[] }
    | { ok: false, failure: { kind: string, message: string, logs: string[] } }

export interface SkillRuntimePort {
  readSource?: (toolId: string, workspaceRoot?: string) => Promise<string>
  readSelftest?: (toolId: string, workspaceRoot?: string) => Promise<string>
  getWorkspaceRoot?: () => Promise<string>
  getMemoryScope?: () => MemoryScope
  runCommand: (params: { command: string, approvalRequired?: boolean }) => Promise<SkillRuntimeCommandResult>
  /** Shared Code Mode sandbox, used by the generic reviewed-skill executor. */
  runProgram?: (params: { program: string, timeoutMs?: number, expectedWorkspaceRoot?: string }) => Promise<SkillRuntimeProgramResult>
}

let skillRuntime: SkillRuntimePort | undefined

/** Exact artifacts displayed to a reviewer; approval rechecks both hashes. */
export interface SkillReviewArtifacts {
  contentHash: string
  source: string
  selftest?: { contentHash: string, source: string, logs: string[], traceCount: number }
}

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
  contentHash: builtInSkillArtifact.contentHash,
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

const SKILLS_QUEUE_STORAGE_KEY = 'skills/review-queue'

/** Toolset prompt provider for reviewed skills that are currently not callable. */
const UNAVAILABLE_SKILLS_PROMPT_PROVIDER = 'self-authored-skills-unavailable'
/** Bound the unavailable list so the toolset section cannot grow with the queue. */
const UNAVAILABLE_SKILLS_PROMPT_MAX = 10

/**
 * Reads and validates the durable registry. Invalid bytes remain in storage
 * and block writes until the user repairs or restores the registry.
 */
function hydrateQueueFromStorage(): ReviewQueueEntry[] {
  if (typeof localStorage === 'undefined')
    return []
  const raw = localStorage.getItem(SKILLS_QUEUE_STORAGE_KEY)
  if (raw === null)
    return []
  return v.parse(v.array(skillReviewSchema), JSON.parse(raw))
}

function persistQueueAndTrim(entries: ReviewQueueEntry[]): void {
  // Non-renderer callers have no durable storage owner.
  if (typeof localStorage !== 'undefined')
    localStorage.setItem(SKILLS_QUEUE_STORAGE_KEY, JSON.stringify(entries))
}

/** Human review queue for self-authored skills. */
export const useSkillsReviewStore = defineStore('skills-review', () => {
  const pinia = getActivePinia()
  const llmToolsStore = useLlmToolsStore()
  const toolsetPromptsStore = useLlmToolsetPromptsStore()
  const journalStore = useJournalStore()
  const memoryStore = useMemoryStore()
  const queue = ref<ReviewQueueEntry[]>([])
  const persistenceError = shallowRef<string>()
  try {
    queue.value = hydrateQueueFromStorage().map(entry => ({
      ...entry,
      artifactError: entry.trust === 'reviewed' ? 'Artifact verification is pending.' : entry.artifactError,
    }))
  }
  catch (error) {
    // Keep the original bytes intact. A damaged registry must not become an
    // empty registry that the next review silently overwrites.
    persistenceError.value = errorMessageFrom(error) ?? 'Cannot read the skill registry.'
  }
  const catalog = ref<ReviewQueueSubmission[]>([OPENCODE_ADAPTER_SKELETON])
  const revisionBatch = ref<SkillRevisionCandidate[]>([])
  const runtimeToolIds = new Set<string>()
  const reviewRequestIds = new Map<string, string>()

  function persist() {
    if (persistenceError.value)
      throw new Error(persistenceError.value)
    try {
      persistQueueAndTrim(queue.value)
    }
    catch (error) {
      persistenceError.value = errorMessageFrom(error) ?? 'Cannot save the skill registry.'
      throw error
    }
  }

  // Received snapshots must not write storage. Only the explicit review
  // actions below persist, after the leader applies a complete transition.

  const probationCount = computed(() => queue.value.filter(entry => entry.trust === 'probation').length)
  const canSubmitMore = computed(() => canEnterProbation(queue.value))

  /** Projects reviewed, non-quarantined skills for the chat input skill shelf. */
  const reviewedSkills = computed(() => activeEntries().map(entry => ({
    toolId: entry.toolId,
    name: entry.name,
    description: entry.description,
  })))

  function activeEntries() {
    return queue.value.filter((entry) => {
      if (persistenceError.value || entry.trust !== 'reviewed' || entry.quarantine || entry.artifactError || entry.reviewedHash !== entry.contentHash)
        return false
      return validateToolInputSchema(entry.tool.parameters) === undefined
    })
  }

  /**
   * Explains to the model why a reviewed skill is excluded from the tool list.
   *
   * A filtered-out skill used to be invisible except by its absence, so the
   * model could only answer "not in the tool list" or guess at unrelated
   * discovery tools (ACC-20260910 R05). Name the entry and its reason instead.
   */
  function registerUnavailableSkillsPrompt(): void {
    const unavailable = queue.value.filter(entry => entry.trust === 'reviewed' && !activeEntries().includes(entry))
    if (unavailable.length === 0) {
      toolsetPromptsStore.clearToolsetPrompts(UNAVAILABLE_SKILLS_PROMPT_PROVIDER)
      return
    }

    const listed = unavailable.slice(0, UNAVAILABLE_SKILLS_PROMPT_MAX)
    const content = [
      'These reviewed self-authored skills are not callable right now. Do not call them and do not invent their results. Tell the user the reason below and ask them to re-verify the skill in Settings → Modules → Skills.',
      ...listed.map(entry => `- ${entry.name} (${entry.toolId}): ${unavailableSkillReason(entry)}`),
      ...(unavailable.length > listed.length ? [`- and ${unavailable.length - listed.length} more unavailable reviewed skills.`] : []),
    ].join('\n')
    toolsetPromptsStore.registerToolsetPrompts(UNAVAILABLE_SKILLS_PROMPT_PROVIDER, [{
      id: 'self-authored-skills-unavailable',
      title: 'Unavailable reviewed skills',
      content,
    }])
  }

  function unavailableSkillReason(entry: ReviewQueueEntry): string {
    if (persistenceError.value)
      return persistenceError.value
    if (entry.quarantine)
      return 'quarantined after a failed compatibility check'
    if (entry.reviewedHash !== entry.contentHash)
      return 'the reviewed hash does not match the current source'
    if (entry.artifactError)
      return entry.artifactError
    return validateToolInputSchema(entry.tool.parameters) ?? 'the review is no longer valid'
  }

  async function syncRuntimeTools() {
    toolsetPromptsStore.clearToolsetPrompts('self-authored-skills')
    const nextIds = new Set(activeEntries().map(entry => `self-authored:${entry.toolId}`))
    for (const id of runtimeToolIds) {
      if (!nextIds.has(id))
        await llmToolsStore.removeToolById(id)
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
      // Reviewed skills are default-active so they are callable without
      // keyword activation; the review gate, not the prompt, is the trust
      // boundary. prepareForPrompt still injects the skill's guidance when a
      // keyword/pattern matches.
      defaultActive: true,
      execute: input => useSkillsReviewStore(pinia).executeReviewedSkill(entry.toolId, input),
    }))
    if (tools.length > 0)
      await llmToolsStore.addTools(...tools)
    for (const id of nextIds)
      runtimeToolIds.add(id)
    registerUnavailableSkillsPrompt()
  }

  /**
   * Re-registers runtime tools from the persisted queue after a restart.
   *
   * The queue is durable in localStorage, but `trust`/`review`/`quarantine`
   * only re-inflate into runtime tools when this runs. Idempotent: repeated
   * calls must not duplicate tool registration, re-create muscle memory, or
   * re-emit a review notice. The leader boot path calls this once after the
   * journal replays (see apps/stage-tamagotchi/src/renderer/main.ts).
   */
  async function restore(): Promise<void> {
    await waitForRestore()
    // A restored profile remains inert until the user adopts it. Keep
    // imported reviewed entries quarantined while the durable effect hold is
    // active; the adoption event calls this method again after release.
    if (areRestoreEffectsHeld())
      return
    for (const entry of queue.value) {
      if (entry.trust === 'reviewed' && await verifySource(entry) === undefined)
        await retireMuscle(entry)
    }
    await syncRuntimeTools()
  }

  /** Replaces the durable review queue during an isolated profile restore. */
  async function restoreQueue(entries: ReviewQueueEntry[]): Promise<void> {
    // Preserve review evidence, but require startup source verification in the
    // restored workspace before any imported tool becomes executable.
    queue.value = entries.map(entry => ({
      ...entry,
      artifactError: entry.trust === 'reviewed' ? 'Artifact verification is pending.' : entry.artifactError,
    }))
    persist()
    await syncRuntimeTools()
  }

  async function verifySource(entry: ReviewQueueEntry): Promise<string | undefined> {
    if (entry.trust === 'reviewed' && entry.reviewedHash !== entry.contentHash) {
      entry.artifactError = 'The review does not identify this source. Review the skill again.'
      return
    }
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(entry.toolId)) {
      entry.artifactError = 'Invalid skill artifact identifier.'
      return
    }
    if (entry.toolId === OPENCODE_ADAPTER_SKELETON.toolId && entry.contentHash === OPENCODE_ADAPTER_SKELETON.contentHash) {
      entry.artifactError = undefined
      return builtInSkillArtifact.source
    }
    try {
      if (skillRuntime?.getWorkspaceRoot && entry.workspaceRoot !== await skillRuntime.getWorkspaceRoot())
        throw new Error('This skill belongs to a different workspace. Return to its workspace before use.')
      if (!skillRuntime?.readSource)
        throw new Error('Skill artifact reader is unavailable.')
      const source = await skillRuntime.readSource(entry.toolId, entry.workspaceRoot)
      if (contentHashOf(source) !== entry.contentHash)
        throw new Error('Skill source changed. Submit the new source for review.')
      entry.artifactError = undefined
      return source
    }
    catch (error) {
      entry.artifactError = errorMessageFrom(error) ?? 'Skill artifact verification failed.'
    }
  }

  function activatedEntries(text: string) {
    const normalized = text.toLocaleLowerCase()
    return activeEntries().filter((entry) => {
      // The chat input shelf inserts the skill's canonical name as a /name
      // token; matching name and toolId keeps that insertion reliable even
      // when the author's activation keyword list omits them.
      const nameHit = normalized.includes(entry.name.toLocaleLowerCase())
        || normalized.includes(entry.toolId.toLocaleLowerCase())
      const keywordHit = entry.activation.keywords.some(keyword => normalized.includes(keyword.toLocaleLowerCase()))
      const patternHit = entry.activation.patterns.some((pattern) => {
        try {
          return new RegExp(pattern, 'i').test(text)
        }
        catch {
          return false
        }
      })
      return nameHit || keywordHit || patternHit
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
    if (!skillRuntime)
      return `Skill "${entry.toolId}" is unavailable because the coding host is not installed.`

    const source = await verifySource(entry)
    if (source === undefined || !activeEntries().includes(entry)) {
      await syncRuntimeTools()
      await retireMuscle(entry)
      return `Skill "${entry.toolId}" is blocked: ${entry.artifactError ?? 'review is no longer valid'}`
    }

    // Pass the input unchanged: coercing `null` or `undefined` to `{}` would
    // let a non-object argument satisfy an object schema with no required
    // fields, so the "input must be an object" contract would never apply.
    const inputError = validateToolInput(entry.tool.parameters, input)
    if (inputError)
      return `Skill "${entry.toolId}" rejected the input: ${inputError}`

    // The sandbox receives the verified bytes. Its bridge stays bound to the
    // workspace checked by the main process at invocation time.
    if (entry.toolId !== OPENCODE_ADAPTER_SKELETON.toolId) {
      if (!skillRuntime.runProgram)
        return `Skill "${entry.toolId}" cannot run because the sandbox executor is not installed.`
      const invocation = JSON.stringify(input)
      const program = [
        // Execute the checked bytes so a later filesystem edit cannot replace
        // the artifact between verification and sandbox evaluation.
        `const raw = ${JSON.stringify(source)}`,
        // Strip ESM export keywords so the source evaluates as a plain script
        // (submitted sources are authored as `export function run(input)` or
        // `export default function run(input)`).
        `const code = raw.split('\\n').map(line => line.replace(/^export\\s+(default\\s+)?/, '')).join('\\n')`,
        // The sandbox program needs `null` to be a valid `return` value, so
        // wrap the source's entry lookup instead of returning null directly.
        `const entry = new Function('bridge', 'input', code + '\\n;return (typeof run === \\'function\\') ? run(input) : (typeof main === \\'function\\' ? main(input) : { __missing_entry__: true })')`,
        `const out = await entry(bridge, ${invocation})`,
        `if (out && out.__missing_entry__ === true) throw new Error('skill source must define function run(input) — got entry-less source')`,
        `return out`,
      ].join('\n')
      journalStore.appendActive({
        type: 'tool/call',
        toolName: entry.tool.name,
        args: input,
      })
      const run = await skillRuntime.runProgram({ program, expectedWorkspaceRoot: entry.workspaceRoot })
      const ok = run.ok
      const summary = ok
        ? `sandbox ok: ${JSON.stringify(run.value ?? null).slice(0, 200)}`
        : `[${run.failure.kind}] ${run.failure.message.slice(0, 200)}`
      journalStore.appendActive({
        type: 'tool/result',
        toolName: entry.tool.name,
        ok,
        outcome: ok ? 'ok' : 'failed',
        summary,
        provenance: 'reviewed_self_authored',
      })
      return ok ? (run.value ?? 'skill ran (no return value)') : `Skill "${entry.toolId}" failed in the sandbox: ${summary}`
    }

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
        await quarantine(entry.toolId)
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

  /** Executes through the leader so verification and revocation have one owner. */
  async function executeReviewedSkill(toolId: string, input: unknown): Promise<unknown> {
    const entry = queue.value.find(item => item.toolId === toolId)
    if (!entry)
      return `Skill "${toolId}" has no active review.`
    const schemaError = validateToolInputSchema(entry.tool.parameters)
    if (schemaError)
      return `Skill "${toolId}" is blocked: invalid input schema: ${schemaError}`
    if (!activeEntries().includes(entry))
      return `Skill "${toolId}" has no active review.`
    return executeSkill(entry, input)
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
      outcome: result.status === 'ok' ? 'ok' : result.status === 'denied' ? 'denied' : result.status === 'timeout' ? 'timeout' : 'failed',
      summary: `${result.status}: ${(result.stdout || result.stderr).slice(0, 500)}`,
      provenance: 'reviewed_self_authored',
    })
    return result
  }

  /** Submits a freshly written tool to probation. */
  async function submit(entry: ReviewQueueSubmission): Promise<{ accepted: boolean, reason?: string }> {
    if (persistenceError.value)
      return { accepted: false, reason: persistenceError.value }
    v.parse(skillReviewSchema, { ...entry, trust: 'draft' })
    const schemaError = validateToolInputSchema(entry.tool.parameters)
    if (schemaError)
      return { accepted: false, reason: `invalid input schema: ${schemaError}` }
    const workspaceRoot = await skillRuntime?.getWorkspaceRoot?.()
    if (queue.value.some(existing => existing.toolId === entry.toolId))
      return { accepted: false, reason: 'duplicate toolId' }

    if (!canEnterProbation(queue.value))
      return { accepted: false, reason: `probation capped at ${MAX_PROBATION_TOOLS}; graduate or reject first` }

    const draft: ReviewQueueEntry = { ...entry, workspaceRoot, trust: 'draft', reviewedHash: undefined, artifactError: undefined }
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
    persist()
    await syncRuntimeTools()
    return { accepted: true }
  }

  /** Applies a content change and invalidates any review bound to the old hash. */
  async function applyContentChange(toolId: string, source: string): Promise<void> {
    const index = queue.value.findIndex(item => item.toolId === toolId)
    const entry = queue.value[index]
    if (!entry)
      return

    const contentHash = contentHashOf(source)
    queue.value[index] = applyLifecycleAction(entry, 'content_changed', {
      newContentHash: contentHash,
    }) as ReviewQueueEntry
    queue.value[index]!.reviewedHash = undefined
    queue.value[index]!.artifactError = undefined
    const reviewRequestId = `review:${toolId}:${Date.now()}`
    reviewRequestIds.set(toolId, reviewRequestId)
    journalStore.appendActive({
      type: 'review/asked',
      reviewRequestId,
      toolId,
      contentHash,
      reason: 'skill source changed and entered probation for a new review',
    })
    persist()
    await syncRuntimeTools()
    await retireMuscle(entry)
  }

  /** Reads the current workspace source and moves it into a fresh review. */
  async function requeueChangedSourceForReview(toolId: string): Promise<void> {
    const entry = queue.value.find(item => item.toolId === toolId)
    if (!entry)
      throw new Error('The skill is no longer in the review queue.')
    if (entry.toolId === OPENCODE_ADAPTER_SKELETON.toolId && entry.contentHash === OPENCODE_ADAPTER_SKELETON.contentHash) {
      await applyContentChange(toolId, builtInSkillArtifact.source)
      return
    }
    if (skillRuntime?.getWorkspaceRoot && entry.workspaceRoot !== await skillRuntime.getWorkspaceRoot())
      throw new Error('This skill belongs to a different workspace. Return to its workspace before review.')
    if (!skillRuntime?.readSource)
      throw new Error('Skill artifact reader is unavailable.')
    const source = await skillRuntime.readSource(toolId, entry.workspaceRoot)
    await applyContentChange(toolId, source)
  }

  /** Reads the recorded workspace revision without running its code. */
  async function readForReview(toolId: string): Promise<SkillReviewArtifacts> {
    const entry = queue.value.find(item => item.toolId === toolId)
    if (!entry)
      throw new Error('The skill is no longer in the review queue.')
    const source = await verifySource(entry)
    if (source === undefined)
      throw new Error(entry.artifactError ?? 'The skill source is unavailable.')
    let selftest: SkillReviewArtifacts['selftest']
    if (entry.selftest) {
      if (!skillRuntime?.readSelftest)
        throw new Error('The self-test reader is unavailable.')
      const source = await skillRuntime.readSelftest(toolId, entry.workspaceRoot)
      if (contentHashOf(source) !== entry.selftest.contentHash)
        throw new Error('The self-test changed. Submit the new artifacts for review.')
      selftest = { ...entry.selftest, logs: [...entry.selftest.logs], source }
    }
    if (!queue.value.includes(entry))
      throw new Error('The review entry changed. Open the source again.')
    return { source, contentHash: entry.contentHash, ...(selftest ? { selftest } : {}) }
  }

  /** Approves only the artifact hashes supplied by the displayed review. */
  async function approve(toolId: string, viewed: Pick<SkillReviewArtifacts, 'contentHash' | 'selftest'>, reviewer = 'you', rationale = 'reviewed the source'): Promise<void> {
    const index = queue.value.findIndex(item => item.toolId === toolId)
    const entry = queue.value[index]
    if (!entry || entry.trust !== 'probation')
      return

    if (!viewed || viewed.contentHash !== entry.contentHash || viewed.selftest?.contentHash !== entry.selftest?.contentHash)
      throw new Error('The review entry changed. Open the source again.')
    await readForReview(toolId)
    // Another decision can arrive while the artifact is read. Never approve
    // an entry that has since been replaced, removed, or already approved.
    if (queue.value[index] !== entry || entry.trust !== 'probation')
      return

    queue.value[index] = applyLifecycleAction(entry, 'approve_review', {
      review: { reviewer, rationale, reviewedAt: Date.now() },
    }) as ReviewQueueEntry
    queue.value[index]!.reviewedHash = entry.contentHash
    journalStore.appendActive({
      type: 'review/decided',
      reviewRequestId: reviewRequestIds.get(toolId) ?? `review:${toolId}`,
      toolId,
      decision: 'approved',
      reviewer,
      rationale,
    })
    persist()
    await syncRuntimeTools()
    const scope = skillRuntime?.getMemoryScope?.()
    if (!scope)
      return
    const triggerPattern = entry.activation.patterns[0] ?? entry.activation.keywords[0] ?? entry.tool.name
    const muscle = await memoryStore.rememberMuscle({
      content: entry.tool.description,
      triggerPattern,
      scope,
    }).catch((error) => {
      console.warn('[Skills] Muscle memory write failed.', error)
    })
    const approved = queue.value[index]
    if (muscle && approved?.trust === 'reviewed' && approved.reviewedHash === entry.contentHash) {
      approved.muscleMemoryId = muscle.id
      persist()
    }
    else if (muscle) {
      // A revocation can overtake embedding. Do not leave a late trigger for
      // a review that no longer exists.
      await memoryStore.remove(muscle.id)
    }
  }

  async function retireMuscle(entry: ReviewQueueEntry) {
    if (!entry.muscleMemoryId)
      return
    await memoryStore.remove(entry.muscleMemoryId)
    const current = queue.value.find(item => item.toolId === entry.toolId)
    if (current?.muscleMemoryId === entry.muscleMemoryId) {
      current.muscleMemoryId = undefined
      persist()
    }
  }

  /** Removes a rejected entry from the queue. */
  async function reject(toolId: string): Promise<void> {
    const rejected = queue.value.find(item => item.toolId === toolId)
    if (queue.value.some(item => item.toolId === toolId)) {
      const reviewRequestId = reviewRequestIds.get(toolId) ?? `review:${toolId}`
      journalStore.appendActive({
        type: 'review/decided',
        reviewRequestId,
        toolId,
        decision: 'rejected',
        reviewer: 'you',
      })
    }
    queue.value = queue.value.filter(item => item.toolId !== toolId)
    reviewRequestIds.delete(toolId)
    persist()
    await syncRuntimeTools()
    if (rejected)
      await retireMuscle(rejected)
  }

  /** Returns a non-draft skill to probation after a compatibility mismatch. */
  async function quarantine(toolId: string): Promise<void> {
    const index = queue.value.findIndex(item => item.toolId === toolId)
    const entry = queue.value[index]
    if (!entry || entry.trust === 'draft')
      return

    queue.value[index] = applyLifecycleAction(entry, 'compatibility_mismatch', {
      detectedAt: Date.now(),
    }) as ReviewQueueEntry
    persist()
    await syncRuntimeTools()
    await retireMuscle(entry)
  }

  /** Clears quarantine after the author fixes the compatibility probe. */
  async function clearQuarantine(toolId: string): Promise<void> {
    const index = queue.value.findIndex(item => item.toolId === toolId)
    const entry = queue.value[index]
    if (!entry)
      return

    queue.value[index] = applyLifecycleAction(entry, 'reset_fix', {
      fixedAt: Date.now(),
    }) as ReviewQueueEntry
    persist()
    await syncRuntimeTools()
  }

  /** Batches failed reviewed-tool calls and returns those tools to probation. */
  async function dreamRevisionBatch(): Promise<SkillRevisionCandidate[]> {
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
      const reviewRequestId = `revision:${candidate.toolId}:${candidate.failureSeq}`
      journalStore.appendActive({
        type: 'review/asked',
        reviewRequestId,
        toolId: candidate.toolId,
        contentHash: entry.contentHash,
        reason: `dreaming pass: ${candidate.failureSummary.slice(0, 180)}`,
      })
    }
    persist()
    await syncRuntimeTools()
    for (const candidate of revisionBatch.value) {
      const entry = queue.value.find(item => item.toolId === candidate.toolId)
      if (entry)
        await retireMuscle(entry)
    }
    return revisionBatch.value
  }

  return {
    queue,
    persistenceError,
    catalog,
    revisionBatch,
    probationCount,
    canSubmitMore,
    reviewedSkills,
    submit,
    applyContentChange,
    approve,
    readForReview,
    requeueChangedSourceForReview,
    reject,
    quarantine,
    clearQuarantine,
    dreamRevisionBatch,
    prepareForPrompt,
    syncRuntimeTools,
    restore,
    restoreQueue,
    executeReviewedSkill,
  }
}, {
  synced: {
    // The review queue must be visible from every window: the submission runs
    // in the leader (where skill_submit executes), while the review card and
    // the skills settings page render in any window. All entries are plain
    // data (structuredClone-safe). User decisions route to the leader.
    state: true,
    actions: ['submit', 'applyContentChange', 'approve', 'readForReview', 'requeueChangedSourceForReview', 'reject', 'quarantine', 'clearQuarantine', 'dreamRevisionBatch', 'restore', 'restoreQueue', 'executeReviewedSkill'],
  },
})

function quoteCommandArgument(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

export { contentHashOf, MAX_PROBATION_TOOLS } from '@proj-airi/skill-forge'
