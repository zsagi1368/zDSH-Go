/**
 * findProjectRoot (S-43 M1, C-04): the project root is the nearest ancestor
 * carrying a `.git` directory, or `cwd` itself when none exists. C-04 pins the
 * "no .git → cwd is the root" boundary so future changes cannot silently move
 * the scope.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { findProjectRoot } from '../src/find-project-root.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-ppr-root-'))
  roots.push(root)
  return root
}

describe('findProjectRoot (C-04)', () => {
  it('uses cwd itself as the root when no ancestor carries a .git directory', () => {
    const root = makeRoot()
    const nested = join(root, 'a', 'b', 'c')
    mkdirSync(nested, { recursive: true })
    expect(findProjectRoot(nested)).toBe(nested)
    expect(findProjectRoot(root)).toBe(root)
  })

  it('walks up to the nearest ancestor carrying a .git directory', () => {
    const root = makeRoot()
    const nested = join(root, 'a', 'b')
    mkdirSync(nested, { recursive: true })
    mkdirSync(join(root, '.git'))
    expect(findProjectRoot(nested)).toBe(root)
  })

  it('prefers the nearest .git over a higher one', () => {
    const root = makeRoot()
    mkdirSync(join(root, '.git'))
    const mid = join(root, 'mid')
    mkdirSync(mid, { recursive: true })
    mkdirSync(join(mid, '.git'))
    const deep = join(mid, 'deep')
    mkdirSync(deep, { recursive: true })
    expect(findProjectRoot(deep)).toBe(mid)
  })

  it('treats a .git FILE (worktree) as a root marker too', () => {
    const root = makeRoot()
    const worktree = join(root, 'worktree')
    mkdirSync(worktree, { recursive: true })
    writeFileSync(join(worktree, '.git'), 'gitdir: ../.git/worktrees/x')
    expect(findProjectRoot(worktree)).toBe(worktree)
  })
})
