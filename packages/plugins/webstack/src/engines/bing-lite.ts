/**
 * Bing lite 端点适配器（免费池第二腿；「lite」= 轻量解析而非完整 API）。
 *
 * 走 `https://www.bing.com/search?...&format=rss` 的 RSS 轻通道：响应是
 * 小体积 XML，用非贪婪正则逐 `<item>` 抽取 title/link/pubDate/description，
 * 不引入任何 XML 库（零依赖纪律）。`pubDate` 尽力转 ISO-8601，失败缺席
 * （契约不变量：缺失字段保持缺失，不编造占位值）。
 *
 * @module webstack/engines/bing-lite
 */

import { engineError } from '../kernel/errors.ts'
import type {
  EngineDescriptor,
  EngineSearchRequest,
  EngineSearchResponse,
  NormalizedHit,
} from '../kernel/types.ts'
import {
  BaseEngine,
  decodeHtmlEntities,
  freezeDescriptor,
  stripHtmlToText,
  unwrapCdata,
} from './engine.ts'

export const BING_LITE_ENGINE_ID = 'bing-lite'

/** RSS 轻通道端点基址。 */
const BING_RSS_ENDPOINT = 'https://www.bing.com/search'

/** G4 有界响应体上限：RSS 体量小，1MB 已远超需要。 */
export const BING_LITE_MAX_BYTES = 1_000_000

/** 静态名片：免费池尽力而为层（冻结，防运行期篡改）。 */
export const BING_LITE_DESCRIPTOR: EngineDescriptor = freezeDescriptor({
  id: BING_LITE_ENGINE_ID,
  kind: 'search',
  tier: 'free',
  caps: { news: true, locale: true },
  cost: { keysRequired: 0, quotaHint: 'unknown' },
  latencyBudgetMs: 4000,
})

/**
 * 组装 Bing RSS 查询串。`site:` 硬约束以预编码形态（`+site%3A<host>`）拼进
 * q 参数；count 直接映射 RSS 的 count 参数。
 */
export function buildBingLiteUrl(query: string, count: number, siteFilter?: string): string {
  const enc = encodeURIComponent(query)
  const site = siteFilter !== undefined ? `+site%3A${encodeURIComponent(siteFilter)}` : ''
  return `${BING_RSS_ENDPOINT}?q=${enc}${site}&format=rss&count=${count}`
}

/**
 * Bing RSS 解析器（纯函数，离线可测）：
 * - 非贪婪正则逐 `<item>...</item>` 抽取四个子节点；
 * - link 为空/缺席 → 坏行跳过；title 缺席回落 url；
 * - pubDate 经 Date.parse 转 ISO-8601，解析失败 → publishedAt 缺席；
 * - description 容错缺席；空 snippet 保持缺席不编造；
 * - 截断至 count 条；零条目返回空数组（不是错误）。
 */
export function parseBingRss(xml: string, count: number): NormalizedHit[] {
  const hits: NormalizedHit[] = []
  const itemRe = /<item>([\s\S]*?)<\/item>/gi
  for (;;) {
    const itemMatch = itemRe.exec(xml)
    if (itemMatch === null || hits.length >= count) break
    const item = itemMatch[1] ?? ''
    // RSS 里的 URL 会把 & 转义为 &amp;——解码还原真实地址（非规范化改写）。
    const url = decodeHtmlEntities(nodeText(item, 'link'))
    if (url === '') continue // 无链接的坏行（广告位/占位项），跳过不致命
    const rawTitle = unwrapCdata(nodeText(item, 'title'))
    const title = stripHtmlToText(rawTitle)
    const rawDescription = stripHtmlToText(unwrapCdata(nodeText(item, 'description')))
    const publishedAt = toIso8601(nodeText(item, 'pubDate'))
    hits.push({
      url,
      title: title === '' ? url : title,
      ...(publishedAt === undefined ? {} : { publishedAt }),
      ...(rawDescription === '' ? {} : { snippet: rawDescription }),
      provenance: { engine: BING_LITE_ENGINE_ID },
    })
  }
  return hits.slice(0, Math.max(0, count))
}

/** 抽取 XML 节点首个出现的文本内容（非贪婪 + CDATA 兼容）；缺席返回空串。 */
function nodeText(fragment: string, tag: string): string {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i')
  const m = re.exec(fragment)
  return (m === null ? '' : (m[1] ?? '')).trim()
}

/**
 * RFC-822 形态时间戳 → ISO-8601。任何解析失败（NaN/空）一律 undefined，
 * 由调用方保持字段缺席。
 */
function toIso8601(raw: string): string | undefined {
  if (raw === '') return undefined
  const ms = Date.parse(raw)
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString()
}

/** Bing RSS 免费池引擎适配器。 */
export class BingLiteEngine extends BaseEngine {
  constructor(descriptor: EngineDescriptor = BING_LITE_DESCRIPTOR) {
    super(descriptor)
  }

  /** 搜索：出站必经安全管道（未接线抛统一 transport 错），RSS 解析容错坏行。 */
  async search(req: EngineSearchRequest): Promise<EngineSearchResponse> {
    return await this.runSearch(req, async () => {
      const { outboundFetch } = await this.pipeline()
      const response = await outboundFetch({
        url: buildBingLiteUrl(req.query, req.count, req.hints.siteFilter),
        method: 'GET',
        ...(req.signal !== undefined ? { signal: req.signal } : {}),
        timeoutMs: this.descriptor.latencyBudgetMs,
        maxBytes: BING_LITE_MAX_BYTES,
      })
      if (response.status >= 400) {
        throw engineError(
          response.status === 429 ? 'rate-limited' : 'http-upstream',
          `bing-lite upstream status ${response.status}`,
          { engineId: this.descriptor.id, httpStatus: response.status },
        )
      }
      return parseBingRss(await response.text(), req.count)
    })
  }
}
