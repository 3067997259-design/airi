// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick } from 'vue'

import ControlsIsland from './index.vue'

const invokeMock = vi.hoisted(() => vi.fn())
const shared = vi.hoisted(() => ({ isOutside: undefined as { value: boolean } | undefined }))

vi.mock('@moeru/eventa', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@moeru/eventa')>()
  return { ...actual, defineInvoke: () => invokeMock }
})

vi.mock('@proj-airi/electron-vueuse', async () => {
  const { ref } = await import('vue')
  shared.isOutside = ref(false)
  return {
    useElectronEventaContext: () => ref({ on: vi.fn() }),
    useElectronEventaInvoke: () => invokeMock,
    useElectronMouseInElement: () => ({ isOutside: shared.isOutside }),
  }
})

vi.mock('pinia', () => ({
  storeToRefs: (store: object) => store,
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('@proj-airi/ui', async () => {
  const { ref } = await import('vue')
  return { useTheme: () => ({ isDark: ref(false), toggleDark: vi.fn() }) }
})

vi.mock('@proj-airi/stage-ui/stores/settings', async () => {
  const { ref } = await import('vue')
  return {
    useSettings: () => ({
      alwaysOnTop: ref(false),
      controlsIslandIconSize: ref('auto'),
    }),
    useSettingsAudioDevice: () => ({ enabled: ref(false) }),
  }
})

vi.mock('./use-controls-island-placement', async () => {
  const { ref } = await import('vue')
  return {
    useControlsIslandPlacement: () => ({
      dock: ref('bottom-right'),
      isLeft: ref(false),
      isTop: ref(false),
      motionPhase: ref('idle'),
    }),
  }
})

vi.mock('../../../../shared/eventa', () => ({
  electron: { app: { isLinux: {} } },
  electronAppQuit: {},
  electronCenterMainWindow: {},
  electronOpenChat: {},
  electronOpenSettings: {},
  electronStartDraggingWindow: {},
  electronWindowSetAlwaysOnTop: {},
}))

vi.mock('./control-button.vue', async () => {
  const { h } = await import('vue')
  return {
    default: {
      inheritAttrs: false,
      setup(_: unknown, { slots, attrs }: { slots: Record<string, (() => unknown) | undefined>, attrs: Record<string, unknown> }) {
        return () => h('button', attrs, slots.default ? slots.default() as never : [])
      },
    },
  }
})

vi.mock('./control-button-tooltip.vue', async () => {
  const { h } = await import('vue')
  return {
    default: {
      setup(_: unknown, { slots }: { slots: Record<string, (() => unknown) | undefined> }) {
        return () => h('span', slots.default ? slots.default() as never : [])
      },
    },
  }
})

vi.mock('../status-island/index.vue', () => ({ default: { render: () => null } }))
vi.mock('./controls-island-auth-button.vue', () => ({ default: { render: () => null } }))
vi.mock('./controls-island-fade-on-hover.vue', () => ({ default: { render: () => null } }))
vi.mock('./controls-island-hearing-config.vue', () => ({ default: { render: () => null } }))
vi.mock('./controls-island-profile-picker.vue', () => ({ default: { render: () => null } }))
vi.mock('./controls-island-stop-speaking.vue', () => ({ default: { render: () => null } }))
vi.mock('./indicator-mic-volume.vue', () => ({ default: { render: () => null } }))

const mountedApps: Array<{ app: ReturnType<typeof createApp>, host: HTMLElement }> = []

function mountIsland() {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp({ render: () => h(ControlsIsland) })
  app.directive('track-button', {})
  app.mount(host)
  mountedApps.push({ app, host })
  return host
}

function settingsEntry(host: HTMLElement): HTMLButtonElement | null {
  return host.querySelector('[data-testid="controls-island-settings"]')
}

function clickExpand(host: HTMLElement) {
  ;(host.querySelector('[data-testid="controls-island-expand"]') as HTMLButtonElement).click()
}

beforeEach(() => {
  vi.useRealTimers()
  if (shared.isOutside)
    shared.isOutside.value = false
  invokeMock.mockClear()
})

afterEach(() => {
  for (const { app, host } of mountedApps.splice(0)) {
    app.unmount()
    host.remove()
  }
})

describe('controls island panel', () => {
  it('shows a clickable settings entry after expanding', async () => {
    // ACC-20260911 #13: the expand button looked dead after the rebuild.
    const host = mountIsland()
    expect(settingsEntry(host)).toBeNull()

    clickExpand(host)
    await nextTick()

    const settings = settingsEntry(host)
    expect(settings).not.toBeNull()
    invokeMock.mockClear()
    settings!.click()
    await nextTick()
    expect(invokeMock).toHaveBeenCalledWith({ route: '/settings' })
  })

  it('does not close the panel on an outside sample recorded before it opened', async () => {
    // The mouse signal starts "outside" (and can stay stale when the OS cursor
    // never moves); that must not collapse the panel 1.5s after it opens.
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'Date'] })
    shared.isOutside!.value = true
    const host = mountIsland()

    clickExpand(host)
    await nextTick()
    await vi.advanceTimersByTimeAsync(5_000)
    await nextTick()

    expect(settingsEntry(host)).not.toBeNull()
  })

  it('closes the panel after a real outside sample', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'Date'] })
    shared.isOutside!.value = false
    const host = mountIsland()

    clickExpand(host)
    await nextTick()
    expect(settingsEntry(host)).not.toBeNull()

    shared.isOutside!.value = true
    await nextTick()
    await vi.advanceTimersByTimeAsync(5_000)
    await nextTick()

    expect(settingsEntry(host)).toBeNull()
  })
})
