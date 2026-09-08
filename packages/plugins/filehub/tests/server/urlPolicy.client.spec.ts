/**
 * M4 urlPolicy full spectrum (P01 §6-D FR-D2/D4 hard acceptance): both vision
 * fences under every spelling trick the spec calls out — decimal-integer IPs,
 * octal/hex forms, ::ffff: mapped re-checks, IPv6 ULA/site-local/link-local,
 * CGNAT, benchmarking, reserved ranges — plus DNS-rebinding mocks on the
 * public guard and the reverse lock of the local probe guard.
 */
import { describe, expect, it } from 'vitest'

import { assertLocalLoopbackUrl, assertPublicHttpUrl, hostnameOf, UrlPolicyError } from '../../src/server/urlPolicy.js'
import type { LookupAllAddresses } from '../../src/server/urlPolicy.js'

function lookupOf(...addresses: string[]): LookupAllAddresses {
  return async () => addresses.map(address => ({ address, family: address.includes(':') ? 6 : 4 }))
}

describe('assertLocalLoopbackUrl (Ollama probe reverse lock)', () => {
  const accepted = [
    'http://127.0.0.1:11434',
    'http://127.0.0.1:9200/api',
    'http://localhost:11434',
    'http://LOCALHOST:11434',
    'http://[::1]:11434',
    'http://[::ffff:127.0.0.1]:11434',
    // Decimal-integer spelling of 127.0.0.1 normalizes onto the sanctioned set.
    'http://2130706433:11434',
  ]
  it.each(accepted)('accepts %s', (input) => {
    expect(assertLocalLoopbackUrl(input).protocol).toMatch(/^https?:$/)
  })

  const refused = [
    'http://example.com:11434',
    'http://8.8.8.8:11434',
    'http://192.168.1.10:11434',
    'http://10.0.0.5:11434',
    'http://127.0.0.2:11434', // loopback /8 but NOT the sanctioned spelling
    'http://[::ffff:8.8.8.8]:11434',
    'ftp://127.0.0.1:11434', // scheme fence
    'not a url at all',
  ]
  it.each(refused)('refuses %s', (input) => {
    expect(() => assertLocalLoopbackUrl(input)).toThrow(UrlPolicyError)
  })
})

describe('assertPublicHttpUrl (explicit endpoint public-only lock)', () => {
  const defaults = { lookup: lookupOf('93.184.216.34') }

  it('passes a plain public https endpoint', async () => {
    await expect(
      assertPublicHttpUrl('https://vision.example.com/v1/caption', defaults),
    ).resolves.toBeInstanceOf(URL)
  })

  it('passes public IP literals', async () => {
    await expect(assertPublicHttpUrl('http://8.8.8.8:8080/x', defaults)).resolves.toBeInstanceOf(URL)
    await expect(assertPublicHttpUrl('https://1.1.1.1/', defaults)).resolves.toBeInstanceOf(URL)
  })

  it('passes a hostname whose every DNS answer is public', async () => {
    await expect(
      assertPublicHttpUrl('https://multi.example.com', {
        lookup: lookupOf('93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946'),
      }),
    ).resolves.toBeInstanceOf(URL)
  })

  const refusedLiteral = [
    // loopback + numeric-spelling tricks (WHATWG canonicalizes them first)
    'http://127.0.0.1/',
    'http://127.1/', // shorthand → 127.0.0.1
    'http://2130706433/', // decimal integer → 127.0.0.1
    'http://0177.0.0.1/', // octal part → 127.0.0.1
    'http://0x7f000001/', // hex → 127.0.0.1
    'http://017700000001/', // octal integer → 127.0.0.1
    'http://127.0.0.1./', // trailing-dot FQDN
    'http://localhost/',
    'http://LOCALHOST:443/',
    'http://localhost.localdomain/',
    // RFC1918
    'http://10.1.2.3/',
    'http://172.16.0.1/',
    'http://172.31.255.254/',
    'http://192.168.1.1/',
    // CGNAT 100.64/10 edges
    'http://100.64.0.1/',
    'http://100.127.255.254/',
    // link-local + metadata endpoint
    'http://169.254.169.254/latest/meta-data/',
    // this-network
    'http://0.0.0.0/',
    'http://0.1.2.3/',
    // benchmarking 198.18/15
    'http://198.18.0.5/',
    'http://198.19.255.255/',
    // reserved 240/4 incl. broadcast
    'http://240.0.0.1/',
    'http://255.255.255.255/',
    // multicast 224/4
    'http://224.0.0.1/',
    'http://239.255.255.250/',
    // IPv6: loopback, unspecified, ULA fc00::/7, link/site-local, multicast
    'http://[::1]/',
    'http://[::]/',
    'http://[fc00::1]/',
    'http://[fd12:3456:789a::1]/',
    'http://[fe80::1]/',
    'http://[fec0::1]/',
    'http://[ff02::1]/',
    // v4-mapped re-checks after unwrap (private + loopback payloads)
    'http://[::ffff:10.0.0.1]/',
    'http://[::ffff:192.168.0.9]/',
    'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:7f00:1]/',
    // legacy IPv4-compatible form hiding a private address
    'http://[::10.0.0.7]/',
    // scheme fence
    'ftp://example.com/',
  ]
  it.each(refusedLiteral)('refuses %s', async (input) => {
    await expect(assertPublicHttpUrl(input, defaults)).rejects.toThrow(UrlPolicyError)
  })

  it('refuses when any DNS answer lands in a private range (rebinding defense)', async () => {
    await expect(
      assertPublicHttpUrl('http://rebind.example.com', {
        lookup: lookupOf('93.184.216.34', '10.0.0.5'),
      }),
    ).rejects.toThrow(UrlPolicyError)
  })

  it('refuses when only the first answer is private even if later ones are clean', async () => {
    await expect(
      assertPublicHttpUrl('http://rebind2.example.com', {
        lookup: lookupOf('192.168.0.1', '8.8.8.8'),
      }),
    ).rejects.toThrow(UrlPolicyError)
  })

  it('refuses an IPv6 ULA DNS answer', async () => {
    await expect(
      assertPublicHttpUrl('http://v6rebind.example.com', {
        lookup: lookupOf('fd00::5'),
      }),
    ).rejects.toThrow(UrlPolicyError)
  })

  it('fails closed when resolution errors or returns nothing', async () => {
    await expect(
      assertPublicHttpUrl('http://nx.example.com', {
        lookup: async () => {
          throw new Error('ENOTFOUND')
        },
      }),
    ).rejects.toThrow(UrlPolicyError)
    await expect(assertPublicHttpUrl('http://empty.example.com', { lookup: lookupOf() })).rejects.toThrow(
      UrlPolicyError,
    )
  })
})

describe('hostnameOf normalization', () => {
  it('strips brackets and trailing dots, lower-cases', () => {
    expect(hostnameOf(new URL('http://[::1]:80/'))).toBe('::1')
    expect(hostnameOf(new URL('http://EXAMPLE.com/'))).toBe('example.com')
    expect(hostnameOf(new URL('http://localhost./'))).toBe('localhost')
  })
})
