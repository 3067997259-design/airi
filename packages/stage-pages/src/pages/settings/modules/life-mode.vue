<script setup lang="ts">
import type { LifeModeTestHeartbeatResult } from '@proj-airi/stage-ui/stores/modules/life-mode'

import { useLifeModeStore } from '@proj-airi/stage-ui/stores/modules/life-mode'
import { storeToRefs } from 'pinia'
import { ref } from 'vue'

import LifeModeDecisionList from './components/life-mode-decision-list.vue'
import LifeModeSettingsForm from './components/life-mode-settings-form.vue'
import LifeModeStatusCard from './components/life-mode-status-card.vue'

const lifeMode = useLifeModeStore()
const { config, recentDecisions, snapshot } = storeToRefs(lifeMode)
const testing = ref(false)
const testResult = ref<LifeModeTestHeartbeatResult>()

async function requestTestHeartbeat(): Promise<void> {
  testing.value = true
  try {
    testResult.value = await lifeMode.requestTestHeartbeat()
  }
  finally {
    testing.value = false
  }
}
</script>

<template>
  <div :class="['flex', 'flex-col', 'gap-6']">
    <LifeModeStatusCard
      :snapshot="snapshot"
      :testing="testing"
      :test-result="testResult"
      @test="requestTestHeartbeat"
    />
    <LifeModeSettingsForm
      :config="config"
      @set-mode="lifeMode.setMode"
      @patch="lifeMode.setConfigPatch"
    />
    <LifeModeDecisionList :decisions="recentDecisions" />
  </div>
</template>

<route lang="yaml">
meta:
  layout: settings
  titleKey: settings.pages.modules.life-mode.title
  subtitleKey: settings.title
  stageTransition:
    name: slide
</route>
