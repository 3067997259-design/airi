import type {
  LifeModePort,
} from '@proj-airi/stage-ui/stores/modules/life-mode'

import { defineInvoke } from '@moeru/eventa'
import { getElectronEventaContext } from '@proj-airi/electron-vueuse'

import {
  lifeHeartbeatEmitted,
  lifeModeClaimDecision,
  lifeModeGetSnapshot,
  lifeModeRecordGate,
  lifeModeRequestTestHeartbeat,
  lifeModeSetConfig,
  lifeModeSnapshotChanged,
} from '../../shared/eventa'
import { resolveRendererWindowContext } from '../window-context'

/** Creates the renderer client for the main-process life-mode owner. */
export function createLifeModeClient(): LifeModePort {
  const context = getElectronEventaContext()
  const getSnapshot = defineInvoke(context, lifeModeGetSnapshot)
  const setConfig = defineInvoke(context, lifeModeSetConfig)
  const claimDecision = defineInvoke(context, lifeModeClaimDecision)
  const requestTestHeartbeat = defineInvoke(context, lifeModeRequestTestHeartbeat)
  const recordGate = defineInvoke(context, lifeModeRecordGate)

  return {
    getSnapshot: async () => await getSnapshot(),
    setConfig: async patch => await setConfig({ patch }),
    claimDecision: async heartbeatId => await claimDecision({ heartbeatId }),
    requestTestHeartbeat: async () => await requestTestHeartbeat(),
    recordGate: async gate => await recordGate({ gate }),
    isHeartbeatConsumer: () => resolveRendererWindowContext().leadership === 'leader-only',
    onSnapshot(listener) {
      const off = context.on(lifeModeSnapshotChanged, (event) => {
        if (event.body)
          listener(event.body)
      })
      return () => off()
    },
    onHeartbeat(listener) {
      const off = context.on(lifeHeartbeatEmitted, (event) => {
        if (event.body)
          listener(event.body)
      })
      return () => off()
    },
  }
}
