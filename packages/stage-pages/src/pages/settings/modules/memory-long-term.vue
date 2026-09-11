<script setup lang="ts">
import { useMemoryStore } from '@proj-airi/stage-ui/stores/modules/memory'
import { Button, Callout, FieldCheckbox, FieldInput } from '@proj-airi/ui'
import { storeToRefs } from 'pinia'
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import MemoryBrowser from './components/memory-browser.vue'
import MemoryLongTermControls from './components/memory-long-term-controls.vue'
import MemoryScopeNav from './components/memory-scope-nav.vue'

const { t } = useI18n()
const memoryStore = useMemoryStore()
const { remoteStatus, remoteError, pgConnectionString, longTermSyncEnabled, longTermSyncOutbox, lastLongTermSyncError, databaseStatus, databaseError, databasePersistenceStatus, embeddingMigration } = storeToRefs(memoryStore)

const connectionStringInput = ref(pgConnectionString.value)
const connecting = ref(false)
const reembedding = ref(false)

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

async function retrySync() {
  await memoryStore.retryLongTermSync()
}

async function queueExistingMemories() {
  await memoryStore.queueExistingLongTermMemories()
}

async function reembedMemories() {
  reembedding.value = true
  try {
    await memoryStore.reembedMemoryVectors()
  }
  finally {
    reembedding.value = false
  }
}
</script>

<template>
  <div :class="['flex', 'flex-col', 'gap-6']">
    <MemoryScopeNav />

    <section :class="['rounded-xl', 'bg-neutral-50', 'p-4', 'dark:bg-[rgba(0,0,0,0.3)]']">
      <div :class="['flex', 'flex-col', 'gap-3']">
        <div :class="['flex', 'flex-wrap', 'items-center', 'justify-between', 'gap-3']">
          <div>
            <h2 :class="['text-lg', 'text-neutral-500', 'md:text-2xl', 'dark:text-neutral-400']">
              {{ t('settings.pages.modules.memory-long-term.database.title') }}
            </h2>
            <p :class="['text-sm', 'text-neutral-400', 'dark:text-neutral-500']">
              {{ t('settings.pages.modules.memory-long-term.database.description') }}
            </p>
          </div>
          <span :class="['rounded-full', 'px-3', 'py-1', 'text-xs', databaseStatus === 'error' || databasePersistenceStatus.state === 'error' ? 'bg-red-100 text-red-600 dark:bg-red-950/40 dark:text-red-300' : 'bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-300']">
            {{ t(`settings.pages.modules.memory-long-term.database.status.${databaseStatus}`) }}
          </span>
        </div>
        <div :class="['flex', 'flex-wrap', 'gap-x-4', 'gap-y-1', 'text-xs', 'text-neutral-400', 'dark:text-neutral-500']">
          <span>{{ t(`settings.pages.modules.memory-long-term.database.persistence.${databasePersistenceStatus.state}`, { count: databasePersistenceStatus.pendingWrites }) }}</span>
          <span>{{ t('settings.pages.modules.memory-long-term.database.migration', { current: embeddingMigration.nextIndex, total: embeddingMigration.total }) }}</span>
        </div>
        <Button
          size="sm"
          :disabled="databaseStatus !== 'ready' || reembedding || embeddingMigration.state === 'running'"
          @click="reembedMemories"
        >
          {{ t('settings.pages.modules.memory-long-term.database.reembed') }}
        </Button>
        <p v-if="databaseError || databasePersistenceStatus.error || embeddingMigration.lastError" :class="['text-sm', 'text-red-500', 'dark:text-red-300']">
          {{ databaseError || databasePersistenceStatus.error || embeddingMigration.lastError }}
        </p>
      </div>
    </section>

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
        <FieldCheckbox
          v-model="longTermSyncEnabled"
          :label="t('settings.pages.modules.memory-long-term.remote.sync-enabled')"
          :description="t('settings.pages.modules.memory-long-term.remote.sync-enabled-description')"
          :disabled="remoteStatus !== 'ready'"
        />
        <div v-if="longTermSyncEnabled" :class="['flex', 'flex-wrap', 'items-center', 'gap-3', 'text-sm', 'text-neutral-400']">
          <span>{{ t('settings.pages.modules.memory-long-term.remote.outbox', { count: longTermSyncOutbox.length }) }}</span>
          <Button v-if="longTermSyncOutbox.length > 0" size="sm" :disabled="remoteStatus !== 'ready'" @click="retrySync">
            {{ t('settings.pages.modules.memory-long-term.remote.retry') }}
          </Button>
          <Button size="sm" :disabled="remoteStatus !== 'ready'" @click="queueExistingMemories">
            {{ t('settings.pages.modules.memory-long-term.remote.queue-existing') }}
          </Button>
          <span v-if="lastLongTermSyncError" class="text-red-500">{{ lastLongTermSyncError }}</span>
        </div>
        <ul
          v-if="longTermSyncEnabled && longTermSyncOutbox.length > 0"
          :class="['flex', 'flex-col', 'gap-1', 'font-mono', 'text-xs', 'text-neutral-400', 'dark:text-neutral-500']"
        >
          <li v-for="(item, index) in longTermSyncOutbox.slice(0, 10)" :key="`${item.originId}-${item.kind}-${item.createdAt}`">
            #{{ index }} [{{ item.kind }}] {{ item.originId }}<span v-if="item.attempts"> · {{ item.attempts }}</span><span v-if="item.lastError" class="text-red-500"> · {{ item.lastError }}</span>
          </li>
          <li v-if="longTermSyncOutbox.length > 10">
            … +{{ longTermSyncOutbox.length - 10 }}
          </li>
        </ul>
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
