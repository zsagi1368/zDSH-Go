/**
 * Git route integration against a REAL temporary repository. The suite's
 * local `user.*` config exists only inside the throwaway repo so commits can
 * run deterministically; the product code itself never touches identity.
 */
import { createServer, type Server } from 'node:http'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { apply } from '../src/index.ts'
import type { WebRoute } from '../src/context-types.ts'

let workspace = ''
let plainDir = ''
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
  const httpServer: Server = createServer((req, res) => {
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
    routes,
    close: () =>
      new Promise((resolveClose) => {
        httpServer.close(() =>{  resolveClose() })
      }),
  }
}

function gitIn(repo: string, args: string[]): void {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' })
  if (result.status !== 0 && result.status !== 1) {
    // status may exit 1 with differences? no—status exits 0; keep guard tight.
    if (args[0] !== 'commit' || result.status !== 128) {
      throw new Error(`git ${args.join(' ')} failed: ${result.stderr ?? ''}`)
    }
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
  workspace = await mkdtemp(join(tmpdir(), 'wb-git-'))
  plainDir = await mkdtemp(join(tmpdir(), 'wb-plain-'))
  gitIn(workspace, ['init', '-b', 'main'])
  gitIn(workspace, ['config', 'user.email', 'suite@example.invalid'])
  gitIn(workspace, ['config', 'user.name', 'Workbench Suite'])
  await writeFile(join(workspace, 'seed.txt'), 'seed\n')
  gitIn(workspace, ['add', '--', 'seed.txt'])
  gitIn(workspace, ['commit', '-m', 'seed'])
  server = await startServer()
})

afterEach(async () => {
  await server.close()
  await rm(workspace, { recursive: true, force: true }).catch(() => {})
  await rm(plainDir, { recursive: true, force: true }).catch(() => {})
})

describe('git api integration', () => {
  it('reports branch and untracked files', async () => {
    await writeFile(join(workspace, 'new.txt'), 'x')
    const result = await api<{ ok: boolean; value?: { branch: string; entries: Array<{ path: string; untracked: boolean }> }; error?: { code: string } }>('git.status', { cwd: workspace })
    expect(result.ok).toBe(true)
    expect(result.value?.branch).toContain('main')
    expect(result.value?.entries.some(entry => entry.path === 'new.txt' && entry.untracked)).toBe(true)
  })

  it('stages, shows cached diff, commits, and logs', async () => {
    await writeFile(join(workspace, 'seed.txt'), 'seed changed\n')
    const diffBefore = await api<{ value?: string }>('git.diff', { cwd: workspace, path: 'seed.txt' })
    expect(diffBefore.value).toContain('+seed changed')

    const staged = await api<{ ok: boolean }>('git.stage', { cwd: workspace, paths: [join(workspace, 'seed.txt')] })
    expect(staged.ok).toBe(true)
    const cached = await api<{ value?: string }>('git.diffCached', { cwd: workspace, path: 'seed.txt' })
    expect(cached.value).toContain('+seed changed')

    const committed = await api<{ ok: boolean }>('git.commit', { cwd: workspace, message: 'suite commit' })
    expect(committed.ok).toBe(true)
    const log = await api<{ value?: Array<{ subject: string }> }>('git.log', { cwd: workspace, limit: 5 })
    expect(log.value?.[0]?.subject).toBe('suite commit')
  })

  it('refuses paths that leave the workspace', async () => {
    const result = await api<{ ok: boolean; error?: { code: string } }>('git.stage', {
      cwd: workspace,
      paths: [join(workspace, '..', 'outside.txt')],
    })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('outside-workspace')
  })

  it('answers network actions with a confirmation preview first', async () => {
    const result = await api<{ ok: boolean; value?: { requiresConfirmation: boolean; action: string } }>('git.push', { cwd: workspace })
    expect(result.ok).toBe(true)
    expect(result.value?.requiresConfirmation).toBe(true)
    expect(result.value?.action).toBe('push')
  })

  it('flags directories that are not repositories', async () => {
    const result = await api<{ ok: boolean; error?: { code: string } }>('git.status', { cwd: plainDir })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('not-a-repository')
  })
})
