import type { TaskMemoryArtifact, TaskMemorySnapshot } from '@proj-airi/plugin-protocol/types'

/** The public task state used by attention projections. */
export type TaskMemory = TaskMemorySnapshot

/** Hard limits that keep untrusted task snapshots small enough for a prompt. */
export const TASK_MEMORY_LIMITS = Object.freeze({
  goal: 500,
  currentStep: 500,
  confirmedFacts: 10,
  fact: 200,
  artifacts: 8,
  artifactLabel: 100,
  artifactValue: 500,
  blockers: 5,
  blocker: 200,
  nextStep: 500,
  plan: 6,
  planItem: 200,
  workingAssumptions: 6,
  workingAssumption: 200,
  recentFailureReason: 500,
  completionCriteria: 6,
  completionCriterion: 200,
} as const)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
function textValue(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string')
    return null

  const text = value.trim()
  return text ? text.slice(0, maxLength) : null
}

function listValue(value: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value))
    return []

  const result: string[] = []
  const seen = new Set<string>()
  for (const item of value) {
    const text = textValue(item, maxLength)
    if (text && !seen.has(text)) {
      seen.add(text)
      result.push(text)
    }
    if (result.length >= maxItems)
      break
  }
  return result
}

function artifactValue(value: unknown): TaskMemoryArtifact | null {
  if (!isRecord(value))
    return null

  const label = textValue(value.label, TASK_MEMORY_LIMITS.artifactLabel)
  const artifact = textValue(value.value, TASK_MEMORY_LIMITS.artifactValue)
  const kind = value.kind
  if (!label || !artifact || (kind !== 'file' && kind !== 'url' && kind !== 'tool' && kind !== 'note'))
    return null

  return { label, value: artifact, kind }
}

function artifactsValue(value: unknown): TaskMemoryArtifact[] {
  if (!Array.isArray(value))
    return []

  const result: TaskMemoryArtifact[] = []
  const seen = new Set<string>()
  for (const item of value) {
    const artifact = artifactValue(item)
    if (!artifact)
      continue

    const key = `${artifact.kind}:${artifact.value}`
    if (!seen.has(key)) {
      seen.add(key)
      result.push(artifact)
    }
    if (result.length >= TASK_MEMORY_LIMITS.artifacts)
      break
  }
  return result
}

function statusValue(value: unknown, fallback: TaskMemory['status']): TaskMemory['status'] {
  return value === 'active' || value === 'blocked' || value === 'done' ? value : fallback
}

function timestampValue(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/**
 * Normalizes an untrusted task snapshot into a bounded prompt-safe snapshot.
 *
 * @example
 * normalizeTaskMemory({ status: 'active', goal: ' '.repeat(600) }, { sourceTurnId: 'turn-1' })
 * // => a bounded snapshot with a null goal and sourceTurnId "turn-1"
 */
export function normalizeTaskMemory(input: unknown, fallback: Partial<TaskMemory> = {}): TaskMemory {
  const source = isRecord(input) ? input : {}
  const now = Date.now()
  const fallbackStatus = fallback.status ?? 'active'
  const sourceTurnId = textValue(source.sourceTurnId, 200) ?? fallback.sourceTurnId ?? 'task-event'
  const goal = textValue(source.goal, TASK_MEMORY_LIMITS.goal) ?? fallback.goal ?? null
  const currentStep = textValue(source.currentStep, TASK_MEMORY_LIMITS.currentStep) ?? fallback.currentStep ?? null
  const nextStep = textValue(source.nextStep, TASK_MEMORY_LIMITS.nextStep) ?? fallback.nextStep ?? null
  const recentFailureReason = textValue(source.recentFailureReason, TASK_MEMORY_LIMITS.recentFailureReason)
    ?? fallback.recentFailureReason
    ?? null

  return {
    status: statusValue(source.status, fallbackStatus),
    goal,
    currentStep,
    confirmedFacts: listValue(source.confirmedFacts, TASK_MEMORY_LIMITS.confirmedFacts, TASK_MEMORY_LIMITS.fact),
    artifacts: artifactsValue(source.artifacts),
    blockers: listValue(source.blockers, TASK_MEMORY_LIMITS.blockers, TASK_MEMORY_LIMITS.blocker),
    nextStep,
    updatedAt: timestampValue(source.updatedAt, fallback.updatedAt ?? now),
    sourceTurnId,
    plan: listValue(source.plan, TASK_MEMORY_LIMITS.plan, TASK_MEMORY_LIMITS.planItem),
    workingAssumptions: listValue(source.workingAssumptions, TASK_MEMORY_LIMITS.workingAssumptions, TASK_MEMORY_LIMITS.workingAssumption),
    recentFailureReason,
    completionCriteria: listValue(source.completionCriteria, TASK_MEMORY_LIMITS.completionCriteria, TASK_MEMORY_LIMITS.completionCriterion),
  }
}
