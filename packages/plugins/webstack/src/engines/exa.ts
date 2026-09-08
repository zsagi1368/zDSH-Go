/**
 * Exa keyed 引擎适配器（tier=keyed，x-api-key 鉴权）。
 *
 * 端点协议（POST https://api.exa.ai/search）：
 * - 请求体 {query, numResults}；
 * - 鉴权经 `x-api-key` 请求头下发（密钥绝不进 URL，W-B-55）；
 * - 响应 results[]{title,url,text,publishedDate}。
 *
 * 载荷收窄遵循 W-B-52「不信任任何响应形状」：解析器为纯函数 parseExaJson，
 * url/title 收窄失败或为空即跳该条；publishedDate 仅接受 ISO-8601 形态。
 * 出站必经安全管道 outboundFetch（ddg 同款动态探测）；POST 方法语义经
 * pool.HTTP_POST_BRIDGED 单点桥接。
 *
 * @module webstack/engines/exa
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

export const EXA_ENGINE_ID = 'exa'

/** 凭据槽位名：请求级 credentials 通道与本引擎约定的字段键。 */
export const EXA_CRED_SLOT = 'exaKey'

/** 端点源基址（官方默认；实际请求端点 = `<baseUrl>/search`）。 */
export const EXA_ENDPOINT = 'https://api.exa.ai'

/** 搜索路径段（POST JSON 体语义）。 */
const EXA_SEARCH_PATH = '/search'

/**
 * 解析 Exa 搜索端点（纯函数）：缺省回官方 `https://api.exa.ai/search`；
 * 第三方 exa-compatible shim 可经构造选项注入自定义 baseUrl 覆盖源
 * （F-204 消费侧），尾部斜杠归一化后统一拼接 `/search`。
 */
export function resolveExaEndpoint(baseUrl?: string): string {
  const trimmed = baseUrl?.trim()
  const origin =
    trimmed !== undefined && trimmed !== '' ? `${trimmed.replace(/\/+$/, '')}` : EXA_ENDPOINT
  return `${origin}${EXA_SEARCH_PATH}`
}

/** G4 有界响应体上限：JSON 结果集适中，1MB 封顶。 */
export const EXA_MAX_BYTES = 1_000_000

/** 静态名片：keyed 档单密钥（冻结，防运行期篡改）。 */
export const EXA_DESCRIPTOR: EngineDescriptor = freezeDescriptor({
  id: EXA_ENGINE_ID,
  kind: 'search',
  tier: 'keyed',
  caps: {},
  cost: { keysRequired: 1, quotaHint: 'paid' },
  latencyBudgetMs: 4000,
})

/**
 * 组装请求体：numResults=count（负数钳为 0，交上游自然空回）。
 */
export function buildExaPayload(query: string, count: number): Record<string, unknown> {
  return { query, numResults: Math.max(0, count) }
}

/**
 * Exa JSON 载荷解析器（纯函数，离线可测）：
 * - 根与每条 result 均按记录收窄；results 缺席/非数组视为零结果（非错误）；
 * - title 与 url 必须 narrowString 后非空，任一缺失 → 整条跳过；
 * - text → snippet；publishedDate 仅接受 ISO-8601 形态；
 * - 截断至 count 条。
 */
export function parseExaJson(value: unknown, count: number): NormalizedHit[] {
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
    const snippet = narrowString(record.text)
    const publishedAt = isoTimestampOrUndefined(record.publishedDate)
    hits.push({
      url,
      title,
      ...(publishedAt === undefined ? {} : { publishedAt }),
      ...(snippet === undefined ? {} : { snippet }),
      provenance: { engine: EXA_ENGINE_ID },
    })
  }
  return hits.slice(0, Math.max(0, count))
}

/** Exa keyed 引擎适配器。 */
export class ExaEngine extends BaseEngine {
  /** 覆盖端点源（构造选项注入；undefined = 官方默认）。 */
  private readonly baseUrl: string | undefined

  constructor(
    descriptor: EngineDescriptor = EXA_DESCRIPTOR,
    options?: { readonly baseUrl?: string },
  ) {
    super(descriptor)
    this.baseUrl = options?.baseUrl
  }

  /** 搜索：缺密钥即 auth（不打网）；出站必经安全管道；JSON 解析失败转 narrow-failed。 */
  async search(req: EngineSearchRequest): Promise<EngineSearchResponse> {
    return await this.runSearch(req, async () => {
      const apiKey = requireCredential(req, this.descriptor.id, EXA_CRED_SLOT)
      const { outboundFetch, parseJsonLoose } = await this.pipeline()
      const outboundReq: OutboundRequest = {
        url: resolveExaEndpoint(this.baseUrl),
        method: HTTP_POST_BRIDGED,
        headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
        ...(req.signal !== undefined ? { signal: req.signal } : {}),
        timeoutMs: this.descriptor.latencyBudgetMs,
        maxBytes: EXA_MAX_BYTES,
      }
      attachPostBody(outboundReq, buildExaPayload(req.query, req.count))
      const response = await outboundFetch(outboundReq)
      if (response.status >= 400) {
        throw keyedHttpStatusError(this.descriptor.id, response.status, response.headers)
      }
      const parsed = parseJsonLoose(await response.text())
      if (!parsed.ok) {
        throw engineError('narrow-failed', parsed.reason, { engineId: this.descriptor.id })
      }
      return parseExaJson(parsed.value, req.count)
    })
  }
}
