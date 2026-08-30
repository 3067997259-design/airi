// @vitest-environment jsdom

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { useConsciousnessSettingsStore } from './consciousness-settings'

describe('consciousness settings', () => {
  beforeEach(() => {
    localStorage.clear()
    setActivePinia(createPinia())
  })

  it('turns model reasoning off by default', () => {
    const store = useConsciousnessSettingsStore()

    expect(store.reasoning).toBe(false)
  })

  it('loads the persisted reasoning value', () => {
    localStorage.setItem('settings/consciousness/reasoning', 'true')
    const store = useConsciousnessSettingsStore()

    expect(store.reasoning).toBe(true)
  })

  it('persists reasoning changes through store actions', async () => {
    const store = useConsciousnessSettingsStore()
    await store.setReasoning(true)

    expect(store.reasoning).toBe(true)
    expect(localStorage.getItem('settings/consciousness/reasoning')).toBe('true')
  })

  it('ignores storage events because Pinia owns cross-window synchronization', () => {
    const store = useConsciousnessSettingsStore()

    window.dispatchEvent(new StorageEvent('storage', {
      key: 'settings/consciousness/reasoning',
      newValue: 'true',
    }))

    expect(store.reasoning).toBe(false)
  })

  it('keeps mirror image capability overrides scoped to provider and model', async () => {
    const store = useConsciousnessSettingsStore()

    expect(store.getMirrorVisualCapability('provider-a', 'model-a')).toBe('auto')
    await store.setMirrorVisualCapability('provider-a', 'model-a', 'image-input')

    expect(store.getMirrorVisualCapability('provider-a', 'model-a')).toBe('image-input')
    expect(store.getMirrorVisualCapability('provider-a', 'model-b')).toBe('auto')
    expect(store.getMirrorVisualCapability('provider-b', 'model-a')).toBe('auto')
    expect(localStorage.getItem('settings/consciousness/mirror-visual-capabilities')).toContain('image-input')
  })

  it('clears mirror capability overrides with the settings reset', async () => {
    const store = useConsciousnessSettingsStore()
    await store.setMirrorVisualCapability('provider-a', 'model-a', 'text-only')

    await store.resetState()

    expect(store.getMirrorVisualCapability('provider-a', 'model-a')).toBe('auto')
    expect(localStorage.getItem('settings/consciousness/mirror-visual-capabilities')).toBe('{}')
  })
})
