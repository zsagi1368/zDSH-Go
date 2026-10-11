/**
 * 插件治理系统 - 注册表与插件基类集成测试
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { DefaultPluginRegistry } from '../src/registry/registry.ts'
import { BasePlugin } from '../src/base/base.ts'
import {
  PluginManifest,
  PluginStatus,
  PluginContext,
  PluginError,
  PluginTimeoutError,
  PluginMemoryError,
} from '../src/spec/index.ts'
import { mockContext, testManifest } from './fixtures.ts'

class ProbePlugin extends BasePlugin {
  installed = false
  uninstalled = false

  async install() {
    this.installed = true
  }

  async uninstall() {
    this.uninstalled = true
  }

  exposeValidateConfig(config: Record<string, unknown>, schema: Record<string, unknown>) {
    return this.validateConfig(config, schema)
  }

  exposeAddCleanup(fn: () => void) {
    this.addCleanup(fn)
  }

  exposeCleanup() {
    this.cleanup(this.context)
  }

  exposeRegisterCapability(name: string) {
    this.registerCapability({ type: 'tool', tool: { name, description: name, schema: {} } })
  }

  exposeUnregisterCapability(name: string) {
    this.unregisterCapability(name)
  }

  exposeSetStatus(value: PluginStatus) {
    this.status = value
  }
}

describe('DefaultPluginRegistry', () => {
  let registry: DefaultPluginRegistry

  beforeEach(() => {
    registry = new DefaultPluginRegistry()
  })

  const makePlugin = (overrides: Partial<PluginManifest> = {}, context?: PluginContext) =>
    new ProbePlugin(testManifest(overrides), context ?? mockContext())

  it('registers a valid plugin and calls install', async () => {
    const plugin = makePlugin()
    const result = await registry.register(plugin)
    expect(result.success).toBe(true)
    expect(result.pluginId).toBe('test/plugin')
    expect(plugin.installed).toBe(true)
  })

  it('rejects invalid plugin IDs', async () => {
    const result = await registry.register(makePlugin({ id: 'invalid' }))
    expect(result.success).toBe(false)
    expect(result.errors?.[0]?.path).toBe('id')
  })

  it('rejects duplicate registration of the same normalized id', async () => {
    await registry.register(makePlugin())
    const again = await registry.register(makePlugin({ name: 'Second' }))
    expect(again.success).toBe(false)
    expect(again.errors?.[0]?.message).toContain('already registered')
  })

  it('unregistering an unknown id is a quiet no-op', async () => {
    await expect(registry.unregister('ghost/plugin')).resolves.toBeUndefined()
  })

  it('rejects malformed semver, missing capabilities, and missing sandbox', async () => {
    const badVersion = await registry.register(makePlugin({ version: 'abc' }))
    expect(badVersion.success).toBe(false)

    const noCaps = await registry.register(makePlugin({ capabilities: [] }))
    expect(noCaps.errors?.[0]?.path).toBe('capabilities')

    const missingCaps = await registry.register(
      makePlugin({
        capabilities: undefined as unknown as PluginManifest['capabilities'],
      }),
    )
    expect(missingCaps.errors?.[0]?.path).toBe('capabilities')

    const noSandbox = await registry.register(
      makePlugin({ sandbox: undefined as unknown as PluginManifest['sandbox'] }),
    )
    expect(noSandbox.errors?.[0]?.path).toBe('sandbox')
  })

  it('marks the plugin ERROR when install throws and reports failure', async () => {
    class ExplodingPlugin extends BasePlugin {
      async install() {
        throw new Error('boom during install')
      }
    }
    const result = await registry.register(new ExplodingPlugin(testManifest(), mockContext()))
    expect(result.success).toBe(false)
    expect(result.errors?.[0]?.message).toContain('boom during install')
    expect(registry.getStatus('test/plugin')).toBe(PluginStatus.ERROR)
    // The failed registration must not keep the plugin around.
    expect(registry.get('test/plugin')).toBeNull()
  })

  it('normalizes legacy dsh- ids at registration', async () => {
    const result = await registry.register(makePlugin({ id: 'dsh-tools' }))
    expect(result.success).toBe(true)
    expect(result.pluginId).toBe('core/tools')
  })

  it('unregisters plugins and invokes uninstall', async () => {
    const plugin = makePlugin()
    await registry.register(plugin)
    await registry.unregister('test/plugin')
    expect(plugin.uninstalled).toBe(true)
    expect(registry.get('test/plugin')).toBeNull()
  })

  it('survives uninstall failures during unregister', async () => {
    class BadUninstall extends BasePlugin {
      async install() {}
      async uninstall() {
        throw new Error('uninstall exploded')
      }
    }
    await registry.register(new BadUninstall(testManifest(), mockContext()))
    await registry.unregister('test/plugin')
    expect(registry.get('test/plugin')).toBeNull()
  })

  it('generates a health report from registry state', async () => {
    await registry.register(makePlugin())
    const report = registry.getHealthReport()
    expect(report.total).toBe(1)
    expect(report.active).toBe(1)
    expect(report.plugins[0]).toMatchObject({ id: 'test/plugin', name: 'Test Plugin' })
  })

  it('queries by capability across tool/hook/service types', async () => {
    await registry.register(
      makePlugin({
        capabilities: [
          { type: 'tool', tool: { name: 'probe_tool', description: 't', schema: {} } },
          { type: 'hook', hook: { name: 'hooky', event: 'session:start' } },
          { type: 'service', service: { name: 'servicy', factory: './factory.js' } },
        ],
      }),
    )
    expect(registry.findByCapability('tool', 'probe_tool')).toHaveLength(1)
    expect(registry.findByCapability('hook', 'hooky')).toHaveLength(1)
    expect(registry.findByCapability('service', 'servicy')).toHaveLength(1)
    expect(registry.findByCapability('tool', 'missing')).toHaveLength(0)
  })

  it('enable/disable/setStatus drive findActive/findDisabled and error notes', async () => {
    await registry.register(makePlugin())
    await registry.disable('test/plugin', 'user asked')
    expect(registry.findDisabled()).toHaveLength(1)
    expect(registry.getHealthReport().disabled).toBe(1)
    // The plugin stays registered while disabled.
    expect(registry.get('test/plugin')).not.toBeNull()

    await registry.enable('test/plugin')
    expect(registry.findActive()).toHaveLength(1)

    registry.setStatus('test/plugin', PluginStatus.WARNINGS)
    expect(registry.getStatus('test/plugin')).toBe(PluginStatus.WARNINGS)

    // Disabling without a reason records no error note.
    await registry.disable('test/plugin')
    expect(registry.getHealthReport().disabled).toBe(1)
  })

  it('registerDisposable for an unknown plugin id is a quiet no-op', () => {
    registry.registerDisposable('ghost/plugin', () => {})
  })

  it('validate surfaces the raw-id failure for direct callers', () => {
    const result = registry.validate(makePlugin({ id: 'not valid' }))
    expect(result.valid).toBe(false)
    expect(result.errors[0]).toMatchObject({ path: 'id' })
  })

  it('checkCompatibility tolerates manifests without a dsh block', async () => {
    await registry.register(
      makePlugin({ dsh: undefined as unknown as PluginManifest['dsh'] }),
    )
    const plugin = registry.get('test/plugin')!
    const result = registry.checkCompatibility(plugin, '9.9.9')
    expect(result.compatible).toBe(true)
    expect(result.requiredVersion).toBe('')
  })

  it('update replaces the registered plugin instance', async () => {
    await registry.register(makePlugin())
    const replacement = makePlugin({ version: '2.0.0' })
    await registry.update('test/plugin', replacement)
    expect(replacement.installed).toBe(true)
    expect(registry.get('test/plugin')).toBe(replacement)
  })

  it('setPluginWarnings upgrades ACTIVE to WARNINGS and back', async () => {
    await registry.register(makePlugin())

    registry.setPluginWarnings('test/plugin', ['slow startup'])
    expect(registry.getStatus('test/plugin')).toBe(PluginStatus.WARNINGS)
    expect(registry.getPluginWarnings('test/plugin')).toEqual(['slow startup'])

    registry.setPluginWarnings('test/plugin', [])
    expect(registry.getStatus('test/plugin')).toBe(PluginStatus.ACTIVE)
    expect(registry.getPluginWarnings('test/plugin')).toBeUndefined()
    expect(registry.getHealthReport().warnings).toBe(0)
  })

  it('setPluginWarnings leaves non-ACTIVE statuses untouched', async () => {
    await registry.register(makePlugin())

    // A disabled plugin gains warnings without a status upgrade.
    await registry.disable('test/plugin', 'user asked')
    registry.setPluginWarnings('test/plugin', ['still broken'])
    expect(registry.getStatus('test/plugin')).toBe(PluginStatus.DISABLED)
    expect(registry.getPluginWarnings('test/plugin')).toEqual(['still broken'])

    // Clearing warnings on an already-ACTIVE plugin keeps it ACTIVE.
    await registry.enable('test/plugin')
    registry.setPluginWarnings('test/plugin', [])
    expect(registry.getStatus('test/plugin')).toBe(PluginStatus.ACTIVE)
  })

  it('dispose runs plugin disposables then uninstall and clears state', async () => {
    const plugin = makePlugin()
    await registry.register(plugin)
    let disposed = false
    registry.registerDisposable('test/plugin', () => {
      disposed = true
    })
    registry.registerDisposable('test/plugin', () => {
      throw new Error('cleanup failure is swallowed')
    })

    await registry.dispose()
    expect(disposed).toBe(true)
    expect(plugin.uninstalled).toBe(true)
    expect(registry.getAll()).toHaveLength(0)
  })

  it('dispose tolerates plugins without disposables or uninstall', async () => {
    class Bare extends BasePlugin {
      async install() {}
    }
    await registry.register(new Bare(testManifest(), mockContext()))
    await expect(registry.dispose()).resolves.toBeUndefined()
    expect(registry.getAll()).toHaveLength(0)
  })

  it('dispose survives uninstall failures', async () => {
    class BadUninstall extends BasePlugin {
      async install() {}
      async uninstall() {
        throw new Error('dispose uninstall exploded')
      }
    }
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await registry.register(new BadUninstall(testManifest(), mockContext()))
      await expect(registry.dispose()).resolves.toBeUndefined()
      expect(registry.getAll()).toHaveLength(0)
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('returns ERROR for unknown plugin status lookups', () => {
    expect(registry.getStatus('ghost/plugin')).toBe(PluginStatus.ERROR)
  })

  it('logs a placeholder-context warning in debug mode', async () => {
    const previousDebug = process.env.DSH_DEBUG
    process.env.DSH_DEBUG = '1'
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {})
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      class ContextCapturing extends BasePlugin {
        registryContext?: PluginContext
        async install(ctx: PluginContext) {
          this.registryContext = ctx
        }
      }
      const debugRegistry = new DefaultPluginRegistry()
      const plugin = new ContextCapturing(testManifest(), mockContext())
      const result = await debugRegistry.register(plugin)
      expect(result.success).toBe(true)
      expect(warnSpy).toHaveBeenCalled()
      // The placeholder context's debug logger only emits in debug mode.
      plugin.registryContext?.logger.debug('debug message')
      expect(debugSpy).toHaveBeenCalled()
      plugin.registryContext?.logger.info('info message')
      expect(logSpy).toHaveBeenCalled()
      plugin.registryContext?.logger.warn('warn message')
      expect(warnSpy).toHaveBeenCalled()
      plugin.registryContext?.logger.error('error message')
      expect(errorSpy).toHaveBeenCalled()

      // Placeholder context behaviors: config, warnings, deprecation, no-op sandbox.
      expect(plugin.registryContext?.getConfig<string>('missing', 'fallback')).toBe('fallback')
      plugin.registryContext?.setWarnings(['degraded'])
      expect(debugRegistry.getPluginWarnings('test/plugin')).toEqual(['degraded'])
      plugin.registryContext?.markDeprecated('superseded')
      expect(debugRegistry.getStatus('test/plugin')).toBe(PluginStatus.DEPRECATED)
      const sandbox = plugin.registryContext!.sandbox
      await expect(sandbox.exec('noop')).resolves.toMatchObject({ exitCode: 0 })
      await expect(sandbox.read('/any')).resolves.toBe('')
      await expect(sandbox.write('/any', 'x')).resolves.toBeUndefined()
      await expect(sandbox.list('/any')).resolves.toEqual([])

      // Event, effect, and config members are deliberate no-ops.
      plugin.registryContext?.emit('event', {})
      const off = plugin.registryContext?.on('event', () => {}) ?? (() => {})
      off()
      const onceOff = plugin.registryContext?.once('event', () => {}) ?? (() => {})
      onceOff()
      plugin.registryContext?.off('event', () => {})
      plugin.registryContext?.effect(() => {})
      plugin.registryContext?.setConfig('key', 1)
      plugin.registryContext?.registerCapability({
        type: 'tool',
        tool: { name: 'cap', description: 'c', schema: {} },
      })
      plugin.registryContext?.unregisterCapability('cap')
      plugin.registryContext?.onDispose(() => {})
    } finally {
      debugSpy.mockRestore()
      warnSpy.mockRestore()
      logSpy.mockRestore()
      errorSpy.mockRestore()
      if (previousDebug === undefined) Reflect.deleteProperty(process.env, 'DSH_DEBUG')
      else process.env.DSH_DEBUG = previousDebug
    }
  })

  it('placeholder-context debug logging stays quiet outside debug mode', async () => {
    const previousDebug = process.env.DSH_DEBUG
    delete process.env.DSH_DEBUG
    try {
      class ContextCapturing extends BasePlugin {
        registryContext?: PluginContext
        async install(ctx: PluginContext) {
          this.registryContext = ctx
        }
      }
      const quietRegistry = new DefaultPluginRegistry()
      const plugin = new ContextCapturing(testManifest(), mockContext())
      expect((await quietRegistry.register(plugin)).success).toBe(true)
      // The debug-mode branch of the placeholder logger must not fire.
      const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {})
      plugin.registryContext?.logger.debug('quiet message')
      expect(debugSpy).not.toHaveBeenCalled()
      debugSpy.mockRestore()
    } finally {
      if (previousDebug === undefined) Reflect.deleteProperty(process.env, 'DSH_DEBUG')
      else process.env.DSH_DEBUG = previousDebug
    }
  })

  it('checkCompatibility flags ranges the kernel falls outside of', async () => {
    await registry.register(makePlugin({ dsh: { compatible: '>=0.1.0-rc.8 <0.2.0' } }))
    const plugin = registry.get('test/plugin')!
    expect(plugin).not.toBeNull()

    const tooNew = registry.checkCompatibility(plugin, '9.9.9')
    expect(tooNew.compatible).toBe(false)
    expect(tooNew.issues[0]).toContain('< 0.2.0')

    const compatibleResult = registry.checkCompatibility(plugin, '0.1.1-rc.2')
    expect(compatibleResult.compatible).toBe(true)
    expect(compatibleResult.peerDepsSatisfied).toBe(true)
  })

  it('rejects a kernel exactly at the declared upper bound (NF1: agrees with the LoadGuard)', async () => {
    // `<X` excludes X itself. The registry compared with `> 0` while the
    // LoadGuard compared with `>= 0`, so the two governance faces disagreed at
    // exactly this point (NF1). The mirrored LoadGuard case lives in
    // guards.spec.ts ("agrees with the registry on the kernel==max boundary").
    await registry.register(makePlugin({ dsh: { compatible: '>=0.1.0-rc.8 <0.2.0' } }))
    const plugin = registry.get('test/plugin')!
    expect(plugin).not.toBeNull()

    const atBound = registry.checkCompatibility(plugin, '0.2.0')
    expect(atBound.compatible).toBe(false)
    expect(atBound.issues[0]).toContain('< 0.2.0')

    // One patch below the bound stays inside, so the boundary is exact rather
    // than a blanket rejection.
    expect(registry.checkCompatibility(plugin, '0.1.9').compatible).toBe(true)
  })

  it('checkCompatibility survives malformed ranges and compares prereleases', async () => {
    // Malformed tokens fall back to the zero-version parse instead of crashing.
    await registry.register(makePlugin({ dsh: { compatible: '<banana >=0.2.0-x' } }))
    const malformed = registry.get('test/plugin')!
    expect(registry.checkCompatibility(malformed, '9.9.9').compatible).toBe(false)

    await registry.register(
      makePlugin({ id: 'test/pre', dsh: { compatible: '>=0.2.0-alpha <0.2.0-beta' } }),
    )
    const pre = registry.get('test/pre')!
    // A release kernel sits above the '<0.2.0-beta' ceiling.
    expect(registry.checkCompatibility(pre, '0.2.0').compatible).toBe(false)
    // An earlier prerelease sits below the '>=0.2.0-alpha' floor.
    expect(registry.checkCompatibility(pre, '0.2.0-aardvark').compatible).toBe(false)
    // A prerelease between the floor and the ceiling fits the window.
    expect(registry.checkCompatibility(pre, '0.2.0-az').compatible).toBe(true)
  })

  it('checkCompatibility handles one-sided and kernel-prerelease ranges', async () => {
    await registry.register(makePlugin({ id: 'test/min-only', dsh: { compatible: '>=0.1.0' } }))
    const minOnly = registry.get('test/min-only')!
    expect(registry.checkCompatibility(minOnly, '99.0.0').compatible).toBe(true)

    await registry.register(makePlugin({ id: 'test/max-only', dsh: { compatible: '<0.5.0' } }))
    const maxOnly = registry.get('test/max-only')!
    expect(registry.checkCompatibility(maxOnly, '9.0.0').compatible).toBe(false)

    // A kernel prerelease sits below a bare-release floor.
    await registry.register(makePlugin({ id: 'test/pre-floor', dsh: { compatible: '>=0.2.0 <0.3.0' } }))
    const preFloor = registry.get('test/pre-floor')!
    expect(registry.checkCompatibility(preFloor, '0.2.0-rc').compatible).toBe(false)
  })

  it('NF2: checkCompatibility verifies peer dependency satisfaction', async () => {
    // Register a peer dependency plugin first
    await registry.register(makePlugin({ id: 'test/peer-dep', version: '2.0.0' }))
    const peerDep = registry.get('test/peer-dep')!
    expect(peerDep).not.toBeNull()

    // Plugin declaring a satisfied peer dependency
    await registry.register(
      makePlugin({
        id: 'test/consumer',
        dsh: {
          compatible: '>=0.1.0',
          peerDependencies: { 'test/peer-dep': '^2.0.0' },
        },
      }),
    )
    const consumer = registry.get('test/consumer')!
    const satisfied = registry.checkCompatibility(consumer, '0.1.0')
    expect(satisfied.compatible).toBe(true)
    expect(satisfied.peerDepsSatisfied).toBe(true)
    expect(satisfied.issues).toHaveLength(0)

    // Plugin declaring a version-mismatched peer dependency
    await registry.register(
      makePlugin({
        id: 'test/consumer-bad-version',
        dsh: {
          compatible: '>=0.1.0',
          peerDependencies: { 'test/peer-dep': '^3.0.0' },
        },
      }),
    )
    const badVersion = registry.get('test/consumer-bad-version')!
    const versionMismatch = registry.checkCompatibility(badVersion, '0.1.0')
    expect(versionMismatch.compatible).toBe(false)
    expect(versionMismatch.peerDepsSatisfied).toBe(false)
    expect(versionMismatch.issues).toHaveLength(1)
    expect(versionMismatch.issues[0]).toContain('test/peer-dep')
    expect(versionMismatch.issues[0]).toContain('does not meet')

    // Plugin declaring a missing peer dependency
    await registry.register(
      makePlugin({
        id: 'test/consumer-missing',
        dsh: {
          compatible: '>=0.1.0',
          peerDependencies: { 'test/nonexistent': '^1.0.0' },
        },
      }),
    )
    const missing = registry.get('test/consumer-missing')!
    const missingResult = registry.checkCompatibility(missing, '0.1.0')
    expect(missingResult.compatible).toBe(false)
    expect(missingResult.peerDepsSatisfied).toBe(false)
    expect(missingResult.issues).toHaveLength(1)
    expect(missingResult.issues[0]).toContain('test/nonexistent')
    expect(missingResult.issues[0]).toContain('not registered')

    // Plugin with no peer dependencies should always pass
    await registry.register(
      makePlugin({
        id: 'test/consumer-no-peer',
        dsh: { compatible: '>=0.1.0' },
      }),
    )
    const noPeer = registry.get('test/consumer-no-peer')!
    const noPeerResult = registry.checkCompatibility(noPeer, '0.1.0')
    expect(noPeerResult.compatible).toBe(true)
    expect(noPeerResult.peerDepsSatisfied).toBe(true)
    expect(noPeerResult.issues).toHaveLength(0)
  })
})

describe('BasePlugin lifecycle helpers', () => {
  it('exposes manifest and status through getters', () => {
    const plugin = new ProbePlugin(testManifest(), mockContext())
    expect(plugin.manifest.id).toBe('test/plugin')
    expect(plugin.status).toBe(PluginStatus.ACTIVE)
    expect(plugin.getHealthStatus()).toMatchObject({ healthy: true })
  })

  it('validateConfig reports missing required fields and type mismatches', () => {
    const plugin = new ProbePlugin(testManifest(), mockContext())
    const schema = {
      required: ['apiKey'],
      properties: {
        retries: { type: 'number' },
        enabled: { type: 'boolean' },
      },
    }
    const result = plugin.exposeValidateConfig({ retries: 'many', enabled: false }, schema)
    expect(result.valid).toBe(false)
    expect(result.errors[0]).toMatchObject({ path: 'apiKey', severity: 'error' })
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toMatchObject({ path: 'retries', severity: 'warning' })
  })

  it('validateConfig passes a fully valid config', () => {
    const plugin = new ProbePlugin(testManifest(), mockContext())
    const result = plugin.exposeValidateConfig(
      { apiKey: 'k', retries: 3, enabled: true },
      { required: ['apiKey'], properties: { retries: { type: 'number' } } },
    )
    expect(result.valid).toBe(true)
    expect(result.warnings).toHaveLength(0)
  })

  it('validateConfig tolerates empty schemas and flags boolean mismatches', () => {
    const plugin = new ProbePlugin(testManifest(), mockContext())
    expect(plugin.exposeValidateConfig({}, {})).toMatchObject({ valid: true, errors: [] })

    const result = plugin.exposeValidateConfig(
      { flag: 'yes' },
      { properties: { flag: { type: 'boolean' } } },
    )
    expect(result.valid).toBe(true)
    expect(result.warnings[0]).toMatchObject({ path: 'flag', message: /Expected boolean/ })
  })

  it('logs through the protected status setter', () => {
    const plugin = new ProbePlugin(testManifest(), mockContext())
    plugin.exposeSetStatus(PluginStatus.WARNINGS)
    expect(plugin.status).toBe(PluginStatus.WARNINGS)
  })

  it('cleanup runs registered disposables and survives throwing ones', async () => {
    const plugin = new ProbePlugin(testManifest(), mockContext())
    let ran = false
    plugin.exposeAddCleanup(() => {
      ran = true
    })
    plugin.exposeAddCleanup(() => {
      throw new Error('cleanup boom')
    })
    plugin.exposeCleanup()
    expect(ran).toBe(true)
  })

  it('capability registration delegates to the context', () => {
    const context = mockContext()
    const registered: string[] = []
    context.registerCapability = (capability) => {
      if (capability.tool) registered.push(capability.tool.name)
    }
    context.unregisterCapability = (name) => {
      registered.splice(registered.indexOf(name), 1)
    }
    const plugin = new ProbePlugin(testManifest(), context)
    plugin.exposeRegisterCapability('probe')
    expect(registered).toEqual(['probe'])
    plugin.exposeUnregisterCapability('probe')
    expect(registered).toEqual([])
  })
})

describe('spec error classes', () => {
  it('carries plugin id and sanitized detail', () => {
    const error = new PluginError('a/b', 'went wrong', 'at line 1\nat line 2')
    expect(error.message).toBe('[Plugin a/b] went wrong')
    expect(error.name).toBe('PluginError')
    expect(error.pluginId).toBe('a/b')
    expect(error.detail).toBe('at line 1\nat line 2')
  })

  it('derives timeout and memory errors from PluginError', () => {
    const timeout = new PluginTimeoutError('a/b', 1500)
    expect(timeout.name).toBe('PluginTimeoutError')
    expect(timeout.message).toContain('timeout (1500ms)')
    expect(timeout.pluginId).toBe('a/b')

    const memory = new PluginMemoryError('c/d', 256)
    expect(memory.name).toBe('PluginMemoryError')
    expect(memory.message).toContain('memory limit (256MB)')
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})
