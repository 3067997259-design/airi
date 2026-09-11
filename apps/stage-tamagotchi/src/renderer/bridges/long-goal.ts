import type { LongGoalSchedulerPort } from '@proj-airi/stage-ui/services/long-goal-scheduler'

import { defineInvoke } from '@moeru/eventa'
import { getElectronEventaContext } from '@proj-airi/electron-vueuse'

import {
  longGoalClaim,
  longGoalRelease,
  longGoalSchedule,
  longGoalUnschedule,
  longGoalWakeEmitted,
} from '../../shared/eventa'
import { resolveRendererWindowContext } from '../window-context'

/** Creates the renderer client for the main-process long-goal scheduler. */
export function createLongGoalSchedulerClient(): LongGoalSchedulerPort {
  const context = getElectronEventaContext()
  const schedule = defineInvoke(context, longGoalSchedule)
  const unschedule = defineInvoke(context, longGoalUnschedule)
  const claim = defineInvoke(context, longGoalClaim)
  const release = defineInvoke(context, longGoalRelease)

  return {
    schedule: async input => await schedule(input),
    unschedule: async goalId => await unschedule({ goalId }),
    claim: async input => await claim(input),
    release: async input => await release(input),
    isWakeConsumer: () => resolveRendererWindowContext().leadership === 'leader-only',
    onWake(listener) {
      const off = context.on(longGoalWakeEmitted, (event) => {
        if (event.body)
          listener(event.body)
      })
      return () => off()
    },
  }
}
