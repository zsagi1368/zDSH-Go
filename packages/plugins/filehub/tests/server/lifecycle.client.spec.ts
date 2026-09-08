/**
 * Lifecycle domain (P01 §6-A / §9-F): TTL sweeper across ALL sessions (the
 * historical bug swept only the first), interval start/dispose, idempotent
 * DELETE with containment (sibling-prefix attack, cross-drive), and the
 * bounded list endpoint.
 */
import http from 'node:http'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createMemoryMetaStore } from '../../src/server/meta.js'
import type { MetaStore } from '../../src/server/meta.js'
import { createLifecycle } from '../../src/server/lifecycle.js'
import { createWorkspaceResolver } from '../../src/server/workspace.js'
import type { SessionsLike } from '../../src/server/workspace.js'
import {
  makeDomain,
  makeTempDir,
  rawRequest,
  removeTempDir,
  startRouteServer,
  uploadRequest,
  defaultTestConfig,
  type RunningServer,
} from './helpers.client.js'

const isWindows = process.platform === 'win32'

describe('sweeper', () => {
  it('expires files across ALL sessions — including dead ones found via metadata — and prunes empty dirs', async () => {
    const tmp = await makeTempDir('sweep')
    try {
      const cwdA = path.join(tmp, 'a-ws')
      const rootA = path.join(cwdA, '.filehub')
      const cwdB = path.join(tmp, 'b-ws')
      const rootB = path.join(cwdB, '.filehub')
      await fsp.mkdir(path.join(rootA, 'sub'), { recursive: true })
      await fsp.mkdir(rootB, { recursive: true })

      const oldMs = Date.now() - 10 * 24 * 60 * 60 * 1000 // 10 days old; TTL is 7 days
      await fsp.writeFile(path.join(rootA, 'a-old.txt'), 'old a')
      await fsp.utimes(path.join(rootA, 'a-old.txt'), oldMs / 1000, oldMs / 1000)
      await fsp.writeFile(path.join(rootA, 'sub', 'b-fresh.txt'), 'fresh')
      await fsp.writeFile(path.join(rootB, 'c-old-deep.txt'), 'old c')
      const metaC = Date.now() - 9 * 24 * 60 * 60 * 1000

      // Session A is LIVE in the store; session B has left the store and is
      // only discoverable through the metadata cwd memory.
      const sessions: SessionsLike = {
        get(id) {
          return id === 'live-a' ? { id, header: { cwd: cwdA } } : undefined
        },
        list() {
          return [{ id: 'live-a', header: { cwd: cwdA } }]
        },
      }
      const meta: MetaStore = createMemoryMetaStore()
      await meta.record('dead-b', 'c-old-deep.txt', { sizeBytes: 5, uploadedAtMs: metaC }, cwdB)

      const lifecycle = createLifecycle({
        ttlMs: 7 * 24 * 60 * 60 * 1000,
        meta,
        workspaces: createWorkspaceResolver(sessions, '.filehub'),
        storageRootOf: cwd => path.join(cwd, '.filehub'),
        logInfo: () => undefined,
        logWarn: () => undefined,
      })

      const report = await lifecycle.sweep()
      expect(report.workspaces).toBe(2) // BOTH workspaces visited (not just the first!)
      expect(report.deleted).toBe(2)

      await expect(fsp.access(path.join(rootA, 'a-old.txt'))).rejects.toBeTruthy()
      await expect(fsp.access(path.join(rootB, 'c-old-deep.txt'))).rejects.toBeTruthy()
      await expect(fsp.access(path.join(rootA, 'sub', 'b-fresh.txt'))).resolves.toBeUndefined()
      // Empty parents of deleted files are pruned; non-empty ones survive.
      await expect(fsp.access(rootA)).resolves.toBeUndefined()
      await expect(fsp.access(rootB)).resolves.toBeUndefined()
      // Metadata row for the deleted file cleaned up.
      expect(Object.keys((await meta.get('dead-b')).files)).toHaveLength(0)
    } finally {
      await removeTempDir(tmp)
    }
  })
})

describe('domain-level sweeper clock', () => {
  it('runs on the interval automatically and stops after dispose()', async () => {
    const tmp = await makeTempDir('clock')
    try {
      const cwd = path.join(tmp, 'ws')
      const root = path.join(cwd, '.filehub')
      await fsp.mkdir(root, { recursive: true })
      const { domain } = makeDomain([{ id: 'clock-s1', cwd }], {
        ...defaultTestConfig(),
        lifecycle: { ttlMs: 0 /* everything expires immediately */, sweepIntervalMs: 25 },
      })

      // The interval sweep removes an expired file without manual nudging.
      await fsp.writeFile(path.join(root, 'auto-expire.txt'), 'gone soon')
      let gone = false
      for (let i = 0; i < 40 && !gone; i += 1) {
        await new Promise(resolve => setTimeout(resolve, 15))
        gone = await fsp
          .access(path.join(root, 'auto-expire.txt'))
          .then(() => false)
          .catch(() => true)
      }
      expect(gone).toBe(true)

      domain.dispose()

      // After dispose the clock is stopped: nothing removes later expired files.
      await fsp.writeFile(path.join(root, 'after-dispose.txt'), 'stays')
      await new Promise(resolve => setTimeout(resolve, 120))
      await expect(fsp.access(path.join(root, 'after-dispose.txt'))).resolves.toBeUndefined()
    } finally {
      await removeTempDir(tmp)
    }
  }, 20_000)
})

describe('DELETE /api/filehub/file', () => {
  interface DeleteEnv {
    tmp: string
    root: string
    port: number
    agent: http.Agent
    dispose: () => void
  }

  let env: DeleteEnv

  beforeAll(async () => {
    const tmp = await makeTempDir('delete')
    const cwd = path.join(tmp, 'ws')
    const root = path.join(cwd, '.filehub')
    await fsp.mkdir(path.join(root, 'docs'), { recursive: true })
    await fsp.writeFile(path.join(root, 'docs', 'target.txt'), 'delete me')
    const { domain, route } = makeDomain([{ id: 'del-s1', cwd }])
    const server = await startRouteServer(route)
    env = {
      tmp,
      root,
      port: server.port,
      agent: new http.Agent(),
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

  function deletePath(target: string): Promise<import('./helpers.client.js').RawResponse> {
    return rawRequest(env.agent, env.port, {
      method: 'DELETE',
      path: `/api/filehub/file?path=${encodeURIComponent(target)}`,
    })
  }

  it('deletes an existing file and answers 204', async () => {
    const target = path.join(env.root, 'docs', 'target.txt')
    const response = await deletePath(target)
    expect(response.status).toBe(204)
    await expect(fsp.access(target)).rejects.toBeTruthy()
  })

  it('is idempotent: deleting a missing file still answers 204', async () => {
    const response = await deletePath(path.join(env.root, 'docs', 'already-gone.txt'))
    expect(response.status).toBe(204)
  })

  it('answers 204 for a missing workspace root too', async () => {
    const response = await deletePath(path.join(env.root, 'no-such-dir', 'x.txt'))
    expect(response.status).toBe(204)
  })

  it('rejects the sibling-prefix attack (/root vs /rootX)', async () => {
    const sibling = `${env.root}x`
    await fsp.mkdir(sibling, { recursive: true })
    const victim = path.join(sibling, 'secret.txt')
    await fsp.writeFile(victim, 'must survive')
    const response = await deletePath(victim)
    expect(response.status).toBe(403)
    await expect(fsp.access(victim)).resolves.toBeUndefined() // untouched
    await fsp.rm(sibling, { recursive: true, force: true })
  })

  it('rejects paths outside any workspace', async () => {
    const response = await deletePath(path.join(env.tmp, 'outside.txt'))
    expect(response.status).toBe(403)
  })

  it.skipIf(!isWindows)('rejects cross-drive absolute paths via the relative() trap defense', async () => {
    const response = await deletePath('D:\\evil\\exfiltrate.txt')
    expect(response.status).toBe(403)
  })

  it('answers 400 when the query parameter is missing', async () => {
    const response = await rawRequest(env.agent, env.port, {
      method: 'DELETE',
      path: '/api/filehub/file',
    })
    expect(response.status).toBe(400)
  })
})

describe('GET /api/filehub/list', () => {
  interface ListEnv {
    tmp: string
    cwd: string
    port: number
    agent: http.Agent
    dispose: () => void
  }

  let env: ListEnv

  beforeAll(async () => {
    const tmp = await makeTempDir('list')
    const cwd = path.join(tmp, 'ws')
    const { domain, route } = makeDomain([{ id: 'list-s1', cwd }])
    const server = await startRouteServer(route)
    env = {
      tmp,
      cwd,
      port: server.port,
      agent: new http.Agent(),
      dispose: () => {
        domain.dispose()
        void server.close()
      },
    }
    // Seed one nested upload through the real endpoint.
    const seeded = await uploadRequest(env.agent, env.port, {
      sessionId: 'list-s1',
      fileName: 'seed.txt',
      relPath: 'nested/seed.txt',
      body: new TextEncoder().encode('seed bytes'),
    })
    if (seeded.status !== 200) throw new Error(`seeding failed: ${seeded.status}`)
  })

  afterAll(async () => {
    env.agent.destroy()
    env.dispose()
    await removeTempDir(env.tmp)
  })

  it('lists entries with contract shape, @-mention relative paths, and metadata timestamps', async () => {
    const response = await rawRequest(env.agent, env.port, {
      method: 'GET',
      path: '/api/filehub/list?sessionId=list-s1',
    })
    expect(response.status).toBe(200)
    const payload = JSON.parse(response.text) as {
      sessionId: string
      truncated: boolean
      entries: Array<{ path: string; relativePath: string; sizeBytes: number; kind: string; uploadedAtMs?: number }>
    }
    expect(payload.sessionId).toBe('list-s1')
    expect(payload.truncated).toBe(false)
    const seededEntry = payload.entries.find(
      entry => entry.kind === 'file' && entry.relativePath.endsWith('-seed.txt'),
    )
    expect(seededEntry).toBeDefined()
    expect(seededEntry?.relativePath.startsWith('.filehub/nested/')).toBe(true)
    expect(seededEntry?.sizeBytes).toBe(10)
    expect(typeof seededEntry?.uploadedAtMs).toBe('number')
    // Directory rows exist as kind=directory.
    expect(payload.entries.some(entry => entry.kind === 'directory')).toBe(true)
  })

  it('flags truncation beyond MAX_LIST_ENTRIES', async () => {
    // Create more flat files than the listing bound.
    const root = path.join(env.cwd, '.filehub', 'bulk')
    await fsp.mkdir(root, { recursive: true })
    for (let i = 0; i < 505; i += 1) {
      await fsp.writeFile(path.join(root, `f${String(i).padStart(4, '0')}.txt`), 'x')
    }
    const response = await rawRequest(env.agent, env.port, {
      method: 'GET',
      path: '/api/filehub/list?sessionId=list-s1',
    })
    expect(response.status).toBe(200)
    const payload = JSON.parse(response.text) as { truncated: boolean; entries: unknown[] }
    expect(payload.truncated).toBe(true)
    expect(payload.entries.length).toBeLessThanOrEqual(500)
  }, 30_000)

  it('answers 403 for an unknown session', async () => {
    const response = await rawRequest(env.agent, env.port, {
      method: 'GET',
      path: '/api/filehub/list?sessionId=nobody',
    })
    expect(response.status).toBe(403)
  })
})

describe('router dispatch over the prefix route', () => {
  it('answers 404 for unknown endpoints under /api/filehub', async () => {
    const tmp = await makeTempDir('router')
    try {
      const cwd = path.join(tmp, 'ws')
      await fsp.mkdir(cwd, { recursive: true })
      const { domain, route } = makeDomain([{ id: 'r-s1', cwd }])
      const server: RunningServer = await startRouteServer(route)
      try {
        const agent = new http.Agent()
        const response = await rawRequest(agent, server.port, {
          method: 'GET',
          path: '/api/filehub/nothing-here',
        })
        expect(response.status).toBe(404)
        agent.destroy()
      } finally {
        domain.dispose()
        await server.close()
      }
    } finally {
      await removeTempDir(tmp)
    }
  })

  it('keeps serving uploads end-to-end after a dispose/rebuild cycle', async () => {
    const tmp = await makeTempDir('rebuild')
    try {
      const cwd = path.join(tmp, 'ws')
      await fsp.mkdir(cwd, { recursive: true })
      const first = makeDomain([{ id: 'rb-s1', cwd }])
      const serverOne = await startRouteServer(first.route)
      const gone = await uploadRequest(new http.Agent(), serverOne.port, {
        sessionId: 'rb-s1',
        fileName: 'before.txt',
        body: new Uint8Array([1]),
      })
      expect(gone.status).toBe(200)
      first.domain.dispose()
      await serverOne.close()

      const second = makeDomain([{ id: 'rb-s1', cwd }])
      const serverTwo = await startRouteServer(second.route)
      try {
        const again = await uploadRequest(new http.Agent(), serverTwo.port, {
          sessionId: 'rb-s1',
          fileName: 'after.txt',
          body: new Uint8Array([2]),
        })
        expect(again.status).toBe(200)
      } finally {
        second.domain.dispose()
        await serverTwo.close()
      }
    } finally {
      await removeTempDir(tmp)
    }
  })
})
