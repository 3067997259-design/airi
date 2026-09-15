import type { Plugin } from 'vue'
import type { RouteRecordRaw } from 'vue-router'

import Tres from '@tresjs/core'

import { autoAnimatePlugin } from '@formkit/auto-animate/vue'
import { PiniaColada } from '@pinia/colada'
import { trackButtonPlugin } from '@proj-airi/stage-ui/directives/track-button'
import { configureAnalyticsAdapter } from '@proj-airi/stage-ui/libs/analytics'
import { browserAuthorizationHandler, registerAuthorizationHandler } from '@proj-airi/stage-ui/libs/auth'
import { piniaPluginTracing, setupSynced } from '@proj-airi/stage-ui/libs/pinia'
import { beginRestoreGate, completeRestoreGate, setRestoredOwner, waitForRestore } from '@proj-airi/stage-ui/services/restore-gate'
import { profileSnapshotBarrier } from '@proj-airi/stage-ui/services/snapshot-barrier'
import { MotionPlugin } from '@vueuse/motion'
import { createPinia } from 'pinia'
import { setupLayouts } from 'virtual:generated-layouts'
import { createApp, watch } from 'vue'
import { createRouter, createWebHashHistory } from 'vue-router'
import { handleHotUpdate, routes } from 'vue-router/auto-routes'

import App from './App.vue'

import { installCodingHostBridge } from './bridges/coding-host-install'
import { createDataBackupBootstrapClient } from './bridges/data-backup'
import { installGameHostBridge } from './bridges/game-host-install'
import { installPackagesBridge } from './bridges/packages-install'
import { i18n } from './modules/i18n'
import { resolveRendererWindowContext } from './window-context'

import '@unocss/reset/tailwind.css'
import 'splitpanes/dist/splitpanes.css'
import 'vue-sonner/style.css'
import './styles/main.css'
import 'uno.css'
// Fonts
import '@proj-airi/font-cjkfonts-allseto/index.css'
import '@proj-airi/font-xiaolai/index.css'
import '@fontsource-variable/dm-sans/index.css'
import '@fontsource-variable/jura/index.css'
import '@fontsource-variable/quicksand/index.css'
import '@fontsource-variable/urbanist/index.css'
import '@fontsource-variable/comfortaa/index.css'
import '@fontsource/dm-mono/index.css'
import '@fontsource/dm-serif-display/index.css'
import '@fontsource/gugi/index.css'
import '@fontsource/kiwi-maru/index.css'
import '@fontsource/m-plus-rounded-1c/index.css'
import '@fontsource-variable/nunito/index.css'

configureAnalyticsAdapter(async (options) => {
  const { createPosthogAdapter } = await import('@proj-airi/stage-ui/libs/analytics/posthog')
  return createPosthogAdapter(options)
})
registerAuthorizationHandler(browserAuthorizationHandler)

const pinia = createPinia()
const synced = setupSynced({
  leadership: resolveRendererWindowContext().leadership,
})
pinia.use(synced.pinia)
pinia.use(profileSnapshotBarrier.plugin)

// Every window waits for the host's durable restore decision. Only the leader
// imports data; followers must not initialize against partial shared state.
beginRestoreGate()
void restorePendingProfile()
if (import.meta.env.DEV)
  pinia.use(piniaPluginTracing)

// Leader-boot auto-initialization (COMMAND-PLAN §3.4 follow-up): the local
// memory database and the plan store hydrate without a manual settings-page
// click. Follower windows no-op through the same guards inside the stores.
if (resolveRendererWindowContext().leadership === 'leader-only') {
  void (async () => {
    // Arm journal replay and hydrate owners only after the archive import has
    // returned and the host has persisted its completion receipt.
    await waitForRestore()
    // Settings windows route backup actions to this owner, even before the
    // leader opens a data page. Registration does not start an export.
    const { useDataBackupStore } = await import('@proj-airi/stage-ui/stores/data-backup')
    useDataBackupStore(pinia)
    const { useMemoryStore } = await import('@proj-airi/stage-ui/stores/modules/memory')
    const { usePlanStore } = await import('@proj-airi/stage-ui/stores/plans')
    const { useLongGoalSchedulerStore } = await import('@proj-airi/stage-ui/stores/modules/long-goals')
    const { useJournalStore } = await import('@proj-airi/stage-ui/stores/journal')
    const { useChatSessionStore } = await import('@proj-airi/stage-ui/stores/chat/session-store')
    const { useDuckDb } = await import('@proj-airi/stage-ui/composables/use-duck-db')
    try {
      // Session selection restores asynchronously from its synced snapshot, so
      // the active session id is still empty at this point. Replay whatever
      // session becomes active, and again on every later switch, instead of
      // once here with an id that cannot be known yet. Plans hydrate after
      // this watcher is armed: plan state derives from journal events, and the
      // journal store updates reactively when a replay lands
      // (HARNESS-PLAN §9.1).
      const journalStore = useJournalStore()
      const chatSessionStore = useChatSessionStore()
      watch(() => chatSessionStore.activeSessionId, (sessionId) => {
        if (!sessionId)
          return
        // After the journal replays, a flow recorded as still running means
        // the app died mid-flow: rebuild its counters and continue it
        // (FLOW-DIAGNOSIS P2-2). Failures stay silent — a boot without a
        // resumable flow is the common case.
        void journalStore.hydrate(sessionId).then(async () => {
          const { useChatStore } = await import('@proj-airi/stage-ui/stores/chat')
          await useChatStore().resumeFlowAfterRestart(sessionId)
        }).catch(error => console.warn('[Boot] Flow resume failed.', error))
      }, { immediate: true })

      // Best-effort drain on close: a graceful unload delivers the queued
      // batches; a forced kill is covered by the host's gap detection on the
      // next boot.
      window.addEventListener('beforeunload', () => {
        void journalStore.flushNow()
        void useDuckDb().closeDb().catch(error => console.warn('[Boot] Memory database close failed.', error))
      })
    }
    catch (error) {
      console.warn('[Boot] Journal replay failed.', error)
    }
    try {
      await usePlanStore().initialize()
    }
    catch (error) {
      console.warn('[Boot] Plan store hydration failed.', error)
    }
    try {
      const { useSkillsReviewStore } = await import('@proj-airi/stage-ui/stores/skills')
      await useSkillsReviewStore().restore()
    }
    catch (error) {
      console.warn('[Boot] Skill review queue restore failed.', error)
    }
    try {
      // Package tools delegate to reviewed skills, so registration arms after
      // the review queue is hydrated.
      const { usePackagesStore } = await import('@proj-airi/stage-ui/stores/modules/packages')
      await usePackagesStore(pinia).refresh()
      const { usePackageToolsRegistrationStore } = await import('./stores/packages-registration')
      usePackageToolsRegistrationStore(pinia)
    }
    catch (error) {
      console.warn('[Boot] Package host initialization failed.', error)
    }
    try {
      await useMemoryStore().initialize()
    }
    catch (error) {
      console.warn('[Boot] Memory database initialization failed.', error)
    }
    try {
      await useLongGoalSchedulerStore().initialize()
    }
    catch (error) {
      console.warn('[Boot] Long-goal scheduler initialization failed.', error)
    }
  })()
}

// Every renderer process installs the coding host bridge (main process
// Eventa contracts); the stage-ui store consumes it from any window.
installCodingHostBridge()

// Same pattern for the MCPFabric game-host bridge: the settings page and the
// module list read it through the stage-ui store from any window.
installGameHostBridge()

// EP-2a package host: every window refreshes its ledger from main broadcasts;
// only the leader leader registers the enabled packages' tools.
installPackagesBridge(pinia)

// A restore profile remains inert until its leader acknowledges the imported
// bytes. The owner stores decide how to consume the validated archive.
async function restorePendingProfile(): Promise<void> {
  const leader = resolveRendererWindowContext().leadership === 'leader-only'
  await createDataBackupBootstrapClient().bootstrap({ leader }).then(async (result) => {
    // The onboarding surface must be able to name the restored owner even
    // before it is allowed to import the archive (ACC-20260910 R03).
    setRestoredOwner(result.restored ? result.ownerId : undefined)
    if (!result.restored || !result.data) {
      completeRestoreGate(result.restored && (result.effectsHeld ?? result.restored))
      return
    }
    const { inspectDataBackup } = await import('@proj-airi/stage-ui/services/data-backup')
    const inspected = await inspectDataBackup(result.data)
    const { useDataBackupStore } = await import('@proj-airi/stage-ui/stores/data-backup')
    await useDataBackupStore().importSnapshot(result.data, { staged: true })
    await createDataBackupBootstrapClient().complete({ snapshotId: inspected.manifest.snapshotId })
    completeRestoreGate(true)
  }).catch((error) => {
    // A damaged archive or interrupted import must not deadlock every owner.
    // Release local initialization while retaining the durable effect hold;
    // the profile remains inert until the user reviews or discards it.
    completeRestoreGate(true)
    console.warn('[Boot] Isolated restore is pending:', error)
  })
}

const router = createRouter({
  history: createWebHashHistory(),
  // TODO: vite-plugin-vue-layouts is long deprecated, replace with another layout solution
  routes: setupLayouts(routes as RouteRecordRaw[]),
})

if (import.meta.hot) {
  handleHotUpdate(router, (updatedRoutes) => {
    router.clearRoutes()
    for (const route of setupLayouts(updatedRoutes))
      router.addRoute(route)
  })
}

createApp(App)
  .use(synced.vue)
  .use(MotionPlugin)
  // TODO: Fix autoAnimatePlugin type error
  .use(autoAnimatePlugin as unknown as Plugin)
  .use(router)
  .use(pinia)
  .use(PiniaColada)
  .use(i18n)
  .use(Tres)
  .use(trackButtonPlugin)
  .mount('#app')
