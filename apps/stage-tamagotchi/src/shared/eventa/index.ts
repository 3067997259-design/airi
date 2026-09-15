import type { Locale } from '@intlify/core'
import type { WorkspaceGrepQuery, WorkspaceGrepResult } from '@proj-airi/coding-harness/tools/grep'
import type { CommandJobSnapshot } from '@proj-airi/coding-harness/tools/jobs'
import type { WorkspaceShell, WorkspaceShellKind } from '@proj-airi/coding-harness/tools/shell'
import type { MemoryEmbeddingMetadata, MemoryEmbeddingQueryMetadata, MemoryScope, MemorySourceContext } from '@proj-airi/memory-core'
import type {
  GameletIframeRequestPayload as GameletIframeInvokePayload,
  GameletIframeResponsePayload,
} from '@proj-airi/plugin-sdk-tamagotchi/gamelet'
import type { ServerOptions } from '@proj-airi/server-runtime/server'
import type {
  ShortcutAccelerator,
  ShortcutBinding,
  ShortcutRegistrationResult,
} from '@proj-airi/stage-shared/global-shortcut'
import type {
  StageViewErrorPayload,
  StageViewPatch,
  StageViewRequestAckPayload,
  StageViewSnapshotPayload,
} from '@proj-airi/stage-shared/godot-stage'
import type { ServerChannelQrPayload } from '@proj-airi/stage-shared/server-channel-qr'
import type {
  ThreeHitTestReadTracePayload,
  ThreeSceneRenderInfoTracePayload,
  VrmDisposeEndTracePayload,
  VrmDisposeStartTracePayload,
  VrmLoadEndTracePayload,
  VrmLoadErrorTracePayload,
  VrmLoadStartTracePayload,
  VrmUpdateFrameTracePayload,
} from '@proj-airi/stage-ui-three/trace'
import type { Rectangle } from 'electron'

import { defineEventa, defineInvokeEventa } from '@moeru/eventa'

export const electronStartTrackMousePosition = defineInvokeEventa('eventa:invoke:electron:start-tracking-mouse-position')
export const electronStartDraggingWindow = defineInvokeEventa('eventa:invoke:electron:start-dragging-window')

export const electronOpenMainDevtools = defineInvokeEventa('eventa:invoke:electron:windows:main:devtools:open')
export const electronCenterMainWindow = defineInvokeEventa<Rectangle>('eventa:invoke:electron:windows:main:center')
export const electronOpenEditor = defineInvokeEventa<void>('eventa:invoke:electron:windows:editor:open')
export const electronOpenSettings = defineInvokeEventa<void, { route?: string }>('eventa:invoke:electron:windows:settings:open')
export const electronSettingsNavigate = defineEventa<{ route: string }>('eventa:event:electron:windows:settings:navigate')
export const electronOpenChat = defineInvokeEventa('eventa:invoke:electron:windows:chat:open')
export const electronSpotlightHide = defineInvokeEventa<void>('eventa:invoke:electron:windows:spotlight:hide')
export const electronSpotlightShowResultNotification = defineInvokeEventa<void, { body: string }>('eventa:invoke:electron:windows:spotlight:show-result-notification')
export const electronSpotlightShortcutGet = defineInvokeEventa<ShortcutAccelerator>('eventa:invoke:electron:windows:spotlight:shortcut:get')
export const electronSpotlightShortcutSet = defineInvokeEventa<ShortcutRegistrationResult, { accelerator: ShortcutAccelerator | null }>('eventa:invoke:electron:windows:spotlight:shortcut:set')
export const electronOpenSettingsDevtools = defineInvokeEventa('eventa:invoke:electron:windows:settings:devtools:open')
export const electronOpenDevtoolsWindow = defineInvokeEventa<void, { key: string, route?: string, width?: number, height?: number, x?: number, y?: number }>('eventa:invoke:electron:windows:devtools:open')

export interface ElectronServerChannelConfig {
  tlsConfig?: ServerOptions['tlsConfig'] | null
  authToken: string
  hostname: string
  /**
   * Resolved listen port of the server channel. The renderer must build its
   *  client URL from this instead of a baked-in constant: the port moves when
   *  SERVER_CHANNEL_PORT is set, and a stale baked value then points at a
   *  port nobody listens on.
   */
  port?: number
}
export const electronGetServerChannelConfig = defineInvokeEventa<ElectronServerChannelConfig>('eventa:invoke:electron:server-channel:get-config')

export * from './data-backup'
export * from './game-host'
export * from './mc2'
export * from './packages'
export * from './permissions'
export const electronApplyServerChannelConfig = defineInvokeEventa<ElectronServerChannelConfig, Partial<ElectronServerChannelConfig>>('eventa:invoke:electron:server-channel:apply-config')
export const electronGetServerChannelQrPayload = defineInvokeEventa<ServerChannelQrPayload>('eventa:invoke:electron:server-channel:get-qr-payload')

export type ElectronUpdaterChannel = 'latest' | 'stable' | 'alpha' | 'beta' | 'nightly' | 'canary'

export interface ElectronUpdaterPreferences {
  channel?: ElectronUpdaterChannel
}

export const electronGetUpdaterPreferences = defineInvokeEventa<ElectronUpdaterPreferences>('eventa:invoke:electron:auto-updater:get-preferences')
export const electronSetUpdaterPreferences = defineInvokeEventa<ElectronUpdaterPreferences, ElectronUpdaterPreferences>('eventa:invoke:electron:auto-updater:set-preferences')

export * from './plugin/assets'
export * from './plugin/capabilities'
export * from './plugin/host'
export * from './plugin/tools'

export interface DesktopOverlayReadiness {
  state: 'booting' | 'ready' | 'degraded'
  error?: string
}

export const getDesktopOverlayReadinessContract = defineInvokeEventa<DesktopOverlayReadiness>('eventa:invoke:electron:windows:desktop-overlay:get-readiness')

export const captionIsFollowingWindowChanged = defineEventa<boolean>('eventa:event:electron:windows:caption-overlay:is-following-window-changed')
export const captionGetIsFollowingWindow = defineInvokeEventa<boolean>('eventa:invoke:electron:windows:caption-overlay:get-is-following-window')

export type RequestWindowActionDefault = 'confirm' | 'cancel' | 'close'
export interface RequestWindowPayload {
  id?: string
  route: string
  type?: string
  payload?: Record<string, any>
}
export interface RequestWindowPending {
  id: string
  type?: string
  payload?: Record<string, any>
}

// Reference window helpers are generic; callers can alias for clarity
export type NoticeAction = 'confirm' | 'cancel' | 'close'

export function createRequestWindowEventa(namespace: string) {
  const prefix = (name: string) => `eventa:${name}:electron:windows:${namespace}`
  return {
    openWindow: defineInvokeEventa<boolean, RequestWindowPayload>(prefix('invoke:open')),
    windowAction: defineInvokeEventa<void, { id: string, action: RequestWindowActionDefault }>(prefix('invoke:action')),
    pageMounted: defineInvokeEventa<RequestWindowPending | undefined, { id?: string }>(prefix('invoke:page-mounted')),
    pageUnmounted: defineInvokeEventa<void, { id?: string }>(prefix('invoke:page-unmounted')),
  }
}

// Notice window events built from generic factory
export const noticeWindowEventa = createRequestWindowEventa('notice')

// Widgets / Adhoc window events
export interface WidgetWindowSize {
  width?: number
  height?: number
  minWidth?: number
  minHeight?: number
  maxWidth?: number
  maxHeight?: number
}

export type WidgetGridSize = 's' | 'm' | 'l' | { cols?: number, rows?: number }

export interface WidgetsAddPayload {
  id?: string
  componentName: string
  componentProps?: Record<string, any>
  alwaysOnTop?: boolean
  // size presets or explicit spans; renderer decides mapping
  size?: WidgetGridSize
  windowSize?: WidgetWindowSize | Record<string, unknown>
  // auto-dismiss in ms; if omitted, persistent until closed by user
  ttlMs?: number
}

export interface WidgetsUpdatePayload {
  id: string
  componentProps?: Record<string, any>
  alwaysOnTop?: boolean
  size?: WidgetGridSize
  windowSize?: WidgetWindowSize | Record<string, unknown>
  ttlMs?: number
}

export interface WidgetSnapshot {
  id: string
  componentName: string
  componentProps: Record<string, any>
  alwaysOnTop: boolean
  size: WidgetGridSize
  windowSize?: WidgetWindowSize
  ttlMs: number
}

/**
 * Request relayed from Electron main to one mounted widget iframe through the widgets renderer.
 */
export interface WidgetsIframeRequestPayload {
  /** Widget id that identifies the mounted iframe target. */
  id: string
  /** Relay correlation id echoed by the renderer-to-main result event. */
  requestId: string
  /** Structured-clone-safe request record forwarded into the iframe Eventa runtime. */
  payload: GameletIframeInvokePayload['payload']
  /** Request timeout budget in milliseconds. */
  timeoutMs: number
}

/**
 * Shared fields for a renderer-to-main iframe request result.
 */
export interface WidgetsIframeRequestResultBasePayload {
  /** Widget id that produced the result. */
  id: string
  /** Relay correlation id matching the original main-to-renderer request. */
  requestId: string
}

/**
 * Successful renderer-to-main iframe request result.
 */
export interface WidgetsIframeRequestSuccessPayload extends WidgetsIframeRequestResultBasePayload {
  /** Marks this result as a successful iframe response. */
  ok: true
  /** Structured-clone-safe response record returned by the iframe Eventa runtime. */
  result: GameletIframeResponsePayload
}

/**
 * Failed renderer-to-main iframe request result.
 */
export interface WidgetsIframeRequestFailurePayload extends WidgetsIframeRequestResultBasePayload {
  /** Marks this result as a failed iframe response. */
  ok: false
  /** Error message returned when the iframe request fails. */
  error: string
}

/**
 * Result relayed from the widgets renderer back to Electron main for one iframe request.
 */
export type WidgetsIframeRequestResultPayload
  = | WidgetsIframeRequestSuccessPayload
    | WidgetsIframeRequestFailurePayload

export interface PluginManifestSummary {
  extensionId: string
  entrypoints: Record<string, string | undefined>
  path: string
  enabled: boolean
  loaded: boolean
  isNew: boolean
}

export interface PluginRegistrySnapshot {
  root: string
  plugins: PluginManifestSummary[]
}

// TODO: Replace these manually duplicated IPC types with re-exports from
// @proj-airi/plugin-sdk (CapabilityDescriptor) once stage-ui and the shared
// eventa layer can depend on the SDK without introducing unwanted coupling.
export interface PluginCapabilityPayload {
  key: string
  state: 'announced' | 'ready' | 'degraded' | 'withdrawn'
  metadata?: Record<string, unknown>
}

export interface PluginCapabilityState {
  key: string
  state: 'announced' | 'ready' | 'degraded' | 'withdrawn'
  metadata?: Record<string, unknown>
  updatedAt: number
}

export interface PluginHostSessionSummary {
  id: string
  extensionId: string
  phase: string
  runtime: 'electron' | 'node' | 'web'
  moduleId: string
}

export interface PluginHostDebugSnapshot {
  registry: PluginRegistrySnapshot
  sessions: PluginHostSessionSummary[]
  capabilities: PluginCapabilityState[]
  refreshedAt: number
}

/** One MCP server entry: stdio child, or a remote HTTP/SSE endpoint. */
export type ElectronMcpServerConfig
  = | { kind: 'stdio', command: string, args?: string[], env?: Record<string, string>, cwd?: string }
    | { kind: 'streamable-http', url: string, headers?: Record<string, string> }
    | { kind: 'sse', url: string, headers?: Record<string, string> }

/** Common optional fields shared by every transport. */
export interface ElectronMcpServerCommon {
  enabled?: boolean
  /** Maximum idle time for one request. Progress notifications reset this timer. */
  requestTimeoutMs?: number
  /** Maximum wall-clock time for one request, including progress notifications. */
  maxTotalTimeoutMs?: number
}

export interface ElectronMcpConfigFile {
  mcpServers: Record<string, ElectronMcpServerConfig & ElectronMcpServerCommon>
}

export interface ElectronMcpStdioApplyResult {
  path: string
  started: Array<{ name: string }>
  failed: Array<{ name: string, error: string }>
  skipped: Array<{ name: string, reason: string }>
}

export interface ElectronMcpStdioServerRuntimeStatus {
  name: string
  state: 'starting' | 'running' | 'reconnecting' | 'error' | 'stopped'
  command: string
  args: string[]
  pid: number | null
  lastError?: string
  /** Server-declared usage guidance from the MCP initialize handshake, if any. */
  instructions?: string
}

export interface ElectronMcpStdioRuntimeStatus {
  path: string
  servers: ElectronMcpStdioServerRuntimeStatus[]
  updatedAt: number
}

export interface ElectronMcpToolDescriptor {
  serverName: string
  name: string
  toolName: string
  description?: string
  inputSchema: Record<string, unknown>
}

export interface ElectronMcpCallToolPayload {
  /** Correlation id for one call; the cancel invoke targets exactly this call. */
  requestId: string
  name: string
  arguments?: Record<string, unknown>
}

export interface ElectronMcpCallToolResult {
  content?: Array<Record<string, unknown>>
  structuredContent?: Record<string, unknown>
  toolResult?: unknown
  isError?: boolean
}

export interface ElectronMcpStdioConfigText {
  path: string
  text: string
}

export interface ElectronMcpStdioTestResult {
  ok: boolean
  error?: string
  tools?: string[]
  durationMs: number
}

export interface ElectronMcpStdioTestPayload {
  name: string
  config: ElectronMcpServerConfig & ElectronMcpServerCommon
}

export const electronMcpOpenConfigFile = defineInvokeEventa<{ path: string }>('eventa:invoke:electron:mcp:open-config-file')
export const electronMcpApplyAndRestart = defineInvokeEventa<ElectronMcpStdioApplyResult>('eventa:invoke:electron:mcp:apply-and-restart')
export const electronMcpGetRuntimeStatus = defineInvokeEventa<ElectronMcpStdioRuntimeStatus>('eventa:invoke:electron:mcp:get-runtime-status')
export const electronMcpListTools = defineInvokeEventa<ElectronMcpToolDescriptor[]>('eventa:invoke:electron:mcp:list-tools')
export const electronMcpCallTool = defineInvokeEventa<ElectronMcpCallToolResult, ElectronMcpCallToolPayload>('eventa:invoke:electron:mcp:call-tool')
/** Cancels one in-flight MCP call by correlation id. Idempotent. */
export const electronMcpCancelTool = defineInvokeEventa<{ cancelled: boolean }, { requestId: string }>('eventa:invoke:electron:mcp:cancel-tool')
export const electronMcpReadConfigText = defineInvokeEventa<ElectronMcpStdioConfigText>('eventa:invoke:electron:mcp:read-config-text')
export const electronMcpWriteConfigText = defineInvokeEventa<ElectronMcpStdioConfigText, { text: string }>('eventa:invoke:electron:mcp:write-config-text')
export const electronMcpTestServer = defineInvokeEventa<ElectronMcpStdioTestResult, ElectronMcpStdioTestPayload>('eventa:invoke:electron:mcp:test-server')

export const widgetsOpenWindow = defineInvokeEventa<void, { id?: string }>('eventa:invoke:electron:windows:widgets:open')
export const widgetsHideWindow = defineInvokeEventa<void, { id?: string }>('eventa:invoke:electron:windows:widgets:hide')
export const widgetsAdd = defineInvokeEventa<string | undefined, WidgetsAddPayload>('eventa:invoke:electron:windows:widgets:add')
export const widgetsRemove = defineInvokeEventa<void, { id: string }>('eventa:invoke:electron:windows:widgets:remove')
export const widgetsClear = defineInvokeEventa('eventa:invoke:electron:windows:widgets:clear')
export const widgetsUpdate = defineInvokeEventa<void, WidgetsUpdatePayload>('eventa:invoke:electron:windows:widgets:update')
export const widgetsFetch = defineInvokeEventa<WidgetSnapshot | void, { id: string }>('eventa:invoke:electron:windows:widgets:fetch')
export const widgetsPrepareWindow = defineInvokeEventa<string | undefined, { id?: string }>('eventa:invoke:electron:windows:widgets:prepare')
export const widgetsIframePublish = defineInvokeEventa<void, { id: string, event: Record<string, unknown> }>('eventa:invoke:electron:windows:widgets:iframe-publish')

export const electronWindowClose = defineInvokeEventa<void>('eventa:invoke:electron:window:close')
export type ElectronWindowLifecycleReason
  = | 'initial'
    | 'snapshot'
    | 'show'
    | 'hide'
    | 'minimize'
    | 'restore'
    | 'focus'
    | 'blur'

export interface ElectronWindowLifecycleState {
  focused: boolean
  minimized: boolean
  reason: ElectronWindowLifecycleReason
  updatedAt: number
  visible: boolean
}

export const electronWindowLifecycleChanged = defineEventa<ElectronWindowLifecycleState>('eventa:event:electron:window:lifecycle-changed')
export const electronGetWindowLifecycleState = defineInvokeEventa<ElectronWindowLifecycleState>('eventa:invoke:electron:window:get-lifecycle-state')
export const electronWindowSetAlwaysOnTop = defineInvokeEventa<void, boolean>('eventa:invoke:electron:window:set-always-on-top')
export const electronAppOpenUserDataFolder = defineInvokeEventa<{ path: string }>('eventa:invoke:electron:app:open-user-data-folder')
export const electronAppQuit = defineInvokeEventa<void>('eventa:invoke:electron:app:quit')

export type ElectronGodotStageState = 'stopped' | 'starting' | 'running' | 'stopping' | 'error'

/**
 * Snapshot of the Godot sidecar lifecycle owned by Electron main.
 *
 * Use when:
 * - Renderer windows need to reflect whether the external Godot window is available
 * - Settings or stage pages need lifecycle feedback after start/stop actions
 *
 * Expects:
 * - `pid` is only set while the Godot child process exists
 * - `lastError` is present for the most recent lifecycle or scene-apply failure
 *
 * Returns:
 * - N/A
 */
export interface ElectronGodotStageStatus {
  state: ElectronGodotStageState
  pid: number | null
  lastError?: string
  updatedAt: number
}

/**
 * Serialized scene input payload forwarded from renderer to Electron main.
 *
 * Use when:
 * - The selected model should be materialized to disk and applied to the Godot scene
 *
 * Expects:
 * - `data` contains the full model file bytes
 * - `fileName` matches the original model asset name when available
 *
 * Returns:
 * - N/A
 */
export interface ElectronGodotStageSceneInputPayload {
  modelId: string
  format: 'vrm'
  name: string
  fileName: string
  data: Uint8Array
}

export const electronGodotStageStart = defineInvokeEventa<ElectronGodotStageStatus>('eventa:invoke:electron:godot-stage:start')
export const electronGodotStageStop = defineInvokeEventa<ElectronGodotStageStatus>('eventa:invoke:electron:godot-stage:stop')
export const electronGodotStageGetStatus = defineInvokeEventa<ElectronGodotStageStatus>('eventa:invoke:electron:godot-stage:get-status')
export const electronGodotStageApplySceneInput = defineInvokeEventa<void, ElectronGodotStageSceneInputPayload>('eventa:invoke:electron:godot-stage:apply-scene-input')
export const electronGodotStageGetViewSnapshot = defineInvokeEventa<StageViewSnapshotPayload | null>('eventa:invoke:electron:godot-stage:view-snapshot:get')
export const electronGodotStageApplyViewPatch = defineInvokeEventa<StageViewRequestAckPayload, StageViewPatch>('eventa:invoke:electron:godot-stage:view-state:apply-patch')
export const electronGodotStageRequestViewSnapshot = defineInvokeEventa<StageViewRequestAckPayload>('eventa:invoke:electron:godot-stage:view-state:request-snapshot')
export const electronGodotStageStatusChanged = defineEventa<ElectronGodotStageStatus>('eventa:event:electron:godot-stage:status-changed')
export const electronGodotStageViewSnapshotChanged = defineEventa<StageViewSnapshotPayload>('eventa:event:electron:godot-stage:view-snapshot-changed')
export const electronGodotStageViewStateError = defineEventa<StageViewErrorPayload>('eventa:event:electron:godot-stage:view-state-error')

// Global shortcut ->

/**
 * Phase of a shortcut trigger event.
 *
 * - `down` — key combination pressed
 * - `up`   — key combination released; only emitted by drivers that
 *            accepted a binding with `receiveKeyUps: true`
 */
export type ElectronShortcutTriggerPhase = 'down' | 'up'

/**
 * Payload broadcast to all subscribed windows when a registered shortcut
 * fires. Renderer composables filter by `id` to dispatch local handlers.
 */
export interface ElectronShortcutTriggerPayload {
  id: string
  phase: ElectronShortcutTriggerPhase
}

export const electronShortcutRegister = defineInvokeEventa<ShortcutRegistrationResult, ShortcutBinding>('eventa:invoke:electron:shortcut:register')
export const electronShortcutUnregister = defineInvokeEventa<void, { id: string }>('eventa:invoke:electron:shortcut:unregister')
export const electronShortcutUnregisterAll = defineInvokeEventa<void>('eventa:invoke:electron:shortcut:unregister-all')
export const electronShortcutList = defineInvokeEventa<ShortcutBinding[]>('eventa:invoke:electron:shortcut:list')
export const electronShortcutTriggered = defineEventa<ElectronShortcutTriggerPayload>('eventa:event:electron:shortcut:triggered')

// <- Global shortcut

export type StageThreeRuntimeTraceEnvelope
  = | { type: 'three-render-info', payload: ThreeSceneRenderInfoTracePayload }
    | { type: 'three-hit-test-read', payload: ThreeHitTestReadTracePayload }
    | { type: 'vrm-update-frame', payload: VrmUpdateFrameTracePayload }
    | { type: 'vrm-load-start', payload: VrmLoadStartTracePayload }
    | { type: 'vrm-load-end', payload: VrmLoadEndTracePayload }
    | { type: 'vrm-load-error', payload: VrmLoadErrorTracePayload }
    | { type: 'vrm-dispose-start', payload: VrmDisposeStartTracePayload }
    | { type: 'vrm-dispose-end', payload: VrmDisposeEndTracePayload }

export interface StageThreeRuntimeTraceForwardedPayload {
  envelope: StageThreeRuntimeTraceEnvelope
  origin: string
}

export interface StageThreeRuntimeTraceRemoteControlPayload {
  origin: string
}

export const stageThreeRuntimeTraceForwardedEvent = defineEventa<StageThreeRuntimeTraceForwardedPayload>('eventa:event:stage-three-runtime-trace:forwarded')
export const stageThreeRuntimeTraceRemoteEnableEvent = defineEventa<StageThreeRuntimeTraceRemoteControlPayload>('eventa:event:stage-three-runtime-trace:remote-enable')
export const stageThreeRuntimeTraceRemoteDisableEvent = defineEventa<StageThreeRuntimeTraceRemoteControlPayload>('eventa:event:stage-three-runtime-trace:remote-disable')

// Internal event from main -> widgets renderer when a widget should render
export const widgetsRenderEvent = defineEventa<WidgetSnapshot>('eventa:event:electron:windows:widgets:render')
export const widgetsRemoveEvent = defineEventa<{ id: string }>('eventa:event:electron:windows:widgets:remove')
export const widgetsClearEvent = defineEventa('eventa:event:electron:windows:widgets:clear')
export const widgetsUpdateEvent = defineEventa<WidgetsUpdatePayload>('eventa:event:electron:windows:widgets:update')
/** Main-to-renderer event requesting work from a mounted widget iframe. */
export const widgetsIframeRequestEvent = defineEventa<WidgetsIframeRequestPayload>('eventa:event:electron:windows:widgets:iframe-request')
/** Renderer-to-main event carrying the correlated result for a widget iframe request. */
export const widgetsIframeRequestResultEvent = defineEventa<WidgetsIframeRequestResultPayload>('eventa:event:electron:windows:widgets:iframe-request-result')

// Onboarding window events
export const electronOnboardingClose = defineInvokeEventa('eventa:invoke:electron:windows:onboarding:close')
export const electronOpenOnboarding = defineInvokeEventa('eventa:invoke:electron:windows:onboarding:open')

// Auth — OIDC Authorization Code + PKCE flow via system browser
export interface ElectronAuthTokens {
  accessToken: string
  refreshToken?: string
  idToken?: string
  expiresIn: number
}
export const electronAuthStartLogin = defineInvokeEventa<void>('eventa:invoke:electron:auth:start-login')
export const electronAuthCallback = defineEventa<ElectronAuthTokens>('eventa:event:electron:auth:callback')
export const electronAuthCallbackError = defineEventa<{ error: string }>('eventa:event:electron:auth:callback-error')
export const electronAuthLogout = defineInvokeEventa<void>('eventa:invoke:electron:auth:logout')

export const i18nSetLocale = defineInvokeEventa<void, Locale>('eventa:invoke:electron:i18n:set-locale')
export const i18nGetLocale = defineInvokeEventa<string | undefined>('eventa:invoke:electron:i18n:get-locale')

// ---------------------------------------------------------------------------
// Coding host — Hashline file tools, bash execution and PTC (Code Mode).
// Main process owns the workspace host; renderers invoke through these
// contracts (CODING-HARNESS-DESIGN §2 / §3, WIRING-BACKLOG §2).
// ---------------------------------------------------------------------------

export interface CodingFsReadParams {
  path: string
  /** Refuse a skill read if a workspace switch overtook the request. */
  expectedWorkspaceRoot?: string
}
export interface CodingFsReadResult {
  content: string
  mtime?: string
}
export interface CodingFsListParams {
  path: string
}
export interface CodingFsListEntry {
  name: string
  kind: 'file' | 'dir'
}
export interface CodingFsListResult {
  entries: CodingFsListEntry[]
}
export interface CodingFsWriteParams {
  path: string
  content: string
}
export interface CodingFsWriteResult {
  ok: true
}
export interface CodingFsWriteGuardedParams extends CodingFsWriteParams {
  /** Whole-file hash from read, or null when the file must not exist. */
  baseHash: string | null
}
export type CodingFsWriteGuardedResult
  = | { status: 'written', baseHash: string }
    | { status: 'state_changed', currentHash: string | null }

/** Search request and signed result; owned by the coding harness. */
export type CodingGrepParams = WorkspaceGrepQuery
export type CodingGrepResult = WorkspaceGrepResult

export type CodingBashRiskTier = 'read-only' | 'medium' | 'high'
export interface CodingExecRunParams {
  command: string
  /** Upgrades medium-tier commands to approval-required for this call. */
  mediumApprovalRequired?: boolean
  /** Forces the approval gate for a high-impact tool wrapper. */
  approvalRequired?: boolean
  /** Starts the command as a background job and answers with its id. */
  runInBackground?: boolean
  timeoutMs?: number
}
export interface CodingExecRunResult {
  tier: CodingBashRiskTier
  /** `started` means a background job was created; read it with job output. */
  status: 'ok' | 'error' | 'denied' | 'timeout' | 'started'
  /** Present when `status === 'started'`. */
  jobId?: string
  stdout: string
  stderr: string
  /** Interpreter that ran the command; absent when nothing was executed. */
  shell?: WorkspaceShellKind
  exitCode?: number
  /** Present when `status === 'denied'` so the UI can correlate the card. */
  requestId?: string
  reason?: 'approval_required'
}

export type CodingCodeRunFailureKind = 'parse' | 'runtime' | 'timeout' | 'bridge-limit' | 'bridge' | 'sandbox'
export interface CodingCodeRunFailure {
  kind: CodingCodeRunFailureKind
  message: string
  logs: string[]
  traces: CodingCodeRunTrace[]
}
export interface CodingCodeRunTrace {
  toolName: string
  args: unknown[]
  ok: boolean
  resultSummary: string
}
export type CodingCodeRunResult
  = | { ok: true, value?: unknown, logs: string[], traces: CodingCodeRunTrace[] }
    | { ok: false, failure: CodingCodeRunFailure }
export interface CodingCodeRunParams {
  program: string
  timeoutMs?: number
  /** Bind reviewed skill IO to the workspace where its source was checked. */
  expectedWorkspaceRoot?: string
  /**
   * Game bridge tools the reviewed skill declared (mc-1c D2). Reviewed skills
   * pass the approved list; calls to declaration-requiring tools outside it
   * are rejected inside the sandbox runtime.
   */
  allowedTools?: string[]
  /**
   * Renderer-minted id for `codingHostCodeCancel` (mc-1c D3).
   *
   * Eventa 0.3.0 does not deliver renderer cancellation to handlers, so the
   * cancel path is an explicit second invoke keyed by this id.
   */
  runId?: string
}

export interface CodingToolAvailability {
  name: string
  description: string
  available: boolean
}
/**
 * The interpreter the host spawns for `bash`, as told to the renderer.
 *
 * Renderers build the model-facing `bash` description from this, so the tool
 * declaration and the process that runs commands cannot disagree.
 */
export type CodingShellDescriptor = Pick<WorkspaceShell, 'kind' | 'label' | 'syntax'>

export interface CodingToolsStatusResult {
  workspaceRoot: string
  shell: CodingShellDescriptor
  tools: CodingToolAvailability[]
}

// ---------------------------------------------------------------------------
// Journal persistence — durable JSONL per session (HARNESS-PLAN §9.1).
// ---------------------------------------------------------------------------

export interface JournalAppendParams {
  sessionId: string
  /** One JSONL line per event, already serialized by the renderer. */
  lines: string[]
}
export interface JournalAppendResult {
  appended: number
  /** Lines skipped because their seq was already persisted (receipt-loss retries). */
  skipped: number
}
export interface JournalReadParams {
  sessionId: string
  /** Newest events to return. @default 50000 */
  limit?: number
}
export interface JournalReadResult {
  lines: string[]
  /** Whether older events exist on disk beyond the returned window. */
  truncated: boolean
  /** Highest seq found in the file; -1 when the file is missing or empty. */
  lastSeq: number
  /** Seq values missing between 0 and lastSeq (survivors of a lost write batch). */
  gaps: number[]
  /** Lines that are not valid JSON (counted, never rewritten). */
  corruptLines: number
  /** Lines repeating a seq that was already seen in the file. */
  duplicateLines: number
}
export interface JournalClearParams {
  sessionId: string
}
export interface JournalClearResult {
  cleared: true
}

export const journalHostAppend = defineInvokeEventa<JournalAppendResult, JournalAppendParams>('eventa:invoke:electron:journal-host:append')
export const journalHostRead = defineInvokeEventa<JournalReadResult, JournalReadParams>('eventa:invoke:electron:journal-host:read')
export const journalHostClear = defineInvokeEventa<JournalClearResult, JournalClearParams>('eventa:invoke:electron:journal-host:clear')

export interface CodingJobOutputParams {
  jobId: string
  /** Return only the last N characters of output. */
  tail?: number
}

/** A background job, or the fact that no job carries that id. */
export type CodingJobOutputResult
  = | CommandJobSnapshot
    | { jobId: string, status: 'unknown' }

export interface CodingJobKillParams {
  jobId: string
}

export interface CodingJobKillResult {
  jobId: string
  outcome: 'killed' | 'already-finished' | 'unknown'
}

export interface CodingWorkspaceRootParams {
  /** Absolute directory the workspace tools should operate in. */
  root: string
}

/**
 * Outcome of a root switch.
 *
 * A rejection keeps the previous root running and carries the reason, so the
 * settings page can show why the directory was refused instead of leaving the
 * agent in a tree it cannot write.
 */
export type CodingWorkspaceRootResult
  = | { status: 'switched', workspaceRoot: string }
    | { status: 'rejected', workspaceRoot: string, reason: string }

export interface CodingWorkspaceRootChangedPayload {
  workspaceRoot: string
}

export interface CodingApprovalRequestPayload {
  requestId: string
  /** The command (or plan step) that needs approval. */
  subject: string
  reason: string
  riskLevel: 'high' | 'medium' | 'low'
  expectedEvidence?: string
  /** Set for plan-step approvals so windows can journal the plan linkage. */
  planId?: string
  stepId?: string
}
export interface CodingApprovalDecisionPayload {
  requestId: string
  decision: 'approved' | 'rejected' | 'hand-over'
  planId?: string
}
export interface PlanApprovalAskPayload {
  planId: string
  stepId: string
  requestId: string
  /** The step intent, shown on the approval card. */
  subject: string
  /** Why the approval is needed; rendered under the subject. */
  reason: string
  riskLevel: 'high' | 'medium' | 'low'
}

export const codingHostFsRead = defineInvokeEventa<CodingFsReadResult, CodingFsReadParams>('eventa:invoke:electron:coding-host:fs:read')
export const codingHostFsList = defineInvokeEventa<CodingFsListResult, CodingFsListParams>('eventa:invoke:electron:coding-host:fs:list')
export const codingHostFsWrite = defineInvokeEventa<CodingFsWriteResult, CodingFsWriteParams>('eventa:invoke:electron:coding-host:fs:write')
export const codingHostFsWriteGuarded = defineInvokeEventa<CodingFsWriteGuardedResult, CodingFsWriteGuardedParams>('eventa:invoke:electron:coding-host:fs:write-guarded')
export const codingHostFsGrep = defineInvokeEventa<CodingGrepResult, CodingGrepParams>('eventa:invoke:electron:coding-host:fs:grep')
export const codingHostJobOutput = defineInvokeEventa<CodingJobOutputResult, CodingJobOutputParams>('eventa:invoke:electron:coding-host:job:output')
export const codingHostJobKill = defineInvokeEventa<CodingJobKillResult, CodingJobKillParams>('eventa:invoke:electron:coding-host:job:kill')
export const codingHostSetWorkspaceRoot = defineInvokeEventa<CodingWorkspaceRootResult, CodingWorkspaceRootParams>('eventa:invoke:electron:coding-host:workspace-root:set')
export const codingWorkspaceRootChanged = defineEventa<CodingWorkspaceRootChangedPayload>('eventa:event:electron:coding-host:workspace-root:changed')
export const codingHostExecRun = defineInvokeEventa<CodingExecRunResult, CodingExecRunParams>('eventa:invoke:electron:coding-host:exec:run')
export const codingHostCodeRun = defineInvokeEventa<CodingCodeRunResult, CodingCodeRunParams>('eventa:invoke:electron:coding-host:code:run')
export const codingHostCodeCancel = defineInvokeEventa<void, { runId: string }>('eventa:invoke:electron:coding-host:code:cancel')
export const codingHostListTools = defineInvokeEventa<CodingToolsStatusResult, void>('eventa:invoke:electron:coding-host:tools:list')

// Bash approval tri-state (CAPABILITY-PLAN §三):
// - require:    medium + high commands wait for a human decision
// - substitute: medium runs automatically, high still waits
// - full:       nothing waits (auto-approve, including high)
export type CodingApprovalMode = 'require' | 'substitute' | 'full'
export const codingHostSetApprovalMode = defineInvokeEventa<void, { mode: CodingApprovalMode }>('eventa:invoke:electron:coding-host:approval-mode:set')
export const codingHostGetApprovalMode = defineInvokeEventa<{ mode: CodingApprovalMode }, void>('eventa:invoke:electron:coding-host:approval-mode:get')
export const codingApprovalRequested = defineEventa<CodingApprovalRequestPayload>('eventa:event:electron:coding-host:approval:requested')
export const codingApprovalDecided = defineEventa<CodingApprovalDecisionPayload>('eventa:event:electron:coding-host:approval:decided')

// Plan-step approval uses the same card channel and timeout as bash.
// Focusing an `approvalRequired` step raises the card; the decision lands in
// every window's journal as approval/asked + approval/decided, which is what
// the plan evidence gate requires for `human_approval`.
export const planApprovalAsk = defineInvokeEventa<CodingApprovalDecisionPayload, PlanApprovalAskPayload>('eventa:invoke:electron:coding-host:plan-approval:ask')

// -- Memory host (long-term Postgres/pgvector store, MAINTENANCE-PLAN P2.4) --
// The main process owns the Postgres connection; renderers ship embeddings
// they computed locally (the embed worker is browser-only) and the host
// delegates to the @proj-airi/memory-pgvector repository.

export interface MemoryHostStatus {
  status: 'unconfigured' | 'ready' | 'error'
  error?: string
}

export interface MemoryHostListParams {
  memoryType?: string
  reviewStatus?: string
  limit?: number
  scope?: MemoryScope
}

/** Full durable archives, captured by the journal owner after pending writes. */
export const journalHostExport = defineInvokeEventa<{ files: Array<{ name: string, content: string }> }, void>('eventa:invoke:electron:journal-host:export')

export interface MemoryHostSearchParams {
  embedding: number[]
  limit?: number
  weights?: {
    similarity?: number
    timeRelevance?: number
    arousal?: number
    accessCount?: number
    moodCongruence?: number
  }
  embeddingMetadata?: MemoryEmbeddingQueryMetadata
  scope?: MemoryScope
}

export interface MemoryHostInsertParams {
  content: string
  memoryType: string
  category: string
  importance?: number
  valence?: number
  arousal?: number
  halfLifeHours?: number
  sessionId?: string
  scope?: MemoryScope
  sourceContext?: MemorySourceContext
  reviewStatus?: string
  factStatus?: string
  supersedesId?: string
  conflictGroup?: string
  embedding?: number[]
  embeddingMetadata?: MemoryEmbeddingMetadata
  now?: number
  /** Stable local memory id used to make remote mirroring idempotent. */
  originId?: string
}

export interface MemoryHostFragment {
  id: string
  content: string
  memoryType: string
  category: string
  importance: number
  createdAt: number
  lastAccessed: number
  accessCount: number
  scope?: MemoryScope
  sourceContext?: MemorySourceContext
  reviewStatus?: string
  factStatus?: string
  supersedesId?: string
  conflictGroup?: string
  sessionIds?: string[]
  originId?: string
  embeddingProvider?: string
  embeddingModel?: string
  embeddingDimensions?: number
  embeddingInputType?: 'query' | 'document'
  embeddingSourceFingerprint?: string
  embeddedAt?: number
  embeddingStatus?: 'active' | 'stale'
  score?: number
}

/** Patch carried by a mirroring update op; fields absent from it stay untouched. */
export interface MemoryHostUpdatePatch {
  content?: string
  category?: string
  importance?: number
  reviewStatus?: string
  factStatus?: string
  supersedesId?: string
  conflictGroup?: string
  embedding?: number[]
  embeddingMetadata?: MemoryEmbeddingMetadata
}

export interface MemoryHostUpdateParams {
  originId: string
  patch: MemoryHostUpdatePatch
}

export interface MemoryHostRemoveParams {
  originId: string
}

export const memoryHostConfigure = defineInvokeEventa<MemoryHostStatus, { connectionString?: string }>('eventa:invoke:electron:memory-host:configure')
export const memoryHostGetStatus = defineInvokeEventa<MemoryHostStatus, void>('eventa:invoke:electron:memory-host:status')
export const memoryHostList = defineInvokeEventa<MemoryHostFragment[], MemoryHostListParams | void>('eventa:invoke:electron:memory-host:list')
export const memoryHostSearch = defineInvokeEventa<MemoryHostFragment[], MemoryHostSearchParams>('eventa:invoke:electron:memory-host:search')
export const memoryHostInsert = defineInvokeEventa<MemoryHostFragment, MemoryHostInsertParams>('eventa:invoke:electron:memory-host:insert')
export const memoryHostUpdate = defineInvokeEventa<MemoryHostFragment | undefined, MemoryHostUpdateParams>('eventa:invoke:electron:memory-host:update')
export const memoryHostRemove = defineInvokeEventa<{ removed: boolean }, MemoryHostRemoveParams>('eventa:invoke:electron:memory-host:remove')

// -- Web fetch (CAPABILITY-PLAN §二 fetch) --
// The main process owns the SSRF-hardened fetcher: `node:dns` resolution
// re-checks private/loopback IPs and the manual redirect loop re-checks every
// hop, so the `fetch` LLM tool cannot be steered at internal services.

export interface WebFetchParams {
  url: string
  maxChars: number
}

export interface WebFetchResult {
  status: number
  finalUrl: string
  text: string
  truncated: boolean
  contentType?: string
}

export const webFetchInvoke = defineInvokeEventa<WebFetchResult, WebFetchParams>('eventa:invoke:electron:web-fetch:fetch')

// -- Life mode (LIFE-PLAN M3) --
// The main process owns the durable life-mode config (persisted next to the
// app config, like the memory host) and the heartbeat that becomes a
// consideration turn. Cheap gates (quiet hours, daily budget, cooldown) run
// here, before any renderer round is initiated.

export interface LifeModeConfigContract {
  mode: 'off' | 'respond' | 'autonomous'
  intervalMinutes: number
  quietHoursStart: number
  quietHoursEnd: number
  dailyBudget: number
  cooldownMinutes: number
}

export type LifeModeGate
  = | 'mode'
    | 'quiet-hours'
    | 'budget'
    | 'cooldown'
    | 'busy'
    | 'focused'
    | 'flow-active'
    | 'speech-active'
    | 'no-session'
    | 'no-stimulus'
    | 'stale-stimulus'
    | 'tools-unavailable'
    | 'stale-heartbeat'
    | 'respond'

export interface LifeModeRuntimeSnapshotContract {
  config: LifeModeConfigContract
  revision: number
  budgetUsed: number
  budgetDateKey: string
  nextHeartbeatAt?: number
  lastHeartbeatAt?: number
  lastDecisionAt?: number
  lastGate?: LifeModeGate
}

export interface LifeHeartbeatEventPayload {
  heartbeatId: string
  reason: 'schedule' | 'manual-test'
  timestamp: number
}

export interface LifeDecisionClaimPayload {
  heartbeatId: string
}

export interface LifeDecisionClaimResult {
  claimed: boolean
  gate?: LifeModeGate
  snapshot: LifeModeRuntimeSnapshotContract
}

export interface LifeModeSetConfigPayload {
  patch: Partial<LifeModeConfigContract>
}

export interface LifeModeTestHeartbeatResult {
  emitted: boolean
  gate?: LifeModeGate
  snapshot: LifeModeRuntimeSnapshotContract
}

export interface LifeModeRecordGatePayload {
  gate: LifeModeGate
}

export const lifeModeGetSnapshot = defineInvokeEventa<LifeModeRuntimeSnapshotContract, void>('eventa:invoke:electron:life-mode:snapshot:get')
export const lifeModeSetConfig = defineInvokeEventa<LifeModeRuntimeSnapshotContract, LifeModeSetConfigPayload>('eventa:invoke:electron:life-mode:config:set')
export const lifeModeClaimDecision = defineInvokeEventa<LifeDecisionClaimResult, LifeDecisionClaimPayload>('eventa:invoke:electron:life-mode:decision:claim')
export const lifeModeRequestTestHeartbeat = defineInvokeEventa<LifeModeTestHeartbeatResult, void>('eventa:invoke:electron:life-mode:heartbeat:test')
/**
 * Mirrors a renderer-decided gate into the main-process snapshot. Most gates
 * (busy, focused, flow-active, speech-active, no-session, stale-stimulus) are
 * decided in the leader renderer, and a follower settings window reads only
 * the main-process snapshot (S03-S18, 2026-09-10).
 */
export const lifeModeRecordGate = defineInvokeEventa<LifeModeRuntimeSnapshotContract, LifeModeRecordGatePayload>('eventa:invoke:electron:life-mode:gate:record')
export const lifeModeSnapshotChanged = defineEventa<LifeModeRuntimeSnapshotContract>('eventa:event:electron:life-mode:snapshot:changed')
export const lifeHeartbeatEmitted = defineEventa<LifeHeartbeatEventPayload>('eventa:event:electron:life-mode:heartbeat')

// -- Long-horizon goals (LONG-HORIZON-GOALS-PLAN LG-2) --
// The main process owns only the wake clock and the single-run lease. The
// leader renderer still owns goal state, Flow, model calls, and tool policy.

export interface LongGoalSchedulePayload {
  goalId: string
  nextReviewAt: number
}

export interface LongGoalUnschedulePayload {
  goalId: string
}

export interface LongGoalWakeEventPayload {
  goalId: string
  wakeId: string
  reason: 'schedule' | 'retry' | 'startup'
  timestamp: number
}

export interface LongGoalClaimPayload {
  goalId: string
  wakeId: string
}

export interface LongGoalClaimResult {
  claimed: boolean
  leaseId?: string
  reason?: 'stale-wake' | 'already-running' | 'unknown-goal'
}

export interface LongGoalReleasePayload {
  goalId: string
  leaseId: string
}

export const longGoalSchedule = defineInvokeEventa<void, LongGoalSchedulePayload>('eventa:invoke:electron:long-goal:schedule')
export const longGoalUnschedule = defineInvokeEventa<void, LongGoalUnschedulePayload>('eventa:invoke:electron:long-goal:unschedule')
export const longGoalClaim = defineInvokeEventa<LongGoalClaimResult, LongGoalClaimPayload>('eventa:invoke:electron:long-goal:claim')
export const longGoalRelease = defineInvokeEventa<void, LongGoalReleasePayload>('eventa:invoke:electron:long-goal:release')
export const longGoalWakeEmitted = defineEventa<LongGoalWakeEventPayload>('eventa:event:electron:long-goal:wake')

export { electron } from '@proj-airi/electron-eventa'
export * from '@proj-airi/electron-eventa/electron-updater'
