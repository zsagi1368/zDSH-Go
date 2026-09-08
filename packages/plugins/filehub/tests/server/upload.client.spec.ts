/**
 * POST /api/filehub/upload over REAL HTTP against the fake-context domain
 * (P01 §6-A): happy paths with folder nesting, every guard-rail error code,
 * keep-alive survival after 413, concurrency gate, quota bookkeeping, dedupe
 * race recovery, and the same-origin fence.
 */
import http from 'node:http'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  defaultTestConfig,
  makeDomain,
  makeTempDir,
  removeTempDir,
  sendRequest,
  startRouteServer,
  uploadHeaders,
  uploadRequest,
  type RunningServer,
} from './helpers.client.js'
import { isLoopbackRemoteAddress, originMatchesHost } from '../../src/server/upload.js'

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])

interface Env {
  tmp: string
  cwd: string
  root: string
  port: number
  agent: http.Agent
  dispose: () => void
}

let env: Env

beforeAll(async () => {
  const tmp = await makeTempDir('upload')
  const cwd = path.join(tmp, 'project-ws')
  await fsp.mkdir(cwd, { recursive: true })
  const { domain, route } = makeDomain([
    { id: 's1', cwd },
    { id: 'quota-s1', cwd },
    { id: 'quota-s2', cwd },
  ])
  const server: RunningServer = await startRouteServer(route)
  env = {
    tmp,
    cwd,
    root: path.join(cwd, '.filehub'),
    port: server.port,
    agent: new http.Agent({ keepAlive: true, maxSockets: 1 }),
    dispose: () => {
      domain.dispose()
      void server.close()
    },
  }
})

afterAll(async () => {
  env.agent.destroy()
  env.dispose()
  await removeTempDir(env.tmp)
})

function jsonOf(text: string): Record<string, unknown> {
  return JSON.parse(text) as Record<string, unknown>
}

describe('happy path', () => {
  it('stores a plain file, sniffs its type, and answers the contract shape', async () => {
    const response = await uploadRequest(env.agent, env.port, {
      sessionId: 's1',
      fileName: 'hello world.txt',
      body: new TextEncoder().encode('hello world'),
    })
    expect(response.status).toBe(200)
    const result = jsonOf(response.text)
    expect(result.sniffedType).toBe('text/plain; charset=utf-8')
    expect(result.label).toBe('hello world.txt')
    expect(String(result.path)).toContain(path.join('.filehub', ''))
    const relative = String(result.relativePath)
    expect(relative.startsWith('.filehub/')).toBe(true)
    expect(relative.endsWith('-hello world.txt')).toBe(true)
    // The stored file exists at the returned absolute path with the payload.
    const stored = await fsp.readFile(String(result.path))
    expect(stored.toString('utf8')).toBe('hello world')
    expect(String(result.path).startsWith(env.root)).toBe(true)
  })

  it('creates nested folders from x-file-relpath and decodes percent-encoded names', async () => {
    const response = await uploadRequest(env.agent, env.port, {
      sessionId: 's1',
      fileName: '报告.txt',
      relPath: 'docs/深/报告.txt',
      body: new TextEncoder().encode('季度数据'),
    })
    expect(response.status).toBe(200)
    const result = jsonOf(response.text)
    expect(String(result.path)).toContain(path.join('docs', '深'))
    expect(String(result.label)).toBe('报告.txt')
    // Deterministic assertions on the wire-relative path:
    const segments = String(result.relativePath).split('/')
    expect(segments[0]).toBe('.filehub')
    expect(segments.at(-1)?.endsWith('-报告.txt')).toBe(true)
    const stored = await fsp.readFile(String(result.path))
    expect(stored.toString('utf8')).toBe('季度数据')
  })

  it('sniffs magic bytes server-side regardless of the declared content type', async () => {
    const response = await uploadRequest(env.agent, env.port, {
      sessionId: 's1',
      fileName: 'innocent.bin',
      extraHeaders: { 'content-type': 'application/octet-stream' },
      body: PNG_BYTES,
    })
    expect(response.status).toBe(200)
    expect(jsonOf(response.text).sniffedType).toBe('image/png')
  })

  it('deduplicates identical content into one sha256_16-prefixed file', async () => {
    const body = new TextEncoder().encode('identical payload '.repeat(16))
    const responses = await Promise.all(
      Array.from({ length: 6 }, () =>
        uploadRequest(env.agent, env.port, {
          sessionId: 's1',
          fileName: 'same-name.txt',
          relPath: 'dedupe/same-name.txt',
          body,
        }),
      ),
    )
    const results = responses.map((response) => {
      expect(response.status).toBe(200)
      return jsonOf(response.text)
    })
    const paths = new Set(results.map(result => result.path))
    expect(paths.size).toBe(1)
    const directory = path.join(env.root, 'dedupe')
    const entries = await fsp.readdir(directory)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatch(/^[0-9a-f]{16}-same-name\.txt$/)
  })
})

describe('guard rails: per-error-code', () => {
  it('answers 403 for an unknown session', async () => {
    const response = await uploadRequest(env.agent, env.port, {
      sessionId: 'ghost-session',
      fileName: 'x.txt',
      body: new TextEncoder().encode('x'),
    })
    expect(response.status).toBe(403)
  })

  it('answers 403 for a session-id that fails the whitelist', async () => {
    const response = await uploadRequest(env.agent, env.port, {
      sessionId: 'bad/sid',
      fileName: 'x.txt',
      body: new Uint8Array([1]),
    })
    expect(response.status).toBe(403)
  })

  it('answers 415 for a dangerous extension and stores nothing', async () => {
    const response = await uploadRequest(env.agent, env.port, {
      sessionId: 's1',
      fileName: 'setup.exe',
      body: new Uint8Array([0x4d, 0x5a, 0, 0]),
    })
    expect(response.status).toBe(415)
    const entries = await fsp.readdir(env.root, { recursive: true })
    expect(entries.some(entry => entry.endsWith('.exe'))).toBe(false)
  })

  it('answers 415 for a dangerous extension hidden behind relpath folders', async () => {
    const response = await uploadRequest(env.agent, env.port, {
      sessionId: 's1',
      fileName: 'macro-free.pptx',
      relPath: 'tools/payload.bat',
      body: new Uint8Array([0x40, 0x65, 0x63, 0x68]),
    })
    expect(response.status).toBe(415)
  })

  it('answers 400 for malformed percent-encoding', async () => {
    const response = await uploadRequest(env.agent, env.port, {
      sessionId: 's1',
      fileName: 'ok.txt',
      extraHeaders: { 'x-file-relpath': '%zz%2etxt' },
      body: new Uint8Array([1]),
    })
    expect(response.status).toBe(400)
  })

  describe('413 size limit', () => {
    it('rejects an honest oversized Content-Length and keeps the connection reusable', async () => {
      const big = new Uint8Array(70 * 1024) // limit is 64 KiB in defaultTestConfig
      const rejected = await uploadRequest(env.agent, env.port, {
        sessionId: 's1',
        fileName: 'big.bin',
        extraHeaders: { 'content-length': String(big.length) },
        body: big,
      })
      expect(rejected.status).toBe(413)

      // Same keep-alive socket must serve the NEXT request: the drained 413
      // did not wedge the connection (spec §6-A).
      const followup = await uploadRequest(env.agent, env.port, {
        sessionId: 's1',
        fileName: 'after-413.txt',
        body: new TextEncoder().encode('still alive'),
      })
      expect(followup.reusedSocket).toBe(true)
      expect(followup.status).toBe(200)
    })

    it('catches chunked bodies whose real byte count crosses the limit', async () => {
      // Dedicated domain with a LARGE quota so the size ceiling is what trips.
      const tmp = await makeTempDir('size-limit')
      try {
        const cwd = path.join(tmp, 'ws')
        await fsp.mkdir(cwd, { recursive: true })
        const { domain, route } = makeDomain([{ id: 'size-s1', cwd }], {
          ...defaultTestConfig(),
          upload: { maxBytes: 16 * 1024, maxConcurrent: 2, perSessionQuotaBytes: 64 * 1024 * 1024 },
        })
        const server = await startRouteServer(route)
        try {
          const agent = new http.Agent()
          const chunk = new Uint8Array(4 * 1024)
          const request = sendRequest(agent, server.port, {
            method: 'POST',
            path: '/api/filehub/upload',
            headers: uploadHeaders({ sessionId: 'size-s1', fileName: 'chunky.bin' }),
            slowBody: { chunks: Array.from({ length: 12 }, () => chunk), delayMs: 3 },
          })
          request.end()
          const response = await request.done
          expect(response.status).toBe(413)
          agent.destroy()
        } finally {
          domain.dispose()
          await server.close()
        }
      } finally {
        await removeTempDir(tmp)
      }
    })
  })

  describe('507 quota', () => {
    it('pre-checks an honest Content-Length against KV-accounted usage', async () => {
      // Quota is 4 KiB; park 3 KiB, then a 2 KiB declaration must fail early.
      const parked = new Uint8Array(3 * 1024).fill(0x61)
      const ok = await uploadRequest(env.agent, env.port, {
        sessionId: 'quota-s1',
        fileName: 'parked.txt',
        body: parked,
      })
      expect(ok.status).toBe(200)

      const over = await uploadRequest(env.agent, env.port, {
        sessionId: 'quota-s1',
        fileName: 'over.txt',
        extraHeaders: { 'content-length': String(2 * 1024) },
        body: new Uint8Array(2 * 1024),
      })
      expect(over.status).toBe(507)
    }, 20_000)

    it('catches unannounced (chunked) bodies that cross the remaining quota', async () => {
      const chunk = new Uint8Array(512).fill(0x62)
      const request = sendRequest(env.agent, env.port, {
        method: 'POST',
        path: '/api/filehub/upload',
        headers: uploadHeaders({ sessionId: 'quota-s2', fileName: 'sneaky.txt' }),
        slowBody: { chunks: Array.from({ length: 20 }, () => chunk), delayMs: 2 },
      })
      request.end()
      const response = await request.done
      expect(response.status).toBe(507)
    }, 20_000)
  })

  describe('429 concurrency gate', () => {
    it('admits up to maxConcurrent and answers 429 beyond it, then completes', async () => {
      const tmp = await makeTempDir('concurrency')
      try {
        const cwd = path.join(tmp, 'ws')
        await fsp.mkdir(cwd, { recursive: true })
        const { domain, route } = makeDomain([{ id: 'gate-s1', cwd }], {
          ...defaultTestConfig(),
          upload: { maxBytes: 64 * 1024, maxConcurrent: 1, perSessionQuotaBytes: 4 * 1024 },
        })
        const server = await startRouteServer(route)
        try {
          const agent = new http.Agent({ keepAlive: true, maxSockets: 4 })

          // Occupant: chunked body trickling in; holds the single gate slot.
          const holder = sendRequest(agent, server.port, {
            method: 'POST',
            path: '/api/filehub/upload',
            headers: uploadHeaders({ sessionId: 'gate-s1', fileName: 'holder.txt' }),
          })
          // First chunk only; the gate stays held until we end the stream.
          holder.write(new Uint8Array([0x61]))
          await new Promise(resolve => setTimeout(resolve, 150))

          const overflow = await uploadRequest(agent, server.port, {
            sessionId: 'gate-s1',
            fileName: 'overflow.txt',
            body: new Uint8Array([0x78]),
          })
          expect(overflow.status).toBe(429)

          holder.end()
          const holderResult = await holder.done
          expect(holderResult.status).toBe(200)
          agent.destroy()
        } finally {
          domain.dispose()
          await server.close()
        }
      } finally {
        await removeTempDir(tmp)
      }
    }, 20_000)
  })
})

describe('same-origin fence', () => {
  it('rejects an Origin whose hostname differs from Host', async () => {
    const response = await uploadRequest(env.agent, env.port, {
      sessionId: 's1',
      fileName: 'evil.txt',
      origin: 'http://evil.example:8080',
      body: new Uint8Array([1]),
    })
    expect(response.status).toBe(403)
  })

  it('accepts loopback clients without an Origin header (non-browser clients)', async () => {
    const response = await uploadRequest(env.agent, env.port, {
      sessionId: 's1',
      fileName: 'curl-like.txt',
      body: new TextEncoder().encode('from curl'),
    })
    expect(response.status).toBe(200)
  })

  it('rejects a matching Origin arriving from a NON-loopback remote', async () => {
    const tmp = await makeTempDir('origin')
    try {
      const cwd = path.join(tmp, 'ws')
      await fsp.mkdir(cwd, { recursive: true })
      const { domain, route } = makeDomain([{ id: 'remote-s1', cwd }])
      const server = await startRouteServer(route, {
        remoteAddressOverride: '::ffff:203.0.113.9',
      })
      try {
        const agent = new http.Agent()
        const response = await uploadRequest(agent, server.port, {
          sessionId: 'remote-s1',
          fileName: 'spoofed.txt',
          origin: `http://127.0.0.1:${server.port}`,
          body: new Uint8Array([1]),
        })
        expect(response.status).toBe(403)
        agent.destroy()
      } finally {
        domain.dispose()
        await server.close()
      }
    } finally {
      await removeTempDir(tmp)
    }
  })

  describe('pure guard units', () => {
    it.each([
      ['::1', true],
      ['127.0.0.1', true],
      ['127.9.9.9', true],
      ['::ffff:127.0.0.1', true],
      ['::ffff:7f00:1', false],
      ['203.0.113.5', false],
      ['::2', false],
      [undefined, false],
    ])('isLoopbackRemoteAddress(%j) → %j', (input, expected) => {
      expect(isLoopbackRemoteAddress(input)).toBe(expected)
    })

    it('Origin absent passes; present-but-unparseable fails closed', () => {
      expect(originMatchesHost(undefined, '127.0.0.1:3000')).toBe(true)
      expect(originMatchesHost('', '127.0.0.1:3000')).toBe(false)
      expect(originMatchesHost('not a url', '127.0.0.1:3000')).toBe(false)
      expect(originMatchesHost('http://127.0.0.1:5555', '127.0.0.1:3000')).toBe(true)
      expect(originMatchesHost('http://[::1]:5555', '[::1]:3000')).toBe(true)
      expect(originMatchesHost('https://127.0.0.1.evil.io', '127.0.0.1:3000')).toBe(false)
    })
  })
})
