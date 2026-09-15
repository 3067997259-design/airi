import { errorMessageFrom } from '@moeru/std'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

/**
 * Game-host bridge settings port (MCPFabric, MC-0a/MC-0c).
 *
 * The actual bridge lives in the Electron main process; this store is the
 * renderer-side injection port for any window (stage, settings, ...). The app
 * shell installs the bridge client once per renderer process, and pages only
 * consume `useGameHostStore`. Web builds never install a client, so the
 * settings surface reports the desktop-only state instead of failing.
 */

/** MC-3 movement planner selection exposed by the settings surface. */
export type GameHostMovementPlanner = 'terrain' | 'legacy'

/** MC-3c X-10: MC chat trigger policy mirrored from the app shell contract. */
export interface GameHostChatCommandConfig {
  enabled: boolean
  admins: string[]
  blocked: string[]
  mentionlessSampleRate: number
  contextLines: number
}

/** Loopback bridge endpoint the settings surface edits. */
export interface GameHostBridgeConfig {
  url: string
  /** Omit to keep the stored token; an empty string clears it. */
  token?: string
  /** Optional dedicated-server bridge endpoint; an empty string clears it. */
  serverUrl?: string
  movement?: { planner: GameHostMovementPlanner }
  /** MC-3c X-10: chat triggers; omitted means "leave the stored policy". */
  chatCommands?: GameHostChatCommandConfig
  allowedTools: string[]
}

/** World identity the bridge reports after a successful connect. */
export interface GameHostBridgeIdentity {
  minecraftVersion: string
  worldId: string
  dimension: string
  playerUuid: string
}

export interface GameHostBridgeStatus {
  phase: 'unconfigured' | 'connecting' | 'connected' | 'error'
  error?: string
  identity?: GameHostBridgeIdentity
}

export interface GameHostBridgeConfigView {
  url: string
  hasToken: boolean
  serverUrl?: string
  allowedTools: string[]
  movement?: { planner: GameHostMovementPlanner }
  chatCommands?: GameHostChatCommandConfig
}

/** Structural mirror of the app shell's game-host client. */
export interface GameHostBridgeClientPort {
  getStatus: () => Promise<GameHostBridgeStatus>
  getConfig: () => Promise<GameHostBridgeConfigView>
  applyConfig: (config: GameHostBridgeConfig) => Promise<GameHostBridgeStatus>
}

/** Read whitelist MC-0a exposes by default; the bridge may never call more. */
const DEFAULT_ALLOWED_TOOLS = ['get_status', 'get_self', 'get_inventory', 'get_blocks_region']

let client: GameHostBridgeClientPort | undefined

/** Registers the main-process bridge client for this renderer. */
export function installGameHostBridgeClient(next: GameHostBridgeClientPort): void {
  client = next
}

/** True when this renderer can reach the main-process game-host bridge. */
export function hasGameHostBridgeClient(): boolean {
  return client !== undefined
}

export const useGameHostStore = defineStore('game-host', () => {
  const status = ref<GameHostBridgeStatus>({ phase: 'unconfigured' })
  const config = ref<GameHostBridgeConfigView>({ url: '', hasToken: false, allowedTools: [...DEFAULT_ALLOWED_TOOLS] })

  const url = ref('')
  const token = ref('')
  const serverUrl = ref('')
  const planner = ref<GameHostMovementPlanner>('terrain')
  const chatEnabled = ref(false)
  const chatAdminsText = ref('')
  const chatBlockedText = ref('')
  const chatSampleRate = ref(0.2)
  const chatContextLines = ref(5)
  const allowedToolsText = ref(DEFAULT_ALLOWED_TOOLS.join('\n'))

  const busy = ref(false)
  const saveState = ref<'idle' | 'saved' | 'error'>('idle')
  const saveError = ref('')

  let loaded = false

  const bridgeAvailable = computed(() => hasGameHostBridgeClient())
  /** Module-list dot: the bridge answered as connected. */
  const configured = computed(() => status.value.phase === 'connected')

  function parseAllowedTools(): string[] {
    const entries = allowedToolsText.value
      .split(/[\n,]/)
      .map(entry => entry.trim())
      .filter(entry => entry.length > 0)

    return [...new Set(entries)]
  }

  function parseNameList(text: string): string[] {
    const entries = text
      .split(/[\n,]/)
      .map(entry => entry.trim())
      .filter(entry => entry.length > 0)

    return [...new Set(entries)]
  }

  function clampNumber(value: number, min: number, max: number, fallback: number): number {
    return Number.isFinite(value) ? Math.min(Math.max(value, min), max) : fallback
  }

  async function refresh() {
    if (!client)
      return

    const [nextStatus, nextConfig] = await Promise.all([client.getStatus(), client.getConfig()])
    status.value = nextStatus
    config.value = nextConfig
    url.value = nextConfig.url
    serverUrl.value = nextConfig.serverUrl ?? ''
    planner.value = nextConfig.movement?.planner ?? 'terrain'
    chatEnabled.value = nextConfig.chatCommands?.enabled ?? false
    chatAdminsText.value = (nextConfig.chatCommands?.admins ?? []).join('\n')
    chatBlockedText.value = (nextConfig.chatCommands?.blocked ?? []).join('\n')
    chatSampleRate.value = nextConfig.chatCommands?.mentionlessSampleRate ?? 0.2
    chatContextLines.value = nextConfig.chatCommands?.contextLines ?? 5
    allowedToolsText.value = (nextConfig.allowedTools.length > 0 ? nextConfig.allowedTools : DEFAULT_ALLOWED_TOOLS).join('\n')
    // The token draft stays empty: blank keeps the stored token.
    token.value = ''
    loaded = true
  }

  /** Loads the bridge state once; safe to call from list and page setup. */
  async function ensureLoaded() {
    if (loaded || !client)
      return

    await refresh()
  }

  async function saveSettings() {
    if (!client)
      return

    busy.value = true
    saveState.value = 'idle'
    saveError.value = ''

    try {
      status.value = await client.applyConfig({
        url: url.value.trim(),
        ...(token.value.trim() ? { token: token.value.trim() } : {}),
        serverUrl: serverUrl.value.trim(),
        movement: { planner: planner.value },
        chatCommands: {
          enabled: chatEnabled.value,
          admins: parseNameList(chatAdminsText.value),
          blocked: parseNameList(chatBlockedText.value),
          mentionlessSampleRate: clampNumber(chatSampleRate.value, 0, 1, 0.2),
          contextLines: Math.round(clampNumber(chatContextLines.value, 0, 20, 5)),
        },
        allowedTools: parseAllowedTools(),
      })

      config.value = await client.getConfig()
      url.value = config.value.url
      if (config.value.allowedTools.length > 0)
        allowedToolsText.value = config.value.allowedTools.join('\n')
      token.value = ''

      if (status.value.phase === 'error') {
        saveState.value = 'error'
        saveError.value = status.value.error ?? ''
      }
      else {
        saveState.value = 'saved'
      }

      loaded = true
    }
    catch (error) {
      saveState.value = 'error'
      saveError.value = errorMessageFrom(error) ?? 'Failed to save the bridge settings'
    }
    finally {
      busy.value = false
    }
  }

  /** Disconnects and clears the stored bridge config (data maintenance reset). */
  async function resetState() {
    url.value = ''
    token.value = ''
    serverUrl.value = ''
    planner.value = 'terrain'
    chatEnabled.value = false
    chatAdminsText.value = ''
    chatBlockedText.value = ''
    chatSampleRate.value = 0.2
    chatContextLines.value = 5
    allowedToolsText.value = DEFAULT_ALLOWED_TOOLS.join('\n')
    saveState.value = 'idle'
    saveError.value = ''

    if (!client) {
      status.value = { phase: 'unconfigured' }
      config.value = { url: '', hasToken: false, allowedTools: [...DEFAULT_ALLOWED_TOOLS] }
      loaded = true
      return
    }

    try {
      status.value = await client.applyConfig({ url: '', allowedTools: [...DEFAULT_ALLOWED_TOOLS] })
      config.value = await client.getConfig()
      loaded = true
    }
    catch (error) {
      saveState.value = 'error'
      saveError.value = errorMessageFrom(error) ?? 'Failed to reset the bridge settings'
    }
  }

  return {
    status,
    config,
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
    busy,
    saveState,
    saveError,
    bridgeAvailable,
    configured,

    ensureLoaded,
    refresh,
    saveSettings,
    resetState,
  }
})
