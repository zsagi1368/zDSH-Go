/**
 * WebStack 契约总纲（CONTRACT FREEZE · Wave 1 定稿，非 stub）。
 *
 * 本文件是 dsh-webstack 全部跨模块公共词汇的唯一事实源。并行工程师只允许
 * 「消费」这里的类型；需要新增或修改公共类型必须走首席架构师（见
 * docs/CONTRACTS.md 协作规则）。所有导出均为冻结契约，字段语义一经发布
 * 不做破坏性变更，只能加可选字段。
 *
 * 设计溯源 id（G:\000Github\DSH\PluginR&D\docs\web-search\81-design-inspiration.md）：
 * - W-B-05 结构镜像契约：HostSeams 在本文件内以独立 interface 重述平台 API，
 *   本包在 monorepo 外可编译、对宿主零 import 依赖（运行时仍走真实 seam）。
 * - W-B-93 双通道结果暴露：NormalizedHit 只含最小可移植字段集。
 * - W-B-35 / W-A-20：url 永远保留「原始首见」表示，身份归一只在缓存键内部发生。
 * - W-B-40：闭集错误码 union + 三分类（retryable/non-retryable/terminal）。
 * - W-B-95：截断权上交 seam——引擎/聚合器不做最终裁剪，truncated 只作可观测标志。
 *
 * @module webstack/kernel/types
 */

// ---------------------------------------------------------------------------
// 层与档位词汇表
// ---------------------------------------------------------------------------

/** 路由层。`native` = 直接委托宿主内置 provider（不停用、不重写）。 */
export type SearchLayer = 'native' | 'free' | 'api' | 'selfhosted' | 'mcp'

/** 全部路由层的封闭枚举（顺序即 UI 呈现顺序）。 */
export const SEARCH_LAYERS = ['native', 'free', 'api', 'selfhosted', 'mcp'] as const

/** 引擎计费档位。`free` 引擎结构性禁止要求凭据（W-B-12）。 */
export type EngineTier = 'native' | 'free' | 'keyed' | 'selfhosted' | 'mcp'

/** 引擎能力面：一个适配器可以只搜、只取、或两者兼备。 */
export type EngineKind = 'search' | 'fetch' | 'both'

/** 复杂度分档（W-B-14）：路由器按查询特征估算，决定引擎集合与并发预算。 */
export type ComplexityBand = 'simple' | 'medium' | 'complex'

/** 抓取偏好模式（F-004 回退链 raw→fit→citations→HTML 兜底）。 */
export type FetchMode = 'raw' | 'fit' | 'citations'

/** 会话联网模式（W-B-94）：Host-owned 状态机的三态词汇。 */
export type SessionOnlineMode = 'off' | 'on' | 'ask'

/** WebStack 注册进宿主 seam 的 provider id（补丁选择器的唯一指向目标）。 */
export const WEBSTACK_PROVIDER_ID = 'webstack'

// ---------------------------------------------------------------------------
// 引擎描述符
// ---------------------------------------------------------------------------

/** 引擎能力徽章位（全部可选；缺省 = 不支持，路由器不得假设其存在）。 */
export interface EngineCaps {
  /** 支持新闻/时效垂直检索（软新鲜度 hints 仅对该类引擎生效，W-B-15）。 */
  readonly news?: boolean
  /** 支持 `site:` 限域过滤。 */
  readonly siteFilter?: boolean
  /** 支持时间范围参数。 */
  readonly freshness?: boolean
  /** 支持区域/语言参数。 */
  readonly locale?: boolean
  /** 垂直定制源（仅卫星包供给，内核恒缺省）。 */
  readonly vertical?: boolean
}

/** 引擎成本画像：keyed 引擎 keysRequired ≥ 1；免费池恒为 0。 */
export interface EngineCost {
  readonly keysRequired: number
  /** 额度提示。无权威数据一律 `unknown`，展示层禁伪造百分比（W-B-98）。 */
  readonly quotaHint?: 'unknown' | 'paid' | 'free'
}

/**
 * 引擎描述符：注册表的静态名片。探针状态（健康/冷却）是运行时数据，
 * 存放在 registry，绝不混入描述符。
 */
export interface EngineDescriptor {
  /** 稳定唯一 id；同时是设置面 `engines.<id>` 配置键与缓存键维度。 */
  readonly id: string
  readonly kind: EngineKind
  readonly tier: EngineTier
  readonly caps: EngineCaps
  readonly cost: EngineCost
  /** 单次尝试的延迟预算（毫秒）；registry 据此做双态超时的 attempt 态。 */
  readonly latencyBudgetMs: number
}

// ---------------------------------------------------------------------------
// 搜索请求 / 响应
// ---------------------------------------------------------------------------

/**
 * 确定性意图层产物（W-B-15）：纯正则双语词表从 query 提取。
 * `hard` 是必须下推到引擎的约束片段（如 `site:`），`soft` 是尽力偏好。
 */
export interface SearchHints {
  /** 归并后的主题词（去掉了已提取的操作符）。 */
  readonly topic?: string
  /** 时效窗口；软新鲜度只对 caps.news 引擎生效。 */
  readonly freshness?: 'day' | 'week' | 'month' | 'year'
  /** 限域 host 后缀（自 `site:` 提取，硬约束）。 */
  readonly siteFilter?: string
  /** BCP-47 语言提示（软偏好）。 */
  readonly locale?: string
  /** 未结构化但必须满足的硬约束原文片段。 */
  readonly hard: readonly string[]
  /** 软偏好原文片段（引擎可忽略）。 */
  readonly soft: readonly string[]
}

/**
 * 引擎层搜索请求。由 router 从工具层请求装配；`tier`/`layer` 是操作起点
 * 快照的一部分（W-B-74）：一次操作内一致，配置保存即时生效于下一次操作。
 */
export interface EngineSearchRequest {
  readonly query: string
  readonly hints: SearchHints
  /** 期望结果条数上限；最终截断权上交 seam（W-B-95），引擎只做成本优化。 */
  readonly count: number
  readonly layer: SearchLayer
  readonly band: ComplexityBand
  /** 取消信号：caller-abort 必须真取消底层请求（W-B-42）。 */
  readonly signal?: AbortSignal
  /**
   * 聚合器从凭据快照注入的明文键值（键 = 引擎约定字段名，值 = 明文密钥）。
   * 仅限本次请求生命周期，随请求对象一同消亡；**禁止日志化、禁止序列化进
   * 缓存/快照/模型上下文、禁止拼入 URL query（只允许经请求头下发）**
   * （W-B-55 密钥不出 Host 进程的请求内延伸）。keyed 引擎适配器可自主选择
   * 消费本通道或走内部 KeyPool；缺席 = 由引擎自取（W-B-41）。
   */
  readonly credentials?: Readonly<Record<string, string>>
}

/**
 * 结果出处元组（W-B-16 可解释性）：每条命中都能回答「谁给的、多可信、
 * 经什么路径」。`score` 为融合排序归一化分数（单引擎直出时可省略）。
 */
export interface HitProvenance {
  /** 产出该命中的引擎 id。 */
  readonly engine: string
  /** 融合分数（0–1）；单引擎直出可省略。 */
  readonly score?: number
  /** 降级/中转标注（如 "bridge"、"oEmbed-fallback"）。 */
  readonly via?: string
  /** 面向用户的补充说明键（i18n 键，不是自由文本——防注入 W-B-53）。 */
  readonly note?: string
}

/**
 * 归一化命中（最小可移植字段集，W-B-93 通用通道）。
 *
 * 不变量（冻结）：
 * - `url` 是「原始首见」字符串，禁止任何规范化改写（W-B-35/W-A-20）；
 *   URL 身份归一只发生在缓存指纹内部。
 * - 缺失字段保持缺失（undefined），禁止编造占位值让 seam 说谎。
 */
export interface NormalizedHit {
  readonly url: string
  readonly title: string
  readonly snippet?: string
  /** ISO-8601 发布/抓取时间戳，引擎未提供则缺省。 */
  readonly publishedAt?: string
  readonly provenance: HitProvenance
}

/**
 * 单次引擎尝试的审计轨迹条目（F-010/F-011 的 attempts 回显来源）。
 * `outcome` 为 `ok` 或触发的错误码；不含任何敏感文本（过 scrubber 后才有文本）。
 */
export interface AttemptRecord {
  readonly engineId: string
  /** epoch 毫秒起点。 */
  readonly startedAt: number
  readonly durationMs: number
  readonly outcome: 'ok' | EngineErrorCode
}

/** 引擎层搜索响应。`attempts` 允许空（缓存直出时由上层补写来源）。 */
export interface EngineSearchResponse {
  readonly hits: readonly NormalizedHit[]
  readonly attempts: readonly AttemptRecord[]
  /** 非致命警告的 i18n 键列表（如「某引擎冷却跳过」）。 */
  readonly warnings?: readonly string[]
}

// ---------------------------------------------------------------------------
// 抓取请求 / 结果
// ---------------------------------------------------------------------------

/**
 * 内容三层预算（F-005，anysearch B-03）：canonical/rendered/error 各自独立
 * 上限，互不挤占；超限截断必须置 truncated 且不写入缓存正文。
 */
export interface ContentBudgets {
  /** 正文规范形字符上限。 */
  readonly canonicalChars: number
  /** 渲染视图字符上限。 */
  readonly renderedChars: number
  /** 错误体字符上限（进入上下文前再经 injection 截断转义）。 */
  readonly errorChars: number
}

/** 引擎层抓取请求。SSRF 四道闸在 pipeline 内强制执行，调用方无法绕过。 */
export interface FetchRequest {
  readonly url: string
  readonly mode: FetchMode
  readonly budgets: ContentBudgets
  readonly signal?: AbortSignal
}

/**
 * 引擎层抓取结果。
 *
 * 不变量（冻结）：
 * - 目标站自身 4xx/5xx 是「数据」，如实上呈 statusCode，不是异常（W-B-46）；
 *   只有抓取管道自身故障才抛 EngineError。
 * - `statusCode === 0` 表示经由桥接等非 HTTP 通道取得。
 * - `mode` 是回退链后**实际达成**的模式，可与请求模式不同（调用方据此降级渲染）。
 * - `content` 永不为空串之外还必须「带解释」：拿不到正文时返回解释性文本，
 *   绝不静默返回空（F-004 验收要点）。
 */
export interface FetchResult {
  /** 最终 URL（允许的重定向逐跳复验之后）。 */
  readonly url: string
  readonly statusCode: number
  readonly content: string
  readonly mode: FetchMode
  readonly truncated: boolean
  readonly budgets: ContentBudgets
}

// ---------------------------------------------------------------------------
// 错误分类学（W-B-40 闭集 union + 三分类）
// ---------------------------------------------------------------------------

/**
 * 闭集错误码。冻结清单（新增码 = 契约变更，须走架构师）：
 *
 * | code             | 三分类        | 语义与处置 |
 * |------------------|---------------|------------|
 * | transport        | retryable     | 网络层失败（DNS/TCP/TLS/超时）。退避后同引擎可重试。 |
 * | http-upstream    | retryable     | 上游返回 5xx/异常状态。瞬态概率高，退避重试；附 httpStatus。 |
 * | unrepresentable  | non-retryable | 响应合法但无法表达为 NormalizedHit 最小字段集。重试无意义。 |
 * | aborted          | terminal      | caller-abort（W-B-42 双态之一）。整场操作立即结算，不再 fallback。 |
 * | auth             | non-retryable | 凭据无效/过期。换键池职责（W-B-41），当前尝试不可重试。 |
 * | quota            | non-retryable | 配额耗尽（账户级）。冷却整个 provider，禁止换键硬闯。 |
 * | cooldown         | non-retryable | 引擎处于冷却期被路由器拒绝。换下一个候选即可。 |
 * | ssrf-blocked     | terminal      | SSRF 任一闸拒绝（含重定向目标被拒）。安全 refusal 不做 fallback 绕行。 |
 * | narrow-failed    | retryable     | 窄化层校验失败（上游 schema 漂移/垃圾载荷）。新尝试可能不同。 |
 * | rate-limited     | retryable     | 429 类限频。尊重 retryAfterMs 退避；provider 级冷却。 |
 */
export const ENGINE_ERROR_CODES = [
  'transport',
  'http-upstream',
  'unrepresentable',
  'aborted',
  'auth',
  'quota',
  'cooldown',
  'ssrf-blocked',
  'narrow-failed',
  'rate-limited',
] as const

/** 闭集错误码类型（由 tuple 推导，永不手写重复）。 */
export type EngineErrorCode = (typeof ENGINE_ERROR_CODES)[number]

/** 错误三分类：fallback 决策的唯一依据（W-B-40）。 */
export type ErrorClass = 'retryable' | 'non-retryable' | 'terminal'

/**
 * 分类学映射表：每个错误码恰好一个分类。完整性由
 * tests/kernel-errors.test.ts 表驱动锁死——新增码而漏映射会直接红。
 */
export const ERROR_CLASSIFICATION: Readonly<Record<EngineErrorCode, ErrorClass>> = Object.freeze({
  transport: 'retryable',
  'http-upstream': 'retryable',
  unrepresentable: 'non-retryable',
  aborted: 'terminal',
  auth: 'non-retryable',
  quota: 'non-retryable',
  cooldown: 'non-retryable',
  'ssrf-blocked': 'terminal',
  'narrow-failed': 'retryable',
  'rate-limited': 'retryable',
})

/** 构造 EngineError 的附加字段（全部可选，均须先过 scrubber 才可携带外部文本）。 */
export interface EngineErrorExtras {
  /** 触发错误的引擎 id（若已知）。 */
  readonly engineId?: string
  /** 上游 HTTP 状态码（http-upstream/rate-limited 场景）。 */
  readonly httpStatus?: number
  /** 服务端要求的退避毫秒数（rate-limited/cooldown）。 */
  readonly retryAfterMs?: number
  /** 已脱敏的结构化细节（i18n 键或白名单键值，不放自由文本）。 */
  readonly detail?: string
  /** 原始异常（留在进程内诊断用，禁止序列化进模型上下文）。 */
  readonly cause?: unknown
}

// ---------------------------------------------------------------------------
// 统一错误对象形状（类实现位于 kernel/errors.ts）
// ---------------------------------------------------------------------------

/**
 * 引擎层统一错误对象。所有引擎适配器、安全闸、窄化层抛出的错误都必须是
 * 该形状（`isEngineError()` 守卫判定）；翻译层据此产出双语处置文本
 * （W-B-44），scrubber 在任何文本进入日志/模型上下文前过滤（W-B-56）。
 */
export interface EngineErrorShape extends Error {
  readonly name: 'EngineError'
  readonly code: EngineErrorCode
  readonly engineId?: string
  readonly httpStatus?: number
  readonly retryAfterMs?: number
  readonly detail?: string
}

// ---------------------------------------------------------------------------
// 安全词汇（分册 05 四道闸）
// ---------------------------------------------------------------------------

/** SSRF 纵深四道闸标识（W-B-50）。顺序即执行顺序，豁免机制永不跳过 G1/G3/G4。 */
export type SafetyGate = 'G1-static' | 'G2-dns' | 'G3-redirect' | 'G4-body-bound'

/** 执行顺序固定的四道闸清单（数据化规则单一来源，W-A-18 反制）。 */
export const SAFETY_GATE_ORDER: readonly SafetyGate[] = Object.freeze([
  'G1-static',
  'G2-dns',
  'G3-redirect',
  'G4-body-bound',
])

/** 拒绝原因闭集（i18n 与 doctor 处方按此键派生）。 */
export type SsrfRejectReason =
  | 'scheme-disallowed'
  | 'userinfo-present'
  | 'nonstandard-port'
  | 'loopback'
  | 'private-range'
  | 'link-local'
  | 'reserved-range'
  | 'redirect-cross-origin-auth'
  | 'redirect-to-blocked'
  | 'body-over-bound'

/**
 * 安全裁决结果：放行 = `{ allowed: true }`；拒绝必须携带闸位与原因码，
 * 并由调用方映射为 `ssrf-blocked` 错误（terminal）。
 */
export interface SafetyVerdict {
  readonly allowed: boolean
  readonly gate?: SafetyGate
  readonly reasonCode?: SsrfRejectReason
  /** 面向诊断的补充说明；进入上下文前过 scrubber。 */
  readonly detail?: string
}

// ---------------------------------------------------------------------------
// 缓存词汇（W-B-30~34）
// ---------------------------------------------------------------------------

/** 缓存域：分域 TTL 表与联合失效的最小分区单位。 */
export type CacheDomain = 'search' | 'fetch' | 'vertical'

/**
 * 缓存键输入维度（W-B-33）：**从请求函数签名机械推导**，字段清单即键维度
 * 清单。新增影响结果的参数时必须同时在此加字段并补相邻差异测试——宁可
 * miss 不可错 hit（W-B-30）。
 */
export interface CacheKeyInput {
  readonly layer: SearchLayer
  /** 本次操作实际参与的引擎 id 集合（排序后参与指纹）。 */
  readonly engineSet: readonly string[]
  readonly count: number
  readonly hints: SearchHints
  readonly tier: EngineTier
  /** 凭据解析快照的指纹（opaque hash 前 8 位级），凭据轮换即换键。 */
  readonly credFingerprint: string
  /** 其余自由选项（无原型对象承接后传入；值必须是可 JSON 标量）。 */
  readonly options?: Readonly<Record<string, string | number | boolean>>
}

/**
 * 持久层适配器（L1 占位接口）：MVP 只带内存 LRU 实现；接入平台 storage /
 * snapshot 服务或未来 node:sqlite 时实现本接口即可，禁止引入原生模块
 * （Fork allowBuilds 白名单约束）。`clearAll()` 是联合失效入口
 * （W-B-31：先设计失效路径再分层），必须同时清空 L0+L1 全部域。
 */
export interface PersistenceAdapter {
  readonly domain: CacheDomain | 'all'
  get(key: string): Promise<{ readonly value: unknown; readonly storedAt: number } | undefined>
  set(key: string, value: unknown, ttlMs: number): Promise<void>
  delete(key: string): Promise<void>
  clearAll(): Promise<void>
}

// ---------------------------------------------------------------------------
// 凭据快照（W-B-54/55/74）
// ---------------------------------------------------------------------------

/** 凭据三级解析链固定优先级：遗留字面 → credentialRef → env。 */
export const CREDS_SOURCE_ORDER = ['legacy-literal', 'credential-ref', 'env'] as const

export type CredSource = (typeof CREDS_SOURCE_ORDER)[number]

/**
 * 单引擎凭据状态快照。密钥本体永不出 Host 进程：对外只有布尔态、掩码
 * hint（前 3 + 尾 4）与 opaque key id（hash 前 8 位）（W-B-55）。
 */
export interface CredSnapshotEntry {
  readonly state: 'configured' | 'absent'
  readonly source?: CredSource
  readonly maskedHint?: string
  readonly opaqueId?: string
}

/**
 * 操作起点凭据快照（W-B-74）：每次搜索/抓取开始时解析一次，操作内一致；
 * 凭据轮换热生效于下一次操作。
 */
export interface CredsSnapshot {
  readonly resolvedAt: number
  readonly entries: Readonly<Record<string, CredSnapshotEntry>>
}

// ---------------------------------------------------------------------------
// 能力位图与降级梯（W-B-08 / F-013）
// ---------------------------------------------------------------------------

/**
 * 宿主能力探测结果位图。每个位对应一个耦合点（分册 06 §2 清单），探测
 * 函数唯一归口 kernel/capability.ts；位图变化写入加载标记日志（W-B-78）。
 */
export interface CapabilityBitmap {
  /** ctx.web.registerSearchProvider/registerFetchProvider 存在且为函数。 */
  webSeam: boolean
  /** cordis patch 可将选择器指向 webstack（启动后回读验证）。 */
  selectorPatchable: boolean
  /** installSettingsSection / settings 服务可用。 */
  settingsSection: boolean
  /** 输入区 `conversation.input.left` keyed slot 可用。 */
  inputSlot: boolean
  /** credentials 域 credentialRef 服务可用。 */
  credentialsDomain: boolean
  /** 平台 storage/snapshot 持久服务可用。 */
  storageService: boolean
  /** 浏览器桥接卫星在线且已配对。 */
  bridgeOnline: boolean
}

/** 运行档位：接管（fork/新版）→ 共存（官方旧版）→ 只读诊断（API 缺失）。 */
export type TierMode = 'takeover' | 'coexist' | 'diagnostic'

// ---------------------------------------------------------------------------
// HostSeams —— 结构镜像契约（W-B-05）
// ---------------------------------------------------------------------------
//
// 以下 Seam* 类型把本插件消费的平台 API 重述为独立 interface：
// - 本包不 import 宿主类型也能编译（结构兼容由 tests/kernel-types.test.ts
//   对 @deepseek-ai/dsh-web 真实类型做 toExtend 断言锁死，W-B-07）；
// - 运行期一律先能力探测再使用，缺失走降级梯，绝不裸假设。

/** 宿主 seam 的搜索请求（镜像 dsh-web WebSearchRequest）。 */
export interface SeamWebSearchRequest {
  readonly query: string
  readonly maxResults?: number
}

/** 宿主 seam 的单条引用源（镜像 WebSearchSource）。 */
export interface SeamWebSearchSource {
  readonly url: string
  readonly title?: string
  readonly snippet?: string
  readonly publishedAt?: string
}

/** 宿主 seam 的搜索结果（镜像 WebSearchResult；截断由 seam 裁决 W-B-95）。 */
export interface SeamWebSearchResult {
  readonly content?: string
  readonly sources: readonly SeamWebSearchSource[]
  readonly truncated: boolean
}

/** 宿主 seam 的抓取请求（镜像 WebFetchRequest）。 */
export interface SeamWebFetchRequest {
  readonly url: string
}

/** 抓取体封闭判别 union（镜像 WebFetchBody；kind 增项是宿主协同变更）。 */
export type SeamWebFetchBody =
  | { readonly kind: 'html'; readonly content: string }
  | { readonly kind: 'text'; readonly content: string }

/** 宿主 seam 的抓取结果（镜像 WebFetchResult）。 */
export interface SeamWebFetchResult {
  readonly url: string
  readonly statusCode: number
  readonly body: SeamWebFetchBody
  readonly truncated: boolean
}

/**
 * 我们注册进 `ctx.web` 的 provider 形状（镜像 WebSearchProvider /
 * WebFetchProvider）。`available()` 必须**廉价同步**：禁止网络探针、禁止
 * 纸面配置检查（W-B-97/W-A-05）；健康与否经失败时的可诊断错误表达。
 */
export interface SeamWebSearchProvider {
  readonly id: string
  available(): boolean
  search(request: SeamWebSearchRequest, signal?: AbortSignal): Promise<SeamWebSearchResult>
}

export interface SeamWebFetchProvider {
  readonly id: string
  available(): boolean
  fetch(request: SeamWebFetchRequest, signal?: AbortSignal): Promise<SeamWebFetchResult>
}

/** 注册方法签名（镜像 ctx.web.register*Provider：返回 disposer，随 fiber 释放）。 */
export interface SeamWebRuntime {
  registerSearchProvider(provider: SeamWebSearchProvider): () => void
  registerFetchProvider(provider: SeamWebFetchProvider): () => void
}

/** prompt 节形状（镜像 ctx.systemPrompt.section 的入参子集）。order 必须有限。 */
export interface SeamPromptSection {
  readonly name: string
  readonly order: number
  readonly text: string
}

export interface SeamSystemPromptRuntime {
  section(section: SeamPromptSection): () => void
}

/** 工具注册面（镜像 ctx.tools.register；定义由 defineTool 构造，此处只镜像最小面）。 */
export interface SeamToolsRuntime {
  register(definition: Record<string, unknown>): () => void
}

/** 设置节安装面（镜像 dsh-settings installSettingsSection 的钩子形状）。 */
export interface SeamSettingsHooks<T> {
  setSource(current: () => T): void
  onChange(): void
  validate?(value: T): void
}

export interface SeamSettingsRuntime {
  installSection<T>(ns: string, schema: unknown, entry: T, hooks: SeamSettingsHooks<T>): void
}

/** 凭据解析面（镜像 credentials 域 resolve；每操作起点解析快照 W-B-74）。 */
export interface SeamCredentialsRuntime {
  resolve(ref: string): Promise<string | undefined>
}

/** 持久存储面（平台 storage/snapshot 的最小镜像；缺失则仅 L0 内存缓存）。 */
export interface SeamStorageRuntime {
  getItem(key: string): Promise<string | undefined>
  setItem(key: string, value: string): Promise<void>
}

/**
 * 全部宿主接缝的可选集合：activate 时逐一探测填充，缺省位驱动降级梯。
 * 这是本插件与宿主的**全部**耦合点的机器可读清单（分册 06 §2）。
 */
export interface HostSeams {
  readonly web?: SeamWebRuntime
  readonly systemPrompt?: SeamSystemPromptRuntime
  readonly tools?: SeamToolsRuntime
  readonly settings?: SeamSettingsRuntime
  readonly credentials?: SeamCredentialsRuntime
  readonly storage?: SeamStorageRuntime
  /** 浏览器桥接卫星（F-201）在线且已配对时由装配层填充。 */
  readonly bridge?: SeamBridgeRuntime
}

// ---------------------------------------------------------------------------
// P1/P2 扩展词汇（2026-08-24 加法式增补：只增新类型与可选字段，不改旧义）
// ---------------------------------------------------------------------------

/** 融合参数（F-104/W-B-16）：与 settings schema 的 fusion 段一一对应。 */
export interface FusionParams {
  readonly enabled: boolean
  /** 时效半衰期（小时）；0 = 关闭时效衰减。 */
  readonly timeDecayHalfLifeH: number
  /** 权威域加权系数（≥0，1 = 不加权）。 */
  readonly authorityBoost: number
  /** 同域/单源多样性软折扣（0–1，1 = 不折扣）。 */
  readonly diversityDiscount: number
}

/** MCP 服务器条目（F-108）：预设目录承载样板、用户条目只存差异（W-B-72）。 */
export interface McpServerEntry {
  readonly id: string
  readonly transport: 'stdio' | 'http'
  /** stdio 启动命令；必须含 `@version` 锁定形态，裸 npx 在校验层拒绝（W-A-02）。 */
  readonly command?: string
  readonly args?: readonly string[]
  readonly url?: string
  /** 凭据引用名列表（经 credentials 域每操作解析，绝不存明文）。 */
  readonly credentialRefs?: readonly string[]
  readonly env?: Readonly<Record<string, string>>
}

/** 批量扇出单条结果（F-113/W-B-20）：保序、逐项结构化，部分失败不传染。 */
export type BatchSearchItem =
  | {
    readonly index: number
    readonly query: string
    readonly ok: true
    readonly hits: readonly NormalizedHit[]
    readonly attempts: readonly AttemptRecord[]
  }
  | {
    readonly index: number
    readonly query: string
    readonly ok: false
    readonly code: EngineErrorCode
    readonly message: string
  }

/** 历史回放条目（F-205/pro B-13）：搜索回放来源列表、抓取回放状态与截断标志。 */
export interface HistoryEntry {
  readonly kind: 'search' | 'fetch'
  readonly at: number
  readonly input: string
  readonly layer?: SearchLayer
  readonly statusCode?: number
  readonly sources: readonly { url: string; title?: string }[]
  readonly truncated?: boolean
}

/** 站选定制源规则（F-203/pro B-11）：只到 CSS 选择器粒度，杜绝任意脚本注入面。 */
export interface SelectorRule {
  /** hostname 最长后缀匹配（如 `example.com` 命中 `a.b.example.com`）。 */
  readonly hostSuffix: string
  readonly selectors: {
    readonly title?: string
    readonly content: string
    readonly publishedAt?: string
  }
}

/**
 * 浏览器桥接消费面（F-201，卫星包供给）：内核只依赖此接口，配对/WS/心跳等
 * 协议细节全部留在卫星（W-B-05 消费侧解耦）。返回 undefined = 桥当前不可用。
 */
export interface SeamBridgeRuntime {
  render(
    url: string,
    timeoutMs: number,
  ): Promise<{ content: string; statusCode: number } | undefined>
}
