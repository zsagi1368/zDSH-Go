/**
 * Tavily keyed 引擎适配器（tier=keyed，单密钥 Bearer 鉴权）。
 *
 * 端点协议（POST https://api.tavily.com/search）：
 * - 请求体 {query, max_results, days?(freshness 直映天数)}；
 * - 响应 results[]{title,url,content,published_date}。
 *
 * 载荷收窄遵循 W-B-52「不信任任何响应形状」：解析器为纯函数 parseTavilyJson，
 * url/title 收窄失败或为空即跳该条；published_date 仅接受 ISO-8601 形态，
 * 其余一律缺席（不猜测、不改写）。出站必经安全管道 outboundFetch（ddg 同款
 * 动态探测）；POST 方法语义经 pool.HTTP_POST_BRIDGED 单点桥接。
 *
 * @module webstack/engines/tavily
 */

import { narrowArray, narrowRecord, narrowString } from '../fetch/narrowing.ts'
import { engineError } from '../kernel/errors.ts'
import type {
  EngineDescriptor,
  EngineSearchRequest,
  EngineSearchResponse,
  NormalizedHit,
} from '../kernel/types.ts'
import {
  attachPostBody,
  BaseEngine,
  freezeDescriptor,
  keyedHttpStatusError,
  type OutboundRequest,
  requireCredential,
} from './engine.ts'
import { HTTP_POST_BRIDGED, isoTimestampOrUndefined } from './pool.ts'

export const TAVILY_ENGINE_ID = 'tavily'

/** 凭据槽位名：请求级 credentials 通道与本引擎约定的字段键。 */
export const TAVILY_CRED_SLOT = 'tavilyKey'

/** 端点基址（POST JSON 体语义）。 */
const TAVILY_ENDPOINT = 'https://api.tavily.com/search'

/** G4 有界响应体上限：JSON 结果集适中，1MB 封顶。 */
export const TAVILY_MAX_BYTES = 1_000_000

/** 静态名片：keyed 档单密钥（冻结，防运行期篡改）。 */
export const TAVILY_DESCRIPTOR: EngineDescriptor = freezeDescriptor({
  id: TAVILY_ENGINE_ID,
  kind: 'search',
  tier: 'keyed',
  caps: { freshness: true },
  cost: { keysRequired: 1, quotaHint: 'paid' },
  latencyBudgetMs: 4000,
})

/** freshness 软提示 → Tavily days 天数直映表。 */
const FRESHNESS_TO_DAYS = { day: 1, week: 7, month: 30, year: 365 } as const

/**
 * 组装请求体：max_results=count；freshness 存在时直映 days（缺席不带键）。
 */
export function buildTavilyPayload(
  query: string,
  count: number,
  freshness?: EngineSearchRequest['hints']['freshness'],
): Record<string, unknown> {
  const days = freshness === undefined ? undefined : FRESHNESS_TO_DAYS[freshness]
  return {
    query,
    max_results: Math.max(0, count),
    ...(days === undefined ? {} : { days }),
  }
}

/**
 * Tavily JSON 载荷解析器（纯函数，离线可测）：
 * - 根与每条 result 均按记录收窄；results 缺席/非数组视为零结果（非错误）；
 * - title 与 url 必须 narrowString 后非空（空串即缺席），任一缺失 → 整条跳过；
 * - content → snippet（空串保持缺席）；published_date 仅接受 ISO-8601 形态；
 * - 截断至 count 条。
 */
export function parseTavilyJson(value: unknown, count: number): NormalizedHit[] {
  const root = narrowRecord(value)
  if (root === undefined) return []
  const hits: NormalizedHit[] = []
  for (const entry of narrowArray(root.results)) {
    if (hits.length >= count) break
    const record = narrowRecord(entry)
    if (record === undefined) continue
    const url = narrowString(record.url)
    const title = narrowString(record.title)
    if (url === undefined || title === undefined) continue
    const snippet = narrowString(record.content)
    const publishedAt = isoTimestampOrUndefined(record.published_date)
    hits.push({
      url,
      title,
      ...(publishedAt === undefined ? {} : { publishedAt }),
      ...(snippet === undefined ? {} : { snippet }),
      provenance: { engine: TAVILY_ENGINE_ID },
    })
  }
  return hits.slice(0, Math.max(0, count))
}

/** Tavily keyed 引擎适配器。 */
export class TavilyEngine extends BaseEngine {
  constructor(descriptor: EngineDescriptor = TAVILY_DESCRIPTOR) {
    super(descriptor)
  }

  /** 搜索：缺密钥即 auth（不打网）；出站必经安全管道；JSON 解析失败转 narrow-failed。 */
  async search(req: EngineSearchRequest): Promise<EngineSearchResponse> {
    return await this.runSearch(req, async () => {
      const apiKey = requireCredential(req, this.descriptor.id, TAVILY_CRED_SLOT)
      const { outboundFetch, parseJsonLoose } = await this.pipeline()
      const outboundReq: OutboundRequest = {
        url: TAVILY_ENDPOINT,
        method: HTTP_POST_BRIDGED,
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        ...(req.signal !== undefined ? { signal: req.signal } : {}),
        timeoutMs: this.descriptor.latencyBudgetMs,
        maxBytes: TAVILY_MAX_BYTES,
      }
      attachPostBody(outboundReq, buildTavilyPayload(req.query, req.count, req.hints.freshness))
      const response = await outboundFetch(outboundReq)
      if (response.status >= 400) {
        throw keyedHttpStatusError(this.descriptor.id, response.status, response.headers)
      }
      const parsed = parseJsonLoose(await response.text())
      if (!parsed.ok) {
        throw engineError('narrow-failed', parsed.reason, { engineId: this.descriptor.id })
      }
      return parseTavilyJson(parsed.value, req.count)
    })
  }
}
