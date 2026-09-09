/**
 * The deployment workspace clamp (`allowedRoots`) must bind EVERY surface
 * that accepts a request-declared cwd: JSON fs methods, git methods, the
 * SSE watcher registration, and the media byte route.
 */
import { createServer, type Server } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { apply } from '../src/index.ts'
import type { WebRoute } from '../src/context-types.ts'

let inside = ''
let outside = ''
let server: TestServer

interface TestServer {
  baseUrl: string
  close(): Promise<void>
}

async function startClamped(clampRoot: string): Promise<TestServer> {
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
  await apply(fakeCtx, { allowedRoots: [clampRoot] })
  const httpServer: Server = createServer((req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => {
    const parsed = new URL(req.url ?? '/', 'http://workbench.invalid')
    const exact = routes.find(route => route.kind === 'exact' && route.path === parsed.pathname)
    const prefix = routes
      // Contract semantics (webserver match()): prefix p matches p and p/<anything>.
      .filter(route => route.kind === 'prefix'
        && (parsed.pathname === route.path || parsed.pathname.startsWith(`${route.path}/`)))
      .sort((a, b) => b.path.length - a.path.length)[0]
    const handler = exact?.handler ?? prefix?.handler
    if (handler === undefined) {
      res.writeHead(404)
      res.end()
      return
    }
    void handler(req, res)
  })
  await new Promise<void>(resolveListen => httpServer.listen(0, '127.0.0.1', resolveListen))
  const address = httpServer.address()
  return {
    baseUrl: `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`,
    close: () =>
      new Promise((resolveClose) => {
        httpServer.close(() =>{  resolveClose() })
      }),
  }
}

async function api<T>(method: string, payload?: unknown): Promise<T> {
  const response = await fetch(`${server.baseUrl}/workbench/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
  })
  return (await response.json()) as T
}

beforeEach(async () => {
  inside = await mkdtemp(join(tmpdir(), 'wb-in-'))
  outside = await mkdtemp(join(tmpdir(), 'wb-out-'))
  await writeFile(join(inside, 'ok.txt'), 'in')
  await writeFile(join(outside, 'secret.txt'), 'out')
  await mkdir(join(outside), { recursive: true })
  server = await startClamped(inside)
})

afterEach(async () => {
  await server.close()
  await rm(inside, { recursive: true, force: true }).catch(() => {})
  await rm(outside, { recursive: true, force: true }).catch(() => {})
})

describe('deployment workspace clamp', () => {
  it('allows reads whose cwd is inside the clamp', async () => {
    const result = await api<{ ok: boolean; value?: { content: string } }>('fs.read', { cwd: inside, path: join(inside, 'ok.txt') })
    expect(result.ok).toBe(true)
    expect(result.value?.content).toBe('in')
  })

  it('rejects fs reads declared against an outside cwd', async () => {
    const result = await api<{ ok: boolean; error?: { code: string } }>('fs.read', { cwd: outside, path: join(outside, 'secret.txt') })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('outside-workspace')
  })

  it('rejects git operations against an outside cwd', async () => {
    const result = await api<{ ok: boolean; error?: { code: string } }>('git.status', { cwd: outside })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('outside-workspace')
  })

  it('refuses the media byte route for an outside cwd', async () => {
    const url = `${server.baseUrl}/workbench/file?cwd=${encodeURIComponent(outside)}&path=${encodeURIComponent(join(outside, 'secret.txt'))}`
    const response = await fetch(url)
    expect(response.status).toBe(403)
  })

  // Note: SSE watcher-root filtering lives in the events route (roots are
  // resolved through the same rootCache + clamp before addRoots); asserting
  // it over real sockets belongs to the mount-e2e lane, not unit tests.
})
