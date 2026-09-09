/**
 * Route-contract integration for the two webserver-contract seams:
 *
 * 1. Registrations follow the vendored webserver contract — absolute
 *    pathnames with no trailing slash, where prefix `p` matches `p` and
 *    `p/<anything>`. The API route used to register with a trailing slash,
 *    which the real matcher never matched for deep paths (`/workbench/api/`
    + `/fs/list` would need a double slash), 404ing every dock API call.
 * 2. The dock SPA face serves the composing web frontend's index for
 *    `/workbench` paths no workbench endpoint claims, behind the browser
 *    trust fence and index authentication.
 *
 * The harness mirrors WebServer.match() exactly (exact table first, then
 * longest prefix over `p` and `p/<anything>`), so these tests fail if a
 * registration ever drifts from the contract again.
 */
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { apply, internals } from '../src/index.ts'
import type { WebRoute } from '../src/context-types.ts'

interface TestServer {
  baseUrl: string
  routes: WebRoute[]
  close(): Promise<void>
}

async function startServer(authorized = true): Promise<TestServer> {
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
      renderIndex: (html: string) => html,
    },
    connection: {
      // Production authorizeIndex writes the 401 challenge itself; mirror that.
      authorizeIndex(_req: unknown, res: import('node:http').ServerResponse): boolean {
        if (!authorized) {
          res.writeHead(401)
          res.end()
        }
        return authorized
      },
    },
  } as unknown as Context
  await apply(fakeCtx)

  // Contract-faithful dispatch mirroring WebServer.match(): exact table
  // first, then longest-prefix-wins over `p` and `p/<anything>`.
  const server: Server = createServer((req, res) => {
    const parsed = new URL(req.url ?? '/', 'http://workbench.invalid')
    const exact = routes.find(route => route.kind === 'exact' && route.path === parsed.pathname)
    let best: WebRoute | undefined
    for (const route of routes) {
      if (route.kind !== 'prefix') continue
      if (parsed.pathname !== route.path && !parsed.pathname.startsWith(`${route.path}/`)) continue
      if (best === undefined || route.path.length > best.path.length) best = route
    }
    const handler = exact?.handler ?? best?.handler
    if (handler === undefined) {
      res.writeHead(404)
      res.end()
      return
    }
    void handler(req, res)
  })
  await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
  const address = server.address()
  return {
    baseUrl: `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`,
    routes,
    close: () =>
      new Promise((resolveClose) => {
        server.close(() => { resolveClose() })
      }),
  }
}

let dist = ''
let server: TestServer
const originalResolveSpaIndex = internals.resolveSpaIndex

beforeEach(async () => {
  dist = await mkdtemp(join(tmpdir(), 'wb-spa-'))
  await writeFile(
    join(dist, 'index.html'),
    '<!doctype html>\n<html><head><title>spa</title></head><body>workbench-spa</body></html>',
  )
  internals.resolveSpaIndex = () => join(dist, 'index.html')
  server = await startServer()
})

afterEach(async () => {
  internals.resolveSpaIndex = originalResolveSpaIndex
  await server.close()
  await rm(dist, { recursive: true, force: true }).catch(() => {})
})

describe('workbench route contract', () => {
  it('registers every route path without a trailing slash', () => {
    for (const route of server.routes) {
      expect(route.path.startsWith('/') && !route.path.endsWith('/'), route.path).toBe(true)
    }
    expect(server.routes.map(route => route.path)).toEqual(expect.arrayContaining([
      '/workbench/api',
      '/workbench/events',
      '/workbench/file',
      '/workbench',
    ]))
  })

  it('routes a deep API path through the prefix contract', async () => {
    const response = await fetch(`${server.baseUrl}/workbench/api/ping`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expect(response.status).toBe(200)
    const envelope = await response.json() as { ok: boolean }
    expect(envelope.ok).toBe(true)
  })

  it('answers the bare /workbench/api endpoint with a no-route envelope, not 404', async () => {
    const response = await fetch(`${server.baseUrl}/workbench/api`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expect(response.status).toBe(200)
    const envelope = await response.json() as { ok: boolean; error?: { code?: string } }
    expect(envelope.ok).toBe(false)
    expect(envelope.error?.code).toBe('no-route')
  })

  it('serves the SPA index on /workbench and its deep paths', async () => {
    for (const path of ['/workbench', '/workbench/deep/link']) {
      const response = await fetch(`${server.baseUrl}${path}`)
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
      const body = await response.text()
      expect(body).toContain('<base href="/">')
      expect(body).toContain('workbench-spa')
    }
  })

  it('rejects non-GET/HEAD on the SPA face with 405', async () => {
    const response = await fetch(`${server.baseUrl}/workbench/deep`, { method: 'POST', body: '{}' })
    expect(response.status).toBe(405)
  })

  it('answers 404 when the composing dist index is absent', async () => {
    internals.resolveSpaIndex = () => join(dist, 'missing.html')
    const absent = await startServer()
    try {
      const response = await fetch(`${absent.baseUrl}/workbench`)
      expect(response.status).toBe(404)
    } finally {
      await absent.close()
    }
  })

  it('degrades to no SPA face when the frontend package is absent', async () => {
    internals.resolveSpaIndex = () => undefined
    const bare = await startServer()
    try {
      expect(bare.routes.some(route => route.path === '/workbench')).toBe(false)
      const response = await fetch(`${bare.baseUrl}/workbench`)
      expect(response.status).toBe(404)
    } finally {
      await bare.close()
    }
  })

  it('refuses unauthenticated index requests with 401', async () => {
    const gated = await startServer(false)
    try {
      const response = await fetch(`${gated.baseUrl}/workbench`)
      expect(response.status).toBe(401)
    } finally {
      await gated.close()
    }
  })
})
