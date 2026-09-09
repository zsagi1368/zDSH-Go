import { createServer, type Server } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { apply } from '../src/index.ts'
import type { WebRoute } from '../src/context-types.ts'

let workspace = ''
let server: TestServer

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
  const httpServer: Server = createServer((req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => {
    const parsed = new URL(req.url ?? '/', 'http://workbench.invalid')
    const exact = routes.find(route => route.kind === 'exact' && route.path === parsed.pathname)
    const prefix = routes
      // Contract semantics (webserver match()): prefix p matches p and p/<anything>.
      .filter(route => route.kind === 'prefix'
        && (parsed.pathname === route.path || parsed.pathname.startsWith(`${route.path}/`)))
      .sort((a, b) => b.path.length - a.path.length)[0]
    // Exact wins over prefix regardless of registration order (media route
    // must not be shadowed by the /workbench/api prefix — they do not overlap,
    // but the harness mirrors the documented match order anyway).
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
    routes,
    close: () =>
      new Promise((resolveClose) => {
        httpServer.close(() =>{  resolveClose() })
      }),
  }
}

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'wb-media-'))
  server = await startServer()
})

afterEach(async () => {
  await server.close()
  await rm(workspace, { recursive: true, force: true }).catch(() => {})
})

describe('media byte route', () => {
  it('streams exact bytes with a conservative content type', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
    await writeFile(join(workspace, 'pic.png'), png)
    const url = `${server.baseUrl}/workbench/file?cwd=${encodeURIComponent(workspace)}&path=${encodeURIComponent(join(workspace, 'pic.png'))}`
    const response = await fetch(url)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(Buffer.from(await response.arrayBuffer())).toEqual(png)
  })

  it('offers attachment disposition on download=1 and refuses escapes', async () => {
    await writeFile(join(workspace, 'notes.txt'), 'hello')
    const download = await fetch(`${server.baseUrl}/workbench/file?cwd=${encodeURIComponent(workspace)}&path=${encodeURIComponent(join(workspace, 'notes.txt'))}&download=1`)
    expect(download.headers.get('content-disposition') ?? '').toContain('attachment')

    const escaped = await fetch(`${server.baseUrl}/workbench/file?cwd=${encodeURIComponent(workspace)}&path=${encodeURIComponent(join(workspace, '..', 'x'))}`)
    expect(escaped.status).toBe(403)
  })
})
