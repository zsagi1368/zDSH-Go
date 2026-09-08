/**
 * AnySearch keyed 引擎适配器（tier=keyed，Bearer 鉴权）。
 *
 * 端点协议（POST https://api.anysearch.com/v1/search）：
 * - 请求体 {query, count}；
 * - 鉴权经 `Authorization: Bearer` 请求头下发（密钥绝不进 URL，W-B-55）；
 * - 响应 results[]{title,url,snippet,publishedAt}。
 *
 * 载荷收窄遵循 W-B-52「不信任任何响应形状」：解析器为纯函数
 * parseAnysearchJson，url/title 收窄失败或为空即跳该条；publishedAt 仅接受
 * ISO-8601 形态。出站必经安全管道 outboundFetch；POST 方法语义经
 * pool.HTTP_POST_BRIDGED 单点桥接。
 *
 * @module webstack/engines/anysearch
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

export const ANYSEARCH_ENGINE_ID = 'anysearch'

/** 凭据槽位名：请求级 credentials 通道与本引擎约定的字段键。 */
export const ANYSEARCH_CRED_SLOT = 'anysearchKey'

/** 端点基址（POST JSON 体语义）。 */
const ANYSEARCH_ENDPOINT = 'https://api.anysearch.com/v1/search'

/** G4 有界响应体上限：JSON 结果集适中，1MB 封顶。 */
export const ANYSEARCH_MAX_BYTES = 1_000_000

/** 静态名片：keyed 档单密钥（冻结，防运行期篡改）。 */
export const ANYSEARCH_DESCRIPTOR: EngineDescriptor = freezeDescriptor({
  id: ANYSEARCH_ENGINE_ID,
  kind: 'search',
  tier: 'keyed',
  caps: {},
  cost: { keysRequired: 1, quotaHint: 'paid' },
  latencyBudgetMs: 4000,
})

/**
 * 组装请求体：count 原样透传（负数钳为 0，交上游自然空回）。
 */
export function buildAnysearchPayload(query: string, count: number): Record<string, unknown> {
  return { query, count: Math.max(0, count) }
}

/**
 * AnySearch JSON 载荷解析器（纯函数，离线可测）：
 * - 根与每条 result 均按记录收窄；results 缺席/非数组视为零结果（非错误）；
 * - title 与 url 必须 narrowString 后非空，任一缺失 → 整条跳过；
 * - snippet 直用（空串保持缺席）；publishedAt 仅接受 ISO-8601 形态；
 * - 截断至 count 条。
 */
export function parseAnysearchJson(value: unknown, count: number): NormalizedHit[] {
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
    const snippet = narrowString(record.snippet)
    const publishedAt = isoTimestampOrUndefined(record.publishedAt)
    hits.push({
      url,
      title,
      ...(publishedAt === undefined ? {} : { publishedAt }),
      ...(snippet === undefined ? {} : { snippet }),
      provenance: { engine: ANYSEARCH_ENGINE_ID },
    })
  }
  return hits.slice(0, Math.max(0, count))
}

/** AnySearch keyed 引擎适配器。 */
export class AnysearchEngine extends BaseEngine {
  constructor(descriptor: EngineDescriptor = ANYSEARCH_DESCRIPTOR) {
    super(descriptor)
  }

  /** 搜索：缺密钥即 auth（不打网）；出站必经安全管道；JSON 解析失败转 narrow-failed。 */
  async search(req: EngineSearchRequest): Promise<EngineSearchResponse> {
    return await this.runSearch(req, async () => {
      const apiKey = requireCredential(req, this.descriptor.id, ANYSEARCH_CRED_SLOT)
      const { outboundFetch, parseJsonLoose } = await this.pipeline()
      const outboundReq: OutboundRequest = {
        url: ANYSEARCH_ENDPOINT,
        method: HTTP_POST_BRIDGED,
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        ...(req.signal !== undefined ? { signal: req.signal } : {}),
        timeoutMs: this.descriptor.latencyBudgetMs,
        maxBytes: ANYSEARCH_MAX_BYTES,
      }
      attachPostBody(outboundReq, buildAnysearchPayload(req.query, req.count))
      const response = await outboundFetch(outboundReq)
      if (response.status >= 400) {
        throw keyedHttpStatusError(this.descriptor.id, response.status, response.headers)
      }
      const parsed = parseJsonLoose(await response.text())
      if (!parsed.ok) {
        throw engineError('narrow-failed', parsed.reason, { engineId: this.descriptor.id })
      }
      return parseAnysearchJson(parsed.value, req.count)
    })
  }
}
