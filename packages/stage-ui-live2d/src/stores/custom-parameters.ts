import { useLocalStorageManualReset } from '@proj-airi/stage-shared/composables'
import { defineStore } from 'pinia'
import { ref } from 'vue'

/** A user override for one model parameter (value re-asserted every frame while enabled). */
export interface Live2DCustomParameterValue {
  value: number
  enabled: boolean
}

/** Parameter metadata discovered from the model at load time (cdi3 + core ranges). */
export interface Live2DDiscoveredParameter {
  id: string
  name: string
  groupId: string | null
  min: number
  max: number
  default: number
}

export interface Live2DDiscoveredGroup {
  id: string
  name: string
}

export interface Live2DDiscoveredModelParameters {
  parameters: Live2DDiscoveredParameter[]
  groups: Live2DDiscoveredGroup[]
}

/**
 * Per-model custom parameter overrides plus the discovered parameter catalog.
 *
 * Use when:
 * - Surfacing model-native toggles (hairstyle switches, pupil styles, ears)
 *   that no other AIRI surface controls.
 *
 * Expects:
 * - Discovery is re-registered on every model load; overrides persist per
 *   model id in localStorage and survive restarts.
 */
export const useLive2DCustomParameters = defineStore('live2d-custom-parameters', () => {
  const overrides = useLocalStorageManualReset<Record<string, Record<string, Live2DCustomParameterValue>>>('live2d/custom-parameters', {})
  const discovered = ref(new Map<string, Live2DDiscoveredModelParameters>())

  function discoveryFor(modelId: string | undefined): Live2DDiscoveredModelParameters | undefined {
    if (!modelId)
      return undefined
    return discovered.value.get(modelId)
  }

  function registerDiscovered(modelId: string | undefined, catalog: Live2DDiscoveredModelParameters) {
    if (!modelId)
      return
    const next = new Map(discovered.value)
    next.set(modelId, catalog)
    discovered.value = next
  }

  function valuesFor(modelId: string | undefined): Record<string, Live2DCustomParameterValue> {
    if (!modelId)
      return {}
    return overrides.value[modelId] ?? {}
  }

  function setValue(modelId: string | undefined, parameterId: string, value: number) {
    if (!modelId)
      return
    const model = overrides.value[modelId] ?? {}
    const entry = model[parameterId] ?? { value, enabled: true }
    model[parameterId] = { ...entry, value, enabled: true }
    overrides.value = { ...overrides.value, [modelId]: model }
  }

  function setEnabled(modelId: string | undefined, parameterId: string, enabled: boolean) {
    if (!modelId)
      return
    const model = overrides.value[modelId] ?? {}
    const entry = model[parameterId]
    if (!entry)
      return
    model[parameterId] = { ...entry, enabled }
    overrides.value = { ...overrides.value, [modelId]: model }
  }

  function resetModel(modelId: string | undefined) {
    if (!modelId)
      return
    const next = { ...overrides.value }
    delete next[modelId]
    overrides.value = next
  }

  return {
    discovered,
    discoveryFor,
    overrides,
    registerDiscovered,
    resetModel,
    setEnabled,
    setValue,
    valuesFor,
  }
})
