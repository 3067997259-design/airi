import { useLocalStorageManualReset } from '@proj-airi/stage-shared/composables'
import { defineStore } from 'pinia'

/** Stores the user choice for active-task prompt focus. */
export const useAttentionStore = defineStore('attention', () => {
  const focusedModeEnabled = useLocalStorageManualReset('settings/attention/focused-mode-enabled', true)

  function resetState() {
    focusedModeEnabled.reset()
  }

  return { focusedModeEnabled, resetState }
})
