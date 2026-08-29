<script setup lang="ts">
import { useMemoryStore } from '@proj-airi/stage-ui/stores/modules/memory'
import { Button, Callout, FieldInput } from '@proj-airi/ui'
import { storeToRefs } from 'pinia'
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import MemoryBrowser from './components/memory-browser.vue'
import MemoryLongTermControls from './components/memory-long-term-controls.vue'
import MemoryScopeNav from './components/memory-scope-nav.vue'

const { t } = useI18n()
const memoryStore = useMemoryStore()
const { remoteStatus, remoteError, pgConnectionString } = storeToRefs(memoryStore)

const connectionStringInput = ref(pgConnectionString.value)
const connecting = ref(false)

onMounted(() => {
  void memoryStore.refreshRemoteHostStatus()
})

async function connect() {
  connecting.value = true
  try {
    await memoryStore.configureRemoteHost(connectionStringInput.value)
  }
  finally {
    connecting.value = false
  }
}

async function disconnect() {
  connecting.value = true
  try {
    await memoryStore.configureRemoteHost('')
  }
  finally {
    connecting.value = false
  }
}
</script>

<template>
  <div :class="['flex', 'flex-col', 'gap-6']">
    <MemoryScopeNav />

    <section :class="['rounded-xl', 'bg-neutral-50', 'p-4', 'dark:bg-[rgba(0,0,0,0.3)]']">
      <div :class="['flex', 'flex-col', 'gap-4']">
        <div>
          <h2 :class="['text-lg', 'text-neutral-500', 'md:text-2xl', 'dark:text-neutral-400']">
            {{ t('settings.pages.modules.memory-long-term.remote.title') }}
          </h2>
          <p :class="['text-sm', 'text-neutral-400', 'dark:text-neutral-500']">
            {{ t('settings.pages.modules.memory-long-term.remote.description') }}
          </p>
        </div>

        <FieldInput
          v-model="connectionStringInput"
          :label="t('settings.pages.modules.memory-long-term.remote.connection-label')"
          :placeholder="t('settings.pages.modules.memory-long-term.remote.connection-placeholder')"
        />

        <div :class="['flex', 'items-center', 'gap-3']">
          <Button :disabled="connecting" @click="connect">
            {{ t('settings.pages.modules.memory-long-term.remote.connect') }}
          </Button>
          <Button v-if="remoteStatus === 'ready'" :disabled="connecting" @click="disconnect">
            {{ t('settings.pages.modules.memory-long-term.remote.disconnect') }}
          </Button>
        </div>

        <Callout
          :theme="remoteStatus === 'ready' ? 'lime' : remoteStatus === 'error' ? 'red' : 'orange'"
          :label="t(`settings.pages.modules.memory-long-term.remote.status.${remoteStatus}`)"
        >
          <span v-if="remoteError" :class="['text-sm']">{{ remoteError }}</span>
        </Callout>
      </div>
    </section>

    <MemoryLongTermControls />
    <MemoryBrowser />
  </div>
</template>

<route lang="yaml">
meta:
  layout: settings
  titleKey: settings.pages.modules.memory-long-term.title
  subtitleKey: settings.title
  stageTransition:
    name: slide
</route>
