/**
 * 中性聚合器：WebStack 注册进宿主 seam 的唯一 provider 实现（决策一）。
 * 运行时路由（native/free/api/selfhosted/mcp）全部是其内部决策，永不重新打补丁。
 *
 * search 全管线（W-B-74 操作起点快照）：
 * enabled 检查 → extractHints → estimateBand → planSearch → resolveCreds（指纹）
 * → 缓存查询（命中直接回）→ miss 则 singleFlight 包裹：多引擎走
 * runFusedLegs（按复杂度档整体预算 race，allSettled + AbortSignal 真取消，
 * 超时慢腿记 attempts 'aborted'、已返回部分结果仍参与融合）→ fusion.fuse()
 * 融合 → 截断 → 写缓存原文 → 映射 SeamWebSearchResult；单引擎/关闭融合直出。
 *
 * fetch 管线：预算从快照派生（canonical = min(maxContentChars×4, 8MiB)）→
 * fetchPipeline（SSRF 四道闸 + 回退链已有实现）→ 映射 SeamWebFetchResult；
 * 目标站 4xx/5xx 是数据如实上呈；管道故障（含 ssrf-blocked）经 scrub 后抛出。
 *
 * @module webstack/kernel/aggregator
 */

import { keyFor, SearchCache, singleFlight } from '../cache/store.ts'
import { credFingerprint, resolveCredsDetailed } from '../creds/resolve.ts'
import { credSlotOf } from '../creds/slots.ts'
import { fetchPipeline } from '../fetch/pipeline.ts'
import { scrubText } from '../safety/scrub.ts'
import { type EngineError, engineError, normalizeThrown } from './errors.ts'
import { DEFAULT_FUSION_PARAMS, fuse } from './fusion.ts'
import { extractHints } from './hints.ts'
import type { HistoryStore } from './history.ts'
import { EngineRegistry } from './registry.ts'
import { estimateBand, planSearch } from './router.ts'
import type {
  AttemptRecord,
  ComplexityBand,
  ContentBudgets,
  EngineSearchRequest,
  EngineTier,
  FetchMode,
  FetchRequest,
  FetchResult,
  FusionParams,
  NormalizedHit,
  SeamBridgeRuntime,
  SeamWebFetchProvider,
  SeamWebFetchRequest,
  SeamWebFetchResult,
  SeamWebSearchProvider,
  SeamWebSearchRequest,
  SeamWebSearchResult,
  SearchLayer,
} from './types.ts'
import { WEBSTACK_PROVIDER_ID } from './types.ts'

/** G4 出站纪律的硬上限：canonical 字节预算封顶 8 MiB。 */
const MAX_BYTES_CAP = 8 * 1024 * 1024

/** 错误体字符预算（进入上下文前再经 injection 截断转义）。 */
const ERROR_CHARS = 2000

/**
 * T3 桥接兜底单次渲染预算（毫秒，F-201）：`bridge.render` 的固定超时；
 * 每次抓取至多触发一次兜底（不重试、不级联）。
 */
export const BRIDGE_RENDER_TIMEOUT_MS = 8000

/**
 * 「内容过短」判定阈值（字符）：静态抓取正文低于该值且未截断时视为
 * 疑似 JS 渲染空壳，触发一次桥接兜底；桥结果更长才采纳（宁缺勿滥）。
 */
export const BRIDGE_SHORT_CONTENT_CHARS = 256

/**
 * 复杂度档整体预算（毫秒）：多引擎融合腿共享一个总预算——medium 5s /
 * complex 8s；simple 不设整体预算（单引擎，registry 自带 per-attempt 预算）。
 * 快照 `bandBudgetMs` 可整体覆盖（测试与高级配置注入点）。
 */
export const BAND_BUDGET_MS: Readonly<Partial<Record<ComplexityBand, number>>> = Object.freeze({
  medium: 5000,
  complex: 8000,
})

/** 聚合器运行快照（W-B-74 起点）：操作起点解析，配置保存即时生效于下一次操作。 */
export interface AggregatorSnapshot {
  /** 总开关；false 时 available()=false，seam 自动回落其它 provider 或原生。 */
  enabled: boolean
  /** 默认路由层。 */
  layer: SearchLayer
  /** 候选展开开关；false 只用首选单引擎。 */
  autoFallback: boolean
  /** 结果条数上限（请求未带 maxResults 时生效）。 */
  maxResults: number
  /** 多引擎 RRF 融合总开关。 */
  fusionEnabled: boolean
  /** 复杂度分档路由开关。 */
  complexityRouting: boolean
  /** 抓取回退链首选模式。 */
  fetchMode: FetchMode
  /** 渲染视图字符上限（canonical 预算由此 ×4 派生并封顶 8 MiB）。 */
  maxContentChars: number
  /** SSRF G2 豁免清单（host:port 与 CIDR；永不影响 G1/G3/G4）。 */
  ssrfExempts: readonly string[]
  /** 搜索缓存开关。 */
  cacheEnabled: boolean
  /**
   * 会话联网强制在线（W-B94/W9）：true = 本轮聚合器跳过缓存读（强制
   * fresh），由设置 `mode.sessionOnline === 'on'` 驱动；缺省 false。
   */
  forceFresh?: boolean
  /**
   * 层候选池覆盖（W9）：mcp 层等动态池经此注入 planSearch；缺席层回落
   * router.LAYER_ENGINE_POOL。
   */
  readonly layerPools?: Partial<Record<SearchLayer, readonly string[]>>
  /**
   * 垂直腿引擎 id（W9 实验性）：非空且 hints 命中 X/Twitter 触发矩阵时加发
   * 该腿（见 router.hintsTargetVerticalX）。
   */
  readonly verticalEngineIds?: readonly string[]
  /**
   * 融合细参覆盖（半衰期/权威乘子/多样性折扣）；缺席字段回落
   * {@link DEFAULT_FUSION_PARAMS}（与 settings schema `search.fusion.*`
   * 默认值对齐）。
   */
  readonly fusionParams?: Partial<Omit<FusionParams, 'enabled'>>
  /** 复杂度档预算覆盖（毫秒）；缺席档位回落 {@link BAND_BUDGET_MS}。 */
  readonly bandBudgetMs?: Partial<Record<ComplexityBand, number>>
}

/** 凭据解析输入视图（装配层提供，操作起点消费；W-B54/74）。 */
export interface CredsSourceView {
  /** 设置面遗留字面值表（`engines.<id>.key` / 兼容 `.apiKey`）。 */
  readonly configValues?: Readonly<Record<string, string | undefined>>
  /** 设置面 credentialRef 表。 */
  readonly credentialsRef?: Readonly<Record<string, string | undefined>>
  /** 宿主接缝（目前仅消费 credentials.resolve）。 */
  readonly seams?: { credentials?: import('./types.ts').SeamCredentialsRuntime }
}

/** 凭据源回调：每次搜索起点调用一次，返回当时的配置快照视图。 */
export type CredsSourceFn = () => CredsSourceView

/** 构造依赖：注册表与缓存可注入（测试假引擎注入点）；缺省自建空实例。 */
export interface AggregatorDeps {
  readonly snapshot: AggregatorSnapshot
  readonly registry?: EngineRegistry
  readonly cache?: SearchCache
  /** 浏览器桥接兜底通道（T3，可选卫星）：fetch 管道失败/内容过短时单次渲染。 */
  readonly bridge?: SeamBridgeRuntime
  /** 历史环形账本（P1/F-205）：search/fetch 结果回放来源；缺席 = 不记账。 */
  readonly history?: HistoryStore
  /**
   * 凭据源回调（W9 凭据流贯通）：操作起点解析全部计划引擎的凭据；
   * 缺席 = 全 absent 快照（免费池语义不变）。
   */
  readonly credsSource?: CredsSourceFn
}

/** 层 → 计费档位映射（缓存键 tier 维度）。 */
const TIER_OF_LAYER: Readonly<Record<SearchLayer, EngineTier>> = Object.freeze({
  native: 'native',
  free: 'free',
  api: 'keyed',
  selfhosted: 'selfhosted',
  mcp: 'mcp',
})

/**
 * WebStack 聚合器。同一实例同时实现搜索与抓取两个 seam 面注册
 * （id 相同、能力种类不同，宿主两本注册簿互不冲突）。
 */
export class WebstackAggregator implements SeamWebSearchProvider, SeamWebFetchProvider {
  readonly id = WEBSTACK_PROVIDER_ID

  private snapshotField: AggregatorSnapshot
  readonly registry: EngineRegistry
  private cacheField: SearchCache
  private readonly bridge: SeamBridgeRuntime | undefined
  private readonly historyStore: HistoryStore | undefined
  private readonly credsSource: CredsSourceFn | undefined
  /** 最近一次 fetch 的 via 标注（lastFetchVia 只读访问器的后备字段）。 */
  private lastFetchViaField: string | undefined

  /** 当前缓存实例（attachCache 可热替换，读面经此转发）。 */
  get cache(): SearchCache {
    return this.cacheField
  }

  constructor(deps: AggregatorDeps) {
    this.snapshotField = deps.snapshot
    this.registry = deps.registry ?? new EngineRegistry()
    this.cacheField = deps.cache ?? new SearchCache()
    this.bridge = deps.bridge
    this.historyStore = deps.history
    this.credsSource = deps.credsSource
  }

  /**
   * 热替换缓存实例（W9：`cache.persist` 热生效——memory↔durable 切换时由
   * 装配层重建 SearchCache 并经此挂载；旧实例就地废弃，无迁移语义）。
   */
  attachCache(cache: SearchCache): void {
    this.cacheField = cache
  }

  /**
   * 操作起点刷新快照（settings watch / 配置变化都走到这里）。整对象替换：
   * 快照字段在操作内必须一致（W-B-74），禁止部分更新造成混合态。
   */
  updateSnapshot(snapshot: AggregatorSnapshot): void {
    this.snapshotField = snapshot
  }

  /** 当前运行快照只读视图（诊断/测试观测点；操作起点一致性 W-B-74）。 */
  get snapshot(): AggregatorSnapshot {
    return this.snapshotField
  }

  /**
   * 廉价同步可用性检查（W-B-97）：只读本地状态，绝不发网络探针。
   * 引擎级健康由 registry 失败冷却表达，不在此处。
   */
  available(): boolean {
    return this.snapshot.enabled
  }

  async search(request: SeamWebSearchRequest, signal?: AbortSignal): Promise<SeamWebSearchResult> {
    const hits = await this.searchHits(request, signal)
    return toSeamResult(hits)
  }

  /**
   * 归一化命中直出面（W9：web_batch_search 工具与垂类免费池回调共用同一条
   * 聚合管线——凭据解析/缓存/融合/fallback 全一致）；search() 是其 seam 映射。
   */
  async searchHits(
    request: SeamWebSearchRequest,
    signal?: AbortSignal,
  ): Promise<readonly NormalizedHit[]> {
    if (!this.snapshot.enabled) {
      throw this.scrubbed(
        engineError('transport', 'webstack provider is disabled', {
          detail: 'disabled',
        }),
      )
    }
    const hints = extractHints(request.query)
    const band = estimateBand(request.query)
    const plan = planSearch(
      {
        layer: this.snapshot.layer,
        autoFallback: this.snapshot.autoFallback,
        fusionEnabled: this.snapshot.fusionEnabled,
        complexityRouting: this.snapshot.complexityRouting,
        ...(this.snapshot.layerPools === undefined ? {} : { layerPools: this.snapshot.layerPools }),
        ...(this.snapshot.verticalEngineIds === undefined
          ? {}
          : { verticalEngineIds: this.snapshot.verticalEngineIds }),
      },
      hints,
      band,
    )
    const count = request.maxResults ?? this.snapshot.maxResults

    // 计划引擎集与注册表求交：配置池 id 与实际接线一致时即计划本身；
    // 全部计划 id 未接线时按层回落已注册候选（降级梯，绝不空转）。
    const engineSet = this.wiredEngineIds(plan)

    // 凭据快照 + 明文（仅进程内传递）：操作起点解析一次（W-B-74/W-B-55）；
    // 指纹进缓存键（轮换即换键），明文按槽位装进引擎请求对象。
    const source = this.credsSource?.() ?? {}
    const { snapshot: creds, secrets } = await resolveCredsDetailed(engineSet, {
      ...(source.configValues === undefined ? {} : { configValues: source.configValues }),
      ...(source.credentialsRef === undefined ? {} : { credentialsRef: source.credentialsRef }),
      ...(source.seams === undefined ? {} : { seams: source.seams }),
    })
    const credentials: Record<string, string> = {}
    for (const id of engineSet) {
      const slot = credSlotOf(id)
      const secret = secrets[id]
      if (slot !== undefined && secret !== undefined) credentials[slot] = secret
    }

    const cacheKey = keyFor({
      layer: plan.layer,
      engineSet,
      count,
      hints,
      tier: TIER_OF_LAYER[plan.layer],
      credFingerprint: credFingerprint(creds),
    })

    const cached = await this.readCache(cacheKey)
    if (cached !== undefined) {
      return cached
    }

    try {
      const hits = await singleFlight(`search:${cacheKey}`, async () => {
        // 在飞合并后的二次确认：并发同键调用共享首个 miss 的执行结果。
        const again = await this.readCache(cacheKey)
        if (again !== undefined) return again
        const req = {
          query: hints.topic ?? request.query,
          hints,
          count,
          layer: plan.layer,
          band,
          ...(signal === undefined ? {} : { signal }),
          ...(Object.keys(credentials).length === 0 ? {} : { credentials }),
        }
        const useFusion = plan.fusion && engineSet.length > 1
        const resultHits: readonly NormalizedHit[] = useFusion
          ? fuse((await this.runFusedLegs(req, engineSet)).sets, this.fusionParamsSnapshot())
          : (await this.registry.runWithFallback(req, engineSet)).hits
        const trimmed = resultHits.slice(0, Math.max(0, count))
        if (this.snapshot.cacheEnabled && trimmed.length > 0) {
          await this.cache.set('search', cacheKey, trimmed)
        }
        return trimmed
      })
      this.recordHistory({
        kind: 'search',
        at: Date.now(),
        input: request.query,
        layer: plan.layer,
        sources: hits.map(hit => ({ url: hit.url, title: hit.title })),
      })
      return hits
    } catch (thrown) {
      this.recordHistory({
        kind: 'search',
        at: Date.now(),
        input: request.query,
        layer: plan.layer,
        sources: [],
      })
      throw this.scrubbed(thrown)
    }
  }

  /**
   * 最近一次 fetch 的出处标注（W-B-16 可解释性在抓取面的延伸）：
   * `'pipeline'` = 静态抓取管线直出；`'bridge'` = T3 桥接兜底产出；
   * 尚未执行过为 undefined。FetchResult 契约无 provenance 位（types 冻结），
   * 该标注经本只读访问器与 `statusCode === 0`（非 HTTP 通道约定）共同表达。
   */
  get lastFetchVia(): string | undefined {
    return this.lastFetchViaField
  }

  async fetch(request: SeamWebFetchRequest, signal?: AbortSignal): Promise<SeamWebFetchResult> {
    if (!this.snapshot.enabled) {
      throw this.scrubbed(
        engineError('transport', 'webstack provider is disabled', {
          detail: 'disabled',
        }),
      )
    }
    // 三层预算（F-005）：canonical 由渲染预算 ×4 派生并封顶 8 MiB；各层独立不挤占。
    const budgets: ContentBudgets = {
      canonicalChars: Math.min(this.snapshot.maxContentChars * 4, MAX_BYTES_CAP),
      renderedChars: this.snapshot.maxContentChars,
      errorChars: ERROR_CHARS,
    }
    const req: FetchRequest = {
      url: request.url,
      mode: this.snapshot.fetchMode,
      budgets,
      ...(signal === undefined ? {} : { signal }),
    }
    let result: FetchResult
    try {
      result = await fetchPipeline(req, {
        exemptions: [...this.snapshot.ssrfExempts],
      })
    } catch (thrown) {
      const err = normalizeThrown(thrown)
      // T3 桥接兜底（F-201）：管道故障时若桥在线则单次渲染兜底；terminal
      // 错误（ssrf-blocked/aborted）绝不绕行（W-B-50 安全 refusal 直通）。
      const bridged =
        err.code !== 'ssrf-blocked' && err.code !== 'aborted'
          ? await this.bridgeRender(request.url, budgets)
          : undefined
      if (bridged === undefined) throw this.scrubbed(thrown)
      return this.seamFetchResult(bridged, 'bridge')
    }
    // 内容过短（疑似 JS 空壳）且未截断 → 桥接一次，取更长的一方。
    if (
      !result.truncated &&
      result.content.length < BRIDGE_SHORT_CONTENT_CHARS &&
      this.bridge !== undefined
    ) {
      const bridged = await this.bridgeRender(request.url, budgets)
      if (bridged !== undefined && bridged.content.length > result.content.length) {
        return this.seamFetchResult(bridged, 'bridge')
      }
    }
    return this.seamFetchResult(result, 'pipeline')
  }

  // -------------------------------------------------------------------------
  // 内部机制
  // -------------------------------------------------------------------------

  /**
   * T3 桥接兜底（F-201）：桥缺席/渲染失败/超时一律返回 undefined（降级梯，
   * 绝不致命）；成功返回引擎层 FetchResult 形态——statusCode 透传桥值，
   * 桥未给状态码时记 0（types 契约：0 = 经桥接等非 HTTP 通道取得）。
   */
  private async bridgeRender(
    url: string,
    budgets: ContentBudgets,
  ): Promise<FetchResult | undefined> {
    if (this.bridge === undefined) return undefined
    try {
      const rendered = await this.bridge.render(url, BRIDGE_RENDER_TIMEOUT_MS)
      if (rendered === undefined) return undefined
      const content = rendered.content ?? ''
      if (content === '') return undefined
      return {
        url,
        statusCode: rendered.statusCode,
        content,
        mode: 'raw',
        truncated: false,
        budgets,
      }
    } catch {
      // 桥是锦上添花通道：任何故障都不放大为业务失败。
      return undefined
    }
  }

  /** 引擎层抓取结果 → seam 面 + via 标注记账。 */
  private seamFetchResult(result: FetchResult, via: string): SeamWebFetchResult {
    this.lastFetchViaField = via
    return {
      url: result.url,
      statusCode: result.statusCode,
      body: { kind: 'text', content: result.content },
      truncated: result.truncated,
    }
  }

  /** 计划引擎集 ∩ 注册表；交集为空时按层回落全部已注册候选（保序）。 */
  private wiredEngineIds(plan: {
    readonly layer: SearchLayer
    readonly engineIds: readonly string[]
  }): string[] {
    const planned = plan.engineIds.filter(id => this.registry.describe(id) !== undefined)
    if (planned.length > 0) return [...planned]
    return this.registry.candidates(plan.layer).map(engine => engine.descriptor.id)
  }

  /** 读缓存并做形状校验：宁可 miss 不可错 hit（W-B-30），坏条目按 miss 处理。 */
  private async readCache(key: string): Promise<NormalizedHit[] | undefined> {
    if (!this.snapshot.cacheEnabled) return undefined
    // 会话联网强制在线（W-B94/W9）：mode=on 时跳过缓存读（强制 fresh）；
    // 写侧照常——本轮 fresh 结果供后续轮次复用。
    if (this.snapshot.forceFresh === true) return undefined
    const value: unknown = await this.cache.get('search', key)
    return isNormalizedHitArray(value) ? value : undefined
  }

  /** 历史记账（尽力而为）：HistoryStore.record 内部绝不抛错，此处再兜一层。 */
  private recordHistory(entry: Parameters<HistoryStore['record']>[0]): void {
    try {
      this.historyStore?.record(entry)
    } catch {
      // 历史绝不成为故障点。
    }
  }

  /** 抛出前统一脱敏：message 经 scrubText，错误码/分类语义原样保留（W-B-56）。 */
  private scrubbed(thrown: unknown): EngineError {
    const err = normalizeThrown(thrown)
    const message = scrubText(err.message)
    if (message === err.message) return err
    return engineError(err.code, message, {
      ...(err.engineId === undefined ? {} : { engineId: err.engineId }),
      ...(err.httpStatus === undefined ? {} : { httpStatus: err.httpStatus }),
      ...(err.retryAfterMs === undefined ? {} : { retryAfterMs: err.retryAfterMs }),
      ...(err.detail === undefined ? {} : { detail: err.detail }),
    })
  }

  /**
   * 操作起点融合参数：快照覆盖 → 缺省对齐（schema `search.fusion.*` 默认值）；
   * `enabled` 以快照总开关为准（router 已据此决定 plan.fusion）。
   */
  private fusionParamsSnapshot(): FusionParams {
    return {
      ...DEFAULT_FUSION_PARAMS,
      ...this.snapshot.fusionParams,
      enabled: this.snapshot.fusionEnabled,
    }
  }

  /**
   * 并发跑全部计划引擎（每腿独立 runWithFallback 单候选链），共享一个
   * 复杂度档整体预算：预算到点未归的慢腿记 attempts 'aborted' 被裁掉，
   * 已返回的部分结果照常参与融合（allSettled 语义 + AbortSignal 真取消——
   * 预算信号经 AbortSignal.any 下推进引擎请求，真取消底层外呼）。
   *
   * 结算语义：
   * - caller signal 中止 → 抛 aborted（terminal，整场立即结算，W-B-42）；
   * - 全部腿零命中且存在失败 → 抛首个失败错误（错误如实上呈）；
   * - 全部腿零命中且全部成功 → 返回空结果集（合法空页 ≠ 故障）；
   * - 其余 → 部分结果 + 裁腿审计。
   */
  private async runFusedLegs(
    req: EngineSearchRequest,
    engineIds: readonly string[],
  ): Promise<FusedLegsResult> {
    const budgetMs = this.snapshot.bandBudgetMs?.[req.band] ?? BAND_BUDGET_MS[req.band]
    const budgetSignal = budgetMs === undefined ? undefined : AbortSignal.timeout(budgetMs)
    const parts: AbortSignal[] = []
    if (req.signal !== undefined) parts.push(req.signal)
    if (budgetSignal !== undefined) parts.push(budgetSignal)
    const legSignal =
      parts.length === 0 ? undefined : parts.length === 1 ? parts[0] : AbortSignal.any(parts)
    const legReq: EngineSearchRequest = {
      ...req,
      ...(legSignal === undefined ? {} : { signal: legSignal }),
    }

    // Promise.allSettled 语义：任一腿的成败不传染其它腿；runLeg 本身永不 reject。
    const settled = await Promise.allSettled(
      engineIds.map(async id => await this.runLeg(legReq, id, budgetSignal)),
    )
    const outcomes: LegOutcome[] = settled.flatMap(entry =>
      entry.status === 'fulfilled' ? [entry.value] : [],
    )

    const byId = new Map(outcomes.map(outcome => [outcome.id, outcome]))
    const result: FusedLegsResult = { sets: [], attempts: [], trimmedLegs: 0 }
    const failures: EngineError[] = []
    for (const id of engineIds) {
      const outcome = byId.get(id)
      if (outcome === undefined) continue
      if (outcome.ok) {
        result.sets.push([...outcome.res.hits])
        result.attempts.push(...outcome.res.attempts)
        continue
      }
      result.attempts.push({
        engineId: outcome.id,
        startedAt: outcome.startedAt,
        durationMs: Math.max(0, Date.now() - outcome.startedAt),
        outcome: outcome.error.code,
      })
      failures.push(outcome.error)
      if (outcome.error.code === 'aborted') result.trimmedLegs++
    }

    if (req.signal?.aborted) {
      throw engineError('aborted', 'caller aborted during fused search', {})
    }
    const anyHits = result.sets.some(set => set.length > 0)
    if (!anyHits && failures.length > 0) throw failures[0] as EngineError
    return result
  }

  /**
   * 单条融合腿：预算到点仍未归即以 aborted 结算该腿（底层 promise 的迟到
   * 结算被吞掉，绝不产生 unhandled rejection）；caller-abort 由引擎自然抛出、
   * 经 normalizeThrown 归一为闭集码。
   */
  private async runLeg(
    req: EngineSearchRequest,
    id: string,
    budgetSignal: AbortSignal | undefined,
  ): Promise<LegOutcome> {
    const startedAt = Date.now()
    const inner = this.registry.runWithFallback(req, [id]).then(
      (res): LegOutcome => ({ ok: true, id, startedAt, res }),
      (thrown: unknown): LegOutcome => ({
        ok: false,
        id,
        startedAt,
        error: normalizeThrown(thrown, id),
      }),
    )
    if (budgetSignal === undefined) return await inner
    return await new Promise<LegOutcome>((resolve) => {
      let done = false
      const finish = (value: LegOutcome): void => {
        if (done) return
        done = true
        resolve(value)
      }
      void inner.then(finish) // inner 恒 resolve（成败都走值通道）
      budgetSignal.addEventListener(
        'abort',
        () =>
          finish({
            ok: false,
            id,
            startedAt,
            error: engineError('aborted', 'complexity band budget exceeded', {
              engineId: id,
              detail: 'band-budget',
            }),
          }),
        { once: true },
      )
    })
  }
}

// ---------------------------------------------------------------------------
// 多引擎融合腿（复杂度档整体预算 race）与映射辅助
// ---------------------------------------------------------------------------

/** 单条融合腿的结算结果（runLeg 永不 reject，失败也走值通道）。 */
type LegOutcome =
  | {
    readonly ok: true
    readonly id: string
    readonly startedAt: number
    readonly res: {
      readonly hits: readonly NormalizedHit[]
      readonly attempts: readonly AttemptRecord[]
    }
  }
  | {
    readonly ok: false
    readonly id: string
    readonly startedAt: number
    readonly error: EngineError
  }

/** 融合腿集合结算：按计划序的结果集与审计轨迹。 */
interface FusedLegsResult {
  /** 每腿一个结果集（保持计划引擎序，空集保留占位）。 */
  sets: NormalizedHit[][]
  attempts: AttemptRecord[]
  /** 因预算超时被裁掉的慢腿数。 */
  trimmedLegs: number
}

/** NormalizedHit[] 形状守卫（缓存读出的 unknown 收窄）。 */
function isNormalizedHitArray(value: unknown): value is NormalizedHit[] {
  if (!Array.isArray(value)) return false
  return value.every((entry) => {
    if (typeof entry !== 'object' || entry === null) return false
    const record = entry as Record<string, unknown>
    return (
      typeof record.url === 'string' &&
      typeof record.title === 'string' &&
      typeof record.provenance === 'object' &&
      record.provenance !== null
    )
  })
}

/** 引擎命中 → 宿主 seam 引用源（缺失字段保持缺失，不编造占位值 W-B-93）。 */
function toSeamResult(hits: readonly NormalizedHit[]): SeamWebSearchResult {
  return {
    sources: hits.map(hit => ({
      url: hit.url,
      title: hit.title,
      ...(hit.snippet === undefined ? {} : { snippet: hit.snippet }),
      ...(hit.publishedAt === undefined ? {} : { publishedAt: hit.publishedAt }),
    })),
    truncated: false,
  }
}
