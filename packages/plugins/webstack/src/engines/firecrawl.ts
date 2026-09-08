/**
 * Firecrawl keyed 引擎适配器（tier=keyed，Bearer 鉴权）。
 *
 * 端点协议（POST https://api.firecrawl.dev/v1/search）：
 * - 请求体 {query, limit}；
 * - 鉴权经 `Authorization: Bearer` 请求头下发（密钥绝不进 URL，W-B-55）；
 * - 响应 data[]{title,url,description}。
 *
 * 抓取型上游延迟波动大，latencyBudgetMs 放宽至 8000、响应体上限给足 2MB。
 * 载荷收窄遵循 W-B-52「不信任任何响应形状」：解析器为纯函数
 * parseFirecrawlJson，url/title 收窄失败或为空即跳该条。出站必经安全管道
 * outboundFetch；POST 方法语义经 pool.HTTP_POST_BRIDGED 单点桥接。
 *
 * @module webstack/engines/firecrawl
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
import { HTTP_POST_BRIDGED } from './pool.ts'

export const FIRECRAWL_ENGINE_ID = 'firecrawl'

/** 凭据槽位名：请求级 credentials 通道与本引擎约定的字段键。 */
export const FIRECRAWL_CRED_SLOT = 'firecrawlKey'

/** 端点基址（POST JSON 体语义）。 */
const FIRECRAWL_ENDPOINT = 'https://api.firecrawl.dev/v1/search'

/** G4 有界响应体上限：抓取型结果可能携带正文片段，2MB 封顶。 */
export const FIRECRAWL_MAX_BYTES = 2_000_000

/** 静态名片：keyed 档单密钥；抓取型上游延迟预算放宽（冻结，防运行期篡改）。 */
export const FIRECRAWL_DESCRIPTOR: EngineDescriptor = freezeDescriptor({
  id: FIRECRAWL_ENGINE_ID,
  kind: 'search',
  tier: 'keyed',
  caps: {},
  cost: { keysRequired: 1, quotaHint: 'paid' },
  latencyBudgetMs: 8000,
})

/**
 * 组装请求体：limit=count（负数钳为 0）。
 */
export function buildFirecrawlPayload(query: string, count: number): Record<string, unknown> {
  return { query, limit: Math.max(0, count) }
}

/**
 * Firecrawl JSON 载荷解析器（纯函数，离线可测）：
 * - 根与每条条目均按记录收窄；data 缺席/非数组视为零结果（非错误）；
 *   上游的 success/error 元数据键不参与解析（失败经 HTTP 状态/错误映射表达）；
 * - title 与 url 必须 narrowString 后非空，任一缺失 → 整条跳过；
 * - description → snippet（空串保持缺席）；
 * - 截断至 count 条。
 */
export function parseFirecrawlJson(value: unknown, count: number): NormalizedHit[] {
  const root = narrowRecord(value)
  if (root === undefined) return []
  const hits: NormalizedHit[] = []
  for (const entry of narrowArray(root.data)) {
    if (hits.length >= count) break
    const record = narrowRecord(entry)
    if (record === undefined) continue
    const url = narrowString(record.url)
    const title = narrowString(record.title)
    if (url === undefined || title === undefined) continue
    const snippet = narrowString(record.description)
    hits.push({
      url,
      title,
      ...(snippet === undefined ? {} : { snippet }),
      provenance: { engine: FIRECRAWL_ENGINE_ID },
    })
  }
  return hits.slice(0, Math.max(0, count))
}

/** Firecrawl keyed 引擎适配器。 */
export class FirecrawlEngine extends BaseEngine {
  constructor(descriptor: EngineDescriptor = FIRECRAWL_DESCRIPTOR) {
    super(descriptor)
  }

  /** 搜索：缺密钥即 auth（不打网）；出站必经安全管道；JSON 解析失败转 narrow-failed。 */
  async search(req: EngineSearchRequest): Promise<EngineSearchResponse> {
    return await this.runSearch(req, async () => {
      const apiKey = requireCredential(req, this.descriptor.id, FIRECRAWL_CRED_SLOT)
      const { outboundFetch, parseJsonLoose } = await this.pipeline()
      const outboundReq: OutboundRequest = {
        url: FIRECRAWL_ENDPOINT,
        method: HTTP_POST_BRIDGED,
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        ...(req.signal !== undefined ? { signal: req.signal } : {}),
        timeoutMs: this.descriptor.latencyBudgetMs,
        maxBytes: FIRECRAWL_MAX_BYTES,
      }
      attachPostBody(outboundReq, buildFirecrawlPayload(req.query, req.count))
      const response = await outboundFetch(outboundReq)
      if (response.status >= 400) {
        throw keyedHttpStatusError(this.descriptor.id, response.status, response.headers)
      }
      const parsed = parseJsonLoose(await response.text())
      if (!parsed.ok) {
        throw engineError('narrow-failed', parsed.reason, { engineId: this.descriptor.id })
      }
      return parseFirecrawlJson(parsed.value, req.count)
    })
  }
}
