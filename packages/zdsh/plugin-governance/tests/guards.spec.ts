/**
 * Guards behavioral suite: LoadGuard pre-checks, RunGuard/PluginWatcher
 * runtime enforcement, and HealthGuard's failure-escalation loop.
 */

import { describe, expect, it, vi, afterEach } from 'vitest'
import { LoadGuard } from '../src/guards/load-guard.ts'
import { RunGuard } from '../src/guards/run-guard.ts'
import { PluginWatcher } from '../src/guards/watcher.ts'
import { HealthGuard, type HealthCheck } from '../src/guards/health-guard.ts'
import { DefaultPluginRegistry } from '../src/registry/registry.ts'
import { BasePlugin } from '../src/base/base.ts'
import { PluginStatus } from '../src/spec/index.ts'
import type { CapabilityDeclaration, Plugin, PluginManifest, PluginSandboxConfig } from '../src/spec/index.ts'
import { mockContext, testManifest } from './fixtures.ts'

class NoopPlugin extends BasePlugin {
  async install() {}
}

function pluginOf(overrides: Partial<PluginManifest> = {}): Plugin {
  return new NoopPlugin(testManifest(overrides), mockContext())
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('LoadGuard', () => {
  it('passes a fully-formed manifest', async () => {
    const result = await new LoadGuard().preLoad(pluginOf(), '0.1.1-rc.2')
    expect(result.allowed).toBe(true)
    expect(result.failures).toHaveLength(0)
    expect(result.warnings).toHaveLength(0)
  })

  it('flags every missing manifest field', async () => {
    const guard = new LoadGuard()
    const cases: Array<[Partial<PluginManifest>, RegExp]> = [
      [{ id: '' }, /missing required field: id/i],
      [{ version: '' }, /missing required field: version/i],
      [{ name: '' }, /missing required field: name/i],
      [{ dsh: { compatible: '' } }, /dsh\.compatible/i],
      [{ capabilities: [] }, /capabilities/i],
      [{ sandbox: undefined as unknown as PluginManifest['sandbox'] }, /sandbox/i],
    ]
    for (const [override, pattern] of cases) {
      const result = await guard.preLoad(pluginOf(override), '0.1.1-rc.2')
      expect(result.allowed, JSON.stringify(override)).toBe(false)
      expect(result.failures.some(f => f.message.match(pattern)), String(pattern)).toBe(true)
    }
  })

  it('enforces the declared compatibility window', async () => {
    const guard = new LoadGuard()
    const manifest = { compatible: '>=0.1.0 <0.2.0' }

    const tooNew = await guard.preLoad(
      pluginOf({ dsh: manifest }),
      '0.2.0',
    )
    expect(tooNew.allowed).toBe(false)
    expect(tooNew.failures[0]?.message).toContain('< 0.2.0')

    const tooOld = await guard.preLoad(pluginOf({ dsh: manifest }), '0.0.9')
    expect(tooOld.allowed).toBe(false)

    const inside = await guard.preLoad(pluginOf({ dsh: manifest }), '0.1.5')
    expect(inside.allowed).toBe(true)
  })

  it('agrees with the registry on the kernel==max boundary (NF1)', async () => {
    // Mirrors integration.spec.ts ("rejects a kernel exactly at the declared
    // upper bound"): `<0.2.0` excludes 0.2.0, so BOTH governance faces must
    // reject a kernel equal to the bound. This pair was the missing lock — the
    // registry compared `> 0` and silently admitted the boundary kernel (NF1).
    const guard = new LoadGuard()
    const atBound = await guard.preLoad(pluginOf({ dsh: { compatible: '>=0.1.0-rc.8 <0.2.0' } }), '0.2.0')
    expect(atBound.allowed).toBe(false)
    expect(atBound.failures[0]?.message).toContain('< 0.2.0')

    const belowBound = await guard.preLoad(pluginOf({ dsh: { compatible: '>=0.1.0-rc.8 <0.2.0' } }), '0.1.9')
    expect(belowBound.allowed).toBe(true)
  })

  it('validates sandbox resource configuration', async () => {
    const guard = new LoadGuard()
    const resources = testManifest().sandbox.resources

    const noType = await guard.preLoad(
      pluginOf({
        // 'untrusted' 已从 SandboxType 移除；经字符串转义模拟磁盘 JSON 携带
        // 该旧值，断言 LoadGuard 仍以 Invalid sandbox type 拒载（fail-closed）。
        sandbox: {
          ...testManifest().sandbox,
          type: 'untrusted' as unknown as PluginSandboxConfig['type'],
        },
      }),
      '0.1.1',
    )
    expect(noType.allowed).toBe(false)
    expect(noType.failures[0]?.message).toContain('Invalid sandbox type')

    const zeroMemory = await guard.preLoad(
      pluginOf({
        sandbox: {
          ...testManifest().sandbox,
          resources: { ...resources, memoryLimitMb: 0 },
        },
      }),
      '0.1.1',
    )
    expect(zeroMemory.allowed).toBe(false)
    expect(zeroMemory.failures[0]?.message).toContain('Memory limit must be positive')

    const zeroTimeout = await guard.preLoad(
      pluginOf({
        sandbox: {
          ...testManifest().sandbox,
          resources: { ...resources, timeoutMs: 0 },
        },
      }),
      '0.1.1',
    )
    expect(zeroTimeout.allowed).toBe(false)
    expect(zeroTimeout.failures[0]?.message).toContain('Timeout must be positive')
  })

  it('validates capability declarations per kind', async () => {
    const guard = new LoadGuard()

    const badType = await guard.preLoad(
      pluginOf({ capabilities: [{ type: 'warp-drive' as never }] }),
      '0.1.1',
    )
    expect(badType.allowed).toBe(false)
    expect(badType.failures[0]?.message).toContain('Invalid capability type')

    const toolless = await guard.preLoad(
      pluginOf({ capabilities: [{ type: 'tool' }] }),
      '0.1.1',
    )
    expect(toolless.allowed).toBe(false)

    const hookWithoutEvent = await guard.preLoad(
      pluginOf({
        capabilities: [
          { type: 'hook', hook: { name: 'h' } as NonNullable<CapabilityDeclaration['hook']> },
        ],
      }),
      '0.1.1',
    )
    expect(hookWithoutEvent.allowed).toBe(false)

    const serviceWithoutFactory = await guard.preLoad(
      pluginOf({
        capabilities: [
          { type: 'service', service: { name: 's' } as NonNullable<CapabilityDeclaration['service']> },
        ],
      }),
      '0.1.1',
    )
    expect(serviceWithoutFactory.allowed).toBe(false)
  })

  it('maps warning-severity check failures to warnings without blocking load', async () => {
    const guard = new LoadGuard()
    ;(guard as unknown as { checks: unknown[] }).checks = [
      {
        name: 'warn-only',
        run: () => ({ passed: false, severity: 'warning', message: 'warn-check: degraded' }),
      },
    ]
    const result = await guard.preLoad(pluginOf(), '0.1.1')
    expect(result.allowed).toBe(true)
    expect(result.failures[0]).toMatchObject({ severity: 'warning', check: 'warn-check' })
    expect(result.warnings[0]).toMatchObject({ check: 'warn-check', message: 'warn-check: degraded' })
  })

  it('falls back to unknown/placeholder labels for failures without details', async () => {
    const guard = new LoadGuard()
    ;(guard as unknown as { checks: unknown[] }).checks = [
      { name: 'opaque', run: () => ({ passed: false }) },
      { name: 'opaque-warn', run: () => ({ passed: false, severity: 'warning' }) },
    ]
    const result = await guard.preLoad(pluginOf(), '0.1.1')
    expect(result.allowed).toBe(false)
    expect(result.failures[0]).toEqual({
      check: 'unknown',
      message: 'Unknown error',
      severity: 'error',
    })
    expect(result.warnings[0]).toEqual({
      check: 'unknown',
      message: 'Unknown warning',
    })
  })

  it('flags a sandbox config without a resources block', async () => {
    const guard = new LoadGuard()
    const sandbox = testManifest().sandbox
    const noResources = await guard.preLoad(
      pluginOf({
        sandbox: { ...sandbox, resources: undefined as unknown as typeof sandbox.resources },
      }),
      '0.1.1',
    )
    expect(noResources.allowed).toBe(false)
    expect(noResources.failures[0]?.message).toContain('missing required field: resources')

    const noType = await guard.preLoad(
      pluginOf({ sandbox: { ...sandbox, type: '' as typeof sandbox.type } }),
      '0.1.1',
    )
    expect(noType.allowed).toBe(false)
    expect(noType.failures[0]?.message).toContain('missing required field: type')
  })

  it('tolerates manifests whose capabilities list is absent', async () => {
    const guard = new LoadGuard()
    const result = await guard.preLoad(
      pluginOf({
        capabilities: undefined as unknown as PluginManifest['capabilities'],
      }),
      '0.1.1',
    )
    expect(result.allowed).toBe(false)
  })

  it('flags capabilities that lack a type entirely', async () => {
    const guard = new LoadGuard()
    const result = await guard.preLoad(
      pluginOf({ capabilities: [{} as CapabilityDeclaration] }),
      '0.1.1',
    )
    expect(result.allowed).toBe(false)
    expect(result.failures[0]?.message).toContain('Capability missing required field: type')
  })
})

describe('RunGuard and PluginWatcher', () => {
  it('watch/unwatch manage the watcher table', () => {
    const guard = new RunGuard()
    const watcher = guard.watch('a/b', pluginOf())
    expect(watcher).toBeInstanceOf(PluginWatcher)
    expect(guard.getActiveWatchers()).toEqual(['a/b'])
    expect(guard.getWatcher('a/b')).toBe(watcher)

    expect(() => guard.watch('a/b', pluginOf())).toThrow(/already exists/)
    guard.unwatch('a/b')
    expect(guard.getWatcher('a/b')).toBeUndefined()
  })

  it('execute requires a watcher', async () => {
    const guard = new RunGuard()
    await expect(guard.execute('ghost', async () => 1)).rejects.toThrow(/No watcher for plugin/)
  })

  it('executes through the watcher and passes results through', async () => {
    const guard = new RunGuard()
    guard.watch('a/b', pluginOf())
    await expect(guard.execute('a/b', async () => 'value')).resolves.toBe('value')
  })

  it('counts calls and blocks beyond maxCallCount', async () => {
    // timeoutMs > 60000 arms a maxCallCount of 100.
    const watcher = new PluginWatcher(
      'a/b',
      pluginOf({ sandbox: { ...testManifest().sandbox, resources: { ...testManifest().sandbox.resources, timeoutMs: 61000 } } }),
    )
    for (let i = 0; i < 100; i++) {
      await watcher.execute(async () => i)
    }
    await expect(watcher.execute(async () => 'over')).rejects.toThrow(
      /Exceeded maximum call count/,
    )
    const health = watcher.getHealthStatus()
    expect(health.callCount).toBe(101)
    expect(health.warnings).toContain('Approaching call limit')
  })

  it('wraps plugin failures in sanitized PluginErrors', async () => {
    const watcher = new PluginWatcher('a/b', pluginOf())
    try {
      await watcher.execute(async () => {
        throw new Error('inner secret\nwith stack lines\nand more')
      })
      expect.unreachable('should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).name).toBe('PluginError')
      expect((error as Error).message).not.toContain('with stack lines')
    }
    const health = watcher.getHealthStatus()
    expect(health.healthy).toBe(false)
    expect(health.errors?.[0]).toBeTruthy()
    expect(health.lastError).toBeTruthy()
    expect(health.lastErrorTime).toBeGreaterThan(0)
    expect(health.errorRate).toBeGreaterThan(0)
  })

  it('sanitizes failures whose error carries no stack', async () => {
    const watcher = new PluginWatcher('a/b', pluginOf())
    try {
      await watcher.execute(async () => {
        const bare = new Error('stackless failure')
        delete (bare as { stack?: string }).stack
        throw bare
      })
      expect.unreachable('should have thrown')
    } catch (error) {
      expect((error as Error).message).toContain('stackless failure')
    }
  })

  it('reports healthy status before any call', () => {
    const watcher = new PluginWatcher('a/b', pluginOf())
    const health = watcher.getHealthStatus()
    expect(health.healthy).toBe(true)
    expect(health.errors).toBeUndefined()
    expect(health.warnings).toBeUndefined()
    expect(health.callCount).toBe(0)
  })
})

describe('HealthGuard', () => {
  function setup(options?: Partial<{ warningThreshold: number; disableThreshold: number; intervalMs: number }>) {
    const registry = new DefaultPluginRegistry()
    const guard = new HealthGuard(registry)
    guard.setOptions({ intervalMs: 1000, warningThreshold: 2, disableThreshold: 3, ...options })
    return { registry, guard }
  }

  function registeredPlugin(registry: DefaultPluginRegistry): Promise<void> {
    return registry.register(new NoopPlugin(testManifest(), mockContext())).then((result) => {
      if (!result.success) throw new Error('fixture registration failed')
    })
  }

  it('escalates consecutive failures from ACTIVE to WARNINGS to DISABLED', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const { registry, guard } = setup()
    await registeredPlugin(registry)

    const healthy = false
    // No error field: exercises the 'Unknown error' / 'auto-disabled'
    // notification fallbacks on the way down.
    const check: HealthCheck = { run: async () => ({ healthy }) }
    guard.registerCheck('test/plugin', check)

    // Failure 1 -> still under warning threshold.
    const performCheck = (guard as unknown as { performCheck(id: string, c: HealthCheck): Promise<void> })
    await performCheck.performCheck('test/plugin', check)
    expect(guard.getConsecutiveFailures('test/plugin')).toBe(1)
    expect(registry.getStatus('test/plugin')).toBe(PluginStatus.ACTIVE)

    // Failure 2 -> WARNINGS.
    await performCheck.performCheck('test/plugin', check)
    expect(registry.getStatus('test/plugin')).toBe(PluginStatus.WARNINGS)

    // Failure 3 -> DISABLED.
    await performCheck.performCheck('test/plugin', check)
    expect(registry.getStatus('test/plugin')).toBe(PluginStatus.DISABLED)
    expect(guard.getHealthReport().disabled).toBe(1)
  })

  it('recovers plugins whose checks turn healthy again', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const { registry, guard } = setup({ warningThreshold: 2, disableThreshold: 99 })
    await registeredPlugin(registry)

    const performCheck = (guard as unknown as { performCheck(id: string, c: HealthCheck): Promise<void> })
    const failing: HealthCheck = { run: async () => ({ healthy: false, error: 'down' }) }
    const passing: HealthCheck = { run: async () => ({ healthy: true }) }

    await performCheck.performCheck('test/plugin', failing)
    expect(guard.getConsecutiveFailures('test/plugin')).toBe(1)

    await performCheck.performCheck('test/plugin', passing)
    expect(guard.getConsecutiveFailures('test/plugin')).toBe(0)
    expect(registry.getStatus('test/plugin')).toBe(PluginStatus.ACTIVE)
  })

  it('startMonitoring polls on the configured interval until stopped', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const { registry, guard } = setup({ intervalMs: 50, disableThreshold: 99 })
    await registeredPlugin(registry)

    let healthy = true
    guard.registerCheck('test/plugin', { run: async () => ({ healthy }) })

    vi.useFakeTimers()
    try {
      guard.startMonitoring()
      guard.startMonitoring() // idempotent
      healthy = false
      await vi.advanceTimersByTimeAsync(160)
      expect(guard.getConsecutiveFailures('test/plugin')).toBeGreaterThan(0)
    } finally {
      guard.stopMonitoring()
      vi.useRealTimers()
    }
  })

  it('stopMonitoring is safe without a timer and unregisterCheck removes probes', () => {
    const { registry, guard } = setup()
    guard.stopMonitoring()

    const check: HealthCheck = { run: async () => ({ healthy: true }) }
    guard.registerCheck('test/plugin', check)
    guard.unregisterCheck('test/plugin')
    expect(guard.getConsecutiveFailures('unknown')).toBe(0)
    expect(registry.getAll()).toHaveLength(0)
  })

  it('getHealthReport reflects registry state including optional plugin health', async () => {
    const { registry, guard } = setup()
    class HealthyReporting extends BasePlugin {
      async install() {}
      override getHealthStatus() {
        return { healthy: true, status: this._status, uptime: 42 }
      }
    }
    const result = await registry.register(new HealthyReporting(testManifest(), mockContext()))
    expect(result.success).toBe(true)

    // A bare-object plugin without getHealthStatus exercises the fallback row.
    const bare: Plugin = {
      manifest: testManifest({ id: 'test/bare' }),
      install: () => {},
    }
    expect((await registry.register(bare)).success).toBe(true)

    const report = guard.getHealthReport()
    expect(report.total).toBe(2)
    expect(report.active).toBe(2)
    expect(report.plugins[0]).toMatchObject({ id: 'test/plugin', name: 'Test Plugin' })
    expect(report.plugins[1]).toMatchObject({ id: 'test/bare' })
  })
})
