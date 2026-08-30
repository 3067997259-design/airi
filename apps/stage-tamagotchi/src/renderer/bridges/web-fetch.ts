import type { FetchTextPort, FetchTextResult } from '@proj-airi/stage-ui/tools/fetch'

import { defineInvoke } from '@moeru/eventa'
import { getElectronEventaContext } from '@proj-airi/electron-vueuse'

import { webFetchInvoke } from '../../shared/eventa'

/**
 * Renderer-side web fetch client (CAPABILITY-PLAN §二 fetch).
 *
 * Thin facade over the main-process SSRF-hardened fetcher. The caller's abort
 * signal is intentionally not forwarded: the main service owns its own
 * timeout, and a canceled turn must not kill a request the tool already
 * committed to.
 */
export function createWebFetchClient(): FetchTextPort {
  const context = getElectronEventaContext()
  const invoke = defineInvoke(context, webFetchInvoke)

  return async ({ url, maxChars }): Promise<FetchTextResult> => {
    const result = await invoke({ url, maxChars })
    return result as FetchTextResult
  }
}
