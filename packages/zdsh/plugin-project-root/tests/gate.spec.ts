/**
 * Gate pipeline suite (S-43 M2a): clamp + LoadGuard.preLoad + llm-adapter
 * capability rejection, with a full report trail for every candidate.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { gate, kernelVersionFromManifest, PROJECT_PLUGIN_KERNEL_VERSION } from '../src/gate.ts'
import type { DiscoveredProjectPlugin } from '../src/types.ts'
import { testSandbox, testManifest } from './fixtures.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function makePluginDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-ppr-gate-'))
  roots.push(root)
  const pluginDir = join(root, '.dsh', 'plugins', 'demo')
  mkdirSync(pluginDir, { recursive: true })
  return pluginDir
}

function candidate(overrides: Partial<DiscoveredProjectPlugin> = {}): DiscoveredProjectPlugin {
  const pluginDir = makePluginDir()
  return {
    id: 'fixtures/demo',
    version: '1.0.0',
    name: 'Demo Plugin',
    projectRoot: join(pluginDir, '..', '..', '..'),
    pluginDir,
    manifest: testManifest(),
    manifestHash: 'a'.repeat(64),
    entryFile: join(pluginDir, 'index.js'),
    source: 'project',
    ...overrides,
  }
}

describe('gate', () => {
  it('derives the kernel version from this package manifest (no hand-maintained drift)', () => {
    const manifest: unknown = JSON.parse(
      readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
    )
    const expected = (manifest as { version: string }).version
    expect(PROJECT_PLUGIN_KERNEL_VERSION).toBe(expected)
    // The pre-derivation literal that drifted six release lines.
    expect(PROJECT_PLUGIN_KERNEL_VERSION).not.toBe('0.1.1-rc.2')
  })

  it('throws instead of defaulting when the manifest carries no usable version', () => {
    expect(() => kernelVersionFromManifest({})).toThrow(/no version/)
    expect(() => kernelVersionFromManifest({ version: '' })).toThrow(/no version/)
    expect(() => kernelVersionFromManifest({ version: 'not-a-version' })).toThrow(/not a semantic version/)
    expect(() => kernelVersionFromManifest(null)).toThrow(/must contain an object/)
  })

  it('accepts a clean candidate with the clamped sandbox attached', async () => {
    const { accepted, report } = await gate([candidate()])
    expect(accepted).toHaveLength(1)
    expect(accepted[0]?.clampedSandbox.network.access).toBe('none')
    expect(accepted[0]?.clampedSandbox.type).toBe('inline')
    expect(report.some(row => row.verdict === 'mounted' && row.check === 'gate-passed')).toBe(true)
  })

  it('rejects a candidate whose clamp has an error-level rejection (B-01)', async () => {
    const { accepted, report } = await gate([candidate({
      manifest: testManifest({
        sandbox: testSandbox({ process: { spawn: false, exec: false, allowedCommands: [], fullyAuthorized: true } }),
      }),
    })])
    expect(accepted).toEqual([])
    expect(report.some(row => row.verdict === 'rejected' && row.check === 'fully-authorized')).toBe(true)
  })

  it('rejects a candidate declaring external network (B-03)', async () => {
    const { accepted, report } = await gate([candidate({
      manifest: testManifest({
        sandbox: testSandbox({ network: { access: 'external', allowedHosts: [], deniedHosts: [], allowLocal: false } }),
      }),
    })])
    expect(accepted).toEqual([])
    expect(report.some(row => row.verdict === 'rejected' && row.check === 'network')).toBe(true)
  })

  it('rejects a candidate declaring an llm-adapter capability (B-03)', async () => {
    const { accepted, report } = await gate([candidate({
      manifest: testManifest({
        capabilities: [{ type: 'llm-adapter', llmAdapter: { name: 'adapter', factory: 'f' } }],
      }),
    })])
    expect(accepted).toEqual([])
    expect(report.some(row => row.verdict === 'rejected' && row.check === 'capability-llm-adapter')).toBe(true)
  })

  it('rejects a candidate whose LoadGuard check fails (version window)', async () => {
    const { accepted, report } = await gate([candidate({
      manifest: testManifest({ dsh: { compatible: '>=9.9.9' } }),
    })])
    expect(accepted).toEqual([])
    expect(report.some(row => row.verdict === 'rejected' && row.message.includes('DSH'))).toBe(true)
  })

  it('rejects a duplicate id with a report row', async () => {
    const first = candidate()
    const second = candidate()
    const { accepted, report } = await gate([first, second])
    expect(accepted).toHaveLength(1)
    expect(report.some(row => row.verdict === 'rejected' && row.check === 'duplicate-id')).toBe(true)
  })

  it('records narrowing warnings as warned rows while still accepting (B-02/B-03)', async () => {
    const rootDecl = process.platform === 'win32' ? 'C:\\' : '/'
    const { accepted, report } = await gate([candidate({
      manifest: testManifest({
        sandbox: testSandbox({
          resources: { memoryLimitMb: 4096, cpuLimit: 50, timeoutMs: 30000, maxOutputBytes: 10000 },
          filesystem: { access: 'readwrite', allowedPaths: [rootDecl], deniedPatterns: [] },
        }),
      }),
    })])
    expect(accepted).toHaveLength(1)
    expect(accepted[0]?.clampedSandbox.resources.memoryLimitMb).toBe(512)
    expect(report.some(row => row.verdict === 'warned' && row.check === 'memory-limit')).toBe(true)
  })

  it('emits a report row with root/id/version/check for every verdict (C-05 shape)', async () => {
    const good = candidate()
    const bad = candidate({
      id: 'fixtures/evil',
      manifest: testManifest({
        id: 'fixtures/evil',
        sandbox: testSandbox({ process: { spawn: true, exec: false, allowedCommands: [] } }),
      }),
    })
    const { accepted, report } = await gate([good, bad])
    expect(accepted).toHaveLength(1)
    for (const row of report) {
      expect(typeof row.root).toBe('string')
      expect(row.root.length).toBeGreaterThan(0)
      expect(['fixtures/demo', 'fixtures/evil']).toContain(row.id)
      expect(row.version).toBe('1.0.0')
      expect(typeof row.check).toBe('string')
      expect(row.message.length).toBeGreaterThan(0)
    }
    const rejectedRow = report.find(row => row.verdict === 'rejected')
    expect(rejectedRow?.root).toBe(bad.projectRoot)
    expect(report.some(row => row.verdict === 'rejected' && row.check === 'process-spawn')).toBe(true)
  })
})
