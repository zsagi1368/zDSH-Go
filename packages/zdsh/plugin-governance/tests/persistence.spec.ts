/**
 * Persistence behavioral suite: branch-local storage root resolution,
 * registry save/load round-trips, autosave lifecycle, and directory hygiene.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DSH_BRANCH_DIR_NAME,
  DSH_BRANCH_HOME_ENV,
  PluginPersistence,
  createDefaultPersistence,
  resolveBranchStorageRoot,
} from '../src/persistence/index.ts'
import { DefaultPluginRegistry } from '../src/registry/registry.ts'
import { BasePlugin } from '../src/base/base.ts'
import type { PluginRegistry } from '../src/spec/index.ts'
import { mockContext, testManifest } from './fixtures.ts'

class NoopPlugin extends BasePlugin {
  async install() {}
}

/** Registry stand-in for suites that never touch plugin data. */
const deadRegistry = {} as unknown as PluginRegistry

async function populatedRegistry(): Promise<DefaultPluginRegistry> {
  const registry = new DefaultPluginRegistry()
  const result = await registry.register(new NoopPlugin(testManifest(), mockContext()))
  if (!result.success) throw new Error('fixture registration failed')
  return registry
}

afterEach(() => {
  vi.restoreAllMocks()
  Reflect.deleteProperty(process.env, DSH_BRANCH_HOME_ENV)
  Reflect.deleteProperty(process.env, 'DSH_HOME')
})

describe('storage root resolution', () => {
  it('prefers an explicit config root', () => {
    const explicit = join(tmpdir(), 'explicit-root')
    const persistence = new PluginPersistence(deadRegistry, { storageRoot: explicit })
    expect(persistence.storagePath).toBe(explicit)
  })

  it('resolves DSH_BRANCH_HOME ahead of the homedir default (env override)', () => {
    const branchHome = join(tmpdir(), 'branch-home')
    process.env[DSH_BRANCH_HOME_ENV] = branchHome
    const persistence = new PluginPersistence(deadRegistry)
    expect(persistence.storagePath).toBe(resolve(branchHome))
  })

  it('derives <DSH_HOME>/zdsh when only DSH_HOME is set (single-variable install layout)', () => {
    const dshHome = join(tmpdir(), 'install-dir', 'data')
    process.env.DSH_HOME = dshHome
    expect(resolveBranchStorageRoot()).toBe(join(resolve(dshHome), 'zdsh'))
    const persistence = new PluginPersistence(deadRegistry)
    expect(persistence.storagePath).toBe(join(resolve(dshHome), 'zdsh'))
  })

  it('prefers DSH_BRANCH_HOME over the DSH_HOME derivation', () => {
    process.env.DSH_HOME = join(tmpdir(), 'install-data')
    process.env[DSH_BRANCH_HOME_ENV] = join(tmpdir(), 'branch-home')
    expect(resolveBranchStorageRoot()).toBe(resolve(join(tmpdir(), 'branch-home')))
  })

  it('keeps the legacy ~/.dsh-zdsh-go default when neither variable is set', () => {
    expect(resolveBranchStorageRoot()).toBe(join(homedir(), DSH_BRANCH_DIR_NAME))
  })

  it('ignores blank DSH_HOME and falls through to the homedir default', () => {
    process.env.DSH_HOME = '   '
    expect(resolveBranchStorageRoot()).toBe(join(homedir(), DSH_BRANCH_DIR_NAME))
  })

  it('skips a blank DSH_BRANCH_HOME down to the DSH_HOME derivation', () => {
    // Blank override does not shadow the derived tier: <DSH_HOME>/zdsh wins.
    const dshHome = join(tmpdir(), 'install-data-blank-branch')
    process.env[DSH_BRANCH_HOME_ENV] = '   '
    process.env.DSH_HOME = dshHome
    expect(resolveBranchStorageRoot()).toBe(join(resolve(dshHome), 'zdsh'))
  })

  it('ignores blank env values and defaults to ~/.dsh-zdsh-go under the user home', () => {
    process.env[DSH_BRANCH_HOME_ENV] = '   '
    const persistence = createDefaultPersistence(deadRegistry)
    expect(persistence.storagePath).toBe(join(homedir(), DSH_BRANCH_DIR_NAME))
    expect(DSH_BRANCH_DIR_NAME).toBe('.dsh-zdsh-go')
  })
})

describe('path getters and directory hygiene', () => {
  it('derives registry/cache/logs/data paths from the storage root', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-persist-'))
    const persistence = new PluginPersistence(deadRegistry, { storageRoot: root })
    expect(persistence.registryPath).toBe(join(root, 'registry.json'))
    expect(persistence.cacheDir).toBe(join(root, 'cache'))
    expect(persistence.logDir).toBe(join(root, 'logs'))
    expect(persistence.dataDir).toBe(join(root, 'data'))

    persistence.ensureDirectories()
    for (const dir of [root, persistence.cacheDir, persistence.logDir, persistence.dataDir]) {
      expect(existsSync(dir), dir).toBe(true)
    }
    rmSync(root, { recursive: true, force: true })
  })

  it('clear removes the whole storage tree', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-persist-clear-'))
    const registry = await populatedRegistry()
    const persistence = new PluginPersistence(registry, { storageRoot: root })
    persistence.save()
    expect(existsSync(persistence.registryPath)).toBe(true)

    persistence.clear()
    expect(existsSync(root)).toBe(false)

    // Clearing a missing tree stays quiet.
    expect(() =>{  persistence.clear() }).not.toThrow()
  })
})

describe('save/load round-trip', () => {
  it('persists registered plugin manifests and reads them back', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-persist-roundtrip-'))
    const registry = await populatedRegistry()
    const persistence = new PluginPersistence(registry, { storageRoot: root, autoSave: false })

    persistence.save()
    const raw = JSON.parse(readFileSync(persistence.registryPath, 'utf-8')) as {
      version: string
      plugins: Array<{ id: string; status: string }>
    }
    expect(raw.version).toBe('1.0.0')
    expect(raw.plugins[0]).toMatchObject({ id: 'test/plugin', status: 'active' })

    const manifests = persistence.load()
    expect(manifests).toHaveLength(1)
    expect(manifests[0]).toMatchObject({ id: 'test/plugin', name: 'Test Plugin' })
    rmSync(root, { recursive: true, force: true })
  })

  it('load returns [] for a missing file or unexpected payload shape', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-persist-shape-'))
    const persistence = new PluginPersistence(deadRegistry, { storageRoot: root })

    expect(persistence.load()).toEqual([])

    writeFileSync(persistence.registryPath, JSON.stringify({ plugins: 'not-an-array' }))
    expect(persistence.load()).toEqual([])

    // A literal null payload parses but is not an object.
    writeFileSync(persistence.registryPath, 'null')
    expect(persistence.load()).toEqual([])

    writeFileSync(persistence.registryPath, JSON.stringify({ plugins: [null, {}, { manifest: { id: 'a/b' } }] }))
    expect(persistence.load()).toEqual([{ id: 'a/b' }])
    rmSync(root, { recursive: true, force: true })
  })

  it('load surfaces malformed JSON as a thrown error', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-persist-badjson-'))
    const persistence = new PluginPersistence(deadRegistry, { storageRoot: root })
    mkdirSync(root, { recursive: true })
    writeFileSync(persistence.registryPath, '{not json')

    expect(() => persistence.load()).toThrow()
    rmSync(root, { recursive: true, force: true })
  })
})

describe('autosave lifecycle', () => {
  it('periodically saves while started and stops cleanly', async () => {
    vi.useFakeTimers()
    try {
      const root = mkdtempSync(join(tmpdir(), 'dsh-persist-auto-'))
      const registry = await populatedRegistry()
      const persistence = new PluginPersistence(registry, {
        storageRoot: root,
        autoSave: true,
        saveIntervalMs: 100,
      })

      persistence.start()
      expect(existsSync(persistence.registryPath)).toBe(false)
      await vi.advanceTimersByTimeAsync(350)
      expect(existsSync(persistence.registryPath)).toBe(true)

      // stop() detaches the interval; no further saves fire.
      persistence.stop()
      rmSync(root, { recursive: true, force: true })
    } finally {
      vi.useRealTimers()
    }
  })

  it('never arms a timer when autoSave is false', async () => {
    const intervalSpy = vi.spyOn(globalThis, 'setInterval')
    const root = mkdtempSync(join(tmpdir(), 'dsh-persist-manual-'))
    const persistence = new PluginPersistence(deadRegistry, {
      storageRoot: root,
      autoSave: false,
    })
    persistence.start()
    persistence.stop()
    expect(intervalSpy).not.toHaveBeenCalled()
    intervalSpy.mockRestore()
    rmSync(root, { recursive: true, force: true })
  })
})
