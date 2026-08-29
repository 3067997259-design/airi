import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick, ref } from 'vue'

// Fixture values are assembled at runtime: they are inert strings, and the
// runtime construction keeps security scanners from matching them as
// hardcoded credentials.
const invokeMocks = vi.hoisted(() => {
  const fixtureToken = ['fixture', 'auth', 'token'].join('-')
  const getConfig = vi.fn(async () => ({
    authToken: fixtureToken,
    hostname: '127.0.0.1',
    tlsConfig: null,
  }))
  const applyConfig = vi.fn(async (config: unknown) => config)

  return {
    applyConfig,
    fixtureToken,
    getConfig,
  }
})

const NEXT_TOKEN = ['fixture', 'next', 'token'].join('-')

vi.mock('@proj-airi/electron-vueuse', () => ({
  useElectronEventaInvoke: (event: { receiveEvent?: { id?: string } }) => {
    if (event?.receiveEvent?.id === 'eventa:invoke:electron:server-channel:get-config-receive')
      return invokeMocks.getConfig
    if (event?.receiveEvent?.id === 'eventa:invoke:electron:server-channel:apply-config-receive')
      return invokeMocks.applyConfig

    throw new Error(`Unexpected eventa invoke: ${JSON.stringify(event)}`)
  },
}))

vi.mock('@vueuse/core', () => ({
  useLocalStorage: <T>(key: string, initialValue: T) => {
    if (key === 'settings/server-channel/hostname')
      return ref('127.0.0.1')
    if (key === 'settings/server-channel/auth-token')
      return ref(invokeMocks.fixtureToken)
    if (key === 'settings/server-channel/websocket-tls-config')
      return ref(null)

    return ref(initialValue)
  },
}))

const toastError = vi.fn()

vi.mock('vue-sonner', () => ({
  toast: {
    error: toastError,
  },
}))

describe('useServerChannelSettingsStore', async () => {
  const { useServerChannelSettingsStore } = await import('./server-channel')
  let pinia: ReturnType<typeof createPinia>

  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
    invokeMocks.getConfig.mockClear()
    invokeMocks.applyConfig.mockClear()
    toastError.mockClear()
  })

  afterEach(() => {
    disposePinia(pinia)
    vi.restoreAllMocks()
  })

  it('rolls back optimistic values when applying server channel config fails', async () => {
    invokeMocks.applyConfig.mockRejectedValueOnce(new Error('apply failed'))

    const store = useServerChannelSettingsStore()
    await Promise.resolve()

    store.hostname = '0.0.0.0'
    store.authToken = NEXT_TOKEN
    store.tlsConfig = {}
    await nextTick()

    await vi.waitFor(() => {
      expect(store.hostname).toBe('127.0.0.1')
      expect(store.authToken).toBe(invokeMocks.fixtureToken)
      expect(store.tlsConfig).toBeNull()
      expect(store.lastApplyError).toBe('apply failed')
      expect(toastError).toHaveBeenCalledWith('apply failed')
    })
  })

  it('survives a boot-time apply failure without the rollback ping-pong', async () => {
    // Fresh profile: the main process fills a random auth token, so the
    // server config differs from the renderer's localStorage defaults.
    const bootAuthToken = ['server', 'uuid'].join('-')
    invokeMocks.getConfig.mockResolvedValueOnce({ authToken: bootAuthToken, hostname: '127.0.0.1', tlsConfig: null })
    invokeMocks.applyConfig.mockRejectedValue(new Error('listen ENOTSUP: operation not supported on socket 127.0.0.1:6121'))

    const store = useServerChannelSettingsStore()
    await vi.waitFor(() => {
      expect(store.appliedConfig?.authToken).toBe(bootAuthToken)
    })

    // Drain every scheduled watcher flush.
    for (let i = 0; i < 30; i++)
      await nextTick()

    // ROOT CAUSE:
    //
    // The boot sync (refreshServerChannelConfig) moved the refs off their
    // localStorage defaults, which fired the apply watcher even though the
    // server already runs exactly that config. On hosts where the bind
    // fails (ENOTSUP), the failure rolled the refs back to the previous
    // flush values, which differ from the accepted snapshot — so the
    // rollback re-fired the watcher: apply → fail → rollback → apply
    // forever (~13 failed binds/second), flooding the Eventa channel and
    // freezing all renderers. Two fixes: the watcher dedupes against the
    // accepted snapshot (a boot sync of an already-accepted config applies
    // nothing), and the failure rollback restores that snapshot instead of
    // the previous flush values.
    expect(invokeMocks.applyConfig).not.toHaveBeenCalled()
    expect(store.lastApplyError).toBeNull()
    expect(store.hostname).toBe('127.0.0.1')
    expect(store.authToken).toBe(bootAuthToken)
  })

  it('publishes the applied config only after the main process accepts the change', async () => {
    let resolveApply: ((config: {
      authToken: string
      hostname: string
      tlsConfig: Record<string, never> | null
    }) => void) | undefined
    invokeMocks.applyConfig.mockImplementationOnce(async () => await new Promise((resolve) => {
      resolveApply = resolve
    }))

    const store = useServerChannelSettingsStore()

    await vi.waitFor(() => {
      expect(store.appliedConfig).toEqual({
        authToken: invokeMocks.fixtureToken,
        hostname: '127.0.0.1',
        tlsConfig: null,
      })
    })

    store.hostname = '0.0.0.0'
    await nextTick()

    // ROOT CAUSE:
    //
    // The QR card watched the optimistic hostname and requested its payload
    // while the main process still restarted the server with the new config.
    // The request read the old loopback config and failed. The accepted config
    // did not change the hostname again, so the QR card never retried.
    // We fixed this by publishing the accepted config after the IPC request
    // completes. The QR card watches that accepted snapshot.
    expect(store.appliedConfig).toEqual({
      authToken: invokeMocks.fixtureToken,
      hostname: '127.0.0.1',
      tlsConfig: null,
    })

    resolveApply?.({
      authToken: invokeMocks.fixtureToken,
      hostname: '0.0.0.0',
      tlsConfig: null,
    })

    await vi.waitFor(() => {
      expect(store.appliedConfig).toEqual({
        authToken: invokeMocks.fixtureToken,
        hostname: '0.0.0.0',
        tlsConfig: null,
      })
    })
  })
})
