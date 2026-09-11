import type { createContext as createMainEventaContext } from '@moeru/eventa/adapters/electron/main'

import type { EventaWindowBroadcast } from '../../../libs/electron/eventa-window-broadcast'

import process from 'node:process'

import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'

import { defineInvokeHandler } from '@moeru/eventa'
import { inspectDataBackup } from '@proj-airi/stage-ui/services/data-backup'
import { app } from 'electron'

import {
  backupAdopt,
  backupAdopted,
  backupBootstrap,
  backupBuildId,
  backupComplete,
  backupInspect,
  backupPrepare,
  backupRelaunch,
  backupSave,
} from '../../../../shared/eventa'
import { createProfileRestore, prepareRestoreProfile } from './profiles'

export interface DataBackupHostOptions {
  /** Push channel for the cross-window adoption signal. */
  broadcast?: EventaWindowBroadcast
}

/** Owns backup files and isolated restore staging in the Electron profile. */
export async function setupDataBackupHost(
  context: ReturnType<typeof createMainEventaContext>['context'],
  userDataDir: string,
  options: DataBackupHostOptions = {},
): Promise<void> {
  const backupDirectory = join(userDataDir, 'backups')
  const restoreDirectory = join(userDataDir, 'restores')
  await mkdir(backupDirectory, { recursive: true })
  await mkdir(restoreDirectory, { recursive: true })
  const restore = await createProfileRestore(userDataDir)

  defineInvokeHandler(context, backupBuildId, async () => {
    const identity = `${app.getVersion()}\n${app.getAppPath()}`
    return createHash('sha256').update(identity).digest('hex')
  })

  defineInvokeHandler(context, backupSave, async ({ data }) => {
    const name = `airi-backup-${Date.now()}.zip`
    const target = join(backupDirectory, name)
    await writeFile(target, new Uint8Array(data), { flag: 'wx' })
    return target
  })

  defineInvokeHandler(context, backupInspect, async ({ data }) => {
    const inspected = await inspectDataBackup(new Uint8Array(data))
    return { token: '', manifest: inspected.manifest }
  })

  defineInvokeHandler(context, backupPrepare, async ({ token }) => {
    if (token.includes('/') || token.includes('\\') || token !== token.trim() || token.length === 0)
      throw new Error('The backup token must name one stored archive.')
    const source = join(backupDirectory, token)
    const data = new Uint8Array(await readFile(source))
    const profilePath = await prepareRestoreProfile(restoreDirectory, data)
    return { profilePath }
  })

  defineInvokeHandler(context, backupBootstrap, ({ leader }) => restore.begin(leader))
  defineInvokeHandler(context, backupComplete, ({ snapshotId, error }) => restore.complete(snapshotId, error))
  defineInvokeHandler(context, backupAdopt, async () => {
    await restore.adopt()
    // Adoption is initiated from a settings window (a follower), while the
    // effect hold and the goal scheduler live in the leader renderer. A plain
    // context emit only echoes back to the invoking renderer, so the leader
    // never released the hold and never re-initialized the scheduler
    // (ACC-20260910 R04). Broadcast to every window instead.
    const emit = options.broadcast?.broadcast ?? context.emit
    emit(backupAdopted, undefined)
  })

  defineInvokeHandler(context, backupRelaunch, async ({ profilePath }) => {
    const relativePath = relative(restoreDirectory, profilePath)
    if (isAbsolute(relativePath) || relativePath.startsWith('..') || relativePath.length === 0)
      throw new Error('The restore profile must be inside the managed restore directory.')
    process.env.APP_USER_DATA_PATH = profilePath
    app.relaunch()
    app.exit(0)
  })
}
