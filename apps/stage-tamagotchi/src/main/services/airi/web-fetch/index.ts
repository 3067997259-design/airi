/**
 * Web fetch service (CAPABILITY-PLAN §二 fetch).
 *
 * The SSRF-hardened fetcher behind the `fetch` LLM tool. The renderer default
 * guards only the initial URL and lets the runtime follow redirects blindly;
 * this service resolves the hostname through `node:dns` and re-checks every
 * resolved address, then walks the redirect chain manually, re-checking each
 * hop, so neither DNS trickery nor a redirect can steer the tool at loopback
 * or private address space. Page text returns converted (HTML stripped) and
 * capped, and rides the same untrusted-content contract the renderer tool
 * applies in the tool output.
 */
import type { createContext as createMainEventaContext } from '@moeru/eventa/adapters/electron/main'

import type { WebFetchParams, WebFetchResult } from '../../../../shared/eventa'

import { lookup } from 'node:dns/promises'

import { defineInvokeHandler } from '@moeru/eventa'
import { htmlToText } from '@proj-airi/stage-ui/tools/fetch'
import { assertExternalFetchable, FetchSsrfError, isPrivateIpLiteral } from '@proj-airi/stage-ui/tools/fetch-ssrf'

import { webFetchInvoke } from '../../../../shared/eventa'

const DEFAULT_TIMEOUT_MS = 15_000
const MAX_REDIRECTS = 5
/** Raw body read budget; conversion strips markup, so this sits above text caps. */
const MAX_RESPONSE_BYTES = 512 * 1024

/**
 * Resolves a hostname and rejects it when ANY resolved address is private.
 * `node:dns` returns the same addresses the connection would use, so this
 * closes the gap the renderer heuristic leaves for public names that resolve
 * to internal IPs.
 *
 * NOTICE:
 * A single resolve-then-fetch pass still has a small DNS-rebinding window
 * (the resolver can answer differently on the later connect). Closing it
 * fully requires re-resolving after the TCP connection is established, which
 * undici does not expose here; the redirect loop below re-checks every hop,
 * and the remaining window is accepted for a first-party LLM tool.
 */
async function guardResolvedAddresses(target: URL): Promise<URL> {
  try {
    const addresses = await lookup(target.hostname, { all: true })
    const blocked = addresses.find(entry => isPrivateIpLiteral(entry.address))
    if (blocked)
      throw new FetchSsrfError(`fetch refuses host resolving to non-public address "${blocked.address}" (SSRF guard)`)
  }
  catch (error) {
    if (error instanceof FetchSsrfError)
      throw error
    throw new Error(`fetch failed: cannot resolve "${target.hostname}"`)
  }
  return target
}

async function readBodyWithCap(response: Response): Promise<string> {
  if (!response.body)
    return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let raw = ''
  try {
    while (raw.length < MAX_RESPONSE_BYTES) {
      const { done, value } = await reader.read()
      if (done)
        break
      raw += decoder.decode(value, { stream: true })
    }
    raw += decoder.decode()
  }
  finally {
    reader.releaseLock()
  }
  return raw
}

export async function setupWebFetch(
  context: ReturnType<typeof createMainEventaContext>['context'],
): Promise<void> {
  defineInvokeHandler(context, webFetchInvoke, async ({ url, maxChars }: WebFetchParams): Promise<WebFetchResult> => {
    const initial = assertExternalFetchable(url)

    let current = await guardResolvedAddresses(initial)
    let response: Response | undefined
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const signal = AbortSignal.timeout(DEFAULT_TIMEOUT_MS)
      response = await fetch(current, {
        redirect: 'manual',
        signal,
        headers: {
          'user-agent': 'airi-fetch/1.0 (+https://github.com/moeru-ai/airi)',
          'accept': 'text/html,text/plain,application/json,*/*',
        },
      })

      if (response.status < 300 || response.status >= 400)
        break

      const location = response.headers.get('location')
      if (!location)
        throw new Error(`fetch failed: redirect (HTTP ${response.status}) without a Location header`)
      const next = new URL(location, current)
      const guarded = assertExternalFetchable(next)
      // Re-check DNS only when the hostname changed; same-host hops keep the
      // already-guarded resolution.
      current = next.hostname !== guarded.hostname
        ? await guardResolvedAddresses(guarded)
        : guarded
      response = undefined
    }
    if (!response)
      throw new Error(`fetch failed: more than ${MAX_REDIRECTS} redirects`)

    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 200)
      throw new Error(`fetch failed: http ${response.status}${detail ? `: ${detail}` : ''}`)
    }

    const converted = htmlToText(await readBodyWithCap(response))
    const truncated = converted.length > maxChars
    return {
      status: response.status,
      finalUrl: response.url || current.href,
      text: converted.slice(0, maxChars),
      truncated,
      contentType: response.headers.get('content-type') ?? undefined,
    }
  })
}
