import type { LifeModeConfig, LifeModePort, LifeTickPayload } from '@proj-airi/stage-ui/stores/modules/life-mode'

import { defineInvoke } from '@moeru/eventa'
import { getElectronEventaContext } from '@proj-airi/electron-vueuse'

import { lifeModeGetConfig, lifeModeSetConfig, lifeTickEmitted } from '../../shared/eventa'

/**
 * Renderer-side life mode client (LIFE-PLAN M3).
 *
 * Thin facade over the main-process contracts; shapes mirror the stage-ui
 * `LifeModePort` structurally. The main process owns persistence and the
 * heartbeat; this client only relays config and forwards ticks.
 */
export function createLifeModeClient(): LifeModePort {
  const context = getElectronEventaContext()
  const getConfig = defineInvoke(context, lifeModeGetConfig)
  const setConfig = defineInvoke(context, lifeModeSetConfig)

  return {
    getConfig: async () => (await getConfig()) as unknown as LifeModeConfig,
    setConfig: async config => (await setConfig(config as never)) as unknown as LifeModeConfig,
    onTick(listener) {
      const off = context.on(lifeTickEmitted, (event) => {
        if (event.body)
          listener(event.body as LifeTickPayload)
      })
      return () => off()
    },
  }
}
