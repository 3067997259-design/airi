import { defineInvoke } from '@moeru/eventa'
import { getElectronEventaContext } from '@proj-airi/electron-vueuse'

import { backupAdopt, backupBootstrap, backupComplete } from '../../shared/eventa'

/** Renderer client for the startup restore coordinator. */
export function createDataBackupBootstrapClient() {
  const context = getElectronEventaContext()
  const bootstrap = defineInvoke(context, backupBootstrap)
  const complete = defineInvoke(context, backupComplete)
  const adopt = defineInvoke(context, backupAdopt)
  return {
    bootstrap,
    complete,
    adopt,
  }
}
