/**
 * 原生委托档：`mode:native` 时聚合器直接把请求转交宿主内置 provider 实例
 * （不停用内置实现，只是不默认选中——决策一的回滚零成本保证）。
 *
 * 委托句柄在 capability 探测期从宿主捕获后经构造器注入；无委托（探测失败/
 * 宿主未提供）时 search 抛统一错误 `unrepresentable / native provider
 * unavailable`，由降级梯换层处理。转发动作为「计时包裹」：耗时记录在
 * `lastForwardMs`，供诊断面回读。
 *
 * @module webstack/engines/native-delegate
 */

import { engineError } from '../kernel/errors.ts'
import type {
  EngineDescriptor,
  EngineSearchRequest,
  EngineSearchResponse,
  SeamWebFetchProvider,
  SeamWebSearchProvider,
} from '../kernel/types.ts'
import { BaseEngine, freezeDescriptor } from './engine.ts'

export const NATIVE_DELEGATE_ID = 'native'

/** 静态名片：原生档无自身网络行为，预算继承宿主默认（冻结，防运行期篡改）。 */
export const NATIVE_DELEGATE_DESCRIPTOR: EngineDescriptor = freezeDescriptor({
  id: NATIVE_DELEGATE_ID,
  kind: 'both',
  tier: 'native',
  caps: { news: true },
  cost: { keysRequired: 0, quotaHint: 'unknown' },
  latencyBudgetMs: 8000,
})

/** 可注入的委托句柄集合：search/fetch 任一缺席即该能力不可用。 */
export interface NativeDelegates {
  readonly search?: SeamWebSearchProvider['search']
  readonly fetch?: SeamWebFetchProvider['fetch']
}

/** 原生委托引擎适配器。 */
export class NativeDelegateEngine extends BaseEngine {
  /** 最近一次委托转发的纯转发耗时（毫秒，不含解析）；尚未转发过为 0。 */
  lastForwardMs = 0

  private readonly delegates: NativeDelegates | undefined

  constructor(
    descriptor: EngineDescriptor = NATIVE_DELEGATE_DESCRIPTOR,
    delegates?: NativeDelegates,
  ) {
    super(descriptor)
    // exactOptionalPropertyTypes：仅在确实提供时保存，保持缺席语义清晰。
    if (delegates !== undefined) this.delegates = delegates
  }

  /** 委托是否可用（廉价同步判断；健康与否仍以真实调用错误为准）。 */
  get delegateAvailable(): boolean {
    return this.delegates?.search !== undefined
  }

  /**
   * 搜索：有委托则计时包裹转发 seam（SeamWebSearchRequest={query,maxResults}），
   * sources[] 映射为 NormalizedHit（title 缺席回落 url，W-B-93 最小字段集）；
   * 无委托在统一包装内抛 unrepresentable（non-retryable），attempt 照记。
   */
  async search(req: EngineSearchRequest): Promise<EngineSearchResponse> {
    return await this.runSearch(req, async () => {
      const delegate = this.delegates?.search
      if (delegate === undefined) {
        throw engineError('unrepresentable', 'native provider unavailable', {
          engineId: this.descriptor.id,
        })
      }
      const startedAt = Date.now()
      const result = await delegate({ query: req.query, maxResults: req.count }, req.signal)
      this.lastForwardMs = Math.max(0, Date.now() - startedAt)
      return result.sources.map(source => ({
        url: source.url,
        title: source.title ?? source.url,
        ...(source.snippet === undefined ? {} : { snippet: source.snippet }),
        ...(source.publishedAt === undefined ? {} : { publishedAt: source.publishedAt }),
        provenance: { engine: NATIVE_DELEGATE_ID },
      }))
    })
  }
}
