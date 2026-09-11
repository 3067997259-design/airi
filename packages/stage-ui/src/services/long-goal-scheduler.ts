import type { LongGoalLifecycle } from '@proj-airi/core-agent'

import { areRestoreEffectsHeld } from './restore-gate'

export interface LongGoalWakePayload {
  goalId: string
  wakeId: string
  reason: 'schedule' | 'retry' | 'startup'
  timestamp: number
}

export interface LongGoalClaimResult {
  claimed: boolean
  leaseId?: string
  reason?: 'stale-wake' | 'already-running' | 'unknown-goal'
}

export interface LongGoalSchedulerPort {
  schedule: (input: { goalId: string, nextReviewAt: number }) => Promise<void>
  unschedule: (goalId: string) => Promise<void>
  claim: (input: { goalId: string, wakeId: string }) => Promise<LongGoalClaimResult>
  release: (input: { goalId: string, leaseId: string }) => Promise<void>
  isWakeConsumer?: () => boolean
  onWake?: (listener: (payload: LongGoalWakePayload) => void) => () => void
}

let schedulerPort: LongGoalSchedulerPort | undefined

/** Installs the main-process transport used by the long-goal leader store. */
export function installLongGoalSchedulerPort(next: LongGoalSchedulerPort | undefined): void {
  schedulerPort = next
}

/** Synchronizes one durable goal with the main-process schedule clock. */
export async function syncLongGoalSchedule(input: {
  goalId: string
  lifecycle: LongGoalLifecycle
  nextReviewAt?: number
}): Promise<void> {
  if (!schedulerPort || areRestoreEffectsHeld())
    return

  if ((input.lifecycle === 'executable' || input.lifecycle === 'waiting-condition') && input.nextReviewAt !== undefined) {
    await schedulerPort.schedule({ goalId: input.goalId, nextReviewAt: input.nextReviewAt })
    return
  }

  await schedulerPort.unschedule(input.goalId)
}

/** Removes a goal from the main-process schedule after local deletion. */
export async function unscheduleLongGoal(goalId: string): Promise<void> {
  await schedulerPort?.unschedule(goalId)
}

/** Returns whether this renderer owns the main-process wake consumer role. */
export function isLongGoalWakeConsumer(): boolean {
  return schedulerPort?.isWakeConsumer?.() ?? false
}

/** Claims one main-process wake for a single Flow run. */
export async function claimLongGoalWake(input: { goalId: string, wakeId: string }): Promise<LongGoalClaimResult | undefined> {
  if (areRestoreEffectsHeld())
    return undefined
  return schedulerPort ? await schedulerPort.claim(input) : undefined
}

/** Releases one Flow lease after the renderer finishes or rejects a run. */
export async function releaseLongGoalRun(input: { goalId: string, leaseId: string }): Promise<void> {
  await schedulerPort?.release(input)
}

/** Subscribes the current leader store to main-process wake events. */
export function onLongGoalWake(listener: (payload: LongGoalWakePayload) => void): (() => void) | undefined {
  return schedulerPort?.onWake?.(listener)
}
