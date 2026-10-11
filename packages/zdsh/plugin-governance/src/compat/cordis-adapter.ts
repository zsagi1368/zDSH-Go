/**
 * CordisAdapter - Cordis 插件兼容层
 *
 * 将官方 Cordis 格式的插件适配为 PluginSpec 接口，
 * 实现无缝兼容，不破坏现有插件生态。
 */

import {
  Plugin,
  PluginContext,
  PluginManifest,
  PluginStatus,
  PluginLogger,
  CapabilityDeclaration,
  PluginCertification,
  PluginPermissionLevel,
  SandboxType,
} from '../spec/index.js'
import { guardGovernance } from './../compat.ts'

/**
 * CordisService - Cordis 插件服务实例形状
 *
 * 官方插件通过此类提供功能，我们将其适配为 Plugin 接口。
 * Cordis 惯例把 serviceName / inject 声明为构造函数静态成员；
 * 这里通过 constructor 上的索引读取（见 readCordisStatics）。
 */
export interface CordisService {
  /** 启动方法 */
  start?(ctx: Record<string, unknown>): Promise<void> | void

  /** 停止方法 */
  stop?(): Promise<void> | void

  /** 健康检查 */
  health?(): { healthy: boolean; errors?: string[] }
}

/** Cordis 构造函数上的静态成员（serviceName / inject） */
interface CordisStatics {
  serviceName?: unknown
  inject?: unknown
  name: string
}

/** 读取服务的构造函数静态成员 */
function readCordisStatics(service: CordisService): CordisStatics {
  return service.constructor
}

/**
 * 官方 @deepseek-ai/dsh-user-approval 的线安全结果词表。
 *
 * 与 packages/interaction/user-approval 的 types.ts 对齐：
 * 只有 'allowed-once' 是授权；'rejected'/'cancelled'/'unavailable' 一律视为拒绝。
 * 'cancelled'/'unavailable' 必须显式 fail closed，不得降级为放行。
 */
export type OfficialApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/**
 * 判定审批结果是否为授权（桥接两种词表）：
 * - 官方 @deepseek-ai/dsh-user-approval：仅 'allowed-once' 授权；
 *   'cancelled'/'unavailable' 必须 fail closed。
 * - 本地 spec ApprovalOutcome：额外接受 'allowed-always'。
 * @param outcome - 待判定的审批结果字符串。
 * @returns 是否属于授权结果。
 */
export function isApprovalGranted(outcome: string): boolean {
  return outcome === 'allowed-once' || outcome === 'allowed-always'
}

/**
 * 规范化 Cordis 插件 ID（P0#2：npm scoped 包名 → namespace/name）
 *
 * 官方插件以 npm 包名作为身份（loader EntryOptions.name，
 * 如 '@deepseek-ai/dsh-persona'），而 PluginSpec 要求 namespace/name。
 * 规则：
 * - '@scope/name' → 'scope/name'（与 spec 的 normalizePluginId 对齐）
 * - 其余形式原样返回（已是 namespace/name 或裸名）
 * @param id - 原始 Cordis 插件 ID。
 * @returns 规范化后的插件 ID。
 */
export function normalizeCordisPluginId(id: string): string {
  const trimmed = id.trim()
  if (!trimmed.startsWith('@')) return trimmed
  return trimmed.slice(1)
}

/**
 * 默认沙箱配置 - 安全默认值，需要显式授权
 * 安全修复：默认禁用完全授权，要求显式认证
 */
const OFFICIAL_SANDBOX_CONFIG = {
  type: 'inline' as SandboxType,
  resources: {
    memoryLimitMb: 512,
    cpuLimit: 80,
    timeoutMs: 60000,
    maxOutputBytes: 10485760, // 10MB
  },
  filesystem: {
    access: 'readwrite' as const,
    allowedPaths: [] as string[],
    deniedPatterns: [] as string[],
  },
  network: {
    access: 'external' as const,
    allowedHosts: [] as string[],
    deniedHosts: [] as string[],
    allowLocal: true,
  },
  environment: {
    whitelist: [] as string[],
    blacklist: [] as string[],
    clear: false,
  },
  process: {
    spawn: true,
    exec: true,
    allowedCommands: [] as string[],
    fullyAuthorized: false, // 安全修复：默认禁用完全授权
  },
}

/**
 * CordisPluginWrapper - Cordis 插件包装器
 *
 * 将 Cordis Service 包装为 PluginSpec 接口。
 */
export class CordisPluginWrapper implements Plugin {
  readonly manifest: PluginManifest
  private readonly service: CordisService
  private readonly logger: PluginLogger
  /** 治理镜像模式：生命周期归 Cordis 所有，install/uninstall 不再驱动。 */
  private readonly mirror: boolean
  /** 官方 user-approval 透传：关联的工具调用 ID */
  private readonly approvalCallId: string | undefined
  /** 官方 user-approval 透传：撤回审批问题的中止信号 */
  private readonly approvalSignal: AbortSignal | undefined
  private _status: PluginStatus = PluginStatus.ACTIVE

  constructor(
    service: CordisService,
    cordisConfig: {
      id: string
      name: string
      version?: string | undefined
      description?: string | undefined
      config?: Record<string, unknown> | undefined
      /** 是否完全授权（默认 true，与 core 一致） */
      fullyAuthorized?: boolean | undefined
      /**
       * 治理镜像模式：被包装的服务已由 Cordis Loader 挂载并运行。
       * install()/uninstall() 不再驱动其生命周期（不重复 start/stop），
       * 也不走运行时审批 —— 挂载本身即操作者在 cordis 配置中的准入决定。
       */
      mirror?: boolean | undefined
      /**
       * 项目插件来源（S-43 M2a）：manifest 由宿主侧钳制后直接生效，
       * 一切自报信任字段（certification/permissionLevel/autoApprove）对
       * project 来源一律忽略 —— 不注入 OFFICIAL、autoApprove 恒 false、
       * permissionLevel 恒 CONFIRM_REQUIRED。
       */
      source?: 'project' | undefined
      /** source==='project' 时宿主构造的钳制后 manifest（信任字段已剔除）。 */
      manifest?: PluginManifest | undefined
      /** 官方 user-approval 字段：关联已流式展示的工具调用 */
      callId?: string | undefined
      /** 官方 user-approval 字段：中止即撤回审批问题 */
      signal?: AbortSignal | undefined
    },
    context: PluginContext,
  ) {
    this.service = service
    this.logger = context.logger
    this.approvalCallId = cordisConfig.callId
    this.approvalSignal = cordisConfig.signal
    this.mirror = cordisConfig.mirror === true

    // 项目插件来源：直接采用宿主构造的钳制后清单；manifest 内任何
    // self-certification/trust 类字段一律忽略（剔除 certification，强制
    // permissionLevel=CONFIRM_REQUIRED、autoApprove=false）。
    if (cordisConfig.source === 'project' && cordisConfig.manifest) {
      const { certification: _strippedCertification, ...rest } = cordisConfig.manifest
      this.manifest = {
        ...rest,
        permissionLevel: PluginPermissionLevel.CONFIRM_REQUIRED,
        autoApprove: false,
      }
      return
    }

    // 从 Cordis 配置生成 PluginManifest
    // ID 先做 npm scoped → namespace/name 规范化，保证注册表键与
    // manifest.id 一致（否则 getHealthReport 等按 manifest.id 查询会错位）。
    this.manifest = {
      id: normalizeCordisPluginId(cordisConfig.id),
      version: cordisConfig.version || '1.0.0',
      name: cordisConfig.name,
      ...(cordisConfig.description ? { description: cordisConfig.description } : {}),
      dsh: {
        compatible: '>=0.1.0-rc.8',
        peerDependencies: {},
      },
      capabilities: this.inferCapabilities(service),
      sandbox: {
        ...OFFICIAL_SANDBOX_CONFIG,
        // 默认需要确认，除非明确设置 autoApprove
        process: {
          ...OFFICIAL_SANDBOX_CONFIG.process,
          fullyAuthorized: false, // 默认禁用完全授权
        },
      },
      permissionLevel: cordisConfig.fullyAuthorized === true
        ? PluginPermissionLevel.CONFIRM_REQUIRED
        : PluginPermissionLevel.WORKSPACE,
      // 镜像模式的准入决定在挂载时已由操作者做出（cordis 配置），无需运行时审批。
      autoApprove: cordisConfig.mirror === true || cordisConfig.fullyAuthorized === true, // 只有显式 true 才自动授权
      certification: {
        level: PluginCertification.OFFICIAL,
        certifiedAt: Date.now(),
      },
    }
  }

  /**
   * 推断能力声明
   */
  private inferCapabilities(service: CordisService): CapabilityDeclaration[] {
    const capabilities: CapabilityDeclaration[] = []
    const statics = readCordisStatics(service)

    // 检查是否有 serviceName（Cordis 惯例：构造函数静态成员）
    if (typeof statics.serviceName === 'string') {
      capabilities.push({
        type: 'service',
        service: {
          name: statics.serviceName,
          factory: `cordis:${statics.name}`,
          dependencies: Array.isArray(statics.inject)
            ? statics.inject.filter((entry): entry is string => typeof entry === 'string')
            : [],
        },
      })
    }

    // 检查是否有工具方法
    const proto = service.constructor.prototype as Record<string, unknown>
    for (const key of Object.keys(proto)) {
      if (key.startsWith('tool_') || key.startsWith('command_')) {
        capabilities.push({
          type: 'tool',
          tool: {
            name: key.replace(/^tool_|^command_/, ''),
            description: `${key} tool`,
            schema: {},
          },
        })
      }
    }

    // 如果没有任何能力，添加默认 service 能力
    if (capabilities.length === 0) {
      capabilities.push({
        type: 'service',
        service: {
          name: statics.name.toLowerCase(),
          factory: `cordis:${statics.name}`,
        },
      })
    }

    return capabilities
  }

  async install(ctx: PluginContext): Promise<void> {
    // 治理镜像模式：服务已在 Cordis 下运行，注册表登记即可，不重复驱动生命周期。
    if (this.mirror) {
      this.logger.info(`CordisAdapter mirroring already-mounted ${this.manifest.id}`)
      this._status = PluginStatus.ACTIVE
      return
    }

    this.logger.info(`CordisAdapter installing ${this.manifest.id}`)

    try {
      // 检查是否需要确认
      if (this.manifest.autoApprove !== true) {
        // 需要用户确认，调用 approval request
        const confirmed = await this.requestApproval(ctx)
        if (!confirmed) {
          this._status = PluginStatus.DISABLED
          throw new Error(`Plugin ${this.manifest.id} was rejected by user`)
        }
      }

      // 调用 Cordis Service 的 start 方法
      if (this.service.start) {
        const config = ctx.config as Record<string, unknown> | undefined
        await this.service.start(config || {})
      }

      this._status = PluginStatus.ACTIVE
      this.logger.info(`CordisAdapter installed ${this.manifest.id} successfully`)
    } catch (error) {
      this._status = PluginStatus.ERROR
      this.logger.error(`CordisAdapter failed to install ${this.manifest.id}: ${String(error)}`)
      throw error
    }
  }

  /**
   * 请求用户确认（使用官方 user-approval 机制）
   *
   * 直接调用 ctx.approval.request()，与官方 ACP 使用相同的确认流程：
   * - 弹出 allow-once / reject-once 对话框
   * - 返回 ApprovalOutcome
   */
  private async requestApproval(ctx: PluginContext): Promise<boolean> {
    // 使用 typed approval 字段（可选）。缺失审批服务时 fail closed：
    // 敏感操作宁可拒绝，也不能在无审批通道时静默放行。
    const approval = ctx.approval

    if (!approval || typeof approval.request !== 'function') {
      this.logger.warn(`No approval service available, refusing sensitive install of ${this.manifest.id}`)
      return false
    }

    // 使用 typed agent 字段（可选）
    const agent = ctx.agent ?? { session: { events: [] } }

    try {
      // 调用官方的 approval.request()；payload 对齐官方 ApprovalRequest 形状
      // （agent/toolName 必填，reason 说明缘由，callId/signal 可选透传）。
      const outcome = await approval.request({
        agent,
        toolName: `plugin:${this.manifest.id}`,
        reason: `Plugin ${this.manifest.id} requires permissions`,
        ...(this.approvalCallId !== undefined ? { callId: this.approvalCallId } : {}),
        ...(this.approvalSignal !== undefined ? { signal: this.approvalSignal } : {}),
      })

      // 官方词表中 'cancelled'/'unavailable' 必须 fail closed；
      // 本地词表的 'allowed-always' 也视为授权（见 isApprovalGranted）。
      if (outcome === 'cancelled' || outcome === 'unavailable') {
        this.logger.warn(
          `Approval for ${this.manifest.id} settled as '${outcome}', failing closed`,
        )
      }
      return isApprovalGranted(outcome)
    } catch (error) {
      this.logger.error(`Approval request failed for ${this.manifest.id}: ${String(error)}`)
      return false
    }
  }

  async uninstall(_ctx: PluginContext): Promise<void> {
    // 治理镜像模式：Cordis 拥有服务生命周期，这里只翻转治理状态。
    if (this.mirror) {
      this.logger.info(`CordisAdapter releasing mirrored ${this.manifest.id}`)
      this._status = PluginStatus.DISABLED
      return
    }

    this.logger.info(`CordisAdapter uninstalling ${this.manifest.id}`)

    try {
      if (this.service.stop) {
        await this.service.stop()
      }
      this._status = PluginStatus.DISABLED
    } catch (error) {
      this.logger.error(`CordisAdapter failed to uninstall ${this.manifest.id}: ${String(error)}`)
    }
  }

  getHealthStatus() {
    if (this.service.health) {
      return this.service.health()
    }
    return {
      healthy: this._status === PluginStatus.ACTIVE,
      uptime: Date.now(),
    }
  }

  /**
   * 当前插件状态（只读）
   */
  get status(): PluginStatus {
    return this._status
  }
}

/**
 * isCordisPlugin - 检测是否为 Cordis 插件
 * @param obj - 待检测的对象。
 * @returns 是否为 CordisService 类型守卫结果。
 */
export function isCordisPlugin(obj: unknown): obj is CordisService {
  if (!obj || typeof obj !== 'object') return false

  const candidate = obj as CordisService
  const ctor = (candidate as { constructor?: unknown }).constructor
  if (typeof ctor !== 'function') return false
  if (typeof candidate.start === 'function') return true
  const proto = ctor.prototype as Record<string, unknown> | undefined
  return (
    typeof proto?.start === 'function' ||
    'serviceName' in (ctor as unknown as object)
  )
}

/**
 * wrapCordisPlugin - 包装 Cordis 插件为 PluginSpec 接口
 *
 * @param service - Cordis 服务实例
 * @param context - 插件上下文
 * @param options - 配置选项
 * @param options.fullyAuthorized - 是否自动授权（默认 false，需要确认）
 * @param options.mirror - 治理镜像模式：服务已由 Cordis 挂载运行，
 *   install/uninstall 不再驱动其生命周期（用于治理注册表镜像 Loader 条目）。
 * @returns 包装后的 Plugin 实例。
 */
export function wrapCordisPlugin(
  service: CordisService,
  context: PluginContext,
  options?: {
    id?: string | undefined
    name?: string | undefined
    version?: string | undefined
    /** 是否完全授权（默认 true，与 core 一致） */
    fullyAuthorized?: boolean | undefined
    /** 治理镜像模式（见 CordisPluginWrapper 配置说明） */
    mirror?: boolean | undefined
    /** 项目插件来源（S-43 M2a）：宿主钳制后清单直接生效，trust 字段忽略。 */
    source?: 'project' | undefined
    /** source==='project' 时宿主构造的钳制后 manifest。 */
    manifest?: PluginManifest | undefined
  },
): Plugin {
  const statics = readCordisStatics(service)
  const id = options?.id || (typeof statics.serviceName === 'string' ? statics.serviceName : undefined) || statics.name
  const name = options?.name || statics.name

  return new CordisPluginWrapper(service, {
    id,
    name,
    version: options?.version,
    fullyAuthorized: options?.fullyAuthorized === true, // 只有显式 true 才授权
    mirror: options?.mirror === true,
    source: options?.source,
    manifest: options?.manifest,
  }, context)
}

/**
 * createCordisAdapter - 创建适配器实例
 *
 * 用于 PluginRegistry 的自动适配。先运行兼容性守卫，当 peer 符号不可用时
 * 降级为一个不做任何管控的假适配器。
 * @param context - 插件上下文。
 * @returns 包含 wrap 与 isCordis 的适配器实例。
 */
export async function createCordisAdapter(context: PluginContext): Promise<{
  wrap: (service: CordisService, options?: Parameters<typeof wrapCordisPlugin>[2]) => Plugin
  isCordis: typeof isCordisPlugin
}> {
  const enabled = await guardGovernance(context.logger)
  if (!enabled) {
    context.logger.warn('dsh-plugin-governance: cordis adapter degraded — peer symbols unavailable, governance disabled')
    return {
      wrap: (service, options) => {
        const statics = readCordisStatics(service)
        const id = options?.id || (typeof statics.serviceName === 'string' ? statics.serviceName : undefined) || statics.name
        return {
          manifest: {
            id: normalizeCordisPluginId(id),
            version: options?.version || '1.0.0',
            name: options?.name || statics.name,
            dsh: { compatible: '>=0.1.0-rc.8', peerDependencies: {} },
            capabilities: [],
            sandbox: { ...OFFICIAL_SANDBOX_CONFIG },
            autoApprove: true,
            certification: { level: PluginCertification.OFFICIAL, certifiedAt: Date.now() },
          },
          install: async () => {},
          uninstall: async () => {},
        }
      },
      isCordis: isCordisPlugin,
    }
  }
  return {
    wrap: (service: CordisService, options?: Parameters<typeof wrapCordisPlugin>[2]) =>
      wrapCordisPlugin(service, context, options),
    isCordis: isCordisPlugin,
  }
}
