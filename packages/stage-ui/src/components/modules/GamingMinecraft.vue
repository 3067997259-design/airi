<script setup lang="ts">
import { Button, Callout, FieldCheckbox, FieldInput, FieldSelect, FieldTextArea } from '@proj-airi/ui'
import { storeToRefs } from 'pinia'
import { computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'

import { useGameHostStore } from '../../stores/modules/game-host'

/**
 * Minecraft settings backed by the MCPFabric game-host bridge (MC-0a/MC-0c).
 *
 * The old standalone-bot surface (server address/port/bot username pushed over
 * the mods channel) is gone: this page edits the loopback bridge endpoint that
 * the Electron main process dials, and shows the connection identity the model
 * tools operate against.
 */
const { t } = useI18n()
const gameHostStore = useGameHostStore()

const {
  url,
  token,
  serverUrl,
  planner,
  chatEnabled,
  chatAdminsText,
  chatBlockedText,
  chatSampleRate,
  chatContextLines,
  allowedToolsText,
  status,
  config,
  busy,
  saveState,
  saveError,
  bridgeAvailable,
} = storeToRefs(gameHostStore)

const plannerOptions = computed(() => [
  { value: 'terrain' as const, label: t('settings.pages.modules.gaming-minecraft.movement-planner-terrain') },
  { value: 'legacy' as const, label: t('settings.pages.modules.gaming-minecraft.movement-planner-legacy') },
])

const statusTheme = computed(() => {
  switch (status.value.phase) {
    case 'connected':
      return 'lime'
    case 'error':
      return 'red'
    case 'connecting':
      return 'orange'
    default:
      return 'primary'
  }
})

const statusLabel = computed(() => t(`settings.pages.modules.gaming-minecraft.status.${status.value.phase}`))

const tokenPlaceholder = computed(() => config.value.hasToken
  ? t('settings.pages.modules.gaming-minecraft.token-stored-placeholder')
  : t('settings.pages.modules.gaming-minecraft.token-placeholder'))

const identityRows = computed(() => {
  const identity = status.value.identity
  if (!identity)
    return []

  return [
    { key: 'version', value: identity.minecraftVersion },
    { key: 'world', value: identity.worldId },
    { key: 'dimension', value: identity.dimension },
    { key: 'player', value: identity.playerUuid },
  ]
})

onMounted(() => {
  void gameHostStore.refresh()
})
</script>

<template>
  <div
    :class="[
      'h-fit w-full',
      'flex flex-col gap-4',
      'rounded-xl bg-neutral-100 p-4 dark:bg-[rgba(0,0,0,0.3)]',
    ]"
  >
    <Callout
      v-if="!bridgeAvailable"
      theme="primary"
      :label="t('settings.pages.modules.gaming-minecraft.desktop-only.title')"
    >
      <div :class="['text-sm']">
        {{ t('settings.pages.modules.gaming-minecraft.desktop-only.description') }}
      </div>
    </Callout>

    <template v-else>
      <FieldInput
        v-model="url"
        :label="t('settings.pages.modules.gaming-minecraft.bridge-url')"
        :description="t('settings.pages.modules.gaming-minecraft.bridge-url-description')"
        :placeholder="t('settings.pages.modules.gaming-minecraft.bridge-url-placeholder')"
      />

      <FieldInput
        v-model="serverUrl"
        :label="t('settings.pages.modules.gaming-minecraft.bridge-server-url')"
        :description="t('settings.pages.modules.gaming-minecraft.bridge-server-url-description')"
        :placeholder="t('settings.pages.modules.gaming-minecraft.bridge-server-url-placeholder')"
      />

      <FieldInput
        v-model="token"
        type="password"
        autocomplete="off"
        :label="t('settings.pages.modules.gaming-minecraft.bridge-token')"
        :description="t('settings.pages.modules.gaming-minecraft.bridge-token-description')"
        :placeholder="tokenPlaceholder"
      />

      <FieldSelect
        v-model="planner"
        :label="t('settings.pages.modules.gaming-minecraft.movement-planner')"
        :description="t('settings.pages.modules.gaming-minecraft.movement-planner-description')"
        :options="plannerOptions"
      />

      <div :class="['h-px', 'bg-neutral-200', 'dark:bg-neutral-800']" />

      <FieldCheckbox
        v-model="chatEnabled"
        :label="t('settings.pages.modules.gaming-minecraft.chat-enabled')"
        :description="t('settings.pages.modules.gaming-minecraft.chat-enabled-description')"
      />

      <FieldTextArea
        v-model="chatAdminsText"
        :rows="3"
        :required="false"
        :label="t('settings.pages.modules.gaming-minecraft.chat-admins')"
        :description="t('settings.pages.modules.gaming-minecraft.chat-admins-description')"
      />

      <FieldTextArea
        v-model="chatBlockedText"
        :rows="3"
        :required="false"
        :label="t('settings.pages.modules.gaming-minecraft.chat-blocked')"
        :description="t('settings.pages.modules.gaming-minecraft.chat-blocked-description')"
      />

      <div :class="['grid', 'gap-4', 'sm:grid-cols-2']">
        <FieldInput
          v-model.number="chatSampleRate"
          type="number"
          min="0"
          max="1"
          step="0.05"
          :label="t('settings.pages.modules.gaming-minecraft.chat-sample-rate')"
          :description="t('settings.pages.modules.gaming-minecraft.chat-sample-rate-description')"
        />
        <FieldInput
          v-model.number="chatContextLines"
          type="number"
          min="0"
          max="20"
          step="1"
          :label="t('settings.pages.modules.gaming-minecraft.chat-context-lines')"
          :description="t('settings.pages.modules.gaming-minecraft.chat-context-lines-description')"
        />
      </div>

      <FieldTextArea
        v-model="allowedToolsText"
        :rows="5"
        :required="false"
        :label="t('settings.pages.modules.gaming-minecraft.allowed-tools')"
        :description="t('settings.pages.modules.gaming-minecraft.allowed-tools-description')"
      />

      <div :class="['flex items-center gap-3']">
        <Button
          :label="t('settings.common.save')"
          :disabled="busy"
          @click="gameHostStore.saveSettings()"
        />
        <Button
          variant="secondary"
          :label="t('settings.pages.modules.gaming-minecraft.recheck')"
          :disabled="busy"
          @click="gameHostStore.refresh()"
        />
      </div>

      <div v-if="saveState === 'saved'" :class="['text-sm', 'text-green-600', 'dark:text-green-400']">
        {{ t('settings.pages.modules.gaming-minecraft.save-saved') }}
      </div>
      <div v-else-if="saveState === 'error'" :class="['text-sm', 'text-red-500']">
        {{ t('settings.pages.modules.gaming-minecraft.save-failed', { reason: saveError }) }}
      </div>

      <div :class="['h-px', 'bg-neutral-200', 'dark:bg-neutral-800']" />

      <Callout :theme="statusTheme" :label="statusLabel">
        <div :class="['flex flex-col gap-2 text-sm']">
          <div v-if="status.phase === 'error'">
            {{ status.error }}
          </div>
          <div v-else-if="status.phase === 'connected' && identityRows.length === 0">
            {{ t('settings.pages.modules.gaming-minecraft.status.identity-pending') }}
          </div>
          <div v-else-if="status.phase === 'unconfigured'">
            {{ t('settings.pages.modules.gaming-minecraft.status.unconfigured-hint') }}
          </div>
          <div v-else-if="status.phase === 'connecting'">
            {{ t('settings.pages.modules.gaming-minecraft.status.connecting-hint') }}
          </div>
        </div>
      </Callout>

      <div v-if="identityRows.length > 0" :class="['grid gap-3 text-sm text-neutral-600 dark:text-neutral-300', 'sm:grid-cols-2']">
        <div v-for="row in identityRows" :key="row.key">
          <div :class="['text-xs uppercase tracking-wide text-neutral-500 dark:text-neutral-400']">
            {{ t(`settings.pages.modules.gaming-minecraft.identity.${row.key}`) }}
          </div>
          <div :class="['break-all']">
            {{ row.value }}
          </div>
        </div>
      </div>
    </template>
  </div>
</template>
