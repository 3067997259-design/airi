import type { createContext as createMainEventaContext } from '@moeru/eventa/adapters/electron/main'

import type { PackageListEntrySummary, PackageTrialSummary } from '../../../../../shared/eventa'
import type { EventaWindowBroadcast } from '../../../../libs/electron/eventa-window-broadcast'
import type { PackageListEntry, PackageTrialResult } from './types'

import { join } from 'node:path'

import { defineInvokeHandler } from '@moeru/eventa'
import { dialog } from 'electron'

import {
  extensionPackagesActivate,
  extensionPackagesActive,
  extensionPackagesApprove,
  extensionPackagesChanged,
  extensionPackagesDeactivate,
  extensionPackagesExport,
  extensionPackagesImport,
  extensionPackagesList,
  extensionPackagesPickArchive,
  extensionPackagesPickDirectory,
  extensionPackagesRollback,
  extensionPackagesTrial,
  extensionPackagesUninstall,
} from '../../../../../shared/eventa'
import { PackageStore } from './store'

function toEntrySummary(entry: PackageListEntry): PackageListEntrySummary {
  return { packageId: entry.packageId, versions: entry.versions }
}

function toTrialSummary(result: PackageTrialResult): PackageTrialSummary {
  return {
    packageId: result.packageId,
    version: result.version,
    digest: result.digest,
    tools: result.descriptor.tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      skill: tool.skill,
    })),
    skillChecks: result.skillChecks,
    files: result.fileDigests,
  }
}

export interface PackageHostOptions {
  /** Push channel for lifecycle changes; see `extensionPackagesChanged`. */
  broadcast?: EventaWindowBroadcast
}

/**
 * EP-2a main-process host: registers the `airi:packages:*` invoke handlers
 * against one `PackageStore` under `<userData>/extensions`.
 *
 * The store owns all lifecycle state; this module only maps records to
 * renderer-safe summaries and owns the native open dialogs, so no renderer can
 * import from a path it did not choose through the dialog. Every mutation
 * broadcasts `extensionPackagesChanged`, which is how a follower settings
 * window wakes the leader window that owns the tool face.
 */
export async function setupPackageHost(
  context: ReturnType<typeof createMainEventaContext>['context'],
  userDataDir: string,
  options: PackageHostOptions = {},
): Promise<void> {
  const store = new PackageStore({ extensionsDir: join(userDataDir, 'extensions') })
  const notifyChanged = options.broadcast?.broadcast ?? context.emit
  const broadcastChanged = () => notifyChanged(extensionPackagesChanged, undefined)

  defineInvokeHandler(context, extensionPackagesList, async () => (await store.list()).map(toEntrySummary))

  defineInvokeHandler(context, extensionPackagesActive, async () => (await store.activePackages()).map(pkg => ({
    packageId: pkg.packageId,
    version: pkg.version,
    digest: pkg.digest,
    tools: pkg.descriptor.tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      skill: tool.skill,
    })),
  })))

  defineInvokeHandler(context, extensionPackagesPickArchive, async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'AIRI package', extensions: ['zip'] }],
    })
    return result.canceled || !result.filePaths[0] ? {} : { path: result.filePaths[0] }
  })

  defineInvokeHandler(context, extensionPackagesPickDirectory, async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    return result.canceled || !result.filePaths[0] ? {} : { path: result.filePaths[0] }
  })

  defineInvokeHandler(context, extensionPackagesImport, async ({ archivePath, directory }) => {
    if ((archivePath ? 1 : 0) + (directory ? 1 : 0) !== 1)
      throw new Error('Provide exactly one package archive or directory to import.')
    const imported = archivePath
      ? await store.importFromArchive({ archivePath })
      : await store.importFromDirectory({ sourceDir: directory as string })
    broadcastChanged()
    return {
      packageId: imported.packageId,
      version: imported.version,
      entries: (await store.list()).map(toEntrySummary),
    }
  })

  defineInvokeHandler(context, extensionPackagesTrial, async payload => toTrialSummary(await store.trial(payload)))

  defineInvokeHandler(context, extensionPackagesApprove, async (payload) => {
    const record = await store.approve(payload)
    broadcastChanged()
    return {
      packageId: record.packageId,
      version: record.version,
      digest: record.digest,
      approvedAt: record.approvedAt,
      fileCount: record.fileDigests.length,
    }
  })

  defineInvokeHandler(context, extensionPackagesActivate, async (payload) => {
    const activation = await store.activate(payload)
    broadcastChanged()
    return activation
  })
  defineInvokeHandler(context, extensionPackagesDeactivate, async ({ packageId }) => {
    await store.deactivate({ packageId })
    broadcastChanged()
    return (await store.list()).map(toEntrySummary)
  })
  defineInvokeHandler(context, extensionPackagesRollback, async (payload) => {
    const activation = await store.rollback(payload)
    broadcastChanged()
    return activation
  })
  defineInvokeHandler(context, extensionPackagesUninstall, async (payload) => {
    await store.uninstall(payload)
    broadcastChanged()
    return (await store.list()).map(toEntrySummary)
  })

  defineInvokeHandler(context, extensionPackagesExport, async () => ({ files: await store.exportApprovedFiles() }))
}
