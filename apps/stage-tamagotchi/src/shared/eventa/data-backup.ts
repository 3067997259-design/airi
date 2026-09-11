import type { DataBackupManifest } from '@proj-airi/stage-ui/services/data-backup'

import { defineEventa, defineInvokeEventa } from '@moeru/eventa'

/** A preview token binds confirmation to the exact bytes selected in the dialog. */
export interface BackupPreview {
  token: string
  manifest: DataBackupManifest
}

/** Only the leader receives pending bytes. Other windows wait for completion. */
export interface RestoreBootstrap {
  restored: boolean
  data?: Uint8Array
  workspaceRoot?: string
  /** Local user id recorded in the archive; lets an unauthenticated boot name its owner. */
  ownerId?: string
  /** Restored profiles keep external effects paused until explicit adoption. */
  effectsHeld?: boolean
}

export const backupBuildId = defineInvokeEventa<string>('airi:backup:build-id')
export const backupSave = defineInvokeEventa<string | undefined, { data: Uint8Array }>('airi:backup:save')
export const backupInspect = defineInvokeEventa<BackupPreview, { data: Uint8Array }>('airi:backup:inspect')
export const backupPrepare = defineInvokeEventa<{ profilePath: string }, { token: string }>('airi:backup:prepare')
export const backupBootstrap = defineInvokeEventa<RestoreBootstrap, { leader: boolean }>('airi:backup:bootstrap')
export const backupComplete = defineInvokeEventa<void, { snapshotId: string, error?: string }>('airi:backup:complete')
export const backupAdopt = defineInvokeEventa<void, void>('airi:backup:adopt')
export const backupAdopted = defineEventa<void>('airi:backup:adopted')
export const backupRelaunch = defineInvokeEventa<void, { profilePath: string }>('airi:backup:relaunch')
