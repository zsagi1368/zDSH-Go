/**
 * Cordis adapter behavioral suite: manifest inference, approval-gated
 * install/uninstall, health delegation, and the wrap/detect helpers.
 */

import { describe, expect, it, vi } from 'vitest'
import {
  CordisPluginWrapper,
  createCordisAdapter,
  isApprovalGranted,
  isCordisPlugin,
  normalizeCordisPluginId,
  wrapCordisPlugin,
  type CordisService,
} from '../src/compat/cordis-adapter.ts'
import { PluginCertification, PluginPermissionLevel, PluginStatus, type PluginManifest } from '../src/spec/index.ts'
import { mockContext } from './fixtures.ts'
import { DefaultPluginRegistry } from '../src/registry/registry.ts'
import type { PluginContext } from '../src/spec/index.ts'

class OfficialService implements CordisService {
  static serviceName = 'official-service'
  static inject = ['logger', 'config']

  started = false
  stopped = false

  async start(ctx: Record<string, unknown>) {
    this.started = true
    void ctx
  }

  async stop() {
    this.stopped = true
  }

  health() {
    return { healthy: true }
  }
}

class PlainService {
  // 非 Cordis 形状的服务：有 stop（满足弱类型检查）但没有
  // start/health/serviceName，因此 isCordisPlugin 判定为否。
  async stop() {}
}

// Non-array inject statics must degrade to an empty dependency list.
class WeirdInject {
  static serviceName = 'weird-service'
  static inject = 'logger' as unknown as string[]

  health() {
    return { healthy: true }
  }
}

// Class prototype members are non-enumerable, so the adapter's prototype scan
// only sees explicitly assigned (enumerable) methods — mirror Cordis plugins
// that attach tools onto their prototype object.
class ToolHost {
  health() {
    return { healthy: true }
  }
}
const toolHostProto = ToolHost.prototype as unknown as Record<string, () => unknown>
toolHostProto['tool_probe'] = () => undefined
toolHostProto['command_run'] = () => undefined
toolHostProto['helper'] = () => undefined

function approvalContext(outcome: 'allowed-once' | 'rejected' | 'allowed-always'): PluginContext {
  const context = mockContext()
  context.approval = {
    request: async () => outcome,
  }
  return context
}

describe('CordisPluginWrapper manifest generation', () => {
  it('infers a service capability from the Cordis serviceName/inject statics', () => {
    const wrapper = new CordisPluginWrapper(
      new OfficialService(),
      { id: 'org/plugin', name: 'Official' },
      mockContext(),
    )
    expect(wrapper.manifest.id).toBe('org/plugin')
    expect(wrapper.manifest.version).toBe('1.0.0')
    const service = wrapper.manifest.capabilities[0]?.service
    expect(service).toMatchObject({
      name: 'official-service',
      factory: 'cordis:OfficialService',
      dependencies: ['logger', 'config'],
    })
  })

  it('derives default capability and version fallbacks', () => {
    const wrapper = new CordisPluginWrapper(new PlainService(), { id: 'o/p', name: 'P' }, mockContext())
    expect(wrapper.manifest.version).toBe('1.0.0')
    expect(wrapper.manifest.capabilities[0]?.service?.name).toBe('plainservice')
  })

  it('maps tool_/command_ prototype methods to tool capabilities', () => {
    const wrapper = new CordisPluginWrapper(new ToolHost(), { id: 'o/t', name: 'T' }, mockContext())
    const tools = wrapper.manifest.capabilities.map(c => c.tool?.name)
    expect(tools).toContain('probe')
    expect(tools).toContain('run')
  })

  it('degrades non-array inject statics to an empty dependency list', () => {
    const wrapper = new CordisPluginWrapper(new WeirdInject(), { id: 'o/w', name: 'W' }, mockContext())
    expect(wrapper.manifest.capabilities[0]?.service).toMatchObject({
      name: 'weird-service',
      dependencies: [],
    })
  })

  it('keeps security defaults: confirmation required, fullyAuthorized off', () => {
    const wrapper = new CordisPluginWrapper(
      new OfficialService(),
      { id: 'o/s', name: 'S', description: 'Described' },
      mockContext(),
    )
    expect(wrapper.manifest.sandbox.process.fullyAuthorized).toBe(false)
    expect(wrapper.manifest.autoApprove).toBe(false)
    expect(wrapper.manifest.permissionLevel).toBe('workspace')
    expect(wrapper.manifest.description).toBe('Described')

    const explicit = new CordisPluginWrapper(
      new OfficialService(),
      { id: 'o/s2', name: 'S2', fullyAuthorized: true },
      mockContext(),
    )
    // Even explicit full authorization keeps the sandbox gate closed; only
    // autoApprove flips.
    expect(explicit.manifest.sandbox.process.fullyAuthorized).toBe(false)
    expect(explicit.manifest.autoApprove).toBe(true)
    expect(explicit.manifest.permissionLevel).toBe('confirm-required')
  })
})

describe('CordisPluginWrapper lifecycle', () => {
  it('installs without approval when autoApprove is set', async () => {
    const service = new OfficialService()
    const context = mockContext()
    const wrapper = new CordisPluginWrapper(service, { id: 'o/i', name: 'I', fullyAuthorized: true }, context)
    await wrapper.install(context)
    expect(service.started).toBe(true)
    expect(wrapper.status).toBe(PluginStatus.ACTIVE)
  })

  it('asks for approval once when not auto-approved (allow path)', async () => {
    const service = new OfficialService()
    const request = vi.fn(async () => 'allowed-once' as const)
    const context = mockContext()
    context.approval = { request }

    const wrapper = new CordisPluginWrapper(service, { id: 'o/a', name: 'A' }, context)
    await wrapper.install(context)
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ toolName: 'plugin:o/a' }))
    expect(service.started).toBe(true)
  })

  it('rejects installation when the user declines', async () => {
    const service = new OfficialService()
    const context = approvalContext('rejected')
    const wrapper = new CordisPluginWrapper(service, { id: 'o/r', name: 'R' }, context)
    await expect(wrapper.install(context)).rejects.toThrow(/rejected by user/)
    expect(service.started).toBe(false)
    // The rejection surfaces through the install catch, which marks ERROR.
    expect(wrapper.status).toBe(PluginStatus.ERROR)
  })

  it('honors allowed-always outcomes and forwards the typed agent', async () => {
    const service = new OfficialService()
    const request = vi.fn(async () => 'allowed-always' as const)
    const context = mockContext()
    context.agent = { session: { events: [] } }
    context.approval = { request }

    const wrapper = new CordisPluginWrapper(service, { id: 'o/aa', name: 'AA' }, context)
    await wrapper.install(context)
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ agent: { session: { events: [] } } }),
    )
    expect(service.started).toBe(true)
  })

  it('treats an approval-service failure as a decline', async () => {
    const service = new OfficialService()
    const context = mockContext()
    context.approval = {
      request: async () => {
        throw new Error('approval channel down')
      },
    }
    const wrapper = new CordisPluginWrapper(service, { id: 'o/fail', name: 'F' }, context)
    await expect(wrapper.install(context)).rejects.toThrow(/rejected by user/)
    expect(service.started).toBe(false)
  })

  it('installs services without a start hook and tolerates missing config', async () => {
    // 镜像模式：无 start 钩子的服务在登记时也不需要审批通道。
    const idle = new CordisPluginWrapper(new PlainService(), { id: 'o/ns', name: 'NS', mirror: true }, mockContext())
    const context = mockContext()
    context.config = undefined as unknown as Record<string, unknown>
    await expect(idle.install(context)).resolves.toBeUndefined()
    expect(idle.status).toBe(PluginStatus.ACTIVE)

    // A service with start still receives the (missing) config object.
    const started = new OfficialService()
    const starter = new CordisPluginWrapper(
      started,
      { id: 'o/ns2', name: 'NS2', fullyAuthorized: true },
      mockContext(),
    )
    await expect(starter.install(context)).resolves.toBeUndefined()
    expect(started.started).toBe(true)
  })

  it('marks ERROR status when service start fails', async () => {
    class ExplodingStart extends OfficialService {
      override async start(): Promise<void> {
        throw new Error('start exploded')
      }
    }
    const wrapper = new CordisPluginWrapper(
      new ExplodingStart(),
      { id: 'o/x', name: 'X', fullyAuthorized: true },
      mockContext(),
    )
    await expect(wrapper.install(mockContext())).rejects.toThrow('start exploded')
    expect(wrapper.status).toBe(PluginStatus.ERROR)
  })

  it('fails closed when no approval service is present', async () => {
    const service = new OfficialService()
    const wrapper = new CordisPluginWrapper(service, { id: 'o/n', name: 'N' }, mockContext())
    // 无审批服务时不再静默放行：敏感安装直接拒绝（fail closed）。
    await expect(wrapper.install(mockContext())).rejects.toThrow(/rejected by user/)
    expect(service.started).toBe(false)
    expect(wrapper.status).toBe(PluginStatus.ERROR)
  })

  it('mirror mode installs without approval or lifecycle side effects', async () => {
    const service = new OfficialService()
    const wrapper = new CordisPluginWrapper(
      service,
      { id: '@deepseek-ai/dsh-mirrored', name: 'Mirrored', mirror: true },
      mockContext(),
    )
    // 挂载即准入：autoApprove 为真，无需审批服务。
    expect(wrapper.manifest.autoApprove).toBe(true)
    await expect(wrapper.install(mockContext())).resolves.toBeUndefined()
    // Cordis 拥有生命周期：不重复 start/stop。
    expect(service.started).toBe(false)
    expect(wrapper.status).toBe(PluginStatus.ACTIVE)
    await expect(wrapper.uninstall(mockContext())).resolves.toBeUndefined()
    expect(service.stopped).toBe(false)
    expect(wrapper.status).toBe(PluginStatus.DISABLED)
  })

  it('uninstall stops the service and flips status to DISABLED', async () => {
    const service = new OfficialService()
    const wrapper = new CordisPluginWrapper(
      service,
      { id: 'o/u', name: 'U', fullyAuthorized: true },
      mockContext(),
    )
    const context = mockContext()
    await wrapper.install(context)
    await wrapper.uninstall(context)
    expect(service.stopped).toBe(true)
    expect(wrapper.status).toBe(PluginStatus.DISABLED)
  })

  it('swallows stop failures during uninstall', async () => {
    class BadStop extends OfficialService {
      override async stop(): Promise<void> {
        throw new Error('stop failed')
      }
    }
    const wrapper = new CordisPluginWrapper(
      new BadStop(),
      { id: 'o/bs', name: 'BS', fullyAuthorized: true },
      mockContext(),
    )
    await expect(wrapper.uninstall(mockContext())).resolves.toBeUndefined()
  })

  it('delegates health checks to the service with a status fallback', async () => {
    const service = new OfficialService()
    const wrapper = new CordisPluginWrapper(
      service,
      { id: 'o/h', name: 'H', fullyAuthorized: true },
      mockContext(),
    )
    expect(wrapper.getHealthStatus()).toMatchObject({ healthy: true })

    // An idle wrapper is ACTIVE until installed/uninstalled; after uninstall it
    // reports unhealthy through the fallback.
    const idle = new CordisPluginWrapper(new PlainService(), { id: 'o/h2', name: 'H2' }, mockContext())
    expect(idle.getHealthStatus()).toMatchObject({ healthy: true })
    await idle.uninstall(mockContext())
    expect(idle.getHealthStatus()).toMatchObject({ healthy: false })
  })
})

describe('cordis helpers', () => {
  it('detects cordis-shaped objects', () => {
    expect(isCordisPlugin(null)).toBe(false)
    expect(isCordisPlugin('string')).toBe(false)
    expect(isCordisPlugin({})).toBe(false)
    expect(isCordisPlugin(new OfficialService())).toBe(true)
    // A class with neither start nor serviceName is not cordis-shaped.
    expect(isCordisPlugin(new ToolHost())).toBe(false)

    const protoOnly = Object.create({ start() {} }) as object
    expect(isCordisPlugin(protoOnly)).toBe(true)

    const bare = Object.create(null) as object
    expect(isCordisPlugin(bare)).toBe(false)
  })

  it('wrapCordisPlugin derives identity from options then statics then ctor name', () => {
    const context = mockContext()
    const fromStatic = wrapCordisPlugin(new OfficialService(), context)
    expect(fromStatic.manifest.id).toBe('official-service')

    const overridden = wrapCordisPlugin(new OfficialService(), context, { id: 'x/y', name: 'Y', version: '2.0.0' })
    expect(overridden.manifest.id).toBe('x/y')
    expect(overridden.manifest.name).toBe('Y')
    expect(overridden.manifest.version).toBe('2.0.0')

    const fromCtor = wrapCordisPlugin(new PlainService(), context)
    expect(fromCtor.manifest.id).toBe('PlainService')
  })

  it('createCordisAdapter wraps and detects', async () => {
    const adapter = await createCordisAdapter(mockContext())
    const plugin = adapter.wrap(new OfficialService())
    expect(plugin.manifest.id).toBe('official-service')
    expect(adapter.isCordis(new OfficialService())).toBe(true)
  })
})

describe('ID normalization (npm scoped -> namespace/name)', () => {
  it('strips the npm scope marker, matching spec normalizePluginId', () => {
    expect(normalizeCordisPluginId('@deepseek-ai/dsh-persona')).toBe('deepseek-ai/dsh-persona')
    expect(normalizeCordisPluginId('@scope/name')).toBe('scope/name')
    // Already-namespaced and bare ids pass through untouched.
    expect(normalizeCordisPluginId('org/plugin')).toBe('org/plugin')
    expect(normalizeCordisPluginId('bare-name')).toBe('bare-name')
    expect(normalizeCordisPluginId('  @a/b  ')).toBe('a/b')
  })

  it('normalizes manifest ids so registry keys match manifest.id', () => {
    const wrapper = new CordisPluginWrapper(
      new OfficialService(),
      { id: '@deepseek-ai/dsh-agent-instructions', name: 'Instructions' },
      mockContext(),
    )
    expect(wrapper.manifest.id).toBe('deepseek-ai/dsh-agent-instructions')

    const viaOptions = wrapCordisPlugin(new OfficialService(), mockContext(), {
      id: '@deepseek-ai/dsh-llm',
    })
    expect(viaOptions.manifest.id).toBe('deepseek-ai/dsh-llm')
  })
})

describe('official dsh-user-approval vocabulary bridge', () => {
  it('grants only allowed-* outcomes', () => {
    expect(isApprovalGranted('allowed-once')).toBe(true)
    expect(isApprovalGranted('allowed-always')).toBe(true)
    for (const denied of ['rejected', 'rejected-always', 'cancelled', 'unavailable']) {
      expect(isApprovalGranted(denied), denied).toBe(false)
    }
  })

  it.each(['cancelled', 'unavailable'] as const)(
    'fails closed when official approval settles as %s',
    async (outcome) => {
      const service = new OfficialService()
      const request = vi.fn(async () => outcome)
      const context = mockContext()
      context.approval = { request }

      const wrapper = new CordisPluginWrapper(service, { id: 'o/bridge', name: 'B' }, context)
      await expect(wrapper.install(context)).rejects.toThrow(/rejected by user/)
      expect(service.started).toBe(false)
      expect(wrapper.status).toBe(PluginStatus.ERROR)
      expect(request).toHaveBeenCalledTimes(1)
    },
  )

  it('forwards official callId/signal fields on the approval payload', async () => {
    const service = new OfficialService()
    const request = vi.fn(async () => 'allowed-once' as const)
    const controller = new AbortController()
    const context = mockContext()
    context.approval = { request }

    const wrapper = new CordisPluginWrapper(
      service,
      { id: 'o/call', name: 'C', callId: 'call_123', signal: controller.signal },
      context,
    )
    await wrapper.install(context)
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ callId: 'call_123', signal: controller.signal }),
    )
    expect(service.started).toBe(true)
  })
})

describe('project source (S-43 M2a, C-01)', () => {
  /** A host-clamped project manifest with a self-reporting certification field. */
  function projectManifest(): PluginManifest {
    return {
      id: 'fixtures/project-demo',
      version: '2.0.0',
      name: 'Project Demo',
      dsh: { compatible: '>=0.1.0-rc.8' },
      capabilities: [{ type: 'tool', tool: { name: 'p_tool', description: 't', schema: { type: 'object' } } }],
      sandbox: {
        type: 'inline',
        resources: { memoryLimitMb: 128, cpuLimit: 50, timeoutMs: 30000, maxOutputBytes: 10000 },
        filesystem: { access: 'readonly', allowedPaths: [], deniedPatterns: [] },
        network: { access: 'none', allowedHosts: [], deniedHosts: [], allowLocal: false },
        environment: { whitelist: [], blacklist: [], clear: false },
        process: { spawn: false, exec: false, allowedCommands: [] },
      },
      // A project manifest must never be able to self-report trust: the
      // wrapper must strip this even if the host accidentally passed it.
      certification: {
        level: PluginCertification.OFFICIAL,
        certifiedAt: 1,
      },
      autoApprove: true,
      permissionLevel: PluginPermissionLevel.WORKSPACE,
    }
  }

  it('uses the host clamped manifest and strips every trust field for project sources', () => {
    const wrapper = new CordisPluginWrapper(
      new OfficialService(),
      { id: 'fixtures/project-demo', name: 'Project Demo', source: 'project', manifest: projectManifest(), mirror: true },
      mockContext(),
    )
    // The guarded manifest is adopted verbatim…
    expect(wrapper.manifest.id).toBe('fixtures/project-demo')
    expect(wrapper.manifest.version).toBe('2.0.0')
    expect(wrapper.manifest.capabilities[0]?.tool?.name).toBe('p_tool')
    // …except the trust fields: certification dropped, autoApprove forced
    // false, permissionLevel forced CONFIRM_REQUIRED (C-01).
    expect(wrapper.manifest.certification).toBeUndefined()
    expect(wrapper.manifest.autoApprove).toBe(false)
    expect(wrapper.manifest.permissionLevel).toBe(PluginPermissionLevel.CONFIRM_REQUIRED)
    // The sandbox is the host-clamped effective one.
    expect(wrapper.manifest.sandbox.network.access).toBe('none')
  })

  it('project sources never receive the OFFICIAL certification injected for mirrors', () => {
    const official = new CordisPluginWrapper(
      new OfficialService(),
      { id: 'o/mirror', name: 'Mirror', mirror: true },
      mockContext(),
    )
    expect(official.manifest.certification?.level).toBe(PluginCertification.OFFICIAL)
    expect(official.manifest.autoApprove).toBe(true)

    const project = new CordisPluginWrapper(
      new OfficialService(),
      { id: 'fixtures/p', name: 'P', source: 'project', manifest: projectManifest() },
      mockContext(),
    )
    expect(project.manifest.certification).toBeUndefined()
    // autoApprove stays false even though the host wrapper was created with
    // mirror semantics — the mount decision never auto-approves project code.
    expect(project.manifest.autoApprove).toBe(false)
  })

  it('wrapCordisPlugin forwards the project source options', () => {
    const wrapped = wrapCordisPlugin(new OfficialService(), mockContext(), {
      id: 'fixtures/project-demo',
      name: 'Wrapped',
      version: '1.1.0',
      source: 'project',
      manifest: projectManifest(),
      mirror: true,
    })
    // For project sources, the manifest is authoritative: id and version come
    // from the host-clamped manifest, not the wrapper options.
    expect(wrapped.manifest.id).toBe('fixtures/project-demo')
    expect(wrapped.manifest.version).toBe('2.0.0')
    expect(wrapped.manifest.certification).toBeUndefined()
    expect(wrapped.manifest.autoApprove).toBe(false)
    expect(wrapped.manifest.permissionLevel).toBe(PluginPermissionLevel.CONFIRM_REQUIRED)
  })
})

describe('minimal loader entry chain (wrap -> register -> start/stop -> health)', () => {
  /**
   * 最小 Cordis entry 对象，形状对齐 vendor/loader 的 EntryOptions
   * `{ id, name, config }`（name 为官方 npm scoped 包名）。
   */
  function minimalEntry() {
    return {
      id: 'persona',
      name: '@deepseek-ai/dsh-persona',
      config: { text: 'hello from cordis' },
    }
  }

  it('adapts a loader entry end-to-end through the governance registry', async () => {
    const entry = minimalEntry()
    const service = new OfficialService()

    // 1. 包装：npm scoped 包名规范化为 namespace/name；镜像模式不驱动生命周期。
    const wrapped = wrapCordisPlugin(service, mockContext(), {
      id: normalizeCordisPluginId(entry.name),
      name: 'Persona',
      version: '0.1.1',
      mirror: true,
    })
    expect(wrapped.manifest.id).toBe('deepseek-ai/dsh-persona')
    expect(wrapped.manifest.sandbox.process.fullyAuthorized).toBe(false)
    expect(wrapped.manifest.autoApprove).toBe(true)

    // 2. 注册：镜像包装登记治理名册，但不重复调用 cordis start。
    const registry = new DefaultPluginRegistry()
    const result = await registry.register(wrapped)
    expect(result.success).toBe(true)
    expect(result.pluginId).toBe('deepseek-ai/dsh-persona')
    expect(registry.getStatus('deepseek-ai/dsh-persona')).toBe(PluginStatus.ACTIVE)
    expect(service.started).toBe(false)

    // 3. 健康检查：注册表报告与插件自身委托都可用且健康。
    const report = registry.getHealthReport()
    expect(report.total).toBe(1)
    expect(report.active).toBe(1)
    expect(report.errors).toBe(0)
    const row = report.plugins.find(p => p.id === 'deepseek-ai/dsh-persona')
    // 规范化保证 manifest.id 与注册表键一致，报告不会错位成 error。
    expect(row?.status).toBe(PluginStatus.ACTIVE)
    expect(wrapped.getHealthStatus?.()).toMatchObject({ healthy: true })

    // 4. 启停：卸载只翻转治理状态，cordis 服务保持运行（stop 不被触发）。
    await registry.unregister('deepseek-ai/dsh-persona')
    expect(service.stopped).toBe(false)
    expect(registry.getAll()).toHaveLength(0)

    // 非镜像路径仍驱动生命周期：显式授权的包装在注册时启动服务。
    const driving = new OfficialService()
    const reRegistered = await registry.register(
      wrapCordisPlugin(driving, mockContext(), {
        id: normalizeCordisPluginId(entry.name),
        name: 'Persona',
        fullyAuthorized: true,
      }),
    )
    expect(reRegistered.success).toBe(true)
    expect(reRegistered.pluginId).toBe('deepseek-ai/dsh-persona')
    expect(driving.started).toBe(true)
  })

  it('rejects a duplicate registration of the same normalized id', async () => {
    const entry = minimalEntry()
    const first = new OfficialService()
    const second = new OfficialService()
    const id = normalizeCordisPluginId(entry.name)

    const registry = new DefaultPluginRegistry()
    const firstResult = await registry.register(
      wrapCordisPlugin(first, mockContext(), { id, name: 'Persona', fullyAuthorized: true }),
    )
    expect(firstResult.success).toBe(true)

    const secondResult = await registry.register(
      wrapCordisPlugin(second, mockContext(), { id, name: 'Persona Clone', fullyAuthorized: true }),
    )
    expect(secondResult.success).toBe(false)
    expect(secondResult.errors?.[0]?.message).toBe('Plugin already registered')
    // 第二个实例未被启动，注册表仍只有第一个条目。
    expect(second.started).toBe(false)
    expect(registry.getAll()).toHaveLength(1)
    expect(registry.getHealthReport().errors).toBe(0)
  })
})
