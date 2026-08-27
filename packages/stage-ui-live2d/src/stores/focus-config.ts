import { useLocalStorageManualReset } from '@proj-airi/stage-shared/composables'
import { defineStore } from 'pinia'

export interface Live2DFocusEntry {
  /** Cubism parameter id written by the focus mapping, e.g. ParamEyeBallX. */
  id: string
  /** Focus controller axis feeding this entry. `xy` multiplies both axes (stock AngleZ). */
  axis: 'x' | 'y' | 'xy'
  /** Parameter value at full focus deflection; sign is honored (stock AngleZ is negative). */
  gain: number
  enabled: boolean
}

export interface Live2DFocusConfig {
  mode: 'standard' | 'custom'
  entries: Live2DFocusEntry[]
}

/**
 * Replicates the stock pixi-live2d-display `updateFocus` mapping so switching
 * to `custom` starts from the exact stock behavior before any tuning.
 */
export function createDefaultFocusEntries(): Live2DFocusEntry[] {
  return [
    { id: 'ParamEyeBallX', axis: 'x', gain: 1, enabled: true },
    { id: 'ParamEyeBallY', axis: 'y', gain: 1, enabled: true },
    { id: 'ParamAngleX', axis: 'x', gain: 30, enabled: true },
    { id: 'ParamAngleY', axis: 'y', gain: 30, enabled: true },
    { id: 'ParamAngleZ', axis: 'xy', gain: -30, enabled: true },
    { id: 'ParamBodyAngleX', axis: 'x', gain: 10, enabled: true },
  ]
}

export function createDefaultFocusConfig(): Live2DFocusConfig {
  return { mode: 'standard', entries: createDefaultFocusEntries() }
}

/**
 * Per-model focus mapping overrides. Models with heavily customized eye rigs
 * (texture-switched pupils, deformer-coupled eyeballs) misbehave under the
 * stock fixed gains, so each model can carry its own tuned mapping.
 */
export const useLive2DFocusConfig = defineStore('live2d-focus-config', () => {
  const configs = useLocalStorageManualReset<Record<string, Live2DFocusConfig>>('live2d/focus-configs', {})

  function configFor(modelId: string | undefined): Live2DFocusConfig {
    if (!modelId)
      return createDefaultFocusConfig()
    return configs.value[modelId] ?? createDefaultFocusConfig()
  }

  function setConfig(modelId: string | undefined, config: Live2DFocusConfig) {
    if (!modelId)
      return
    configs.value = { ...configs.value, [modelId]: config }
  }

  function resetConfig(modelId: string | undefined) {
    if (!modelId)
      return
    const next = { ...configs.value }
    delete next[modelId]
    configs.value = next
  }

  return {
    configs,
    configFor,
    resetConfig,
    setConfig,
  }
})
