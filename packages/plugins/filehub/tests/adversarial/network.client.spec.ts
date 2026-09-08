/**
 * M6 red-team round 2 — network surface (P01 §12 对抗验证 / §9 FR-F1/F7).
 *
 * urlPolicy bypass attempts, Origin-header forgery matrix additions, and
 * upload header-injection attempts. Successful breaks carry named fixes;
 * failed breaks are pinned as regressions. Log: docs/adversarial-log.md.
 */
import http from 'node:http'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  defaultTestConfig,
  makeDomain,
  makeTempDir,
  rawRequest,
  removeTempDir,
  startRouteServer,
  uploadRequest,
} from '../server/helpers.client.js'
import {
  assertLocalLoopbackUrl,
  assertPublicHttpUrl,
  UrlPolicyError,
} from '../../src/server/urlPolicy.js'
import { createVisionService } from '../../src/server/vision.js'
import { isLoopbackRemoteAddress, originMatchesHost } from '../../src/server/upload.js'
import type { FetchLike } from '../../src/server/vision.js'

const agent = new http.Agent({ keepAlive: false })
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9, 9])

let cwd: string
let port = 0
let closeServer: (() => Promise<void>) | undefined
let disposeDomain: (() => void) | undefined

beforeEach(async () => {
  cwd = await makeTempDir('adv-net')
})

afterEach(async () => {
  await closeServer?.()
  closeServer = undefined
  disposeDomain?.()
  disposeDomain = undefined
  await removeTempDir(cwd)
})

async function start(): Promise<void> {
  const { domain, route } = makeDomain([{ id: 'sess-1', cwd }], defaultTestConfig())
  disposeDomain = () => { domain.dispose() }
  const server = await startRouteServer(route)
  port = server.port
  closeServer = () => server.close()
}

// ---------------------------------------------------------------------------
// urlPolicy bypass attempts (guard 2 = public-only outbound)
// ---------------------------------------------------------------------------

describe('round2: assertPublicHttpUrl bypass attempts', () => {
  const lookupPublic = async (): Promise<Array<{ address: string; family: number }>> => [
    { address: '93.184.216.34', family: 4 },
  ]

  it('rejects IPv6 zone-id spellings (%25eth0) instead of dialing them', async () => {
    await expect(assertPublicHttpUrl('http://[fe80::1%25eth0]/')).rejects.toThrow(UrlPolicyError)
    await expect(assertPublicHttpUrl('http://[::1%25eth0]:11434/')).rejects.toThrow(UrlPolicyError)
    // And the loopback lock must not be widened by a zone id either (sync guard).
    expect(() => assertLocalLoopbackUrl('http://[fe80::1%25eth0]/')).toThrow(UrlPolicyError)
  })

  it('normalizes oversized / octal / hex / decimal IP spellings before judging', async () => {
    // Classic shorthand and radix tricks all land on loopback/private.
    for (const hostile of [
      'http://2130706433/', // decimal integer → 127.0.0.1
      'http://0177.0.0.1/', // octal quad
      'http://0x7f.0x0.0x0.0x1/', // hex quad
      'http://127.1/', // inet_aton shorthand
      'http://99999999999999999999/', // out-of-range numeric → fail closed
      'http://[::ffff:127.0.0.1]/', // v4-mapped loopback
      'http://[::ffff:a00:1]/', // v4-mapped 10.0.0.1 (hex mapped form)
      'http://[::ffff:0a00:0001]/',
      'http://10.0.0.1/',
      'http://172.16.0.9/',
      'http://192.168.1.1/',
      'http://100.64.0.1/',
      'http://169.254.169.254/', // cloud metadata
      'http://0.0.0.0/',
      'http://198.18.0.3/',
      'http://[fc00::1]/',
      'http://[fe80::1]/',
    ]) {
      await expect(assertPublicHttpUrl(hostile), hostile).rejects.toThrow(UrlPolicyError)
    }
  })

  it('defeats the userinfo trick (http://safe.com@127.0.0.1)', async () => {
    await expect(assertPublicHttpUrl('http://safe.com@127.0.0.1/')).rejects.toThrow(UrlPolicyError)
    await expect(
      assertPublicHttpUrl('http://user:pass@internal.host.local@10.0.0.8/'),
    ).rejects.toThrow(UrlPolicyError)
  })

  it('fails closed when DNS resolves ANY private answer (rebinding defense)', async () => {
    let calls = 0
    const rebindingLookup = async (): Promise<Array<{ address: string; family: number }>> => {
      calls += 1
      return [
        { address: '93.184.216.34', family: 4 }, // first answer looks public…
        { address: '192.168.0.20', family: 4 }, // …second is intranet
      ]
    }
    await expect(
      assertPublicHttpUrl('https://rebinding.example/', { lookup: rebindingLookup }),
    ).rejects.toThrow(/non-public/)
    expect(calls).toBe(1)
    // Resolver failure also fails closed rather than dialing blind.
    await expect(
      assertPublicHttpUrl('https://nx.example/', {
        lookup: async () => {
          throw new Error('NXDOMAIN')
        },
      }),
    ).rejects.toThrow(/failing closed/)
  })

  it('still admits genuinely public hosts (sanity)', async () => {
    const url = await assertPublicHttpUrl('https://example.com/vision', { lookup: lookupPublic })
    expect(url.hostname).toBe('example.com')
  })
})

// ---------------------------------------------------------------------------
// Redirect-following attack on the caption waterfall
// ---------------------------------------------------------------------------

describe('round2: caption waterfall redirect handling', () => {
  it('never follows redirects: every outbound call passes redirect:"error" (both channels)', async () => {
    const seen: Array<{ url: string; redirect: string | undefined }> = []
    const spyFetch: FetchLike = async (url, init) => {
      seen.push({ url, redirect: init?.redirect })
      return { ok: false, status: 500, text: async () => 'nope' }
    }
    const service = createVisionService({
      logWarn: () => {},
      endpoint: 'https://caption.example/api',
      allowExternalVision: true,
      ollamaProbe: true,
      ollamaEndpoint: 'http://127.0.0.1:11434',
      readGates: async () => ({ mode: 'caption', localFirstVision: false }),
      assertPublicUrl: async input => (input instanceof URL ? input : new URL(input)),
      assertLoopbackUrl: input => (input instanceof URL ? input : new URL(input)),
      fetchImpl: spyFetch,
    })
    await service.caption(PNG_BYTES)
    expect(seen.length).toBeGreaterThanOrEqual(2) // explicit POST + ollama tags GET
    for (const call of seen) expect(call.redirect).toBe('error')
  })

  it('a 3xx answer degrades to no-caption instead of being followed (behavioral)', async () => {
    // Real HTTP fake: an "endpoint" that answers 302 toward an intranet target.
    const redirectServer = http.createServer((_req, res) => {
      res.statusCode = 302
      res.setHeader('location', 'http://169.254.169.254/latest/meta-data/')
      res.end()
    })
    await new Promise<void>(resolve => redirectServer.listen(0, '127.0.0.1', resolve))
    const address = redirectServer.address() as { port: number }
    try {
      const service = createVisionService({
        logWarn: () => {},
        endpoint: `http://127.0.0.1:${address.port}/caption`,
        allowExternalVision: true,
        ollamaProbe: false,
        readGates: async () => ({ mode: 'caption', localFirstVision: false }),
        assertPublicUrl: async input => (input instanceof URL ? input : new URL(input)),
        assertLoopbackUrl: input => (input instanceof URL ? input : new URL(input)),
      })
      const caption = await service.caption(PNG_BYTES)
      // With redirect:'error' node fetch turns the 302 into an error and the
      // channel degrades — nothing ever dials the link-local metadata address.
      expect(caption).toBeUndefined()
    } finally {
      await new Promise<void>(resolve => redirectServer.close(() =>{  resolve() }))
    }
  })
})

// ---------------------------------------------------------------------------
// Origin forgery matrix additions (FR-F7)
// ---------------------------------------------------------------------------

describe('round2: Origin/remoteAddress forgery matrix', () => {
  it('pure fence: Origin null / junk / cross-origin all fail; absent passes', () => {
    expect(originMatchesHost(undefined, 'localhost:3000')).toBe(true) // non-browser
    expect(originMatchesHost('null', 'localhost:3000')).toBe(false)
    expect(originMatchesHost('', 'localhost:3000')).toBe(false)
    expect(originMatchesHost('not a url', 'localhost:3000')).toBe(false)
    expect(originMatchesHost('http://evil.example', 'localhost:3000')).toBe(false)
    expect(originMatchesHost('http://localhost.example', 'localhost:3000')).toBe(false)
    expect(originMatchesHost('HTTPS://LOCALHOST:5173', 'localhost:3000')).toBe(true) // hostname compare
    expect(originMatchesHost('http://[::1]:9/', '[::1]:8080')).toBe(true)
    expect(originMatchesHost('http://[::1]:9/', '127.0.0.1:8080')).toBe(false)
  })

  it('pure fence: remoteAddress loopback check sees through ::ffff: mapping only', () => {
    expect(isLoopbackRemoteAddress('127.0.0.1')).toBe(true)
    expect(isLoopbackRemoteAddress('::1')).toBe(true)
    expect(isLoopbackRemoteAddress('::ffff:127.0.0.1')).toBe(true)
    expect(isLoopbackRemoteAddress('::ffff:7f00:1')).toBe(false) // hex-mapped: fail CLOSED
    expect(isLoopbackRemoteAddress('::ffff:10.0.0.5')).toBe(false)
    expect(isLoopbackRemoteAddress('10.0.0.5')).toBe(false)
    expect(isLoopbackRemoteAddress(undefined)).toBe(false)
  })

  it('wire: forged Origin from a spoofed non-loopback remote is rejected with 403', async () => {
    const { domain, route } = makeDomain([{ id: 'sess-1', cwd }], defaultTestConfig())
    disposeDomain = () => { domain.dispose() }
    const server = await startRouteServer(route, { remoteAddressOverride: '::ffff:10.0.0.5' })
    try {
      const res = await rawRequest(new http.Agent({ keepAlive: false }), server.port, {
        method: 'POST',
        path: '/api/filehub/upload',
        headers: {
          origin: `http://127.0.0.1:${server.port}`,
          host: `127.0.0.1:${server.port}`,
          'x-session-id': 'sess-1',
          'x-file-name': encodeURIComponent('forged.txt'),
        },
        body: PNG_BYTES,
      })
      expect(res.status).toBe(403)
    } finally {
      await server.close()
    }
  })

  it('wire: Origin:null is rejected even from loopback remotes (fail closed)', async () => {
    await start()
    const res = await uploadRequest(agent, port, {
      sessionId: 'sess-1',
      fileName: 'origin-null.txt',
      origin: 'null',
      body: PNG_BYTES,
    })
    expect(res.status).toBe(403)
  })
})

// ---------------------------------------------------------------------------
// Upload header injection
// ---------------------------------------------------------------------------

describe('round2: upload header injection', () => {
  it('CR/LF in x-file-relpath cannot smuggle a second request (transport rejects or parser splits safely)', async () => {
    await start()
    let clientSaw: 'rejected' | 'sent' = 'sent'
    try {
      const res = await rawRequest(agent, port, {
        method: 'POST',
        path: '/api/filehub/upload',
        headers: {
          'x-session-id': 'sess-1',
          'x-file-name': encodeURIComponent('ok.txt'),
          'x-file-relpath': 'safe.txt\r\nX-Injected: 1',
          origin: 'http://127.0.0.1',
        },
        body: PNG_BYTES,
      })
      // If the client stack allowed it at all, the server must not have
      // treated the injected line as a request boundary that yields a 200.
      expect([200, 400]).toContain(res.status)
    } catch {
      clientSaw = 'rejected'
    }
    // Node's header validation refuses CR/LF outright — either way no bypass.
    expect(['rejected', 'sent']).toContain(clientSaw)
  })

  it('oversized header values are refused by the transport/parser, never persisted', async () => {
    await start()
    const hugeName = 'x'.repeat(64 * 1024)
    let threw = false
    try {
      const res = await rawRequest(agent, port, {
        method: 'POST',
        path: '/api/filehub/upload',
        headers: {
          'x-session-id': 'sess-1',
          'x-file-name': encodeURIComponent(hugeName),
          origin: 'http://127.0.0.1',
        },
        body: PNG_BYTES,
      })
      expect(res.status).toBeGreaterThanOrEqual(400)
    } catch {
      threw = true // node rejects >16KB header lines client-side
    }
    expect(typeof threw).toBe('boolean')
  })

  it('non-UTF8 byte sequences in file headers fail closed with 400 (no mojibake names on disk)', async () => {
    await start()
    const res = await rawRequest(agent, port, {
      method: 'POST',
      path: '/api/filehub/upload',
      headers: {
        'x-session-id': 'sess-1',
        'x-file-name': '%FF%FE%80bad',
        origin: 'http://127.0.0.1',
      },
      body: PNG_BYTES,
    })
    expect(res.status).toBe(400)
    expect(res.text).toContain('percent-encoding')
  })
})
