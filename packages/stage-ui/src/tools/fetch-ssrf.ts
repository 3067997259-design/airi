/**
 * SSRF guard for the `fetch` tool (CAPABILITY-PLAN §二 fetch).
 *
 * The guard is a pure deny-list: schemes outside http(s) and hosts that name
 * or encode loopback, private, link-local, or reserved address space are
 * rejected before any request leaves the process. Every check is deterministic
 * and unit-testable; the Electron main-process fetcher additionally resolves
 * hostnames through `node:dns` and re-checks the IPs, and re-checks each hop of
 * a manual redirect chain (see the app-side web-fetch service).
 */

export class FetchSsrfError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FetchSsrfError'
  }
}

function isPrivateIpv4(host: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!match)
    return false

  const octets = match.slice(1).map(Number)
  if (octets.some(octet => octet > 255))
    return false

  const [a, b, c] = octets
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127) // CGNAT
    || (a === 169 && b === 254) // link-local (incl. metadata endpoints)
    || (a === 172 && b >= 16 && b <= 31) // private
    || (a === 192 && b === 168) // private
    || (a === 192 && b === 0 && c === 0) // IETF protocol assignments
    || (a === 192 && b === 0 && c === 2) // TEST-NET-1
    || (a === 198 && (b === 18 || b === 19)) // benchmarking
    || (a === 198 && b === 51 && c === 100) // TEST-NET-2
    || (a === 203 && b === 0 && c === 113) // TEST-NET-3
    || a >= 224 // multicast + reserved
}

/**
 * Rejects the 32-bit integer form of an IPv4 address ("2130706433" is
 * 127.0.0.1). Browsers and DNS resolvers normalize this form, so the guard
 * must too, or a deny-list on dotted literals would be trivially bypassed.
 */
function isPrivateIpv4Integer(host: string): boolean {
  const decimal = /^\d{7,10}$/.test(host)
  const hex = /^0x[0-9a-f]{1,8}$/i.test(host)
  if (!decimal && !hex)
    return false

  const value = Number(host)
  if (!Number.isSafeInteger(value) || value > 0xFFFF_FFFF)
    return false

  const octets = [
    (value >>> 24) & 0xFF,
    (value >>> 16) & 0xFF,
    (value >>> 8) & 0xFF,
    value & 0xFF,
  ]
  return isPrivateIpv4(octets.join('.'))
}

function isPrivateIpv6(host: string): boolean {
  // WHATWG URLs keep the literal's brackets in hostname ("[::1]").
  const normalized = host.toLocaleLowerCase().replace(/^\[|\]$/g, '')
  if (!normalized.includes(':'))
    return false

  return normalized === '::'
    || normalized === '::1'
    || normalized.startsWith('fc') // unique-local fc00::/7
    || normalized.startsWith('fd')
    || normalized.startsWith('fe8') // link-local fe80::/10
    || normalized.startsWith('fe9')
    || normalized.startsWith('fea')
    || normalized.startsWith('feb')
    || normalized.startsWith('ff') // multicast ff00::/8
}

/**
 * Returns whether a hostname spells a loopback or otherwise internal name.
 * The list covers the names users and services actually reach for, including
 * the metadata endpoints; public DNS names that resolve to private IPs are
 * caught by the DNS-resolving guard in the Electron fetcher, which re-checks
 * every resolved address.
 */
export function isInternalHostname(hostname: string): boolean {
  const normalized = hostname.toLocaleLowerCase().replace(/\.$/, '')
  return normalized === 'localhost'
    || normalized.endsWith('.localhost')
    || normalized.endsWith('.local')
    || normalized.endsWith('.internal')
    || normalized.endsWith('.lan')
}

/** Returns whether a literal host encodes private, loopback, or reserved space. */
export function isPrivateIpLiteral(host: string): boolean {
  return isPrivateIpv4(host) || isPrivateIpv4Integer(host) || isPrivateIpv6(host)
}

/**
 * Rejects URLs the `fetch` tool must never request: non-http(s) schemes and
 * hosts naming loopback/private/reserved addresses.
 *
 * @example
 * assertExternalFetchable('http://127.0.0.1/admin')
 * // => throws FetchSsrfError
 */
export function assertExternalFetchable(value: string | URL): URL {
  let parsed: URL
  try {
    parsed = typeof value === 'string' ? new URL(value) : value
  }
  catch {
    throw new FetchSsrfError('fetch requires an absolute http(s) URL')
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    throw new FetchSsrfError(`fetch only supports http(s) URLs, got "${parsed.protocol.slice(0, -1)}"`)

  const { hostname } = parsed
  if (isInternalHostname(hostname))
    throw new FetchSsrfError(`fetch refuses internal hostname "${hostname}" (SSRF guard)`)
  if (isPrivateIpLiteral(hostname))
    throw new FetchSsrfError(`fetch refuses non-public address "${hostname}" (SSRF guard)`)

  return parsed
}
