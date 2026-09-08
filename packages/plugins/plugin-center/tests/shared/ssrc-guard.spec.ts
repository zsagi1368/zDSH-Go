import { describe, expect, it } from 'vitest'
import { assertSafeUrl, isHostAllowed } from '../../src/shared/ssrc-guard.js'
import { CpErrorCode } from '../../src/shared/types.js'

const ALLOWED = 'https://registry.example.com/catalog.json'

describe('ssrc guard host vector table', () => {
  const blocked: Array<[string, string]> = [
    ['plain localhost', 'http://localhost/x'],
    ['localhost with port', 'http://localhost:3080/x'],
    ['uppercase localhost', 'http://LOCALHOST/x'],
    ['subdomain localhost', 'http://api.localhost/x'],
    ['loopback v4', 'http://127.0.0.1/x'],
    ['loopback v4 alt', 'http://127.8.8.8/x'],
    ['loopback v6', 'http://[::1]/x'],
    ['unspecified v4', 'http://0.0.0.0/x'],
    ['private 10/8', 'http://10.1.2.3/x'],
    ['private 172.16/12', 'http://172.16.0.1/x'],
    ['private 172.31 edge', 'http://172.31.255.255/x'],
    ['private 192.168', 'http://192.168.1.1/x'],
    ['link local v4', 'http://169.254.169.254/latest/meta-data'],
    ['cgnat 100.64/10', 'http://100.64.0.1/x'],
    ['cgnat upper edge', 'http://100.127.255.254/x'],
    ['multicast v4', 'http://224.0.0.1/x'],
    ['reserved 240/4', 'http://240.0.0.1/x'],
    ['mapped loopback', 'http://[::ffff:127.0.0.1]/x'],
    ['mapped private', 'http://[::ffff:192.168.0.9]/x'],
    ['bare ipv6 ::', 'http://[::]/x'],
    ['unique local fc00::/7', 'http://[fd00::1]/x'],
    ['link local fe80::/10', 'http://[fe80::1]/x'],
    ['multicast ff02::1', 'http://[ff02::1]/x'],
    ['non-http protocol', 'file:///etc/passwd'],
    ['ftp protocol', 'ftp://example.com/file'],
    ['embedded credentials', 'https://user:pass@example.com/x'],
    ['garbage url', 'not-a-url'],
    ['mdns .local', 'http://printer.local/x'],
    ['decimal loopback', 'http://2130706433/'],
    ['short-form loopback', 'http://127.1/'],
    ['hex loopback', 'http://0x7f000001/'],
    ['octal loopback', 'http://0177.0.0.1/'],
    ['mixed numeric private', 'http://10.1/x'],
    ['ipv4-compatible v6 hex', 'http://[::7f00:1]/x'],
    ['nat64 v6', 'http://[64:ff9b::7f00:1]/x'],
  ]

  for (const [label, url] of blocked) {
    it(`blocks ${label}`, () => {
      const result = assertSafeUrl(url)
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.code).toBe(CpErrorCode.unsafeUrl)
      }
    })
  }

  const allowed: string[] = [
    ALLOWED,
    'http://example.com/insecure-ok',
    'https://a.b.c.example.com/deep/path?q=1',
    'https://203.0.113.10/test-net-3',
  ]
  for (const url of allowed) {
    it(`allows ${url}`, () => {
      expect(assertSafeUrl(url).ok).toBe(true)
    })
  }
})

describe('isHostAllowed direct judgments', () => {
  it('accepts regular dns names', () => {
    expect(isHostAllowed('dsh-hub.example.org')).toBe(true)
  })
  it('rejects empty and dotted junk', () => {
    expect(isHostAllowed('')).toBe(false)
    expect(isHostAllowed('..')).toBe(false)
  })
  it('rejects cgnat lower edge exactly', () => {
    expect(isHostAllowed('100.63.255.255')).toBe(true) // outside CGNAT
    expect(isHostAllowed('100.65.0.0')).toBe(false) // inside CGNAT
  })
})
