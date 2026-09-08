/**
 * WebStack (网栈) — integrated web search + fetch kernel plugin for DeepSeek Harness.
 *
 * Host entry: registers the neutral aggregator as a search/fetch provider via
 * `ctx.web`. Coexist mode by default: the bundled cordis patch is an empty
 * list, so upstream selectors stay untouched unless the user opts into
 * takeover. All optional seams (settings/tools/systemPrompt/credentials/
 * storage/bridge) are capability-probed, never hard-injected (W-B-08).
 *
 * 装配顺序（W-B-08 降级梯，W9 全量接线版）：能力探测 → 引擎接线（免费池 /
 * 自托管 / keyed 六家 / 原生委托 / MCP 校验注册 / 垂类条件装配）→ 缓存栈
 * （L1 经 pickPersistence）→ 凭据源 → 聚合器 → settings 配置节（热生效
 * W-B-74）→ 会话联网状态机 → systemPrompt 守则+动态状态节 → tools 三件
 * （web_backend_status / web_batch_search / web_history）→ winproxy 兜底探测
 * → web seam 双面注册 → 加载标记日志（W-B-78）。
 *
 * @module dsh-webstack
 */

import type { Context } from '@deepseek-ai/cordis'
// 类型-only：alpha.4 起 ctx.settings 服务与 SettingsProvider 类型由 dsh-settings
// 的 declare module 合并提供（旧 installSettingsSection/settingsNamespace 已删除）。
import type {} from '@deepseek-ai/dsh-settings'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-web'
import z from '@deepseek-ai/schemastery'
import { pickPersistence } from './cache/adapters.ts'
import { SearchCache } from './cache/store.ts'
import { renderDoctor, runDoctor } from './diag/doctor.ts'
import { AnysearchEngine } from './engines/anysearch.ts'
import { BingLiteEngine } from './engines/bing-lite.ts'
import { BraveEngine } from './engines/brave.ts'
import { DdgEngine } from './engines/ddg.ts'
import { KEYED_ENGINE_IDS } from './engines/engine.ts'
import { ExaEngine } from './engines/exa.ts'
import { FirecrawlEngine } from './engines/firecrawl.ts'
import { JinaEngine } from './engines/jina.ts'
import { McpSearchEngine, validateMcpEntry } from './engines/mcp-generic.ts'
import { NativeDelegateEngine, type NativeDelegates } from './engines/native-delegate.ts'
import { SEARXNG_DESCRIPTOR, SearxngEngine } from './engines/searxng.ts'
import { TavilyEngine } from './engines/tavily.ts'
import {
  type FreePoolSearchFn,
  type VerticalDepsView,
  type VerticalPackView,
  VerticalXLegEngine,
} from './engines/vertical-x.ts'
import {
  type AggregatorSnapshot,
  type CredsSourceView,
  WebstackAggregator,
} from './kernel/aggregator.ts'
import { deriveTierMode, probeCapabilities } from './kernel/capability.ts'
import { HistoryStore } from './kernel/history.ts'
import { EngineRegistry } from './kernel/registry.ts'
import { normalizeLayer } from './kernel/router.ts'
import type {
  CapabilityBitmap,
  EngineSearchRequest,
  McpServerEntry,
  SeamCredentialsRuntime,
  SeamStorageRuntime,
  SearchLayer,
  SessionOnlineMode,
  TierMode,
} from './kernel/types.ts'
import { SessionOnlineState } from './mode/online.ts'
import { charterSection, statusSection } from './prompt/sections.ts'
import { applyProxyToEnv, getWindowsSystemProxy } from './safety/winproxy.ts'
import type { EngineNodeSettings } from './settings/schema.ts'
import { buildBatchSearchTool, buildHistoryTool } from './tools/web-tools.ts'

export { renderDoctor, runDoctor } from './diag/doctor.ts'
export { WebstackAggregator } from './kernel/aggregator.ts'
export { deriveTierMode, probeCapabilities } from './kernel/capability.ts'
export { EngineRegistry } from './kernel/registry.ts'
export { WEBSTACK_PROVIDER_ID } from './kernel/types.ts'
export { SessionOnlineState } from './mode/online.ts'
export { charterSection, statusSection } from './prompt/sections.ts'
// 卫星包（dsh-webstack-bridge）经此复用 SSRF G1+G2 闸：装配层动态导入本入口
// 后注入 BridgeRenderer，避免卫星对 src/safety/ssrf 的深路径耦合（W-B-05）。
export { checkTarget } from './safety/ssrf.ts'
export { buildBatchSearchTool, buildHistoryTool } from './tools/web-tools.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'webstack'

/** Required seam: the web provider registry. Everything else is probed. */
export const inject = ['web']

/** Public plugin configuration type. */
export type Config = PluginConfig

/** 垂直腿引擎 id（settings verticals.channels.x 的接线对象）。 */
const VERTICAL_X_ENGINE_ID = 'x-vertical'

/** 免费池垂类回调允许的引擎 id：杜绝垂类递归加发自身（vertical-x 治理纪律）。 */
const VERTICAL_FREE_POOL_IDS: readonly string[] = ['ddg', 'bing-lite']

export interface PluginConfig {
  /** 总开关；false 时聚合器 available()=false，行为等价回落原生。 */
  enabled?: boolean
  /** 默认路由层（开箱 `free`：免 Key 引擎池）。 */
  layer?: SearchLayer
  /** 候选展开开关；false 只用首选单引擎。 */
  autoFallback?: boolean
  /** 结果条数上限（seam 仍握有最终截断权 W-B-95）。 */
  maxResults?: number
  /** 查询复杂度分档路由开关。 */
  complexityRouting?: boolean
  /** 多引擎 RRF 融合总开关。 */
  fusionEnabled?: boolean
  /** 抓取渲染视图字符上限（canonical 预算 ×4 派生封顶 8 MiB）。 */
  maxContentChars?: number
  /** SSRF G2 豁免清单（host:port / CIDR；永不影响 G1/G3/G4）。 */
  ssrfExempts?: string[]
  /** 自托管 SearXNG 实例根地址；空串 = 未配置（不注册该引擎）。 */
  searxngBaseUrl?: string
  /** 会话联网模式（mode.sessionOnline）：`on` 时搜索强制 fresh 跳缓存读。 */
  sessionOnline?: SessionOnlineMode
  /** 缓存持久层档位（cache.persist）：`durable` 启用 L1（storage seam 或文件）。 */
  cachePersist?: 'memory' | 'durable'
  /**
   * Windows 系统代理兜底（advanced.winProxyFallback，默认 false）：开启时
   * activate 早期探测系统代理并注入 HTTPS_PROXY/HTTP_PROXY（尽力而为层）。
   */
  winProxyFallback?: boolean
  /** 引擎级配置节点（engines.<id>.key / credentialRef / enabled）。 */
  engines?: Record<string, EngineNodeSettings>
  /** MCP 服务器条目；过 validateMcpEntry 的才注册为 McpSearchEngine。 */
  mcpServers?: McpServerEntry[]
  /** 垂直卫星包总闸（实验性；默认 false）。 */
  verticalsPackEnabled?: boolean
  /** X 垂直频道开关键（受 verticalsPackEnabled 约束；默认 false）。 */
  verticalsChannelX?: boolean
}

/** Plugin schema; omitted fields resolve to the frozen defaults. */
export const Config: z<PluginConfig> = z.object({
  enabled: z.boolean().default(true),
  layer: z.union(['native', 'free', 'api', 'selfhosted', 'mcp'] as const).default('free'),
  autoFallback: z.boolean().default(true),
  maxResults: z.number().default(8),
  complexityRouting: z.boolean().default(true),
  fusionEnabled: z.boolean().default(true),
  maxContentChars: z.number().default(12_000),
  ssrfExempts: z.array(z.string()).default([]),
  searxngBaseUrl: z.string().default(''),
  sessionOnline: z.union(['off', 'on', 'ask'] as const).default('off'),
  cachePersist: z.union(['memory', 'durable'] as const).default('memory'),
  winProxyFallback: z.boolean().default(false),
  engines: z.dict(z.any()).default({}),
  mcpServers: z.array(z.any()).default([]),
  verticalsPackEnabled: z.boolean().default(false),
  verticalsChannelX: z.boolean().default(false),
}) as unknown as z<PluginConfig>

/** 宿主 locale 未暴露探测 API——默认中文，TODO(W2-PLATFORM): 跟随宿主语言设置。 */
const HOST_LOCALE: 'zh' | 'en' = 'zh'

/** 设置命名空间（settings.yaml 的 `webstack:` 段）。alpha.4 起为字面量（settings.register 要求小写连字符标识符）。 */
const SETTINGS_NS = 'webstack'

// ---------------------------------------------------------------------------
// 可测试的纯装配辅助（导出面供回归测试直接消费）
// ---------------------------------------------------------------------------

/**
 * 组合入口配置 → 聚合器运行快照（操作起点一致性的唯一装配点）。
 * W9：`sessionOnline === 'on'` 映射 forceFresh（跳缓存读）；`layerPools` /
 * `verticalEngineIds` 由调用方按注册矩阵注入（结构动态，静态配置无法表达）。
 */
export function composeSnapshot(
  config: PluginConfig,
  extras?: {
    readonly layerPools?: Partial<Record<SearchLayer, readonly string[]>>
    readonly verticalEngineIds?: readonly string[]
  },
): AggregatorSnapshot {
  return {
    enabled: config.enabled ?? true,
    layer: normalizeLayer(config.layer),
    autoFallback: config.autoFallback ?? true,
    maxResults: config.maxResults ?? 8,
    fusionEnabled: config.fusionEnabled ?? true,
    complexityRouting: config.complexityRouting ?? true,
    fetchMode: 'raw',
    maxContentChars: config.maxContentChars ?? 12_000,
    ssrfExempts: [...(config.ssrfExempts ?? [])],
    cacheEnabled: true,
    forceFresh: (config.sessionOnline ?? 'off') === 'on',
    ...(extras?.layerPools === undefined ? {} : { layerPools: extras.layerPools }),
    ...(extras?.verticalEngineIds === undefined
      ? {}
      : { verticalEngineIds: extras.verticalEngineIds }),
  }
}

/**
 * 凭据源视图（W9 凭据流贯通）：从组合入口配置抽取 keyed 六家的
 * `engines.<id>.key`（历史别名 `.apiKey` 兼容）与 `credentialRef`，加上宿主
 * credentials seam。每次搜索起点由聚合器调用一次（操作内一致 W-B-74）。
 */
export function credsSourceViewFrom(
  config: PluginConfig,
  seams?: { credentials?: SeamCredentialsRuntime },
): CredsSourceView {
  const nodes = config.engines ?? {}
  const configValues: Record<string, string | undefined> = {}
  const credentialsRef: Record<string, string | undefined> = {}
  for (const id of KEYED_ENGINE_IDS) {
    const node: EngineNodeSettings | undefined = nodes[id]
    if (node === undefined) continue
    configValues[id] = node.key ?? node.apiKey
    if (node.credentialRef !== undefined) credentialsRef[id] = node.credentialRef
  }
  return {
    configValues,
    credentialsRef,
    ...(seams?.credentials === undefined ? {} : { seams }),
  }
}

/** 引擎接线的可选钩子（native 句柄捕获与垂类假体注入均为测试接缝）。 */
export interface RegistryBuildHooks {
  /** 原生委托句柄（宿主捕获后注入；缺省 = 无委托，search 报 unrepresentable）。 */
  readonly nativeDelegates?: NativeDelegates
  /** 垂直腿构造钩子（packEnabled&&channels.x 时必填 freePoolSearch）。 */
  readonly vertical?: {
    readonly loadPack?: () => Promise<VerticalPackView | undefined>
    readonly freePoolSearch: FreePoolSearchFn
    readonly outboundFetch?: VerticalDepsView['outboundFetch']
  }
}

/** 注册矩阵构建结果：注册表 + MCP 接线清单 + 垂直腿标记。 */
export interface RegistryBuildResult {
  readonly registry: EngineRegistry
  /** 过 validateMcpEntry 并已注册的 MCP 引擎 id（`mcp-<entryId>`）。 */
  readonly mcpEngineIds: readonly string[]
  /** 配置了但校验失败的 MCP 条目 id（doctor 以 unwired 态列出）。 */
  readonly invalidMcpIds: readonly string[]
  /** 已注册的垂直腿引擎 id；未启用为 undefined。 */
  readonly verticalLegId?: string
}

/**
 * 引擎注册矩阵（W9 全量）：免费池（ddg/bing-lite）→ 自托管（显式 baseUrl 才
 * 注册）→ keyed 六家（无键即 auth 结构化失败，交 fallback 换候选）→ 原生委托
 * （句柄缺位时同样可诊断地失败）→ MCP（逐条 validateMcpEntry，拒绝项静默跳过
 * 并回传清单供诊断）→ 垂直腿（显式开启才装配）。注册序即 fallback 候选序。
 */
export function buildEngineRegistry(
  config: PluginConfig,
  hooks?: RegistryBuildHooks,
): RegistryBuildResult {
  const registry = new EngineRegistry()
  // ---- 免费池（结构性零凭据，W-B-12）--------------------------------------
  registry.register(new DdgEngine())
  registry.register(new BingLiteEngine())
  const baseUrl = config.searxngBaseUrl?.trim() ?? ''
  if (/^https?:\/\//i.test(baseUrl)) {
    registry.register(new SearxngEngine(SEARXNG_DESCRIPTOR, baseUrl))
  }
  // ---- keyed 六家（api 层候选池；凭据经请求级通道每操作解析）---------------
  registry.register(new TavilyEngine())
  registry.register(new BraveEngine())
  registry.register(new ExaEngine())
  registry.register(new JinaEngine())
  registry.register(new FirecrawlEngine())
  registry.register(new AnysearchEngine())
  // ---- 原生委托（native 层候选；句柄捕获 TODO(W2-PLATFORM)）----------------
  registry.register(new NativeDelegateEngine(undefined, hooks?.nativeDelegates))
  // ---- MCP（F-108）：过 validateMcpEntry 才注册；拒绝项进诊断清单-----------
  const mcpEngineIds: string[] = []
  const invalidMcpIds: string[] = []
  for (const entry of config.mcpServers ?? []) {
    if (validateMcpEntry(entry) !== null) {
      invalidMcpIds.push(entry.id)
      continue
    }
    registry.register(new McpSearchEngine(entry))
    mcpEngineIds.push(`mcp-${entry.id}`)
  }
  // ---- 垂直腿（W9，实验性卫星；缺失包静默 + 诊断键由适配器承担）------------
  let verticalLegId: string | undefined
  if (config.verticalsPackEnabled === true && config.verticalsChannelX === true) {
    registry.register(
      new VerticalXLegEngine({
        ...(hooks?.vertical?.loadPack === undefined ? {} : { loadPack: hooks.vertical.loadPack }),
        ...(hooks?.vertical?.outboundFetch === undefined
          ? {}
          : { outboundFetch: hooks.vertical.outboundFetch }),
        freePoolSearch:
          hooks?.vertical?.freePoolSearch ?? (() => Promise.resolve({ hits: [], attempts: [] })),
      }),
    )
    verticalLegId = VERTICAL_X_ENGINE_ID
  }
  return {
    registry,
    mcpEngineIds,
    invalidMcpIds,
    ...(verticalLegId === undefined ? {} : { verticalLegId }),
  }
}

/** 组装产物（测试与上层诊断的直接观测点；apply 本体只消费不返回）。 */
export interface WebstackAssembly {
  readonly capabilities: CapabilityBitmap
  readonly tier: TierMode
  readonly registry: EngineRegistry
  readonly aggregator: WebstackAggregator
  readonly history: HistoryStore
  readonly sessionOnline: SessionOnlineState
  readonly mcpEngineIds: readonly string[]
  readonly invalidMcpIds: readonly string[]
  readonly verticalLegId?: string
  readonly bridgeOnline: boolean
  /** 以当前配置刷新聚合器快照 / 会话联网模式 / 缓存栈（settings onChange 复用）。 */
  refresh(): void
}

/** 安全读取可能未装载的 cordis 服务（访问未装载服务属性会抛错而非 undefined）。 */
function peekService(ctx: unknown, key: string): Record<string, unknown> | undefined {
  if (typeof ctx !== 'object' || ctx === null) return undefined
  try {
    const value = (ctx as Record<string, unknown>)[key]
    return typeof value === 'object' && value !== null
      ? (value as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

/** 探测宿主 credentials 域（resolve 为函数才算在线）。 */
function peekCredentials(ctx: unknown): SeamCredentialsRuntime | undefined {
  const service = peekService(ctx, 'credentials')
  const resolve = service?.resolve
  return typeof resolve === 'function'
    ? { resolve: resolve as SeamCredentialsRuntime['resolve'] }
    : undefined
}

/** 探测宿主 storage 服务（getItem/setItem 成对才算在线）。 */
function peekStorage(ctx: unknown): SeamStorageRuntime | undefined {
  const service = peekService(ctx, 'storage')
  if (typeof service?.getItem !== 'function' || typeof service?.setItem !== 'function') {
    return undefined
  }
  return service as unknown as SeamStorageRuntime
}

/**
 * 探测浏览器桥接卫星（T3/F-201）：约定服务键 `bridge`（兼容 `webstackBridge`），
 * render 为函数即视为在线。协议细节全部留在卫星（W-B05 消费侧解耦）。
 */
function peekBridge(ctx: unknown): { render: SeamBridgeRender } | undefined {
  for (const key of ['bridge', 'webstackBridge']) {
    const service = peekService(ctx, key)
    if (typeof service?.render === 'function') {
      return { render: service.render as SeamBridgeRender }
    }
  }
  return undefined
}

type SeamBridgeRender = (
  url: string,
  timeoutMs: number,
) => Promise<{ content: string; statusCode: number } | undefined>

/** 出站客户端懒加载包装：垂类 oEmbed 腿复用内核 SSRF 四道闸出站通道。 */
function lazyOutboundFetch(): NonNullable<VerticalDepsView['outboundFetch']> {
  let loaded: Promise<unknown> | undefined
  return async (req) => {
    loaded ??= import('./safety/outbound.ts').then(mod => mod.outboundFetch)
    const fetchImpl = (await loaded) as (
      request: Record<string, unknown>,
    ) => Promise<{ status: number; text(): Promise<string> }>
    return await fetchImpl(req as unknown as Record<string, unknown>)
  }
}

/**
 * Register the aggregator into the host web seam when the seam is present;
 * otherwise log the diagnostic tier and stay inert on the data path while the
 * diagnostics seams still come up (capability ladder, F-013).
 */
export function apply(ctx: Context, config: PluginConfig = {}): void {
  assembleWebstack(ctx, config)
}

/**
 * 全量装配（W9）：apply 的实体。独立导出以便回归测试直接观测注册矩阵、
 * 凭据流、缓存栈与会话联网状态机，而不必穿透 cordis 生命周期。
 */
export function assembleWebstack(ctx: Context, config: PluginConfig = {}): WebstackAssembly {
  const capabilities: CapabilityBitmap = probeCapabilities(ctx)
  capabilities.bridgeOnline = peekBridge(ctx) !== undefined
  const tier: TierMode = deriveTierMode(capabilities)

  // ---- 接缝收集（全部可选，缺失走降级梯）----------------------------------
  const bridge = peekBridge(ctx)
  const storageSeam = peekStorage(ctx)
  const credentialsSeam = peekCredentials(ctx)

  // ---- 垂直腿免费池回调：只跑 ddg/bing-lite，杜绝垂类递归加发自身----------
  // 聚合器晚于注册表创建，这里经可变引用在首次调用时闭合。
  // oxlint-disable-next-line eslint/prefer-const -- delayed closure binding: assigned exactly once, after the aggregator is built.
  let aggregatorRef: WebstackAggregator | undefined
  const freePoolSearch: FreePoolSearchFn = async (req: EngineSearchRequest) => {
    const agg = aggregatorRef
    if (agg === undefined) return { hits: [], attempts: [] }
    return await agg.registry.runWithFallback(req, VERTICAL_FREE_POOL_IDS)
  }

  // ---- 引擎接线（注册序即 fallback 候选序）--------------------------------
  const built = buildEngineRegistry(config, {
    ...(config.verticalsPackEnabled === true && config.verticalsChannelX === true
      ? { vertical: { freePoolSearch, outboundFetch: lazyOutboundFetch() } }
      : {}),
  })
  const registry = built.registry

  // ---- 缓存栈（L0 内存 LRU + 可选 L1 持久层）+ 历史账本共享同一适配器------
  let persistMode = config.cachePersist ?? 'memory'
  let cache!: SearchCache
  let history!: HistoryStore
  const buildCacheStack = (): void => {
    const adapter =
      persistMode === 'durable'
        ? pickPersistence(
          { persist: persistMode },
          storageSeam === undefined ? undefined : { storage: storageSeam },
        )
        : undefined
    cache = new SearchCache(adapter === undefined ? {} : { adapter })
    history = new HistoryStore(adapter === undefined ? {} : { adapter })
  }
  buildCacheStack()

  // ---- 会话联网状态机（Host-owned 单实例；设置驱动 setMode）-----------------
  const sessionOnline = new SessionOnlineState()
  sessionOnline.setMode(config.sessionOnline ?? 'off')

  // ---- 快照组装：层池（mcp 动态集）+ 垂直腿 id------------------------------
  const snapshotExtras = (): {
    layerPools?: Partial<Record<SearchLayer, readonly string[]>>
    verticalEngineIds?: readonly string[]
  } => {
    const pools: Partial<Record<SearchLayer, readonly string[]>> = {}
    if (built.mcpEngineIds.length > 0) pools.mcp = [...built.mcpEngineIds]
    const channelOn = config.verticalsChannelX === true
    return {
      ...(built.mcpEngineIds.length > 0 ? { layerPools: pools } : {}),
      ...(built.verticalLegId !== undefined && channelOn
        ? { verticalEngineIds: [built.verticalLegId] }
        : {}),
    }
  }

  // ---- 聚合器：注册表 + 缓存 + 历史 + 桥 + 凭据源一次到位-------------------
  const aggregator = new WebstackAggregator({
    snapshot: composeSnapshot(config, snapshotExtras()),
    registry,
    cache,
    ...(bridge === undefined ? {} : { bridge }),
    credsSource: () =>
      credsSourceViewFrom(
        config,
        credentialsSeam === undefined ? undefined : { credentials: credentialsSeam },
      ),
  })
  aggregatorRef = aggregator

  /** 配置热刷新（settings onChange 与初始化共用同一路径）。 */
  const refresh = (): void => {
    // 缓存档位切换（memory↔durable）= 结构重建：换新 SearchCache/HistoryStore。
    const nextPersist = config.cachePersist ?? 'memory'
    if (nextPersist !== persistMode) {
      persistMode = nextPersist
      buildCacheStack()
      aggregator.attachCache(cache)
    }
    sessionOnline.setMode(config.sessionOnline ?? 'off')
    aggregator.updateSnapshot(composeSnapshot(config, snapshotExtras()))
  }

  // ---- settings seam：配置节安装 + 热生效（W-B-74/75）---------------------
  // alpha.4：installSettingsSection/settingsNamespace 已删除，改用
  // ctx.inject(['settings']) + settings.register()。服务缺席时回调不执行，
  // 回落组合入口配置——能力缺失降级而非报错（与旧语义一致）。
  let source: () => PluginConfig = () => ({ ...config })
  let refreshStatusSection: () => void = () => {}
  ctx.inject(['settings'], (settingsCtx) => {
    const scope = settingsCtx.settings.register(SETTINGS_NS, Config)
    source = () => scope.get() as PluginConfig
    // 热生效：设置文档是唯一事实源，watcher 与 settings 服务同生命周期。
    scope.watch(() => {
      const live = source()
      rewriteInPlace(config, live)
      refresh()
      refreshStatusSection()
    })
  })

  // ---- systemPrompt seam：守则节 + 动态状态节（W-B-90~92）-----------------
  const systemPrompt = peekService(ctx, 'systemPrompt')
  if (typeof systemPrompt?.section === 'function') {
    const sectionFn = systemPrompt.section as (s: ReturnType<typeof charterSection>) => () => void
    sectionFn(charterSection(HOST_LOCALE))
    let statusDisposer: (() => void) | undefined
    refreshStatusSection = () => {
      statusDisposer?.()
      statusDisposer = sectionFn(
        statusSection(registry.statusSnapshot(), HOST_LOCALE, {
          ...(bridge === undefined ? {} : { bridgeOnline: true }),
          ...(built.verticalLegId === undefined
            ? {}
            : { verticalEnabled: config.verticalsChannelX === true }),
        }),
      )
    }
    refreshStatusSection()
  }

  // ---- tools seam：诊断 + 批量 + 历史三件（W-B-113/114 + F-113 + F-205）----
  const tools = peekService(ctx, 'tools')
  if (typeof tools?.register === 'function') {
    const registerFn = tools.register as (definition: Record<string, unknown>) => () => void
    registerFn(buildStatusTool())
    registerFn(
      // defineTool 返回的 ToolDefinition 缺索引签名，收窄为注册面形状（既有先例）。
      buildBatchSearchTool(
        { run: async query => await aggregator.searchHits({ query }) },
        HOST_LOCALE,
      ) as unknown as Record<string, unknown>,
    )
    registerFn(buildHistoryTool({ history }, HOST_LOCALE) as unknown as Record<string, unknown>)
  }

  /** web_backend_status 工具（读 doctor 报告；含桥/垂类状态行）。 */
  function buildStatusTool(): Record<string, unknown> {
    return defineTool({
      name: 'web_backend_status',
      description:
        'Side-effect-free WebStack diagnostics: tier mode, per-engine state with cooldowns and last error code, bridge/vertical availability, and cache hit statistics. Makes no search requests and exposes no credentials.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            tier: { type: 'string', required: true },
            bridge: { type: 'string' },
            vertical: { type: 'string' },
            engines: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string', required: true },
                  state: { type: 'string', required: true },
                  cooldownRemainingMs: { type: 'number' },
                  lastCode: { type: 'string' },
                },
              },
            },
            cache: {
              type: 'object',
              additionalProperties: false,
              properties: {
                hits: { type: 'number', required: true },
                misses: { type: 'number', required: true },
                size: { type: 'number', required: true },
              },
            },
          },
          required: ['tier', 'engines', 'cache'],
        },
        render: (_args, value) => {
          const report = value as Parameters<typeof renderDoctor>[0]
          return [{ type: 'text', text: renderDoctor(report, HOST_LOCALE) }]
        },
      },
      timeoutMs: 10_000,
      isConcurrencySafe: () => true,
      async execute() {
        const report = runDoctor({
          bitmap: capabilities,
          tier,
          registry,
          cache: aggregator.cache,
          configuredEngineIds: built.invalidMcpIds,
          ...(bridge === undefined ? {} : { bridgeOnline: true }),
          vertical: doctorVerticalState(),
        })
        // 显式展开为 schema 推导形状（readonly 报告数组 → 可变 canonical 值）。
        return {
          tier: report.tier,
          ...(report.bridge === undefined ? {} : { bridge: report.bridge }),
          ...(report.vertical === undefined ? {} : { vertical: report.vertical }),
          engines: report.engines.map(engine => ({
            id: engine.id,
            state: engine.state,
            ...(engine.cooldownRemainingMs === undefined
              ? {}
              : { cooldownRemainingMs: engine.cooldownRemainingMs }),
            ...(engine.lastCode === undefined ? {} : { lastCode: engine.lastCode }),
          })),
          cache: {
            hits: report.cache.hits,
            misses: report.cache.misses,
            size: report.cache.size,
          },
        }
      },
    }) as unknown as Record<string, unknown>
  }

  /** 垂直频道 doctor 三态：关 / 开 / 开但卫星包缺失（最近尝试冷却 = 缺失信号）。 */
  function doctorVerticalState(): 'on' | 'off' | 'pack-missing' {
    if (built.verticalLegId === undefined || config.verticalsChannelX !== true) return 'off'
    const entry = registry.statusSnapshot()[VERTICAL_X_ENGINE_ID]
    return entry?.lastCode === 'cooldown' ? 'pack-missing' : 'on'
  }
  // TODO(W2-PLATFORM): 宿主命令系统 API 未确认——`/webstack doctor` 等对话命令
  // 不硬造；诊断经 web_backend_status 工具或对话请求触发（README 说明）。

  // ---- winproxy：显式开启才早期探测并注入 env（尽力而为层）-----------------
  if (config.winProxyFallback === true) {
    void getWindowsSystemProxy()
      .then((proxy) => {
        applyProxyToEnv(proxy)
      })
      .catch(() => undefined)
  }

  // ---- web seam：聚合器双面注册（search + fetch）---------------------------
  if (capabilities.webSeam) {
    ctx.web.registerSearchProvider(aggregator)
    ctx.web.registerFetchProvider(aggregator)
  }

  // ---- 加载标记一行日志（W-B-78）：tier + 能力位图 + 引擎表 ----------------
  const logger = peekService(ctx, 'logger')
  const logInfo = logger?.info
  const marker = [
    `tier=${tier}`,
    `web=${capabilities.webSeam}`,
    `settings=${capabilities.settingsSection}`,
    `credentials=${capabilities.credentialsDomain}`,
    `storage=${capabilities.storageService}`,
    `bridge=${capabilities.bridgeOnline}`,
    `mcp=${built.mcpEngineIds.length}`,
    `engines=[${registry.listIds().join(',')}]`,
  ].join(' ')
  if (typeof logInfo === 'function') {
    (logInfo as (message: string) => void).call(logger, `[webstack] loaded ${marker}`)
  } else if (typeof ctx.logger === 'function') {
    ctx.logger(name).info(`[webstack] loaded ${marker}`)
  } else {
    console.info(`[webstack] loaded ${marker}`)
  }

  return {
    capabilities,
    tier,
    registry,
    aggregator,
    history,
    sessionOnline,
    mcpEngineIds: built.mcpEngineIds,
    invalidMcpIds: built.invalidMcpIds,
    ...(built.verticalLegId === undefined ? {} : { verticalLegId: built.verticalLegId }),
    bridgeOnline: bridge !== undefined,
    refresh,
  }
}

/** 把 settings 文档快照原位写进初始配置对象（保持闭包身份稳定，字段级覆盖）。 */
function rewriteInPlace(target: PluginConfig, next: PluginConfig): void {
  for (const key of Object.keys(target) as (keyof PluginConfig)[]) {
    // oxlint-disable-next-line typescript/no-dynamic-delete -- 原位清空再整体覆盖，保持 target 的闭包身份稳定。
    delete target[key]
  }
  Object.assign(target, next)
}
