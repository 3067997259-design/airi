import type { Pinia } from 'pinia'

import { getElectronEventaContext, useElectronEventaInvoke } from '@proj-airi/electron-vueuse'
import { installPackageRuntimePort, usePackagesStore } from '@proj-airi/stage-ui/stores/modules/packages'

import {
  extensionPackagesActivate,
  extensionPackagesActive,
  extensionPackagesApprove,
  extensionPackagesChanged,
  extensionPackagesDeactivate,
  extensionPackagesImport,
  extensionPackagesList,
  extensionPackagesPickArchive,
  extensionPackagesPickDirectory,
  extensionPackagesRollback,
  extensionPackagesTrial,
  extensionPackagesUninstall,
} from '../../shared/eventa'

/**
 * Installs the EP-2a package host bridge for this renderer process.
 *
 * The main process owns the lifecycle; every window subscribes to
 * `extensionPackagesChanged` and refreshes its local ledger, so a follower
 * settings window wakes the leader window that registers package tools.
 */
export function installPackagesBridge(pinia: Pinia): void {
  const listPackages = useElectronEventaInvoke(extensionPackagesList)
  const listActive = useElectronEventaInvoke(extensionPackagesActive)
  const pickArchive = useElectronEventaInvoke(extensionPackagesPickArchive)
  const pickDirectory = useElectronEventaInvoke(extensionPackagesPickDirectory)
  const importPackage = useElectronEventaInvoke(extensionPackagesImport)
  const trial = useElectronEventaInvoke(extensionPackagesTrial)
  const approve = useElectronEventaInvoke(extensionPackagesApprove)
  const activate = useElectronEventaInvoke(extensionPackagesActivate)
  const deactivate = useElectronEventaInvoke(extensionPackagesDeactivate)
  const rollback = useElectronEventaInvoke(extensionPackagesRollback)
  const uninstall = useElectronEventaInvoke(extensionPackagesUninstall)

  installPackageRuntimePort({
    list: () => listPackages(),
    active: () => listActive(),
    pickArchive: () => pickArchive(),
    pickDirectory: () => pickDirectory(),
    importPackage: input => importPackage(input),
    trial: input => trial(input),
    approve: input => approve(input),
    activate: input => activate(input),
    deactivate: input => deactivate(input),
    rollback: input => rollback(input),
    uninstall: input => uninstall(input),
  })

  getElectronEventaContext().on(extensionPackagesChanged, () => {
    void usePackagesStore(pinia).refresh()
  })
}
