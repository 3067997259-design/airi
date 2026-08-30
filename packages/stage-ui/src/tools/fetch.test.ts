import { describe, expect, it, vi } from 'vitest'

import { createFetchTools } from './fetch'
import { assertExternalFetchable, FetchSsrfError, isInternalHostname, isPrivateIpLiteral } from './fetch-ssrf'

describe('isPrivateIpLiteral', () => {
  it('classifies loopback, private, link-local, and reserved IPv4 literals', () => {
    for (const host of [
      '127.0.0.1',
      '127.255.255.254',
      '10.0.0.1',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '198.18.0.1',
      '224.0.0.1',
      '255.255.255.255',
    ]) {
      expect(isPrivateIpLiteral(host), host).toBe(true)
    }
  })

  it('classifies IPv4 integer and hex forms that DNS resolvers normalize', () => {
    expect(isPrivateIpLiteral('2130706433')).toBe(true) // 127.0.0.1
    expect(isPrivateIpLiteral('167772161')).toBe(true) // 10.0.0.1
    expect(isPrivateIpLiteral('0x7f000001')).toBe(true) // 127.0.0.1 hex
    expect(isPrivateIpLiteral('2852039166')).toBe(true) // 169.254.169.254
  })

  it('classifies IPv6 private forms', () => {
    for (const host of ['::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'fe9a::1', 'ff02::1']) {
      expect(isPrivateIpLiteral(host), host).toBe(true)
    }
  })

  it('accepts public literals', () => {
    expect(isPrivateIpLiteral('8.8.8.8')).toBe(false)
    expect(isPrivateIpLiteral('1.1.1.1')).toBe(false)
    expect(isPrivateIpLiteral('2606:4700:4700::1111')).toBe(false)
  })
})

describe('isInternalHostname', () => {
  it('flags localhost and private-name suffixes', () => {
    for (const host of ['localhost', 'LOCALHOST', 'mybox.local', 'router.internal', 'nas.lan', 'host.localhost']) {
      expect(isInternalHostname(host), host).toBe(true)
    }
  })

  it('accepts public hostnames', () => {
    expect(isInternalHostname('example.com')).toBe(false)
    expect(isInternalHostname('docs.example.com')).toBe(false)
  })
})

describe('assertExternalFetchable', () => {
  it('rejects non-http schemes', () => {
    for (const url of ['file:///etc/passwd', 'ftp://example.com/file', 'data:text/plain,hi', 'javascript:alert(1)']) {
      expect(() => assertExternalFetchable(url), url).toThrow(FetchSsrfError)
    }
  })

  it('rejects internal hostnames and private literals', () => {
    for (const url of [
      'http://localhost/admin',
      'http://127.0.0.1:3000/',
      'http://10.0.0.5/',
      'http://192.168.1.1/',
      'http://172.16.0.1/',
      'http://169.254.169.254/latest/meta-data/',
      'http://[::1]/',
      'http://[fc00::1]/',
      'http://2130706433/',
      'https://mybox.local/status',
      'http://router.internal/',
    ]) {
      expect(() => assertExternalFetchable(url), url).toThrow(FetchSsrfError)
    }
  })

  it('accepts public http(s) URLs and preserves the parsed target', () => {
    expect(assertExternalFetchable('https://example.com/docs?a=1').hostname).toBe('example.com')
    expect(assertExternalFetchable('http://8.8.8.8/health').hostname).toBe('8.8.8.8')
  })
})

describe('createFetchTools', () => {
  it('exposes the fetch tool with a bounded max_chars parameter', async () => {
    const [tool] = await createFetchTools({ fetchText: async () => ({ status: 200, finalUrl: 'https://example.com', text: 'ok', truncated: false }) })
    expect(tool.function.name).toBe('fetch')
    const parameters = tool.function.parameters as { properties: Record<string, unknown> }
    expect(parameters.properties.max_chars).toBeDefined()
  })

  it('formats the fetched page as untrusted content with its source URL', async () => {
    const [tool] = await createFetchTools({
      fetchText: async () => ({ status: 200, finalUrl: 'https://example.com/page', text: '<b>hello</b>', truncated: false }),
    })
    const output = await tool.execute?.({ url: 'https://example.com/page', max_chars: 8000 }, { abortSignal: undefined } as never)
    expect(String(output)).toContain('Fetched https://example.com/page (HTTP 200)')
    expect(String(output)).toContain('<untrusted_content source="https://example.com/page">')
    expect(String(output)).toContain('hello')
  })

  it('returns the SSRF refusal to the model instead of throwing', async () => {
    const [tool] = await createFetchTools({
      fetchText: async () => { throw new Error('should not be called') },
    })
    const output = await tool.execute?.({ url: 'http://127.0.0.1:3000/', max_chars: 8000 }, { abortSignal: undefined } as never)
    expect(String(output)).toContain('fetch refused')
    expect(String(output)).toContain('SSRF guard')
  })

  it('rejects out-of-range max_chars by clamping at the boundary', async () => {
    const spy = vi.fn(async ({ maxChars }: { maxChars: number }) => ({ status: 200, finalUrl: 'https://example.com', text: 'x'.repeat(maxChars), truncated: false }))
    const [tool] = await createFetchTools({ fetchText: spy })
    await tool.execute?.({ url: 'https://example.com', max_chars: 50 }, { abortSignal: undefined } as never)
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ maxChars: 500 }))
  })
})
