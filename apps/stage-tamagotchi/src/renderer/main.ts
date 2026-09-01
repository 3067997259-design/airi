import type { Plugin } from 'vue'
import type { RouteRecordRaw } from 'vue-router'

import Tres from '@tresjs/core'

import { autoAnimatePlugin } from '@formkit/auto-animate/vue'
import { PiniaColada } from '@pinia/colada'
import { trackButtonPlugin } from '@proj-airi/stage-ui/directives/track-button'
import { configureAnalyticsAdapter } from '@proj-airi/stage-ui/libs/analytics'
import { browserAuthorizationHandler, registerAuthorizationHandler } from '@proj-airi/stage-ui/libs/auth'
import { piniaPluginTracing, setupSynced } from '@proj-airi/stage-ui/libs/pinia'
import { MotionPlugin } from '@vueuse/motion'
import { createPinia } from 'pinia'
import { setupLayouts } from 'virtual:generated-layouts'
import { createApp, watch } from 'vue'
import { createRouter, createWebHashHistory } from 'vue-router'
import { handleHotUpdate, routes } from 'vue-router/auto-routes'

import App from './App.vue'

import { installCodingHostBridge } from './bridges/coding-host-install'
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
if (import.meta.env.DEV)
  pinia.use(piniaPluginTracing)

// Leader-boot auto-initialization (COMMAND-PLAN §3.4 follow-up): the local
// memory database and the plan store hydrate without a manual settings-page
// click. Follower windows no-op through the same guards inside the stores.
if (resolveRendererWindowContext().leadership === 'leader-only') {
  void (async () => {
    const { useMemoryStore } = await import('@proj-airi/stage-ui/stores/modules/memory')
    const { usePlanStore } = await import('@proj-airi/stage-ui/stores/plans')
    const { useJournalStore } = await import('@proj-airi/stage-ui/stores/journal')
    const { useChatSessionStore } = await import('@proj-airi/stage-ui/stores/chat/session-store')
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
        if (sessionId)
          void journalStore.hydrate(sessionId)
      }, { immediate: true })
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
      await useMemoryStore().initialize()
    }
    catch (error) {
      console.warn('[Boot] Memory database initialization failed.', error)
    }
  })()
}

// Every renderer process installs the coding host bridge (main process
// Eventa contracts); the stage-ui store consumes it from any window.
installCodingHostBridge()

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
