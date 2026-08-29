import type {} from 'pinia-plugin-synced'

import type { DisplayModel } from '../display-models'

import { useLocalStorageManualReset } from '@proj-airi/stage-shared/composables'
import { refManualReset, useEventListener } from '@vueuse/core'
import { defineStore, storeToRefs } from 'pinia'
import { computed, watch } from 'vue'

import { DisplayModelFormat, useDisplayModelsStore } from '../display-models'

export type StageModelRenderer = 'live2d' | 'vrm' | 'spine' | 'tachie' | 'mmd' | 'godot' | 'disabled' | undefined
type BuiltInStageModelRenderer = Exclude<StageModelRenderer, 'godot'>

const useStageModelSelectionStore = defineStore('settings-stage-model-selection', () => {
  // Pinia synchronization owns live cross-window state. localStorage only
  // loads and saves the durable model selection.
  const selected = useLocalStorageManualReset<string>('settings/stage/model', 'preset-live2d-1', {
    listenToStorageChanges: false,
  })

  function resetState() {
    selected.reset()
  }

  return {
    selected,
    resetState,
  }
}, {
  synced: {
    state: true,
  },
})

export const useSettingsStageModel = defineStore('settings-stage-model', () => {
  const displayModelsStore = useDisplayModelsStore()
  const stageModelSelectionStore = useStageModelSelectionStore()
  const { selected: stageModelSelectedState } = storeToRefs(stageModelSelectionStore)
  let stageModelUpdateSequence = 0
  const defaultStageModelId = 'preset-live2d-1'
  const stageModelSelected = computed<string>({
    get: () => stageModelSelectedState.value,
    set: (value) => {
      stageModelSelectedState.value = value
    },
  })
  const stageModelSelectedDisplayModel = refManualReset<DisplayModel | undefined>(undefined)
  const stageModelSelectedUrl = refManualReset<string | undefined>(undefined)
  const stageModelRenderer = refManualReset<StageModelRenderer>(undefined)
  const stageModelBuiltInRenderer = refManualReset<BuiltInStageModelRenderer>(undefined)

  const stageViewControlsEnabled = refManualReset<boolean>(false)

  // Deferred revocations: a replaced blob URL may still be mid-flight in the
  // loader (OPFS checkMiddleware fetches it at the start of a heavy model's
  // multi-second setup). Revoking immediately aborts that fetch with
  // "TypeError: Failed to fetch" and the first load attempt after every
  // selection change dies. The blob's backing File stays alive via the
  // display-models store regardless, so deferring revocation costs nothing.
  const pendingRevokeTimers = new Set<ReturnType<typeof setTimeout>>()
  const revokeDelayMs = 120_000

  function revokeStageModelUrl(url?: string) {
    if (url?.startsWith('blob:'))
      URL.revokeObjectURL(url)
  }

  function deferRevokeStageModelUrl(url?: string) {
    if (!url?.startsWith('blob:'))
      return

    const timer = setTimeout(() => {
      pendingRevokeTimers.delete(timer)
      revokeStageModelUrl(url)
    }, revokeDelayMs)
    pendingRevokeTimers.add(timer)
  }

  function replaceStageModelUrl(nextUrl?: string) {
    if (stageModelSelectedUrl.value === nextUrl)
      return

    deferRevokeStageModelUrl(stageModelSelectedUrl.value)
    stageModelSelectedUrl.value = nextUrl
  }

  function resolveBuiltInStageModelRenderer(model?: DisplayModel): BuiltInStageModelRenderer {
    if (!model) {
      return 'disabled'
    }

    switch (model.format) {
      case DisplayModelFormat.Live2dZip:
        return 'live2d'
      case DisplayModelFormat.VRM:
        return 'vrm'
      case DisplayModelFormat.SpineZip:
        return 'spine'
      case DisplayModelFormat.TachieZip:
        return 'tachie'
      case DisplayModelFormat.PMXZip:
      case DisplayModelFormat.PMXDirectory:
      case DisplayModelFormat.PMD:
        return 'mmd'
      default:
        return 'disabled'
    }
  }

  async function updateStageModel() {
    const requestId = ++stageModelUpdateSequence
    const selectedModelId = stageModelSelectedState.value

    if (!selectedModelId) {
      replaceStageModelUrl(undefined)
      stageModelSelectedDisplayModel.value = undefined
      stageModelBuiltInRenderer.value = 'disabled'
      if (stageModelRenderer.value !== 'godot')
        stageModelRenderer.value = 'disabled'
      return
    }

    const model = await displayModelsStore.getDisplayModel(selectedModelId)
    if (requestId !== stageModelUpdateSequence)
      return

    if (!model) {
      if (selectedModelId !== defaultStageModelId) {
        stageModelSelectedState.value = defaultStageModelId
        await updateStageModel()
        return
      }

      replaceStageModelUrl(undefined)
      stageModelSelectedDisplayModel.value = undefined
      stageModelBuiltInRenderer.value = 'disabled'
      if (stageModelRenderer.value !== 'godot')
        stageModelRenderer.value = 'disabled'
      return
    }

    const builtInRenderer = resolveBuiltInStageModelRenderer(model)
    stageModelBuiltInRenderer.value = builtInRenderer
    if (stageModelRenderer.value !== 'godot')
      stageModelRenderer.value = builtInRenderer

    if (model.type === 'file') {
      const nextUrl = URL.createObjectURL(model.file)
      if (requestId !== stageModelUpdateSequence) {
        URL.revokeObjectURL(nextUrl)
        return
      }

      replaceStageModelUrl(nextUrl)
    }
    else {
      replaceStageModelUrl(model.url)
    }

    stageModelSelectedDisplayModel.value = model
  }

  function setStageModelRenderer(renderer: StageModelRenderer) {
    stageModelRenderer.value = renderer
  }

  function restoreBuiltInStageModelRenderer() {
    stageModelRenderer.value = stageModelBuiltInRenderer.value ?? 'disabled'
  }

  async function initializeStageModel() {
    await updateStageModel()
  }

  useEventListener('unload', () => {
    for (const timer of pendingRevokeTimers)
      clearTimeout(timer)
    pendingRevokeTimers.clear()
    revokeStageModelUrl(stageModelSelectedUrl.value)
  })

  watch(stageModelSelectedState, (_newValue, _oldValue) => {
    void updateStageModel()
  })

  async function resetState() {
    deferRevokeStageModelUrl(stageModelSelectedUrl.value)

    stageModelSelectionStore.resetState()
    stageModelSelectedDisplayModel.reset()
    stageModelSelectedUrl.reset()
    stageModelRenderer.reset()
    stageModelBuiltInRenderer.reset()
    stageViewControlsEnabled.reset()

    await updateStageModel()
  }

  return {
    stageModelRenderer,
    stageModelSelected,
    stageModelSelectedUrl,
    stageModelSelectedDisplayModel,
    stageViewControlsEnabled,

    initializeStageModel,
    restoreBuiltInStageModelRenderer,
    setStageModelRenderer,
    updateStageModel,
    resetState,
  }
})
