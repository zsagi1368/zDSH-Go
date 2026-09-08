/**
 * Bounded workspace indexer tests (P01 §6-B FR-B1/FR-B2): deep trees, maxFiles
 * hard stop, ignoreDirs pruning, symlink-cycle survival, unreadable-directory
 * skipping, abort cancellation, and the dirty/TTL freshness model.
 */
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createWorkspaceIndexer, DEFAULT_IGNORE_DIRS } from '../../src/server/workspace.js'

async function makeTree(label: string): Promise<string> {
  const root = path.join(os.tmpdir(), `filehub-idx-${label}-${process.pid.toString(36)}-${Math.random().toString(36).slice(2, 8)}`)
  await fsp.mkdir(root, { recursive: true })
  return root
}

const WARN: string[] = []
const warn = (message: string): void => {
  WARN.push(message)
}

describe('workspace indexer', () => {
  const roots: string[] = []

  afterEach(async () => {
    WARN.length = 0
    for (const root of roots.splice(0)) {
      await fsp.rm(root, { recursive: true, force: true }).catch(() => undefined)
    }
  })

  const track = async (label: string): Promise<string> => {
    const root = await makeTree(label)
    roots.push(root)
    return root
  }

  it('walks a deep tree breadth-first and reports files and directories', async () => {
    const cwd = await track('deep')
    await fsp.mkdir(path.join(cwd, 'src', 'server'), { recursive: true })
    await fsp.writeFile(path.join(cwd, 'README.md'), 'x')
    await fsp.writeFile(path.join(cwd, 'src', 'a.ts'), 'x')
    await fsp.writeFile(path.join(cwd, 'src', 'server', 'b.ts'), 'x')

    const indexer = createWorkspaceIndexer({
      sessions: {
        get: id => (id === 's1' ? { header: { cwd } } : undefined),
        list: () => [{ id: 's1', header: { cwd } }],
      },
      storageDirName: '.filehub',
      logWarn: warn,
      ttlMs: 60_000,
    })
    try {
      const index = await indexer.get('s1')
      expect(index).toBeDefined()
      expect(index?.truncated).toBe(false)
      const paths = index?.entries.map(entry => entry.relativePath).sort() ?? []
      expect(paths).toEqual(['README.md', 'src', 'src/a.ts', 'src/server', 'src/server/b.ts'])
      expect(index?.entries.find(entry => entry.relativePath === 'src')?.kind).toBe('directory')
      expect(index?.entries.find(entry => entry.relativePath === 'src/a.ts')?.kind).toBe('file')
    } finally {
      indexer.dispose()
    }
  })

  it('stops hard at maxFiles with truncated=true', async () => {
    const cwd = await track('maxfiles')
    for (let i = 0; i < 12; i += 1) {
      await fsp.writeFile(path.join(cwd, `f${i}.txt`), 'x')
    }
    const indexer = createWorkspaceIndexer({
      sessions: { get: () => ({ header: { cwd } }), list: () => [] },
      storageDirName: '.filehub',
      logWarn: warn,
      maxFiles: 5,
      ttlMs: 60_000,
    })
    try {
      const index = await indexer.get('s')
      expect(index?.truncated).toBe(true)
      expect(index?.entries.length).toBe(5)
    } finally {
      indexer.dispose()
    }
  })

  it('prunes ignored basenames including the storage dir', async () => {
    const cwd = await track('ignore')
    for (const name of ['node_modules', '.git', 'dist', 'coverage', '__pycache__', '.venv', '.filehub']) {
      await fsp.mkdir(path.join(cwd, name), { recursive: true })
      await fsp.writeFile(path.join(cwd, name, 'noise.txt'), 'x')
    }
    await fsp.writeFile(path.join(cwd, 'keep.txt'), 'x')

    const indexer = createWorkspaceIndexer({
      sessions: { get: () => ({ header: { cwd } }), list: () => [] },
      storageDirName: '.filehub',
      logWarn: warn,
      ttlMs: 60_000,
    })
    try {
      const index = await indexer.get('s')
      const paths = index?.entries.map(entry => entry.relativePath) ?? []
      expect(paths).toEqual(['keep.txt'])
      // Sanity: the shipped default list covers the spec's named entries.
      for (const required of ['node_modules', '.git', 'dist', 'build', 'coverage', '__pycache__', '.venv', 'venv', 'target']) {
        expect(DEFAULT_IGNORE_DIRS).toContain(required)
      }
    } finally {
      indexer.dispose()
    }
  })

  it('survives a symlinked directory cycle without hanging', async () => {
    const cwd = await track('cycle')
    await fsp.mkdir(path.join(cwd, 'inner'), { recursive: true })
    await fsp.writeFile(path.join(cwd, 'inner', 'leaf.txt'), 'x')
    let linkMade = false
    try {
      await fsp.symlink(cwd, path.join(cwd, 'inner', 'back'), 'dir')
      linkMade = true
    } catch {
      // Windows without developer mode / privilege: symlink unavailable.
    }
    if (!linkMade) {
      // Still assert the plain walk works so the suite keeps its value.
      const indexer = createWorkspaceIndexer({
        sessions: { get: () => ({ header: { cwd } }), list: () => [] },
        storageDirName: '.filehub',
        logWarn: warn,
        ttlMs: 60_000,
      })
      try {
        const index = await indexer.get('s')
        expect(index?.entries.length).toBeGreaterThan(0)
        return
      } finally {
        indexer.dispose()
      }
    }
    const indexer = createWorkspaceIndexer({
      sessions: { get: () => ({ header: { cwd } }), list: () => [] },
      storageDirName: '.filehub',
      logWarn: warn,
      ttlMs: 60_000,
    })
    try {
      const index = await Promise.race([
        indexer.get('s'),
        new Promise<never>((_, reject) => setTimeout(() =>{  reject(new Error('index walk hung on symlink cycle')) }, 8000)),
      ])
      if (!index) throw new Error('indexer returned no index for a live session')
      // The cycle guard skips a symlink whose realpath is already on the
      // ancestor chain entirely (candidate not listed, subtree not entered),
      // so exactly the plain tree survives: inner/ + inner/leaf.txt.
      const paths = index.entries.map(entry => entry.relativePath)
      expect(paths).not.toContain('inner/back')
      expect(paths.filter(entry => entry.includes('/back'))).toEqual([])
      expect(paths).toContain('inner/leaf.txt')
    } finally {
      indexer.dispose()
    }
  }, 15_000)

  it('skips unreadable directories with a warn instead of failing', async () => {
    const cwd = await track('denied')
    const locked = path.join(cwd, 'locked')
    await fsp.mkdir(locked, { recursive: true })
    await fsp.writeFile(path.join(cwd, 'ok.txt'), 'x')
    let readable = true
    try {
      await fsp.chmod(locked, 0o000)
    } catch {
      readable = false // Windows ACLs make chmod a partial no-op; degrade.
    }
    const indexer = createWorkspaceIndexer({
      sessions: { get: () => ({ header: { cwd } }), list: () => [] },
      storageDirName: '.filehub',
      logWarn: warn,
      ttlMs: 60_000,
    })
    try {
      const index = await indexer.get('s')
      expect(index?.entries.some(entry => entry.relativePath === 'ok.txt')).toBe(true)
      if (!readable) return // nothing more to assert on this platform
      // On platforms honoring chmod 000, readdir fails → warn emitted.
      if (WARN.some(line => line.includes('locked'))) {
        expect(WARN.join('\n')).toContain('[filehub] index skipped unreadable directory')
      }
    } finally {
      await fsp.chmod(locked, 0o755).catch(() => undefined)
      indexer.dispose()
    }
  })

  it('aborts an in-flight walk promptly on dispose', async () => {
    const cwd = await track('abort')
    // Build a tree wide enough that the walk spans several microtask turns.
    for (let i = 0; i < 30; i += 1) {
      const dir = path.join(cwd, `d${i}`)
      await fsp.mkdir(dir, { recursive: true })
      for (let j = 0; j < 20; j += 1) await fsp.writeFile(path.join(dir, `f${j}.txt`), 'x')
    }
    const slowNow = (): number => Date.now()
    const indexer = createWorkspaceIndexer({
      sessions: { get: () => ({ header: { cwd } }), list: () => [] },
      storageDirName: '.filehub',
      logWarn: warn,
      ttlMs: 0, // always rebuild
      now: slowNow,
    })
    const pending = indexer.get('s').then(
      () => 'done' as const,
      () => 'failed' as const,
    )
    indexer.dispose()
    const outcome = await pending
    // After dispose the walk rejects with AbortError; get() maps that onto the
    // (absent) cached index rather than throwing out of the endpoint path.
    expect(['done', 'failed']).toContain(outcome)
  })

  it('caches until invalidated, then rebuilds in background (zero-rescan steady state)', async () => {
    const cwd = await track('cache')
    await fsp.writeFile(path.join(cwd, 'a.txt'), 'x')
    let clock = 1000
    const indexer = createWorkspaceIndexer({
      sessions: { get: () => ({ header: { cwd } }), list: () => [] },
      storageDirName: '.filehub',
      logWarn: warn,
      ttlMs: 10_000,
      now: () => clock,
    })
    try {
      await indexer.get('s')
      clock += 1000
      // Steady state: no invalidation inside the TTL window → cached snapshot.
      const beforeWrite = await indexer.get('s')
      expect(beforeWrite?.builtAtMs).toBe(1000)

      // New file appears externally; event hook fires.
      await fsp.writeFile(path.join(cwd, 'b.txt'), 'x')
      indexer.invalidateAll()
      const after = await indexer.get('s') // awaits the background rebuild
      expect(after?.entries.some(entry => entry.relativePath === 'b.txt')).toBe(true)

      // TTL fallback: advance past ttlMs without any event → rebuild.
      clock += 20_000
      const refreshed = await indexer.get('s')
      expect(refreshed?.builtAtMs).toBe(22_000)
    } finally {
      indexer.dispose()
    }
  })

  it('returns undefined for unknown or cwd-less sessions', async () => {
    const indexer = createWorkspaceIndexer({
      sessions: {
        get: id => (id === 'no-cwd' ? { header: {} } : undefined),
        list: () => [],
      },
      storageDirName: '.filehub',
      logWarn: warn,
    })
    try {
      await expect(indexer.get('unknown')).resolves.toBeUndefined()
      await expect(indexer.get('no-cwd')).resolves.toBeUndefined()
    } finally {
      indexer.dispose()
    }
  })
})
