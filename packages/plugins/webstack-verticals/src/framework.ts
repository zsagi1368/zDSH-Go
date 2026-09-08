/**
 * 垂直频道最小框架（实验性卫星，默认关闭）。
 *
 * 职责边界（W-B-05 消费侧解耦同款姿态）：
 * - 本文件只定义「频道是什么」与「注册表如何治理频道」，不实现任何具体
 *   频道；具体频道见 x-search.ts 及后续增量。
 * - 全部契约类型均为 dsh-webstack 冻结契约的**本地结构镜像**：字段语义与
 *   `NormalizedHit` / `SearchHints` / `EngineDescriptor` 逐字对齐但零 import，
 *   结构兼容由装配层与 webstack 侧契约测试共同锁死；本包 monorepo 外可编译。
 * - 依赖全部经 `VerticalDeps` 注入：`search` 由装配层接免费池引擎聚合；
 *   `outboundFetch` 复用内核 SSRF 四道闸出站通道。两者缺席/非函数一律按
 *   「未接线」静默降级——本包自身永不直接触网。
 *
 * @module dsh-webstack-verticals/framework
 */

// ---------------------------------------------------------------------------
// 本地结构镜像（缺类型本地加；不改 dsh-webstack types.ts 冻结契约）
// ---------------------------------------------------------------------------

/** 结果出处元组的最小像（镜像 HitProvenance）。 */
export interface HitProvenance {
  /** 产出该命中的引擎 id。 */
  engine: string
  /** 降级/中转标注（如 "oembed"、"site-search"）；W-B-17 如实标注纪律。 */
  via?: string
  /** 面向用户的补充说明键（i18n 键，不是自由文本——防注入 W-B-53）。 */
  note?: string
}

/** 归一化命中的最小像（镜像 NormalizedHit；url 保留首见原样 W-B-35）。 */
export interface NormalizedHit {
  url: string
  title: string
  snippet?: string
  publishedAt?: string
  provenance: HitProvenance
}

/** 搜索提示的最小像（镜像 SearchHints 的频道消费子集）。 */
export interface SearchHints {
  topic?: string
  siteFilter?: string
  hard: readonly string[]
  soft: readonly string[]
}

/**
 * 频道层搜索请求（EngineSearchRequest 的消费子集像）：layer/band 等路由
 * 字段对垂直频道无语义，刻意省略；结构兼容装配层的完整请求对象。
 */
export interface VerticalSearchRequest {
  query: string
  hints: SearchHints
  count: number
  signal?: AbortSignal
}

/** 统一出站请求的最小像（镜像 OutboundRequest；GET 语义）。 */
export interface OutboundRequestLike {
  url: string
  headers?: Record<string, string>
  signal?: AbortSignal
  timeoutMs?: number
  maxBytes: number
}

/** 统一出站响应的最小像（镜像 OutboundResponse）。 */
export interface OutboundResponseLike {
  status: number
  text(): Promise<string>
}

/** 出站客户端函数签名（失败抛 EngineError；本包一律 try/catch 静默降级）。 */
export type OutboundFetchLike = (req: OutboundRequestLike) => Promise<OutboundResponseLike>

/** 装配层注入的频道依赖：缺席成员 = 对应腿静默不可用，绝不裸触网。 */
export interface VerticalDeps {
  /**
   * 免费池搜索回调：装配层把免费池引擎聚合（ddg / bing-lite 等）包装成
   * 单入口注入。返回 hits 或抛错由频道自行消化。
   */
  search(req: VerticalSearchRequest): Promise<NormalizedHit[]>
  /** 内核 outboundFetch 注入位（SSRF 四道闸复用）；缺席 = oEmbed 腿跳过。 */
  outboundFetch?: OutboundFetchLike | undefined
}

// ---------------------------------------------------------------------------
// 频道与描述符
// ---------------------------------------------------------------------------

/** 引擎能力徽章位的频道子集像（内核恒缺省 vertical 位，仅卫星供给）。 */
export interface VerticalCaps {
  readonly vertical: true
}

/** 引擎描述符的频道名片像（tier 恒 'free'：垂直降级链结构性免凭据）。 */
export interface VerticalDescriptor {
  readonly id: string
  readonly kind: 'search'
  readonly tier: 'free'
  readonly caps: VerticalCaps
  readonly cost: { readonly keysRequired: 0; readonly quotaHint: 'unknown' }
  readonly latencyBudgetMs: number
}

/** 深冻结工具（webstack freezeDescriptor 同款语义，本地实现防跨包依赖）。 */
export function freezeDeep<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      freezeDeep((value as Record<string, unknown>)[key])
    }
    Object.freeze(value)
  }
  return value
}

/**
 * 垂直频道接口：一个频道 = 一条「特定信息域」的结构化降级链。
 * `run` 必须自消化全部异常（最坏返回空数组），绝不向注册表抛错。
 */
export interface VerticalChannel {
  /** 稳定唯一 id（同时是设置面 channels.<id> 开关键与缓存键维度）。 */
  readonly id: string
  /** 确定性意图判定：给定 hints 是否值得让该频道出手（纯函数、不打网）。 */
  canHandle(hints: SearchHints): boolean
  /** 执行降级链；deps 缺席成员按未接线处理。 */
  run(req: VerticalSearchRequest, deps: VerticalDeps): Promise<NormalizedHit[]>
}

// ---------------------------------------------------------------------------
// 注册表
// ---------------------------------------------------------------------------

/**
 * 频道注册表：register/list/canRun 三面。同名重复注册按「替换」处理并返回
 * 新 disposer（旧 disposer 幂等失效）；list 返回注册顺序快照。
 */
export class VerticalRegistry {
  private readonly channels = new Map<string, VerticalChannel>()

  /**
   * 注册或替换频道；返回 disposer（再次调用幂等无害）。
   * @throws 同一实例重复注册不同对象但同 id 时按替换语义，不抛错。
   */
  register(channel: VerticalChannel): () => void {
    this.channels.set(channel.id, channel)
    let active = true
    return () => {
      if (!active) return
      active = false
      const current = this.channels.get(channel.id)
      if (current === channel) this.channels.delete(channel.id)
    }
  }

  /** 注册顺序快照（只读数组副本，外部增删不影响注册表）。 */
  list(): readonly VerticalChannel[] {
    return [...this.channels.values()]
  }

  /** 频道存在且 canHandle(hints)=true 才可运行；未知 id 恒 false。 */
  canRun(id: string, hints: SearchHints): boolean {
    const channel = this.channels.get(id)
    if (channel === undefined) return false
    try {
      return channel.canHandle(hints)
    } catch {
      return false // canHandle 抛错视为不可运行（防御性，正常实现不该抛）
    }
  }
}
