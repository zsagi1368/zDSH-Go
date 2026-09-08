/**
 * X 垂直频道 → EngineLike 适配腿（W9 装配层接线，实验性卫星）：
 * 把 `dsh-webstack-verticals` 的 XVerticalChannel 包装成注册表可执行的
 * EngineSearchRequest 消费者。治理要点：
 *
 * - **惰性动态导入**：卫星包是 workspace peer 可选依赖，首次 search 才
 *   `import('dsh-webstack-verticals')`；模块缺失/加载失败缓存为「缺席」，
 *   之后统一抛 `cooldown`（non-retryable，detail = i18n 诊断键），聚合器
 *   fallback 链自然换下一候选——静默跳过 + 诊断键，绝不致命（W-B-08 降级梯）。
 * - **免凭据结构性保证**：tier='free'、caps.vertical=true（内核恒缺省该位，
 *   仅卫星供给）。canHandle 矩阵由 router 的 hintsTargetVerticalX 承担；
 *   本适配器只负责执行与降级语义。
 * - **免费池回调**：频道腿 1 经注入的 freePoolSearch 跑 `site:` 双站查询——
 *   只允许免费池 id（ddg/bing-lite），杜绝垂类递归加发自身。
 *
 * @module webstack/engines/vertical-x
 */

import { engineError } from '../kernel/errors.ts'
import type {
  EngineDescriptor,
  EngineSearchRequest,
  EngineSearchResponse,
} from '../kernel/types.ts'
import { BaseEngine, freezeDescriptor } from './engine.ts'

/** 卫星包动态导入的最小结构视图（framework + x-search 的消费子集）。 */
export interface VerticalHit {
  url: string
  title: string
  snippet?: string
  publishedAt?: string
  provenance: { engine: string; via?: string; note?: string }
}

export interface VerticalRequestView {
  query: string
  hints: {
    topic?: string
    siteFilter?: string
    hard: readonly string[]
    soft: readonly string[]
  }
  count: number
  signal?: AbortSignal
}

export interface VerticalDepsView {
  search(req: VerticalRequestView): Promise<VerticalHit[]>
  outboundFetch?:
    | ((req: {
      url: string
      headers?: Record<string, string>
      signal?: AbortSignal
      timeoutMs?: number
      maxBytes: number
    }) => Promise<{ status: number; text(): Promise<string> }>)
    | undefined
}

export interface VerticalChannelView {
  readonly id: string
  run(req: VerticalRequestView, deps: VerticalDepsView): Promise<VerticalHit[]>
}

export interface VerticalPackView {
  XVerticalChannel: new () => VerticalChannelView
}

/**
 * 卫星包模块 id（可选运行期 peer，零依赖纪律：不进 package.json）。刻意以
 * **变量承载**动态导入——字面量会让类型层在卫星未安装时直接红（TS2307）；
 * 变量形态交由运行时解析，缺失路径统一走 catch → undefined → cooldown 诊断键。
 */
const VERTICALS_MODULE_ID = 'dsh-webstack-verticals'

/** 卫星包缺失/加载失败时的统一错误构造（闭集码 cooldown + 诊断键 detail）。 */
function packUnavailableError(engineId: string): Error {
  return engineError('cooldown', 'vertical satellite pack unavailable', {
    engineId,
    detail: 'webstack.verticals.disabled-notice',
  })
}

/** 免费池搜索回调签名（装配层注入；只跑免费池 id，防垂类递归）。 */
export type FreePoolSearchFn = (req: EngineSearchRequest) => Promise<EngineSearchResponse>

/** 静态名片：free 档、零凭据、caps.vertical。 */
export const VERTICAL_X_DESCRIPTOR: EngineDescriptor = freezeDescriptor({
  id: 'x-vertical',
  kind: 'search',
  tier: 'free',
  caps: { vertical: true },
  cost: { keysRequired: 0, quotaHint: 'unknown' },
  latencyBudgetMs: 6000,
})

/** 构造选项：动态导入器与免费池回调均可注入（测试假体接缝）。 */
export interface VerticalXLegOptions {
  /** 卫星包动态导入器；返回 undefined = 包缺失（默认字面量 import）。 */
  loadPack?: () => Promise<VerticalPackView | undefined>
  /** 免费池聚合回调（频道腿 1 的发现通道）。 */
  freePoolSearch: FreePoolSearchFn
  /** 内核出站客户端（SSRF 四道闸复用）；缺席 = oEmbed 富化腿跳过。 */
  outboundFetch?: VerticalDepsView['outboundFetch'] | undefined
}

/**
 * X 垂直腿引擎适配器。实例持有两级懒状态：包加载 Promise（失败可重试）与
 * 频道实例缓存；全部失败路径收敛为闭集错误交注册表 fallback。
 */
export class VerticalXLegEngine extends BaseEngine {
  private packPromise: Promise<VerticalPackView | undefined> | undefined
  private channelInstance: Promise<VerticalChannelView> | undefined

  constructor(private readonly options: VerticalXLegOptions) {
    super(VERTICAL_X_DESCRIPTOR)
  }

  /** 默认动态导入：说明符经变量承载（见 VERTICALS_MODULE_ID）；缺失 → undefined。 */
  private defaultLoad(): Promise<VerticalPackView | undefined> {
    return import(VERTICALS_MODULE_ID)
      .then(mod => mod as unknown as VerticalPackView)
      .catch(() => undefined)
  }

  private loadPack(): Promise<VerticalPackView | undefined> {
    this.packPromise ??= (this.options.loadPack ?? (() => this.defaultLoad()))()
    return this.packPromise
  }

  /** 频道实例懒构造（同包同实例，会话内 oEmbed 缓存/单飞锁随之共享）。 */
  private async channel(): Promise<VerticalChannelView | undefined> {
    const pack = await this.loadPack()
    const Ctor = pack?.XVerticalChannel
    if (typeof Ctor !== 'function') return undefined
    this.channelInstance ??= Promise.resolve(new Ctor())
    return await this.channelInstance
  }

  /**
   * 执行垂直降级链：包/频道不可用 → cooldown（诊断键 detail）；频道自身
   * run 恒 resolve（最坏空数组），两腿全败的静默语义在卫星侧收敛。
   */
  async search(req: EngineSearchRequest): Promise<EngineSearchResponse> {
    return await this.runSearch(req, async () => {
      const channel = await this.channel()
      if (channel === undefined) throw packUnavailableError(this.descriptor.id)
      const outbound =
        typeof this.options.outboundFetch === 'function' ? this.options.outboundFetch : undefined
      return await channel.run(
        {
          query: req.query,
          hints: {
            ...(req.hints.topic === undefined ? {} : { topic: req.hints.topic }),
            ...(req.hints.siteFilter === undefined ? {} : { siteFilter: req.hints.siteFilter }),
            hard: [...req.hints.hard],
            soft: [...req.hints.soft],
          },
          count: req.count,
          ...(req.signal === undefined ? {} : { signal: req.signal }),
        },
        {
          search: async vreq =>
            // 免费池命中为只读 NormalizedHit[]；频道契约要可变数组，浅拷贝
            // 交接（元素结构兼容：镜像类型与冻结契约逐字对齐）。
            [
              ...(
                await this.options.freePoolSearch({
                  ...req,
                  query: vreq.query,
                  count: vreq.count,
                })
              ).hits,
            ],
          ...(outbound === undefined ? {} : { outboundFetch: outbound }),
        },
      )
    })
  }
}
