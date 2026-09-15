import { useElectronEventaInvoke } from '@proj-airi/electron-vueuse'
import { useSkillsReviewStore } from '@proj-airi/stage-ui/stores/skills'
import { defineStore } from 'pinia'
import { computed, watch } from 'vue'

import { electronPluginUpdateCapability } from '../../shared/eventa/plugin/capabilities'
import { isSyncedLeaderWindow } from '../window-context'

/** Capability id the fixed skill adapter publishes while wrapped skills exist. */
const SKILL_ADAPTER_CAPABILITY_KEY = 'skill.adapter.self-authored'

/**
 * CP-1 consumer 2: the renderer publishes the skill adapter capability so the
 * plugin-host registry can resolve modules waiting on self-authored tools.
 *
 * The adapter is "present" only while at least one reviewed skill is exposed
 * through it; revoking every wrapped skill withdraws the capability.
 */
export const useSkillAdapterCapabilityStore = defineStore('skill-adapter-capability', () => {
  const skillsStore = useSkillsReviewStore()
  const updateCapability = useElectronEventaInvoke(electronPluginUpdateCapability)
  const wrappedCount = computed(() => Object.values(skillsStore.skillAdapterModes).filter(mode => mode === 'wrapped').length)
  let announced = false

  async function sync() {
    try {
      if (wrappedCount.value > 0) {
        if (!announced) {
          // CP-1 observer tracking reads `providerModuleId`; `source` alone is
          // ignored by the registry scope resolver.
          await updateCapability({ key: SKILL_ADAPTER_CAPABILITY_KEY, state: 'announced', metadata: { source: 'skill-adapter', providerModuleId: 'skill-adapter' } })
          announced = true
        }
        await updateCapability({ key: SKILL_ADAPTER_CAPABILITY_KEY, state: 'ready', metadata: { wrappedCount: wrappedCount.value, providerModuleId: 'skill-adapter' } })
        return
      }
      if (announced) {
        await updateCapability({ key: SKILL_ADAPTER_CAPABILITY_KEY, state: 'withdrawn', metadata: { source: 'skill-adapter', providerModuleId: 'skill-adapter' } })
        announced = false
      }
    }
    catch (error) {
      console.warn('[skill-adapter] Failed to update the capability state:', error)
    }
  }

  // The capability has one owner: the leader announces and withdraws it. The
  // watcher calls `sync` through its closure, which bypasses synchronized
  // action routing, so followers would publish stale local adapter state into
  // the plugin host's capability registry.
  watch(wrappedCount, () => {
    if (!isSyncedLeaderWindow())
      return

    void sync()
  }, { immediate: true })

  return { wrappedCount, sync }
}, {
  synced: {
    state: false,
    actions: ['sync'],
  },
})
