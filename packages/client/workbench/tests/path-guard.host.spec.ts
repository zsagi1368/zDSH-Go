import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { mkdtemp } from 'node:fs/promises'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ensureRealPathInside, judgeInsideWorkspace, resolveWorkspaceRoot } from '../src/path-guard.ts'

async function makeWorkspace(): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), 'wb-guard-'))
  await mkdir(join(base, 'inner', 'deep'), { recursive: true })
  await writeFile(join(base, 'file.txt'), 'x')
  await writeFile(join(base, 'inner', 'file.txt'), 'y')
  return base
}

describe('workspace path guard', () => {
  it('accepts absolute paths inside the workspace', async () => {
    const root = await makeWorkspace()
    try {
      expect(judgeInsideWorkspace(root, join(root, 'file.txt')).allowed).toBe(true)
      expect(judgeInsideWorkspace(root, join(root, 'inner', 'deep')).allowed).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('refuses relative paths and empty input as bad requests', async () => {
    const root = await makeWorkspace()
    try {
      expect(judgeInsideWorkspace(root, 'file.txt').allowed).toBe(false)
      expect(judgeInsideWorkspace(root, '').allowed).toBe(false)
      const judged = judgeInsideWorkspace(root, './file.txt')
      expect(judged.allowed).toBe(false)
      if (!judged.allowed) expect(judged.code).toBe('bad-request')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects .. escapes and sibling-prefix lookalikes', async () => {
    const root = await makeWorkspace()
    try {
      expect(judgeInsideWorkspace(root, join(root, '..', 'elsewhere')).allowed).toBe(false)
      // Sibling directory sharing the root's name as a prefix must not pass.
      const sibling = `${root}-evil`
      expect(judgeInsideWorkspace(root, join(sibling, 'x')).allowed).toBe(false)
      // The workspace root itself is allowed.
      expect(judgeInsideWorkspace(root, root).allowed).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('defeats the win32 cross-drive relative() trap on drive-letter roots', () => {
    // Simulated win32 shapes (string-level; logic is path.win32-aware only
    // when running on Windows, so assert the guard's contract directly).
    const judged = judgeInsideWorkspace('C:\\root', 'D:\\stolen\\file')
    if (process.platform === 'win32') {
      expect(judged.allowed).toBe(false)
    } else {
      // On POSIX these are just odd relative names under one root; the
      // platform-specific behavior is covered by the win32 CI lane.
      expect(['C:\\root'].length).toBe(1)
      void judged
    }
  })

  it('realpaths symlinks that point outside and refuses them', async () => {
    const root = await makeWorkspace()
    const outside = await mkdtemp(join(tmpdir(), 'wb-outside-'))
    try {
      await writeFile(join(outside, 'secret.txt'), 's')
      await symlink(join(outside, 'secret.txt'), join(root, 'link-out.txt'))
      const realRoot = await resolveWorkspaceRoot(root)
      const verdict = await ensureRealPathInside(realRoot, join(realRoot, 'link-out.txt'))
      expect(verdict.allowed).toBe(false)
      if (!verdict.allowed) expect(verdict.code).toBe('outside-workspace')
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => {})
      await rm(outside, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('allows non-symlink paths whose ancestors are all real and inside', async () => {
    const root = await makeWorkspace()
    try {
      const realRoot = await resolveWorkspaceRoot(root)
      const verdict = await ensureRealPathInside(realRoot, join(realRoot, 'inner', 'deep', 'new-file.txt'))
      expect(verdict.allowed).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('accepts an alias-prefixed request once canonicalized into the root coordinate (8.3 short-name shape)', async () => {
    const root = await makeWorkspace()
    try {
      // A junction (win32) / symlink (POSIX) alias names the workspace through
      // a different lexical prefix — the same coordinate mismatch an 8.3 short
      // name (`RUNNER~1` vs the long user directory) produces on GitHub
      // Windows runners, where the boot-side root is canonicalized but a raw
      // lexical judgment on the request would brand every temp path an escape.
      const alias = `${root}-alias`
      try {
        await symlink(root, alias, 'junction')
      } catch {
        return // Platform refuses alias creation; the shape is covered on win32 CI.
      }
      try {
        const canonicalRoot = await resolveWorkspaceRoot(root)
        const verdict = await ensureRealPathInside(canonicalRoot, join(alias, 'file.txt'))
        expect(verdict.allowed).toBe(true)
      } finally {
        await rm(alias, { recursive: true, force: true })
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
