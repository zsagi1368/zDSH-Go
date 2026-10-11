/**
 * Project trust ledger suite (S-43 M2a, C-02): root × plugin-id double-keyed
 * enable/disable decisions persisted in project-trusts.json with approvals-ledger
 * narrowing/fail-closed semantics.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  emptyProjectTrusts,
  loadProjectTrusts,
  saveProjectTrusts,
  trustProjectRoot,
  decideProjectPlugin,
  shouldMountProjectPlugin,
  projectRootKey,
  projectTrustsPath,
} from '../src/ledger.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function makeDataDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-ppr-ledger-'))
  roots.push(root)
  const dataDir = join(root, 'data')
  mkdirSync(dataDir, { recursive: true })
  return dataDir
}

describe('project trust ledger (C-02)', () => {
  it('round-trips trust and per-plugin decisions through the file', () => {
    const dataDir = makeDataDir()
    const trusts = emptyProjectTrusts()
    trustProjectRoot(trusts, '/repo/a', 1000)
    decideProjectPlugin(trusts, '/repo/a', 'fixtures/alpha', true, 1001)
    decideProjectPlugin(trusts, '/repo/a', 'fixtures/beta', false, 1002)
    saveProjectTrusts(dataDir, trusts)

    const loaded = loadProjectTrusts(dataDir)
    expect(loaded.version).toBe(1)
    expect(loaded.roots[projectRootKey('/repo/a')]?.trustedAt).toBe(1000)
    expect(loaded.roots[projectRootKey('/repo/a')]?.plugins['fixtures/alpha']).toMatchObject({ enabled: true, decidedAt: 1001 })
    expect(loaded.roots[projectRootKey('/repo/a')]?.plugins['fixtures/beta']).toMatchObject({ enabled: false, decidedAt: 1002 })
  })

  it('scopes decisions by root × plugin id (C-02 granularity)', () => {
    const dataDir = makeDataDir()
    const trusts = emptyProjectTrusts()
    trustProjectRoot(trusts, '/repo/a')
    trustProjectRoot(trusts, '/repo/b')
    decideProjectPlugin(trusts, '/repo/a', 'fixtures/demo', false)
    saveProjectTrusts(dataDir, trusts)

    // Disabled under root A, untouched under root B.
    expect(shouldMountProjectPlugin(trusts, '/repo/a', 'fixtures/demo')).toBe(false)
    expect(shouldMountProjectPlugin(trusts, '/repo/b', 'fixtures/demo')).toBe(true)
    // A different plugin under the same root is unaffected.
    expect(shouldMountProjectPlugin(trusts, '/repo/a', 'fixtures/other')).toBe(true)
  })

  it('fails closed for an untrusted root', () => {
    const trusts = emptyProjectTrusts()
    expect(shouldMountProjectPlugin(trusts, '/repo/a', 'fixtures/demo')).toBe(false)
  })

  it('mounts an untracked plugin under a trusted root by default', () => {
    const trusts = emptyProjectTrusts()
    trustProjectRoot(trusts, '/repo/a')
    expect(shouldMountProjectPlugin(trusts, '/repo/a', 'fixtures/demo')).toBe(true)
  })

  it('normalizes plugin ids before storage', () => {
    const trusts = emptyProjectTrusts()
    trustProjectRoot(trusts, '/repo/a')
    decideProjectPlugin(trusts, '/repo/a', '@scope/name', false)
    expect(shouldMountProjectPlugin(trusts, '/repo/a', 'scope/name')).toBe(false)
    expect(shouldMountProjectPlugin(trusts, '/repo/a', '@scope/name')).toBe(false)
  })

  it('reads a missing ledger as empty (fail closed)', () => {
    const dataDir = makeDataDir()
    expect(loadProjectTrusts(dataDir)).toEqual(emptyProjectTrusts())
    expect(shouldMountProjectPlugin(loadProjectTrusts(dataDir), '/repo/a', 'fixtures/demo')).toBe(false)
  })

  it('reads a corrupt ledger as empty (fail closed)', () => {
    const dataDir = makeDataDir()
    writeFileSync(projectTrustsPath(dataDir), '{ not json !!js')
    expect(loadProjectTrusts(dataDir)).toEqual(emptyProjectTrusts())
    writeFileSync(projectTrustsPath(dataDir), JSON.stringify({ version: 99, roots: {} }))
    expect(loadProjectTrusts(dataDir)).toEqual(emptyProjectTrusts())
    // Narrowing: an entry with a non-boolean enabled value is dropped.
    writeFileSync(projectTrustsPath(dataDir), JSON.stringify({
      version: 1,
      roots: { '/repo/a': { trustedAt: 1, plugins: { 'fixtures/demo': { decidedAt: 1, enabled: 'yes' } } } },
    }))
    const loaded = loadProjectTrusts(dataDir)
    expect(loaded.roots[projectRootKey('/repo/a')]?.plugins['fixtures/demo']).toBeUndefined()
  })

  it('keys project roots case-folded on Windows', () => {
    const trusts = emptyProjectTrusts()
    trustProjectRoot(trusts, process.platform === 'win32' ? 'C:\\Repo\\A' : '/repo/a')
    expect(shouldMountProjectPlugin(trusts, process.platform === 'win32' ? 'c:\\repo\\a' : '/repo/a', 'fixtures/demo')).toBe(true)
  })
})
