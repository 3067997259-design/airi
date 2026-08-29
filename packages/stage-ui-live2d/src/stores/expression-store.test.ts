// @vitest-environment jsdom

import type { ExpressionEntry, ExpressionGroupDefinition } from './expression-store'

import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { nextTick } from 'vue'

import { useExpressionStore } from './expression-store'

const activeStores: Array<ReturnType<typeof useExpressionStore>> = []

function createStore() {
  setActivePinia(createPinia())
  const store = useExpressionStore()
  activeStores.push(store)
  return store
}

function createCatalog(): { groups: ExpressionGroupDefinition[], entries: ExpressionEntry[] } {
  return {
    groups: [{
      name: 'Sleep',
      parameters: [{ parameterId: 'SleepButton', blend: 'Add', value: 1 }],
    }],
    entries: [{
      name: 'SleepButton',
      parameterId: 'SleepButton',
      blend: 'Add',
      currentValue: 0,
      defaultValue: 0,
      modelDefault: 0,
      targetValue: 1,
    }],
  }
}

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  for (const store of activeStores.splice(0))
    store.$dispose()
  localStorage.clear()
})

/**
 * Mirrors how the settings renderer observes a localStorage write made by the
 * stage renderer. VueUse only reflects `storage` events, which jsdom does not
 * emit for same-document writes.
 */
function emitStorageEvent(key: string) {
  window.dispatchEvent(new StorageEvent('storage', {
    key,
    newValue: localStorage.getItem(key),
    storageArea: localStorage,
  }))
}

describe('expression catalog storage', () => {
  // ROOT CAUSE:
  //
  // The catalog used null as its initial storage value. VueUse selected its
  // string serializer and stored the catalog as "[object Object]". A second
  // renderer then read a string and failed when it accessed groups.map().
  //
  // We fixed this by selecting the object serializer explicitly.
  it('serializes the catalog and hydrates it in another Pinia instance', async () => {
    const stageStore = createStore()
    const catalog = createCatalog()

    stageStore.registerExpressions('model-a', catalog.groups, catalog.entries)
    await nextTick()

    const rawCatalog = localStorage.getItem('live2d/expression-catalog')
    expect(rawCatalog).not.toBeNull()
    expect(rawCatalog).not.toBe('[object Object]')
    expect(JSON.parse(rawCatalog!)).toMatchObject({
      modelId: 'model-a',
      groups: [{ name: 'Sleep' }],
      entries: [{ name: 'SleepButton' }],
    })

    const settingsStore = createStore()
    await nextTick()

    expect(settingsStore.modelId).toBe('model-a')
    expect(Array.from(settingsStore.expressionGroups.keys())).toEqual(['Sleep'])
    expect(Array.from(settingsStore.expressions.keys())).toEqual(['SleepButton'])
  })
})

describe('cross-window expression toggles', () => {
  // ROOT CAUSE:
  //
  // `expressions` was a plain in-renderer ref. `registerExpressions` published
  // a catalog to localStorage so the settings window could LIST the groups, but
  // `toggle` only mutated the local Map. The stage renderer owns the model and
  // reads its own `expressions` Map every frame, so a toggle performed in the
  // settings window never reached the renderer that draws the model:
  //
  //   settings window:  toggle('Sleep') -> local Map.currentValue = 1  (dead end)
  //   stage window:     applyExpressions() reads its own Map           (still 0)
  //
  // The custom-parameter panel worked because its overrides live in a
  // localStorage-backed ref that the per-frame plugin re-reads.
  //
  // We fixed this by making the runtime values a localStorage-backed record
  // (`live2d/expression-values`) that both renderers read and write, so a
  // toggle in either window reaches the frame loop.
  it('publishes toggled values to another Pinia instance', async () => {
    const stageStore = createStore()
    const catalog = createCatalog()
    stageStore.registerExpressions('model-a', catalog.groups, catalog.entries)
    await nextTick()

    const settingsStore = createStore()
    await nextTick()

    settingsStore.toggle('Sleep')
    await nextTick()
    emitStorageEvent('live2d/expression-values')
    await nextTick()

    expect(settingsStore.expressions.get('SleepButton')!.currentValue).toBe(1)
    expect(stageStore.expressions.get('SleepButton')!.currentValue).toBe(1)
  })

  it('reflects resetAll across windows', async () => {
    const stageStore = createStore()
    const catalog = createCatalog()
    stageStore.registerExpressions('model-a', catalog.groups, catalog.entries)
    await nextTick()

    const settingsStore = createStore()
    await nextTick()

    settingsStore.toggle('Sleep')
    await nextTick()
    emitStorageEvent('live2d/expression-values')
    await nextTick()
    expect(stageStore.expressions.get('SleepButton')!.currentValue).toBe(1)

    settingsStore.resetAll()
    await nextTick()
    emitStorageEvent('live2d/expression-values')
    await nextTick()

    expect(stageStore.expressions.get('SleepButton')!.currentValue).toBe(0)
  })
})
