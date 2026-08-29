import { useLocalStorageManualReset } from '@proj-airi/stage-shared/composables'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

/** A user override for one model parameter (value re-asserted every frame while enabled). */
export interface Live2DCustomParameterValue {
  value: number
  enabled: boolean
}

/**
 * How much of the model's parameter surface the LLM may drive.
 *
 * `none` keeps the panel a human-only control; `all` offers every discovered
 * parameter; `custom` offers only the ids flagged in `llmExposedRecord`.
 * A 200-parameter model would otherwise flood the tool description, so `custom`
 * is the practical mode for large rigs.
 */
export type Live2DParameterLlmMode = 'all' | 'none' | 'custom'

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
 * - The model usually loads in the main stage window while the settings panel
 *   lives in the settings window (separate Electron renderers with separate
 *   Pinia instances), so the discovered catalog is localStorage-backed —
 *   the same cross-window mechanism `availableMotions` uses.
 * - Discovery is re-registered on every model load; overrides persist per
 *   model id in localStorage and survive restarts.
 */
export const useLive2DCustomParameters = defineStore('live2d-custom-parameters', () => {
  const overrides = useLocalStorageManualReset<Record<string, Record<string, Live2DCustomParameterValue>>>('live2d/custom-parameters', {})
  const discoveredRecord = useLocalStorageManualReset<Record<string, Live2DDiscoveredModelParameters>>('live2d/discovered-parameters', {})
  // Kept for callers that mutate per-entry state on discovered snapshots.
  const discovered = ref(new Map<string, Live2DDiscoveredModelParameters>())
  const discoveredKeys = computed(() => Object.keys(discoveredRecord.value))

  /**
   * LLM exposure policy. Chosen in the settings window, read in the stage
   * window that owns the tool executors, so both cross renderers through
   * localStorage like the overrides themselves.
   */
  const llmMode = useLocalStorageManualReset<Live2DParameterLlmMode>('live2d/custom-parameters-llm-mode', 'none')
  const llmExposedRecord = useLocalStorageManualReset<Record<string, Record<string, boolean>>>('live2d/custom-parameters-llm-exposed', {})

  function setLlmMode(mode: Live2DParameterLlmMode) {
    llmMode.value = mode
  }

  function isExposedToLlm(modelId: string | undefined, parameterId: string): boolean {
    if (llmMode.value === 'all')
      return true
    if (llmMode.value === 'none' || !modelId)
      return false
    return llmExposedRecord.value[modelId]?.[parameterId] ?? false
  }

  function setLlmExposed(modelId: string | undefined, parameterId: string, exposed: boolean) {
    if (!modelId)
      return
    const model = { ...llmExposedRecord.value[modelId], [parameterId]: exposed }
    llmExposedRecord.value = { ...llmExposedRecord.value, [modelId]: model }
  }

  /** Parameters the LLM may drive for one model, honoring the current mode. */
  function llmExposedParameters(modelId: string | undefined): Live2DDiscoveredParameter[] {
    if (llmMode.value === 'none')
      return []
    const catalog = discoveryFor(modelId)
    if (!catalog)
      return []
    if (llmMode.value === 'all')
      return catalog.parameters
    return catalog.parameters.filter(parameter => isExposedToLlm(modelId, parameter.id))
  }

  function discoveryFor(modelId: string | undefined): Live2DDiscoveredModelParameters | undefined {
    if (!modelId)
      return undefined
    return discoveredRecord.value[modelId]
  }

  function registerDiscovered(modelId: string | undefined, catalog: Live2DDiscoveredModelParameters) {
    if (!modelId)
      return
    discoveredRecord.value = { ...discoveredRecord.value, [modelId]: catalog }
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
    discoveredKeys,
    discoveryFor,
    isExposedToLlm,
    llmExposedParameters,
    llmExposedRecord,
    llmMode,
    overrides,
    registerDiscovered,
    resetModel,
    setEnabled,
    setLlmExposed,
    setLlmMode,
    setValue,
    valuesFor,
  }
})
