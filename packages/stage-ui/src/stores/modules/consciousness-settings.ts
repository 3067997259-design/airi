import type {} from 'pinia-plugin-synced'

import type { MirrorVisualCapabilitySetting } from '../mirror-visual'

import { defineStore } from 'pinia'
import { shallowRef } from 'vue'

const MIRROR_VISUAL_SETTINGS_KEY = 'settings/consciousness/mirror-visual-capabilities'

function loadReasoning() {
  // Non-renderer runtimes have no durable settings owner. They use the product
  // default until a synchronized renderer snapshot arrives.
  if (typeof localStorage === 'undefined')
    return false

  return localStorage.getItem('settings/consciousness/reasoning') === 'true'
}

function persistReasoning(value: boolean) {
  if (typeof localStorage === 'undefined')
    return

  localStorage.setItem('settings/consciousness/reasoning', String(value))
}

function loadMirrorVisualCapabilities(): Record<string, MirrorVisualCapabilitySetting> {
  if (typeof localStorage === 'undefined')
    return {}

  try {
    const parsed = JSON.parse(localStorage.getItem(MIRROR_VISUAL_SETTINGS_KEY) ?? '{}') as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      return {}

    const entries: Array<[string, MirrorVisualCapabilitySetting]> = []
    for (const [key, value] of Object.entries(parsed)) {
      if (value === 'auto' || value === 'image-input' || value === 'text-only')
        entries.push([key, value])
    }
    return Object.fromEntries(entries)
  }
  catch {
    return {}
  }
}

function persistMirrorVisualCapabilities(value: Record<string, MirrorVisualCapabilitySetting>) {
  if (typeof localStorage === 'undefined')
    return

  localStorage.setItem(MIRROR_VISUAL_SETTINGS_KEY, JSON.stringify(value))
}

function mirrorVisualSettingKey(providerId: string, modelId: string): string {
  return providerId + String.fromCharCode(0) + modelId
}

/**
 * Stores request policies for the consciousness module.
 *
 * Consciousness chat request preparation reads this state before inference.
 * Each provider maps the reasoning value to its own request fields.
 */
export const useConsciousnessSettingsStore = defineStore('consciousness-settings', () => {
  // Pinia owns live cross-window state. Only synchronized actions write the
  // durable value, so a follower cannot persist an uncommitted proposal.
  const reasoning = shallowRef(loadReasoning())
  const mirrorVisualCapabilities = shallowRef(loadMirrorVisualCapabilities())

  async function setReasoning(value: boolean) {
    reasoning.value = value
    persistReasoning(value)
  }

  function getMirrorVisualCapability(providerId: string, modelId: string): MirrorVisualCapabilitySetting {
    return mirrorVisualCapabilities.value[mirrorVisualSettingKey(providerId, modelId)] ?? 'auto'
  }

  async function setMirrorVisualCapability(
    providerId: string,
    modelId: string,
    value: MirrorVisualCapabilitySetting,
  ) {
    if (!providerId || !modelId)
      return

    const key = mirrorVisualSettingKey(providerId, modelId)
    mirrorVisualCapabilities.value = {
      ...mirrorVisualCapabilities.value,
      [key]: value,
    }
    persistMirrorVisualCapabilities(mirrorVisualCapabilities.value)
  }

  async function resetState() {
    reasoning.value = false
    persistReasoning(false)
    mirrorVisualCapabilities.value = {}
    persistMirrorVisualCapabilities({})
  }

  return {
    reasoning,
    setReasoning,
    mirrorVisualCapabilities,
    getMirrorVisualCapability,
    setMirrorVisualCapability,
    resetState,
  }
}, {
  synced: {
    actions: ['resetState', 'setMirrorVisualCapability', 'setReasoning'],
    state: true,
  },
})
