/**
 * Full-chain integration tests: the real route handlers behind a real
 * node:http server on an ephemeral loopback port. The cordis surface is
 * faked at its narrowest seam (effect runs now; webServer collects routes),
 * which keeps these tests honest about URL parsing, envelopes, the trust
 * fence, and the path guard together.
 */
import { createServer, request as httpRequest, type Server } from 'node:http'
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { apply } from '../src/index.ts'
import { WORKBENCH_PACKAGE_NAME } from '../src/shared/protocol.ts'
import type { WebRoute } from '../src/context-types.ts'

interface TestServer {
  baseUrl: string
  routes: WebRoute[]
  close(): Promise<void>
}

async function startServer(): Promise<TestServer> {
  const routes: WebRoute[] = []
  const fakeCtx = {
    effect: (fn: () => unknown) => fn(),
    webServer: {
      register(route: WebRoute) {
        routes.push(route)
        return () => {}
      },
      registerUpgrade() {
        return () => {}
      },
    },
  } as unknown as Context
  await apply(fakeCtx)

  const server: Server = createServer((req, res) => {
    const parsed = new URL(req.url ?? '/', 'http://workbench.invalid')
    const exact = routes.find(route => route.kind === 'exact' && route.path === parsed.pathname)
    const prefixes = routes
      // Contract semantics (webserver match()): prefix p matches p and
      // p/<anything> — sibling-prefix lookalikes (`/workbench/api-x`) must not
      // route into p's handler.
      .filter(route => route.kind === 'prefix'
        && (parsed.pathname === route.path || parsed.pathname.startsWith(`${route.path}/`)))
      .sort((a, b) => b.path.length - a.path.length)
    const handler = exact?.handler ?? prefixes[0]?.handler
    if (handler === undefined) {
      res.writeHead(404)
      res.end()
      return
    }
    void handler(req, res)
  })
  await new Promise<void>((resolveListen) => {
    server.listen(0, '127.0.0.1', () =>{  resolveListen() })
  })
  const address = server.address()
  const baseUrl = `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`
  return {
    baseUrl,
    routes,
    close: () =>
      new Promise((resolveClose) => {
        server.close(() =>{  resolveClose() })
      }),
  }
}

async function api<T>(baseUrl: string, method: string, payload?: unknown, host?: string): Promise<T> {
  const response = await fetch(`${baseUrl}/workbench/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(host !== undefined ? { host } : {}) },
    body: JSON.stringify(payload ?? {}),
  })
  return (await response.json()) as T
}

let workspace = ''
let server: TestServer

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'wb-fs-'))
  server = await startServer()
})

afterEach(async () => {
  await server.close()
  await rm(workspace, { recursive: true, force: true }).catch(() => {})
})

/** Envelope shape every workbench api answer shares; T names the success payload. */
interface Envelope<T> {
  ok: boolean
  value?: T
  error?: { code: string; message: string }
}

const envelope = <T>(value: unknown): Envelope<T> => value as { ok: boolean; value?: T; error?: { code: string; message: string } }
const payload = (extra: Record<string, unknown>) => ({ cwd: workspace, ...extra })

describe('workbench api integration', () => {
  it('answers ping inside the success envelope', async () => {
    const result = envelope<{ plugin: string; version: string }>(await api(server.baseUrl, 'ping'))
    expect(result.ok).toBe(true)
    expect(result.value?.plugin).toBe(WORKBENCH_PACKAGE_NAME)
  })

  it('rejects foreign Host headers before any work', async () => {
    // undici (fetch) refuses to override Host, so drive the raw client where
    // the header is exactly what a rebinding attacker would send.
    const url = new URL(`${server.baseUrl}/workbench/api/ping`)
    const result = await new Promise<Envelope<never>>((resolve) => {
      const req = httpRequest(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          method: 'POST',
          headers: { 'content-type': 'application/json', host: 'evil.example.com' },
        },
        (res) => {
          let data = ''
          res.on('data', (chunk: Buffer) => {
            data += chunk.toString('utf8')
          })
          res.on('end', () =>{  resolve(JSON.parse(data) as Envelope<never>) })
        },
      )
      req.end('{}')
    })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('untrusted-host')
  })

  it('lists directories sorted dirs-first with broken symlinks flagged', async () => {
    await writeFile(join(workspace, 'a-file.txt'), 'text')
    await mkdir(join(workspace, 'z-dir'))
    await symlink(join(workspace, 'missing-target'), join(workspace, 'dead-link'))
    const result = envelope<{ entries: Array<{ name: string; broken?: boolean; isDir: boolean }> }>(
      await api(server.baseUrl, 'fs.tree', payload({ path: workspace })),
    )
    expect(result.ok).toBe(true)
    const names = result.value?.entries.map(entry => entry.name) ?? []
    expect(names.indexOf('z-dir')).toBeLessThan(names.indexOf('a-file.txt'))
    const dead = result.value?.entries.find(entry => entry.name === 'dead-link')
    expect(dead?.broken).toBe(true)
  })

  it('truncates text reads on UTF-8 character boundaries', async () => {
    // Each '中' is 3 bytes; 100 chars = 300 bytes. Cap at 7 bytes → floor to
    // 2 whole characters (6 bytes), never splitting the third.
    await writeFile(join(workspace, 'cjk.txt'), '中'.repeat(100))
    const result = envelope<{ kind: string; content: string; truncated: boolean; size: number }>(
      await api(server.baseUrl, 'fs.read', payload({ path: join(workspace, 'cjk.txt'), maxBytes: 7 })),
    )
    expect(result.ok).toBe(true)
    expect(result.value?.kind).toBe('text')
    expect(result.value?.content).toBe('中中')
    expect(result.value?.truncated).toBe(true)
    expect(result.value?.size).toBe(300)
  })

  it('detects binary files by extension and returns base64 head', async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff])
    await writeFile(join(workspace, 'img.png'), bytes)
    const result = envelope<{ kind: string; headBase64: string }>(
      await api(server.baseUrl, 'fs.read', payload({ path: join(workspace, 'img.png') })),
    )
    expect(result.value?.kind).toBe('binary')
    expect(Buffer.from(result.value?.headBase64 ?? '', 'base64').subarray(0, 4)).toEqual(bytes.subarray(0, 4))
  })

  it('writes atomically without leaving temp residue', async () => {
    const result = envelope<{ saved: boolean; size: number }>(
      await api(server.baseUrl, 'fs.write', payload({ path: join(workspace, 'notes.md'), content: '# hello' })),
    )
    expect(result.ok).toBe(true)
    expect(await readFile(join(workspace, 'notes.md'), 'utf8')).toBe('# hello')
    const leftovers = (await readdir(workspace)).filter(name => name.includes('.zdsh-tmp-'))
    expect(leftovers).toEqual([])
  })

  it('refuses .. escapes and out-of-workspace symlinks', async () => {
    const escaped = envelope<never>(await api(server.baseUrl, 'fs.read', payload({ path: join(workspace, '..', 'elsewhere') })))
    expect(escaped.error?.code).toBe('outside-workspace')

    const outsideDir = await mkdtemp(join(tmpdir(), 'wb-outside-'))
    try {
      await writeFile(join(outsideDir, 'secret.txt'), 's')
      await symlink(join(outsideDir, 'secret.txt'), join(workspace, 'link.txt'))
      const linked = envelope<never>(await api(server.baseUrl, 'fs.read', payload({ path: join(workspace, 'link.txt') })))
      expect(linked.error?.code).toBe('outside-workspace')
    } finally {
      await rm(outsideDir, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('renames and deletes with directory protection', async () => {
    await writeFile(join(workspace, 'from.txt'), 'data')
    await mkdir(join(workspace, 'adir'))

    const moved = envelope<{ moved: boolean }>(
      await api(server.baseUrl, 'fs.rename', payload({ from: join(workspace, 'from.txt'), to: join(workspace, 'to.txt') })),
    )
    expect(moved.ok).toBe(true)
    expect(await readFile(join(workspace, 'to.txt'), 'utf8')).toBe('data')

    const refused = envelope<never>(await api(server.baseUrl, 'fs.delete', payload({ path: join(workspace, 'adir') })))
    expect(refused.error?.code).toBe('is-directory')

    const deleted = envelope<{ deleted: boolean }>(
      await api(server.baseUrl, 'fs.delete', payload({ path: join(workspace, 'adir'), recursive: true })),
    )
    expect(deleted.ok).toBe(true)
  })

  it('searches names while skipping hidden and vendored trees', async () => {
    await writeFile(join(workspace, 'target-file.ts'), 'x')
    await mkdir(join(workspace, '.hidden'))
    await writeFile(join(workspace, '.hidden', 'target-file.ts'), 'x')
    await mkdir(join(workspace, 'node_modules'))
    await writeFile(join(workspace, 'node_modules', 'target-file.ts'), 'x')
    const result = envelope<{ matches: Array<{ path: string }>; truncated: boolean }>(
      await api(server.baseUrl, 'fs.search', payload({ query: 'TARGET-FILE' })),
    )
    expect(result.ok).toBe(true)
    const paths: Array<{ path: string }> = result.value?.matches ?? []
    expect(paths.some(match => match.path.includes('node_modules'))).toBe(false)
    expect(paths.some(match => match.path.includes('.hidden'))).toBe(false)
    expect(paths.some(match => match.path.endsWith('target-file.ts'))).toBe(true)
  })
})
