<script setup lang="ts">
import type {
  PluginHostSessionSummary,
  PluginManifestSummary,
  PluginPermissionDeclaration,
  PluginPermissionEntry,
} from '@proj-airi/stage-ui/stores/devtools/plugin-host-debug'

import { errorMessageFrom } from '@moeru/std'
import { Section } from '@proj-airi/stage-ui/components'
import { usePluginHostInspectorStore } from '@proj-airi/stage-ui/stores/devtools/plugin-host-debug'
import { Button, Callout, GhostButton, Input } from '@proj-airi/ui'
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { toast } from 'vue-sonner'

declare global {
  interface Window {
    /** CP-2 acceptance probe: approve/revoke permissions from a CDP session. */
    __AIRI_PERMISSIONS_SMOKE__?: {
      refresh: () => Promise<PluginPermissionEntry[]>
      list: () => PluginPermissionEntry[]
      approve: (extensionId: string, grant?: PluginPermissionDeclaration) => Promise<PluginPermissionEntry[]>
      revoke: (extensionId: string) => Promise<PluginPermissionEntry[]>
    }
    /** CP-2 acceptance probe: drive worker isolation loads from CDP. */
    __AIRI_PLUGIN_SMOKE__?: {
      registry: () => PluginManifestSummary[]
      load: (extensionId: string) => Promise<unknown>
      loadInWorker: (extensionId: string) => Promise<unknown>
      unload: (extensionId: string) => Promise<unknown>
    }
  }
}

const store = usePluginHostInspectorStore()
const filter = ref('')
const selectedExtensionId = ref('')

const discoveredPlugins = computed(() => {
  const query = filter.value.trim().toLowerCase()
  const plugins = store.discoveredPlugins.slice().sort((left, right) => left.extensionId.localeCompare(right.extensionId))
  if (!query)
    return plugins
  return plugins.filter(plugin =>
    plugin.extensionId.toLowerCase().includes(query)
    || plugin.path.toLowerCase().includes(query),
  )
})

const enabledPlugins = computed(() => {
  return discoveredPlugins.value.filter(plugin => plugin.enabled)
})

const loadedPlugins = computed(() => {
  return discoveredPlugins.value.filter(plugin => plugin.loaded)
})

const sessionByExtensionId = computed(() => {
  const map = new Map<string, PluginHostSessionSummary>()
  for (const session of store.sessions) {
    map.set(session.extensionId, session)
  }
  return map
})

const readyCapabilitiesCount = computed(() => {
  return store.capabilities.filter(capability => capability.state === 'ready').length
})

function chipClasses(theme: 'neutral' | 'emerald' | 'amber') {
  if (theme === 'emerald') {
    return [
      'bg-emerald-100',
      'text-emerald-700',
      'dark:bg-emerald-900/50',
      'dark:text-emerald-300',
      'border-emerald-300',
      'dark:border-emerald-700',
    ]
  }

  if (theme === 'amber') {
    return [
      'bg-amber-100',
      'text-amber-700',
      'dark:bg-amber-900/50',
      'dark:text-amber-300',
      'border-amber-300',
      'dark:border-amber-700',
    ]
  }

  return [
    'bg-neutral-100',
    'text-neutral-700',
    'dark:bg-neutral-800',
    'dark:text-neutral-300',
    'border-neutral-300',
    'dark:border-neutral-700',
  ]
}

function phaseChipTheme(phase: string) {
  if (phase === 'ready')
    return 'emerald'
  if (phase === 'failed')
    return 'amber'
  if (phase === 'loading' || phase === 'authenticating' || phase === 'preparing')
    return 'amber'
  return 'neutral'
}

async function refresh() {
  try {
    await store.refreshAll()
  }
  catch (error) {
    toast.error(errorMessageFrom(error) ?? 'Failed to refresh plugin host debug state.')
  }
}

async function loadEnabled() {
  try {
    await store.loadEnabled()
  }
  catch (error) {
    toast.error(errorMessageFrom(error) ?? 'Failed to load enabled plugins.')
  }
}

async function setAutoReload(plugin: PluginManifestSummary, enabled: boolean) {
  try {
    await store.setAutoReload({
      extensionId: plugin.extensionId,
      enabled,
    })
  }
  catch (error) {
    toast.error(errorMessageFrom(error) ?? `Failed to update auto-reload state for ${plugin.extensionId}.`)
  }
}

async function setEnabled(plugin: PluginManifestSummary, enabled: boolean) {
  try {
    await store.setEnabled({
      extensionId: plugin.extensionId,
      enabled,
      path: plugin.path,
    })
  }
  catch (error) {
    toast.error(errorMessageFrom(error) ?? `Failed to update enabled state for ${plugin.extensionId}.`)
  }
}

async function loadPlugin(plugin: PluginManifestSummary) {
  try {
    await store.load({ extensionId: plugin.extensionId })
  }
  catch (error) {
    toast.error(errorMessageFrom(error) ?? `Failed to load plugin ${plugin.extensionId}.`)
  }
}

async function loadPluginInWorker(plugin: PluginManifestSummary) {
  try {
    await store.loadInWorker({ extensionId: plugin.extensionId })
  }
  catch (error) {
    toast.error(errorMessageFrom(error) ?? `Failed to load plugin ${plugin.extensionId} in a worker.`)
  }
}

async function unloadPlugin(plugin: PluginManifestSummary) {
  try {
    await store.unload({ extensionId: plugin.extensionId })
  }
  catch (error) {
    toast.error(errorMessageFrom(error) ?? `Failed to unload plugin ${plugin.extensionId}.`)
  }
}

async function loadSelectedPlugin() {
  const extensionId = selectedExtensionId.value.trim()
  if (!extensionId) {
    toast.error('Enter an extension id to load.')
    return
  }

  try {
    await store.load({ extensionId })
  }
  catch (error) {
    toast.error(errorMessageFrom(error) ?? `Failed to load plugin ${extensionId}.`)
  }
}

onMounted(async () => {
  window.__AIRI_PERMISSIONS_SMOKE__ = {
    refresh: () => store.refreshPermissions(),
    list: () => store.permissions,
    approve: (extensionId, grant) => store.approvePermission({ extensionId, ...(grant ? { grant } : {}) }),
    revoke: extensionId => store.revokePermission({ extensionId }),
  }
  window.__AIRI_PLUGIN_SMOKE__ = {
    registry: () => store.discoveredPlugins,
    load: extensionId => store.load({ extensionId }),
    loadInWorker: extensionId => store.loadInWorker({ extensionId }),
    unload: extensionId => store.unload({ extensionId }),
  }
  await refresh()
})

onUnmounted(() => {
  delete window.__AIRI_PERMISSIONS_SMOKE__
  delete window.__AIRI_PLUGIN_SMOKE__
})

const permissionEntries = computed(() => store.permissions)

const PERMISSION_AREAS = ['apis', 'resources', 'capabilities', 'processors', 'pipelines'] as const

function permissionScopeLines(declaration: PluginPermissionDeclaration | undefined): string[] {
  if (!declaration)
    return []
  return PERMISSION_AREAS.flatMap(area =>
    (declaration[area] ?? []).map(spec => `${area} · ${spec.key} [${spec.actions.join(', ')}]`),
  )
}

async function refreshPermissions() {
  try {
    await store.refreshPermissions()
  }
  catch (error) {
    toast.error(errorMessageFrom(error) ?? 'Failed to refresh extension permissions.')
  }
}

async function approvePermission(entry: PluginPermissionEntry) {
  try {
    await store.approvePermission({ extensionId: entry.extensionId })
  }
  catch (error) {
    toast.error(errorMessageFrom(error) ?? `Failed to approve permissions for ${entry.extensionId}.`)
  }
}

async function revokePermission(entry: PluginPermissionEntry) {
  try {
    await store.revokePermission({ extensionId: entry.extensionId })
  }
  catch (error) {
    toast.error(errorMessageFrom(error) ?? `Failed to revoke permissions for ${entry.extensionId}.`)
  }
}
</script>

<template>
  <div :class="['h-full', 'flex', 'flex-col', 'gap-4', 'overflow-y-auto', 'p-4']">
    <Callout
      v-if="!store.isAvailable"
      theme="orange"
      label="Plugin host debug is unavailable in this runtime."
      description="Open this page from Stage Tamagotchi renderer to use Electron plugin host controls."
    />

    <Callout
      v-if="store.error"
      theme="orange"
      label="Last Error"
      :description="store.error"
    />

    <div :class="['grid', 'gap-2', 'sm:grid-cols-2', 'xl:grid-cols-6']">
      <div :class="['rounded-xl', 'bg-neutral-100', 'p-3', 'dark:bg-neutral-900/70']">
        <div :class="['text-xs', 'uppercase', 'opacity-70']">
          Discovered
        </div>
        <div :class="['text-2xl', 'font-semibold']">
          {{ store.discoveredPlugins.length }}
        </div>
      </div>
      <div :class="['rounded-xl', 'bg-neutral-100', 'p-3', 'dark:bg-neutral-900/70']">
        <div :class="['text-xs', 'uppercase', 'opacity-70']">
          Enabled
        </div>
        <div :class="['text-2xl', 'font-semibold']">
          {{ store.enabledPlugins.length }}
        </div>
      </div>
      <div :class="['rounded-xl', 'bg-neutral-100', 'p-3', 'dark:bg-neutral-900/70']">
        <div :class="['text-xs', 'uppercase', 'opacity-70']">
          Loaded
        </div>
        <div :class="['text-2xl', 'font-semibold']">
          {{ store.loadedPlugins.length }}
        </div>
      </div>
      <div :class="['rounded-xl', 'bg-neutral-100', 'p-3', 'dark:bg-neutral-900/70']">
        <div :class="['text-xs', 'uppercase', 'opacity-70']">
          Capabilities
        </div>
        <div :class="['text-2xl', 'font-semibold']">
          {{ readyCapabilitiesCount }} / {{ store.capabilities.length }}
        </div>
      </div>
      <div :class="['rounded-xl', 'bg-neutral-100', 'p-3', 'dark:bg-neutral-900/70']">
        <div :class="['text-xs', 'uppercase', 'opacity-70']">
          Kits
        </div>
        <div :class="['text-2xl', 'font-semibold']">
          {{ store.kits.length }}
        </div>
      </div>
    </div>

    <div :class="['flex', 'flex-wrap', 'items-center', 'gap-2']">
      <Input
        v-model="filter"
        placeholder="Filter discovered plugins..."
        class="max-w-[440px] min-w-[280px]"
      />
      <Button
        label="Refresh"
        icon="i-solar:refresh-bold-duotone"
        size="sm"
        :loading="store.loading"
        @click="refresh"
      />
      <Button
        label="Load Enabled"
        icon="i-solar:play-bold-duotone"
        size="sm"
        :loading="store.loading"
        @click="loadEnabled"
      />
    </div>

    <div :class="['flex', 'flex-wrap', 'items-center', 'gap-2']">
      <Input
        v-model="selectedExtensionId"
        placeholder="Load discovered extension by exact id..."
        class="max-w-[520px] min-w-[320px]"
      />
      <Button
        label="Load Plugin"
        icon="i-solar:download-minimalistic-bold-duotone"
        size="sm"
        :disabled="!selectedExtensionId.trim()"
        :loading="store.loading"
        @click="loadSelectedPlugin"
      />
    </div>

    <Section
      title="Extension Permissions"
      icon="i-solar:shield-check-bold-duotone"
      inner-class="gap-3"
    >
      <div :class="['flex', 'flex-wrap', 'items-center', 'gap-2']">
        <Button
          label="Refresh Permissions"
          icon="i-solar:refresh-bold-duotone"
          size="sm"
          :loading="store.loading"
          @click="refreshPermissions"
        />
        <span :class="['text-xs', 'opacity-70']">
          Approvals bind to the current manifest bytes; an edited manifest needs re-approval.
        </span>
      </div>

      <div
        v-if="permissionEntries.length === 0"
        :class="['rounded-xl', 'border', 'border-dashed', 'border-neutral-400/50', 'p-4', 'text-sm', 'opacity-70']"
      >
        No discovered extension manifests.
      </div>

      <div v-else :class="['grid', 'gap-3']">
        <div
          v-for="entry in permissionEntries"
          :key="entry.extensionId"
          :class="['rounded-xl', 'border', 'border-neutral-300', 'bg-white/70', 'p-3', 'dark:border-neutral-800', 'dark:bg-neutral-950/60']"
        >
          <div :class="['flex', 'flex-wrap', 'items-center', 'justify-between', 'gap-2']">
            <div :class="['flex', 'flex-wrap', 'items-center', 'gap-2']">
              <div :class="['font-semibold']">
                {{ entry.extensionId }}
              </div>
              <span :class="['text-xs', 'opacity-70']">v{{ entry.version }}</span>
              <span :class="['rounded-full', 'border', 'px-2', 'py-0.5', 'text-xs', ...chipClasses(entry.approved ? 'emerald' : 'neutral')]">
                {{ entry.approved ? 'approved' : 'not approved' }}
              </span>
              <span
                v-if="entry.manifestDigestMatches === false"
                :class="['rounded-full', 'border', 'px-2', 'py-0.5', 'text-xs', ...chipClasses('amber')]"
              >
                manifest changed
              </span>
              <span :class="['rounded-full', 'border', 'px-2', 'py-0.5', 'text-xs', ...chipClasses(entry.loaded ? 'emerald' : 'neutral')]">
                {{ entry.loaded ? 'loaded' : 'not loaded' }}
              </span>
            </div>
            <div :class="['flex', 'flex-wrap', 'items-center', 'gap-2']">
              <Button
                size="sm"
                label="Approve Requested"
                icon="i-solar:check-circle-bold-duotone"
                :loading="store.loading"
                :disabled="permissionScopeLines(entry.requested).length === 0"
                @click="approvePermission(entry)"
              />
              <GhostButton
                size="sm"
                label="Revoke"
                icon="i-solar:close-circle-bold-duotone"
                :disabled="!entry.approved && !entry.manifestDigestMatches"
                :loading="store.loading"
                @click="revokePermission(entry)"
              />
            </div>
          </div>

          <div :class="['mt-2', 'grid', 'gap-1']">
            <div :class="['text-xs', 'uppercase', 'opacity-60']">
              Requested
            </div>
            <div v-if="permissionScopeLines(entry.requested).length === 0" :class="['text-xs', 'opacity-60']">
              (none)
            </div>
            <div
              v-for="line in permissionScopeLines(entry.requested)"
              :key="`requested:${line}`"
              :class="['font-mono', 'text-xs']"
            >
              {{ line }}
            </div>
            <template v-if="entry.approved">
              <div :class="['mt-1', 'text-xs', 'uppercase', 'opacity-60']">
                Approved
              </div>
              <div
                v-for="line in permissionScopeLines(entry.approved.grant)"
                :key="`approved:${line}`"
                :class="['font-mono', 'text-xs']"
              >
                {{ line }}
              </div>
            </template>
          </div>
        </div>
      </div>
    </Section>

    <Section
      title="Discovered Plugins"
      icon="i-solar:list-check-bold-duotone"
      inner-class="gap-3"
    >
      <div
        v-if="discoveredPlugins.length === 0"
        :class="['rounded-xl', 'border', 'border-dashed', 'border-neutral-400/50', 'p-4', 'text-sm', 'opacity-70']"
      >
        No discovered plugin manifests found.
      </div>

      <div v-else :class="['grid', 'gap-3']">
        <div
          v-for="plugin in discoveredPlugins"
          :key="plugin.path"
          :class="['rounded-xl', 'border', 'border-neutral-300', 'bg-white/70', 'p-3', 'dark:border-neutral-800', 'dark:bg-neutral-950/60']"
        >
          <div :class="['flex', 'flex-wrap', 'items-center', 'justify-between', 'gap-2']">
            <div :class="['flex', 'flex-wrap', 'items-center', 'gap-2']">
              <div :class="['font-semibold']">
                {{ plugin.extensionId }}
              </div>
              <span :class="['rounded-full', 'border', 'px-2', 'py-0.5', 'text-xs', ...chipClasses(plugin.enabled ? 'emerald' : 'neutral')]">
                {{ plugin.enabled ? 'enabled' : 'disabled' }}
              </span>
              <span :class="['rounded-full', 'border', 'px-2', 'py-0.5', 'text-xs', ...chipClasses(plugin.autoReload ? 'amber' : 'neutral')]">
                {{ plugin.autoReload ? 'auto reload on' : 'auto reload off' }}
              </span>
              <span :class="['rounded-full', 'border', 'px-2', 'py-0.5', 'text-xs', ...chipClasses(plugin.loaded ? 'emerald' : 'neutral')]">
                {{ plugin.loaded ? 'loaded' : 'not loaded' }}
              </span>
              <span v-if="plugin.isNew" :class="['rounded-full', 'border', 'px-2', 'py-0.5', 'text-xs', ...chipClasses('amber')]">
                new
              </span>
            </div>
            <div :class="['flex', 'flex-wrap', 'items-center', 'gap-2']">
              <Button
                size="sm"

                :label="plugin.autoReload ? 'Auto Reload Off' : 'Auto Reload On'"
                :icon="plugin.autoReload ? 'i-solar:refresh-circle-bold' : 'i-solar:refresh-bold-duotone'"
                :loading="store.loading"
                @click="setAutoReload(plugin, !plugin.autoReload)"
              />
              <Button
                size="sm"

                :label="plugin.enabled ? 'Disable' : 'Enable'"
                :icon="plugin.enabled ? 'i-solar:lock-keyhole-minimalistic-unlocked-bold-duotone' : 'i-solar:lock-keyhole-bold-duotone'"
                :loading="store.loading"
                @click="setEnabled(plugin, !plugin.enabled)"
              />
              <Button
                size="sm"

                label="Load"
                icon="i-solar:play-bold-duotone"
                :disabled="plugin.loaded"
                :loading="store.loading"
                @click="loadPlugin(plugin)"
              />
              <Button
                v-if="plugin.entrypoints.node"
                size="sm"

                label="Load in Worker"
                icon="i-solar:cpu-bolt-bold-duotone"
                :disabled="plugin.loaded"
                :loading="store.loading"
                @click="loadPluginInWorker(plugin)"
              />
              <GhostButton
                size="sm"

                label="Unload"
                icon="i-solar:stop-bold-duotone"
                :disabled="!plugin.loaded"
                :loading="store.loading"
                @click="unloadPlugin(plugin)"
              />
            </div>
          </div>

          <div :class="['mt-2', 'text-xs', 'opacity-70', 'font-mono', 'break-all']">
            {{ plugin.path }}
          </div>
          <div :class="['mt-2', 'text-xs', 'opacity-70']">
            entrypoints: {{ JSON.stringify(plugin.entrypoints) }}
          </div>
          <div
            v-if="sessionByExtensionId.get(plugin.extensionId)"
            :class="['mt-2', 'flex', 'items-center', 'gap-2', 'text-sm']"
          >
            <span>phase:</span>
            <span :class="['rounded-full', 'border', 'px-2', 'py-0.5', 'text-xs', ...chipClasses(phaseChipTheme(sessionByExtensionId.get(plugin.extensionId)!.phase))]">
              {{ sessionByExtensionId.get(plugin.extensionId)!.phase }}
            </span>
            <span :class="['opacity-70', 'font-mono']">{{ sessionByExtensionId.get(plugin.extensionId)!.moduleId }}</span>
          </div>
        </div>
      </div>
    </Section>

    <Section
      title="Enabled Plugins"
      icon="i-solar:check-circle-bold-duotone"
      inner-class="gap-2"
    >
      <div :class="['text-sm', 'opacity-80']">
        {{ enabledPlugins.length }} plugin(s) enabled in registry.
      </div>
      <div :class="['flex', 'flex-wrap', 'gap-2']">
        <span
          v-for="plugin in enabledPlugins"
          :key="`enabled-${plugin.path}`"
          :class="['rounded-full', 'border', 'px-2', 'py-0.5', 'text-xs', ...chipClasses('emerald')]"
        >
          {{ plugin.extensionId }}
        </span>
      </div>
    </Section>

    <Section
      title="Loaded Plugins"
      icon="i-solar:play-circle-bold-duotone"
      inner-class="gap-2"
    >
      <div :class="['text-sm', 'opacity-80']">
        {{ loadedPlugins.length }} plugin(s) currently loaded in host sessions.
      </div>
      <div :class="['grid', 'gap-2']">
        <div
          v-for="plugin in loadedPlugins"
          :key="`loaded-${plugin.path}`"
          :class="['rounded-lg', 'bg-neutral-100', 'p-2', 'dark:bg-neutral-900/70']"
        >
          <div :class="['flex', 'items-center', 'justify-between', 'gap-2']">
            <span :class="['font-semibold']">{{ plugin.extensionId }}</span>
            <span :class="['rounded-full', 'border', 'px-2', 'py-0.5', 'text-xs', ...chipClasses(phaseChipTheme(sessionByExtensionId.get(plugin.extensionId)?.phase ?? 'unknown'))]">
              {{ sessionByExtensionId.get(plugin.extensionId)?.phase ?? 'unknown' }}
            </span>
          </div>
        </div>
      </div>
    </Section>

    <Section
      title="Kits"
      icon="i-solar:box-bold-duotone"
      inner-class="gap-2"
    >
      <div
        v-if="store.kits.length === 0"
        :class="['text-sm', 'opacity-70']"
      >
        No kits registered.
      </div>
      <div v-else :class="['grid', 'gap-2']">
        <div
          v-for="kit in store.kits"
          :key="kit.kitId"
          :class="['rounded-lg', 'border', 'border-neutral-300', 'bg-white/60', 'p-3', 'dark:border-neutral-800', 'dark:bg-neutral-950/60']"
        >
          <div :class="['flex', 'flex-wrap', 'items-center', 'justify-between', 'gap-2']">
            <span :class="['font-mono', 'text-xs', 'sm:text-sm']">{{ kit.kitId }}</span>
            <span :class="['rounded-full', 'border', 'px-2', 'py-0.5', 'text-xs', ...chipClasses('neutral')]">
              v{{ kit.version }}
            </span>
          </div>
          <div :class="['mt-2', 'text-xs', 'opacity-70']">
            runtimes: {{ kit.runtimes.join(', ') || '-' }}
          </div>
          <pre :class="['mt-2', 'overflow-auto', 'rounded-lg', 'bg-neutral-100', 'p-2', 'text-xs', 'dark:bg-neutral-900/70']">{{ JSON.stringify(kit.capabilities, null, 2) }}</pre>
        </div>
      </div>
    </Section>

    <Section
      title="Capabilities"
      icon="i-solar:widget-2-bold-duotone"
      inner-class="gap-2"
    >
      <div
        v-if="store.capabilities.length === 0"
        :class="['text-sm', 'opacity-70']"
      >
        No capabilities announced.
      </div>
      <div v-else :class="['grid', 'gap-2']">
        <div
          v-for="capability in store.capabilities"
          :key="capability.key"
          :class="['rounded-lg', 'border', 'border-neutral-300', 'bg-white/60', 'p-3', 'dark:border-neutral-800', 'dark:bg-neutral-950/60']"
        >
          <div :class="['flex', 'flex-wrap', 'items-center', 'justify-between', 'gap-2']">
            <span :class="['font-mono', 'text-xs', 'sm:text-sm']">{{ capability.key }}</span>
            <span :class="['rounded-full', 'border', 'px-2', 'py-0.5', 'text-xs', ...chipClasses(capability.state === 'ready' ? 'emerald' : 'amber')]">
              {{ capability.state }}
            </span>
          </div>
          <div :class="['mt-2', 'text-xs', 'opacity-70']">
            updated: {{ new Date(capability.updatedAt).toLocaleString() }}
          </div>
          <pre :class="['mt-2', 'overflow-auto', 'rounded-lg', 'bg-neutral-100', 'p-2', 'text-xs', 'dark:bg-neutral-900/70']">{{ JSON.stringify(capability.metadata ?? {}, null, 2) }}</pre>
        </div>
      </div>
    </Section>
  </div>
</template>

<route lang="yaml">
meta:
  layout: settings
  title: Plugin Host Debug
  subtitleKey: tamagotchi.settings.devtools.title
</route>
