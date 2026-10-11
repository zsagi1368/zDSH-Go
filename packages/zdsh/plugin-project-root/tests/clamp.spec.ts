/**
 * Host clamp suite (S-43 M2a, B-01/B-02/B-03): the manifest sandbox is an
 * application; the clamp produces the effective granted sandbox, rejecting
 * error-level overclaims and warning about narrowing.
 */

import { resolve, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { clampProjectPluginSandbox } from '../src/clamp.ts'
import { testSandbox } from './fixtures.ts'

const pluginDir = process.platform === 'win32' ? 'C:\\repo\\.dsh\\plugins\\demo' : '/repo/.dsh/plugins/demo'

describe('clampProjectPluginSandbox', () => {
  it('grants the declared subprocess tier in M2b and keeps inline as the inline fallback', () => {
    // Declared inline stays inline with no warning and the in-process tier.
    const inline = clampProjectPluginSandbox(testSandbox({ type: 'inline' }), pluginDir)
    expect(inline.effective.type).toBe('inline')
    expect(inline.runtimeTier).toBe('in-process')
    expect(inline.warnings.some(w => w.check === 'sandbox-type')).toBe(false)

    // Declared worker is granted as the effective worker tier (M2b subprocess).
    const worker = clampProjectPluginSandbox(testSandbox({ type: 'worker' }), pluginDir)
    expect(worker.effective.type).toBe('worker')
    expect(worker.runtimeTier).toBe('subprocess')
    expect(worker.warnings.some(w => w.check === 'sandbox-type')).toBe(false)

    // Declared process is granted as the effective process tier (M2b subprocess).
    const processType = clampProjectPluginSandbox(testSandbox({ type: 'process' }), pluginDir)
    expect(processType.effective.type).toBe('process')
    expect(processType.runtimeTier).toBe('subprocess')
    expect(processType.warnings.some(w => w.check === 'sandbox-type')).toBe(false)
  })

  it('rejects fullyAuthorized=true (B-01)', () => {
    const result = clampProjectPluginSandbox(
      testSandbox({ process: { spawn: false, exec: false, allowedCommands: [], fullyAuthorized: true } }),
      pluginDir,
    )
    expect(result.rejections.some(r => r.check === 'fully-authorized')).toBe(true)
    expect(result.effective.process.fullyAuthorized).toBeUndefined()
  })

  it('accepts fullyAuthorized=false and omits the field from the effective sandbox', () => {
    const result = clampProjectPluginSandbox(
      testSandbox({ process: { spawn: false, exec: false, allowedCommands: [], fullyAuthorized: false } }),
      pluginDir,
    )
    expect(result.rejections).toEqual([])
    expect(result.effective.process.fullyAuthorized).toBeUndefined()
  })

  it('rejects process.spawn or process.exec claims', () => {
    for (const overrides of [
      { spawn: true, exec: false },
      { spawn: false, exec: true },
    ] as const) {
      const result = clampProjectPluginSandbox(
        testSandbox({ process: { ...overrides, allowedCommands: [] } }),
        pluginDir,
      )
      expect(result.rejections.length).toBeGreaterThan(0)
      expect(result.effective.process.spawn).toBe(false)
      expect(result.effective.process.exec).toBe(false)
    }
  })

  it('narrows network.access external/internal to an error rejection (B-03)', () => {
    for (const access of ['external', 'internal'] as const) {
      const result = clampProjectPluginSandbox(
        testSandbox({ network: { access, allowedHosts: [], deniedHosts: [], allowLocal: false } }),
        pluginDir,
      )
      expect(result.rejections.some(r => r.check === 'network')).toBe(true)
    }
    // Declared none stays accepted with network forced off.
    const none = clampProjectPluginSandbox(
      testSandbox({ network: { access: 'none', allowedHosts: [], deniedHosts: [], allowLocal: true } }),
      pluginDir,
    )
    expect(none.rejections).toEqual([])
    expect(none.effective.network.access).toBe('none')
    expect(none.effective.network.allowLocal).toBe(false)
    expect(none.warnings.some(w => w.check === 'network-allow-local')).toBe(true)
  })

  it('narrows allowedPaths to the intersection with [pluginDir] (B-02)', () => {
    // Declaring '/' (or a win32 drive root) yields exactly the plugin dir.
    const rootDecl = process.platform === 'win32' ? 'C:\\' : '/'
    const wide = clampProjectPluginSandbox(
      testSandbox({ filesystem: { access: 'readwrite', allowedPaths: [rootDecl], deniedPatterns: [] } }),
      pluginDir,
    )
    expect(wide.rejections).toEqual([])
    expect(wide.effective.filesystem.allowedPaths).toEqual([resolve(pluginDir)])
    expect(wide.warnings.some(w => w.check === 'allowed-paths')).toBe(false)

    // Paths outside the plugin dir are dropped with a warning.
    const outside = join(pluginDir, '..', '..', 'other')
    const narrowed = clampProjectPluginSandbox(
      testSandbox({ filesystem: { access: 'readwrite', allowedPaths: [outside], deniedPatterns: [] } }),
      pluginDir,
    )
    expect(narrowed.effective.filesystem.allowedPaths).toEqual([])
    expect(narrowed.warnings.some(w => w.check === 'allowed-paths' && w.message.includes('fail-closed'))).toBe(true)

    // Sub-paths inside the plugin dir survive the intersection.
    const sub = join(pluginDir, 'data')
    const withSub = clampProjectPluginSandbox(
      testSandbox({ filesystem: { access: 'readwrite', allowedPaths: [sub], deniedPatterns: [] } }),
      pluginDir,
    )
    expect(withSub.effective.filesystem.allowedPaths).toEqual([resolve(sub)])
  })

  it('clamps memory and timeout into the host caps with warnings', () => {
    const result = clampProjectPluginSandbox(
      testSandbox({
        resources: { memoryLimitMb: 4096, cpuLimit: 50, timeoutMs: 120000, maxOutputBytes: 10000 },
      }),
      pluginDir,
    )
    expect(result.effective.resources.memoryLimitMb).toBe(512)
    expect(result.effective.resources.timeoutMs).toBe(60000)
    expect(result.warnings.some(w => w.check === 'memory-limit')).toBe(true)
    expect(result.warnings.some(w => w.check === 'timeout')).toBe(true)
  })

  it('raises sub-minimum memory/timeout to 1 with a warning', () => {
    const result = clampProjectPluginSandbox(
      testSandbox({
        resources: { memoryLimitMb: 0, cpuLimit: 50, timeoutMs: 0, maxOutputBytes: 10000 },
      }),
      pluginDir,
    )
    expect(result.effective.resources.memoryLimitMb).toBe(1)
    expect(result.effective.resources.timeoutMs).toBe(1)
    expect(result.warnings.some(w => w.check === 'memory-limit')).toBe(true)
    expect(result.warnings.some(w => w.check === 'timeout')).toBe(true)
  })

  it('fills defaults for every undeclared section (deny-all fallback)', () => {
    const result = clampProjectPluginSandbox({}, pluginDir)
    expect(result.effective.network.access).toBe('none')
    expect(result.effective.process.spawn).toBe(false)
    expect(result.effective.process.exec).toBe(false)
    expect(result.effective.filesystem.allowedPaths).toEqual([])
    expect(result.effective.type).toBe('inline')
    expect(result.rejections).toEqual([])
  })

  it('keeps environment whitelist/blacklist declarations (filtered at runtime by deriveSandboxEnvironment)', () => {
    const result = clampProjectPluginSandbox(
      testSandbox({ environment: { whitelist: ['FOO'], blacklist: ['BAR'], clear: false } }),
      pluginDir,
    )
    expect(result.effective.environment.whitelist).toEqual(['FOO'])
    expect(result.effective.environment.blacklist).toEqual(['BAR'])
  })
})
