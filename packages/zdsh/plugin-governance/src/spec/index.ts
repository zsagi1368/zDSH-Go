/**
 * PluginSpec - 统一插件接口规范
 *
 * 定义 DSH 插件系统的核心类型和接口。
 * 所有插件必须遵循此规范。
 */

// ========== 基础枚举 ==========

/** 插件健康状态 */
export enum PluginStatus {
  /** ✅ 正常运行 */
  ACTIVE = 'active',
  /** ⚠️ 有警告但不影响功能 */
  WARNINGS = 'warnings',
  /** 🔇 被禁用（用户或自动） */
  DISABLED = 'disabled',
  /** ❌ 加载失败 */
  ERROR = 'error',
  /** ⏳ 已废弃，即将移除 */
  DEPRECATED = 'deprecated',
}

/** 插件权限级别 */
export enum PluginLevel {
  /** 只读操作 */
  READ_ONLY = 'read-only',
  /** 工作区访问 */
  WORKSPACE = 'workspace',
  /** 系统级访问（需审批） */
  SYSTEM = 'system',
}

/** 插件认证等级 */
export enum PluginCertification {
  /** 官方维护 */
  OFFICIAL = 'official',
  /** 社区验证 */
  VERIFIED = 'verified',
  /** 社区插件 */
  COMMUNITY = 'community',
  /** 私有插件 */
  UNLISTED = 'unlisted',
}

/** 沙箱类型 */
export type SandboxType = 'process' | 'worker' | 'inline'

/** 权限级别（更细粒度） */
export enum PluginPermissionLevel {
  /** 需要用户确认（默认） */
  CONFIRM_REQUIRED = 'confirm-required',
  /** 系统级访问（需审批） */
  SYSTEM = 'system',
  /** 工作区访问 */
  WORKSPACE = 'workspace',
  /** 只读操作 */
  READ_ONLY = 'read-only',
}

/** 能力类型 */
export type CapabilityType =
  | 'tool'
  | 'hook'
  | 'service'
  | 'event'
  | 'ui-slot'
  | 'llm-adapter'

// ========== 配置类型 ==========

/** 验证错误 */
export interface ValidationError {
  path: string
  message: string
  severity: 'error' | 'warning'
}

/** 验证结果 */
export interface ValidationResult {
  valid: boolean
  errors: ValidationError[]
  warnings: ValidationError[]
}

// ========== PluginManifest ==========

/**
 * PluginManifest - 插件清单
 *
 * 所有插件必须提供此 manifest，否则拒绝加载。
 */
export interface PluginManifest {
  // === 标识（必需）===
  /**
   * 插件唯一标识
   * 格式: namespace/plugin-name
   * 示例: dsh/core-tools, my-org/my-plugin
   */
  id: string

  /** semver 版本 */
  version: string

  /** 显示名称 */
  name: string

  /** 插件描述 */
  description?: string

  // === 元数据 ===
  author?: string
  license?: string
  homepage?: string
  repository?: string
  changelog?: string

  // === 兼容性声明（必需）===
  dsh: {
    /**
     * semver 兼容范围。
     *
     * 规则 R（唯一值形态规则）：**上界 = 底座 minor 的下一个 minor（排他）**，
     * 即底座 `0.<minor>.<patch>` 对应 `<0.<minor+1>.0`（底座 0.2.x ⇒ `<0.3.0`，
     * 底座 0.3.x ⇒ `<0.4.0`）；**下界 = 实际构建过的最低底座**，规则 R 不动它
     * （`>=0.1.5-rc.2` 为 intake 期统一规约、非逐仓实测，见裁决 §6 B3 证据记录）。
     * 上界与规则 R 派生值不符时，`scripts/verify-compatible-window.ts` 门禁变红，
     * 由下一次 pin 轮转强制对齐——判据是规则而非记忆。
     *
     * 读者语义禁令：任何读取本字段的代码必须使用 `includePrerelease: true` 语义，
     * 或本包 `plugin-governance/src/semver.ts` 的比较器；**禁止**裸
     * `semver.satisfies(version, range)` 默认模式。npm-default 语义下 prerelease
     * 底座（如 `0.2.0-rc.2`）对任何 rc 下界窗口都判 false，官方强制轴自身在
     * 读者侧固定 `includePrerelease: true` 解决，而不是改写声明值。
     */
    compatible: string // 如 ">=0.1.0-rc.8 <0.2.0"

    /** 最低兼容版本 */
    required?: string

    /** peer 依赖声明 */
    peerDependencies?: Record<string, string>
  }

  // === 能力声明（必需）===
  /** 插件提供的服务能力列表 */
  capabilities: CapabilityDeclaration[]

  // === 配置 Schema（可选）===
  /** JSON Schema 配置验证 */
  configSchema?: Record<string, unknown>

  // === 权限级别 ===
  /** 优先使用新权限级别 */
  permissionLevel?: PluginPermissionLevel
  /** @deprecated 兼容旧版本 */
  permissionLevelLegacy?: PluginLevel
  /** 是否自动授权（默认 false，需要确认） */
  autoApprove?: boolean

  // === 沙箱配置（必需）===
  sandbox: PluginSandboxConfig

  // === 生命周期钩子（可选）===
  lifecycle?: {
    /** 入口函数路径（相对于 src/） */
    init?: string
    /** 清理函数路径 */
    destroy?: string
  }

  // === 认证信息（由市场注入）===
  certification?: PluginCertificationInfo
}

// ========== PluginSandboxConfig ==========

/**
 * 沙箱配置（所有字段必需）
 *
 * 强制执行安全策略。
 */
export interface PluginSandboxConfig {
  /** 沙箱类型 */
  type: SandboxType

  /** 资源限制 */
  resources: {
    /** 内存限制（MB） */
    memoryLimitMb: number
    /** CPU 限制（0-100） */
    cpuLimit: number
    /** 超时时间（ms） */
    timeoutMs: number
    /** 输出大小限制（字节） */
    maxOutputBytes: number
  }

  /** 文件系统访问 */
  filesystem: {
    access: 'readonly' | 'readwrite'
    /** 白名单路径 */
    allowedPaths: string[]
    /** 拒绝模式 */
    deniedPatterns: string[]
  }

  /** 网络访问 */
  network: {
    access: 'none' | 'external' | 'internal'
    /** 白名单主机 */
    allowedHosts: string[]
    /** 拒绝主机 */
    deniedHosts: string[]
    /** 是否允许本地访问 */
    allowLocal: boolean
  }

  /** 环境变量 */
  environment: {
    whitelist: string[]
    blacklist: string[]
    clear: boolean
  }

  /** 进程访问 */
  process: {
    spawn: boolean
    exec: boolean
    /** 白名单命令 */
    allowedCommands: string[]
    /** 完全授权模式 - 与 core 一致，无限制 */
    fullyAuthorized?: boolean
  }
}

// ========== CapabilityDeclaration ==========

/**
 * CapabilityDeclaration - 能力声明
 *
 * 每个 capability 对应一种服务类型。
 */
export interface CapabilityDeclaration {
  /** 能力类型 */
  type: CapabilityType

  // --- tool 类型 ---
  tool?: {
    name: string
    description: string
    schema: Record<string, unknown> // JSON Schema
    maxResultBytes?: number
    concurrencyLimit?: number
    timeoutMs?: number
  }

  // --- hook 类型 ---
  hook?: {
    name: string
    event: string // 监听的事件名
    priority?: number // 执行优先级（越小越先执行）
    allowed?: boolean // 是否默认允许
  }

  // --- service 类型 ---
  service?: {
    name: string
    factory: string // 工厂函数路径
    dependencies?: string[] // 依赖的服务名
    singleton?: boolean // 是否单例（默认 true）
  }

  // --- event 类型 ---
  event?: {
    name: string
    schema?: Record<string, unknown>
  }

  // --- ui-slot 类型 ---
  uiSlot?: {
    name: string
    key?: string // keyed slot 必需
    mountPoint: string
    component: string
  }

  // --- llm-adapter 类型 ---
  llmAdapter?: {
    name: string
    factory: string
    contextWindow?: number
  }
}

// ========== PluginCertificationInfo ==========

/** 认证信息 */
export interface PluginCertificationInfo {
  level: PluginCertification
  certifier?: string
  certifiedAt: number
  expiresAt?: number
  score?: number // 安全评分 0-100
  reviews?: PluginReview[]
}

// ========== PluginReview ==========

/** 用户评价 */
export interface PluginReview {
  id: string
  userId: string
  pluginId: string
  rating: number // 1-5
  title: string
  content: string
  tags: string[] // ['bug', 'feature-request', 'review']
  createdAt: number
  helpfulCount: number
  developerResponse?: {
    content: string
    createdAt: number
  }
}

// ========== PluginHealthStatus ==========

/** 插件健康状态 */
export interface PluginHealthStatus {
  healthy: boolean
  errors?: string[] | undefined
  warnings?: string[] | undefined
  lastError?: string | undefined
  lastErrorTime?: number | undefined
  uptime?: number | undefined
  callCount?: number | undefined
  errorRate?: number | undefined
}

// ========== PluginLogger ==========

/** 插件日志接口 */
export interface PluginLogger {
  info(msg: string, meta?: Record<string, unknown>): void
  warn(msg: string, meta?: Record<string, unknown>): void
  error(msg: string, meta?: Record<string, unknown>): void
  debug(msg: string, meta?: Record<string, unknown>): void
}

// ========== SandboxContext ==========

/** 沙箱上下文 */
export interface SandboxContext {
  exec(command: string, options?: ExecOptions): Promise<ExecResult>
  read(path: string): Promise<string>
  write(path: string, content: string): Promise<void>
  list(path: string): Promise<string[]>
}

/** exec 调用选项 */
export interface ExecOptions {
  timeout?: number
  env?: Record<string, string>
  cwd?: string
}

/** exec 调用结果 */
export interface ExecResult {
  exitCode: number
  stdout: string
  stderr: string
  duration: number
}

// ========== PluginContext ==========

/**
 * PluginContext - 插件运行上下文
 *
 * 插件通过此上下文访问 DSH 核心能力。
 */
/** Approval request payload（对齐官方 @deepseek-ai/dsh-user-approval 的 ApprovalRequest 形状） */
export interface ApprovalRequest {
  agent: { session?: { events?: unknown[] } }
  toolName: string
  reason: string
  /** 官方字段：关联已流式展示的工具调用，便于 UI 挂载提示 */
  callId?: string
  /** 官方字段：中止即撤回问题，请求立刻落为 'cancelled' */
  signal?: AbortSignal
}

/**
 * Approval outcome。
 *
 * 前四个为本地词表；'cancelled'/'unavailable' 来自官方
 * @deepseek-ai/dsh-user-approval，桥接时必须 fail closed（视为拒绝），
 * 只有 'allowed-*' 是授权。
 */
export type ApprovalOutcome =
  | 'allowed-once'
  | 'rejected'
  | 'allowed-always'
  | 'rejected-always'
  /** 官方词表：请求被中止撤回 */
  | 'cancelled'
  /** 官方词表：无可用 answerer，缺省拒绝 */
  | 'unavailable'

/** Approval service */
export interface ApprovalService {
  request(payload: ApprovalRequest): Promise<ApprovalOutcome>
}

/**
 * PluginContext - 插件运行上下文
 *
 * 插件通过此上下文访问 DSH 核心能力：服务、事件、配置与生命周期钩子。
 */
export interface PluginContext {
  // === 服务访问 ===
  services: Map<string, unknown>

  // === 事件系统 ===
  emit(event: string, data: unknown): void
  on(event: string, handler: (data: unknown) => void): () => void
  once(event: string, handler: (data: unknown) => void): () => void
  off(event: string, handler: (data: unknown) => void): void

  // === 配置访问 ===
  config: Record<string, unknown>
  setConfig(key: string, value: unknown): void
  getConfig<T>(key: string, defaultValue?: T): T

  // === 生命周期 ===
  effect(fn: () => void | (() => void)): void
  onDispose(fn: () => void): void

  // === 日志 ===
  logger: PluginLogger

  // === 插件状态 ===
  status: PluginStatus
  setWarnings(warnings: string[]): void
  markDeprecated(reason: string, replaceWith?: string): void

  // === 沙箱控制器 ===
  sandbox: SandboxContext

  // === 注册能力 ===
  registerCapability(capability: CapabilityDeclaration): void
  unregisterCapability(name: string): void

  // === 可选字段：审批与 Agent ===
  /** 审批服务（未提供时为 undefined，插件需自行检查） */
  approval?: ApprovalService
  /** 宿主 agent 对象（未提供时为 undefined） */
  agent?: Record<string, unknown>
}

// ========== Plugin ==========

/**
 * Plugin - 统一插件接口
 *
 * 所有插件必须实现此接口。
 */
export interface Plugin {
  /** 插件清单 */
  manifest: PluginManifest

  /**
   * 安装插件
   * @param ctx 插件上下文
   */
  install(ctx: PluginContext): Promise<void> | void

  /**
   * 卸载插件（可选）
   * @param ctx 插件上下文
   */
  uninstall?(ctx: PluginContext): Promise<void> | void

  /**
   * 获取健康状态（可选）
   */
  getHealthStatus?(): PluginHealthStatus
}

// ========== Registry Types ==========

/** 验证警告（无 error 级严重性的注册发现） */
export interface ValidationWarning {
  path: string
  message: string
}

/** 注册结果 */
export interface RegistrationResult {
  success: boolean
  pluginId: string
  errors?: ValidationError[]
  warnings?: ValidationWarning[]
}

/** 兼容性结果 */
export interface CompatibilityResult {
  compatible: boolean
  kernelVersion: string
  requiredVersion: string
  peerDepsSatisfied: boolean
  issues: string[]
}

/** 健康报告 */
export interface HealthReport {
  total: number
  active: number
  warnings: number
  errors: number
  disabled: number
  plugins: Array<{
    id: string
    name: string
    status: PluginStatus
    errors?: string[] | undefined
    warnings?: string[] | undefined
    lastError?: string | undefined
    lastErrorTime?: number | undefined
    certification?: PluginCertification | undefined
  }>
}

/** 插件注册表 */
export interface PluginRegistry {
  // === 注册 ===
  register(plugin: Plugin): Promise<RegistrationResult>
  unregister(pluginId: string): Promise<void>

  // === 查询 ===
  get(pluginId: string): Plugin | null
  getAll(): Plugin[]
  findByCapability(type: string, name: string): Plugin[]
  findActive(): Plugin[]
  findDisabled(): Plugin[]

  // === 状态 ===
  getStatus(pluginId: string): PluginStatus
  getHealthReport(): HealthReport

  // === 验证 ===
  validate(plugin: Plugin): ValidationResult
  checkCompatibility(
    plugin: Plugin,
    kernelVersion: string
  ): CompatibilityResult

  // === 管理 ===
  enable(pluginId: string): Promise<void>
  disable(pluginId: string, reason?: string): Promise<void>
  update(pluginId: string, newPlugin: Plugin): Promise<void>
  setStatus(pluginId: string, status: PluginStatus): void

  // === 生命周期 ===
  /** Dispose all plugins and release resources */
  dispose(): Promise<void>

  // === 警告管理 ===
  /** Set warnings for a plugin and adjust status accordingly */
  setPluginWarnings(pluginId: string, warnings: string[]): void
  getPluginWarnings(pluginId: string): string[] | undefined
}

// ========== ID Utilities ==========

/**
 * 规范化插件 ID
 *
 * 支持四种格式：
 * - namespace/name（标准格式）
 * - dsh-xxx（旧格式）
 * - zdsh-xxx（zDSH 装件命名世代，TC-O3 workbench 先例；与 dsh- 同折叠入
 *   core/ 空间——id 空间按名折叠是既有语义〔dsh-filehub ≡ core/filehub〕，
 *   出厂件的信任来自 seed/pin 链而非包名，非出厂渠道恒 CONFIRM_REQUIRED）
 * - @scope/name（npm 格式）
 * @param id - 原始插件 ID。
 * @returns 规范化后的插件 ID。
 */
export function normalizePluginId(id: string): string {
  // 格式 1: @scope/name → scope/name
  if (id.startsWith('@')) {
    return id.slice(1)
  }

  // 格式 2: dsh-xxx → core/xxx（裸前缀 'dsh-' 无后名 → 原样返回，交由
  // validatePluginId 格式门显式拒收，不构造空名 'core/'——REVIEW-S3FIX
  // 建议2 加固：拒收路径显式化，处置不变）
  if (id.startsWith('dsh-')) {
    const name = id.slice(4)
    return name === '' ? id : `core/${name}`
  }

  // 格式 2b: zdsh-xxx → core/xxx（TC-O3：真源包名 zdsh-workbench 的准入
  // 身份面；manifestFromLocalSource 以本函数派生治理 id，zdsh- 世代命名
  // 不识别即 request-invalid——O3-S2 设计遗漏等量处理。裸前缀 'zdsh-'
  // 无后名 → 原样返回交格式门显式拒收，与 dsh- 分支同轮加固）
  if (id.startsWith('zdsh-')) {
    const name = id.slice(5)
    return name === '' ? id : `core/${name}`
  }

  // 格式 3: namespace/name（已经是标准格式）
  return id
}

/**
 * 验证插件 ID 格式
 * @param id - 待验证的插件 ID。
 * @returns 是否符合 namespace/name 标准格式。
 */
export function validatePluginId(id: string): boolean {
  // 标准格式: namespace/name
  // namespace: 小写字母、数字、连字符，至少 2 字符
  // name: 小写字母、数字、连字符、下划线，至少 2 字符
  const pattern = /^[a-z][a-z0-9-]{1,}\/[a-z][a-z0-9_-]{1,}$/
  return pattern.test(id)
}

// ========== Guards ==========

/** 加载结果 */
export interface LoadResult {
  allowed: boolean
  failures: CheckFailure[]
  warnings: CheckWarning[]
}

/** 检查失败 */
export interface CheckFailure {
  check: string
  message: string
  severity: 'error' | 'warning'
}

/** 检查警告 */
export interface CheckWarning {
  check: string
  message: string
}

// ========== Plugin Error ==========

/** 插件错误 */
export class PluginError extends Error {
  /** 脱敏后的堆栈片段（不覆盖 Error.stack 本身） */
  readonly detail?: string | undefined

  constructor(
    public readonly pluginId: string,
    message: string,
    detail?: string  ,
  ) {
    super(`[Plugin ${pluginId}] ${message}`)
    this.name = 'PluginError'
    this.detail = detail
  }
}

/** 插件超时错误 */
export class PluginTimeoutError extends PluginError {
  constructor(pluginId: string, timeoutMs: number) {
    super(pluginId, `Plugin exceeded timeout (${timeoutMs}ms)`)
    this.name = 'PluginTimeoutError'
  }
}

/** 插件内存超限错误 */
export class PluginMemoryError extends PluginError {
  constructor(pluginId: string, limitMb: number) {
    super(pluginId, `Plugin exceeded memory limit (${limitMb}MB)`)
    this.name = 'PluginMemoryError'
  }
}
