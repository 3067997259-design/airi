import type { TaskMemory } from './task-memory'

/** Prompt mode for ordinary character conversation. */
export type AttentionMode = 'casual' | 'focused'

/** Selects focused mode only while an active task snapshot exists and the setting allows it. */
export function resolveAttentionMode(tasks: readonly Pick<TaskMemory, 'status'>[], focusedModeEnabled = true): AttentionMode {
  return focusedModeEnabled && tasks.some(task => task.status === 'active') ? 'focused' : 'casual'
}
/** Builds the prompt section that keeps task focus compatible with the character identity. */
export function buildAttentionModeSection(mode: AttentionMode): string {
  if (mode === 'focused') {
    return [
      '## Mode',
      'focused',
      'You have an active task. Keep replies concise, stay helpful, and prioritize correct task progress while preserving your character identity.',
    ].join('\n')
  }

  return [
    '## Mode',
    'casual',
    'No task requires active attention. Use your normal conversational style.',
  ].join('\n')
}
