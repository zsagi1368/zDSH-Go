/**
 * Brave Search keyed 引擎适配器（tier=keyed，X-Subscription-Token 鉴权）。
 *
 * 端点协议（GET https://api.search.brave.com/res/v1/web/search）：
 * - 查询串 q=<query>、可选 count、freshness（day/week/month/year → pd/pw/pm/py）；
 * - 鉴权经 `X-Subscription-Token` 请求头下发（密钥绝不进 URL，W-B-55）；
 * - 响应 web.results[]{title,url,description,age}。
 *
 * 载荷收窄遵循 W-B-52「不信任任何响应形状」：解析器为纯函数 parseBraveJson，
 * url/title 收窄失败或为空即跳该条；age 仅接受 ISO-8601 形态（相对时间文案
 * 一律缺席），出站必经安全管道 outboundFetch（ddg 同款动态探测）。
 *
 * @module webstack/engines/brave
 */

import { narrowArray, narrowRecord, narrowString } from '../fetch/narrowing.ts'
import { engineError } from '../kernel/errors.ts'
import type {
  EngineDescriptor,
  EngineSearchRequest,
  EngineSearchResponse,
  NormalizedHit,
} from '../kernel/types.ts'
import { BaseEngine, freezeDescriptor, keyedHttpStatusError, requireCredential } from './engine.ts'
import { isoTimestampOrUndefined } from './pool.ts'

export const BRAVE_ENGINE_ID = 'brave'

/** 凭据槽位名：请求级 credentials 通道与本引擎约定的字段键。 */
export const BRAVE_CRED_SLOT = 'braveKey'

/** 端点基址（GET 查询串语义）。 */
const BRAVE_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search'

/** G4 有界响应体上限：JSON 结果集适中，1MB 封顶。 */
export const BRAVE_MAX_BYTES = 1_000_000

/** 静态名片：keyed 档单密钥（冻结，防运行期篡改）。 */
export const BRAVE_DESCRIPTOR: EngineDescriptor = freezeDescriptor({
  id: BRAVE_ENGINE_ID,
  kind: 'search',
  tier: 'keyed',
  caps: { freshness: true },
  cost: { keysRequired: 1, quotaHint: 'paid' },
  latencyBudgetMs: 4000,
})

/** freshness 软提示 → Brave freshness 参数直映表。 */
const FRESHNESS_TO_PERIOD = { day: 'pd', week: 'pw', month: 'pm', year: 'py' } as const

/**
 * 组装查询串：q 编码；count/freshness 存在时才拼接（缺席不带键）。
 */
export function buildBraveUrl(
  query: string,
  opts: { count?: number; freshness?: EngineSearchRequest['hints']['freshness'] } = {},
): string {
  let url = `${BRAVE_ENDPOINT}?q=${encodeURIComponent(query)}`
  if (opts.count !== undefined) url += `&count=${Math.max(0, opts.count)}`
  if (opts.freshness !== undefined) {
    url += `&freshness=${FRESHNESS_TO_PERIOD[opts.freshness]}`
  }
  return url
}

/**
 * Brave JSON 载荷解析器（纯函数，离线可测）：
 * - 根.web 记录收窄；web 或 results 缺席/非数组视为零结果（非错误）；
 * - title 与 url 必须 narrowString 后非空，任一缺失 → 整条跳过；
 * - description → snippet；age 仅接受 ISO-8601 形态（相对时间一律缺席）；
 * - 截断至 count 条。
 */
export function parseBraveJson(value: unknown, count: number): NormalizedHit[] {
  const root = narrowRecord(value)
  if (root === undefined) return []
  const web = narrowRecord(root.web)
  if (web === undefined) return []
  const hits: NormalizedHit[] = []
  for (const entry of narrowArray(web.results)) {
    if (hits.length >= count) break
    const record = narrowRecord(entry)
    if (record === undefined) continue
    const url = narrowString(record.url)
    const title = narrowString(record.title)
    if (url === undefined || title === undefined) continue
    const snippet = narrowString(record.description)
    const publishedAt = isoTimestampOrUndefined(record.age)
    hits.push({
      url,
      title,
      ...(publishedAt === undefined ? {} : { publishedAt }),
      ...(snippet === undefined ? {} : { snippet }),
      provenance: { engine: BRAVE_ENGINE_ID },
    })
  }
  return hits.slice(0, Math.max(0, count))
}

/** Brave Search keyed 引擎适配器。 */
export class BraveEngine extends BaseEngine {
  constructor(descriptor: EngineDescriptor = BRAVE_DESCRIPTOR) {
    super(descriptor)
  }

  /** 搜索：缺密钥即 auth（不打网）；出站必经安全管道；JSON 解析失败转 narrow-failed。 */
  async search(req: EngineSearchRequest): Promise<EngineSearchResponse> {
    return await this.runSearch(req, async () => {
      const apiKey = requireCredential(req, this.descriptor.id, BRAVE_CRED_SLOT)
      const { outboundFetch, parseJsonLoose } = await this.pipeline()
      const response = await outboundFetch({
        url: buildBraveUrl(req.query, {
          count: req.count,
          ...(req.hints.freshness !== undefined ? { freshness: req.hints.freshness } : {}),
        }),
        method: 'GET',
        headers: { 'X-Subscription-Token': apiKey, Accept: 'application/json' },
        ...(req.signal !== undefined ? { signal: req.signal } : {}),
        timeoutMs: this.descriptor.latencyBudgetMs,
        maxBytes: BRAVE_MAX_BYTES,
      })
      if (response.status >= 400) {
        throw keyedHttpStatusError(this.descriptor.id, response.status, response.headers)
      }
      const parsed = parseJsonLoose(await response.text())
      if (!parsed.ok) {
        throw engineError('narrow-failed', parsed.reason, { engineId: this.descriptor.id })
      }
      return parseBraveJson(parsed.value, req.count)
    })
  }
}
