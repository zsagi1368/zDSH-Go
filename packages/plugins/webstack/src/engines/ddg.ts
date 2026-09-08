/**
 * DuckDuckGo HTML 端点适配器（免费池，零凭据开箱）。
 *
 * 走 `https://html.duckduckgo.com/html/` 的 GET 表单语义；结果链接是
 * `/l/?uddg=<编码原始 URL>` 跳转形态，解析期还原 uddg 参数得到真实地址。
 * W-B-35：还原后的 URL 保留「首见原样」，不做任何规范化改写。
 *
 * @module webstack/engines/ddg
 */

import { engineError } from '../kernel/errors.ts'
import type {
  EngineDescriptor,
  EngineSearchRequest,
  EngineSearchResponse,
  NormalizedHit,
} from '../kernel/types.ts'
import { BaseEngine, decodeHtmlEntities, freezeDescriptor, stripHtmlToText } from './engine.ts'

export const DDG_ENGINE_ID = 'ddg'

/** HTML 端点基址（GET 查询即表单提交）。 */
const DDG_HTML_ENDPOINT = 'https://html.duckduckgo.com/html/'

/** G4 有界响应体上限：HTML 端点页面较大，给足 2MB。 */
export const DDG_MAX_BYTES = 2_000_000

/** 静态名片：免费池尽力而为层（冻结，防运行期篡改）。 */
export const DDG_DESCRIPTOR: EngineDescriptor = freezeDescriptor({
  id: DDG_ENGINE_ID,
  kind: 'search',
  tier: 'free',
  caps: { locale: true, freshness: true },
  cost: { keysRequired: 0, quotaHint: 'unknown' },
  latencyBudgetMs: 4000,
})

/**
 * 组装 DDG HTML 端点查询串。`site:` 是硬约束片段，直接追加到 query 尾部
 * （hints.siteFilter 存在时），整体走 encodeURIComponent。
 */
export function buildDdgUrl(query: string, siteFilter?: string): string {
  const effective = siteFilter !== undefined ? `${query} site:${siteFilter}` : query
  return `${DDG_HTML_ENDPOINT}?q=${encodeURIComponent(effective)}`
}

/**
 * hints.locale → Accept-Language 头映射：zh*→zh-CN、en*→en-US、
 * auto/缺席→不带该头。返回 undefined 表示头缺席。
 */
export function ddgAcceptLanguage(locale?: string): string | undefined {
  if (locale === undefined) return undefined
  const lower = locale.toLowerCase()
  if (lower === 'auto') return undefined
  if (lower.startsWith('zh')) return 'zh-CN'
  if (lower.startsWith('en')) return 'en-US'
  return locale
}

/**
 * DuckDuckGo HTML 解析器（纯函数，离线可测）：
 * - 逐个 `<a href="...">` 匹配，href 含 `uddg=` 参数者视为结果链接；
 * - 还原 `decodeURIComponent(uddg)` 得到原始 URL（保留首见原样 W-B-35）；
 *   解码失败/为空 → 坏行跳过；
 * - 标题取锚文本（去标签 + 实体解码），空则回落 url；
 * - snippet 取第 i 个 `result__snippet` 块文本，缺失容错（保持缺席）；
 * - 截断至 count 条；零结果返回空数组（不是错误）。
 */
export function parseDdgHtml(html: string, count: number): NormalizedHit[] {
  const snippets = collectDdgSnippets(html)
  const hits: NormalizedHit[] = []
  const anchorRe = /<a\b[^>]*\bhref="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi
  for (;;) {
    const match = anchorRe.exec(html)
    if (match === null || hits.length >= count) break
    const rawHref = decodeHtmlEntities(match[1] ?? '')
    const uddg = extractUddg(rawHref)
    if (uddg === undefined) continue
    let url: string
    try {
      url = decodeURIComponent(uddg)
    } catch {
      continue // 百分号编码损坏的坏行，跳过不致命
    }
    if (url === '') continue
    const title = stripHtmlToText(match[2] ?? '')
    const snippet = snippets[hits.length]
    hits.push(
      snippet === undefined
        ? {
          url,
          title: title === '' ? url : title,
          provenance: { engine: DDG_ENGINE_ID },
        }
        : {
          url,
          title: title === '' ? url : title,
          ...(snippet === '' ? {} : { snippet }),
          provenance: { engine: DDG_ENGINE_ID },
        },
    )
  }
  return hits.slice(0, Math.max(0, count))
}

/** 从 href 中提取 `uddg=` 参数值；不含该参数或值为空则 undefined。 */
function extractUddg(href: string): string | undefined {
  const marker = href.toLowerCase().indexOf('uddg=')
  if (marker === -1) return undefined
  const rest = href.slice(marker + 'uddg='.length)
  const amp = rest.indexOf('&')
  const value = amp === -1 ? rest : rest.slice(0, amp)
  return value === '' ? undefined : value
}

/** 按出现顺序收集全部 result__snippet 块内文本（去标签 + 实体解码）。 */
function collectDdgSnippets(html: string): string[] {
  const out: string[] = []
  const re = /<a\b[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi
  for (;;) {
    const m = re.exec(html)
    if (m === null) break
    out.push(stripHtmlToText(m[1] ?? ''))
  }
  return out
}

/** DuckDuckGo 免费池引擎适配器。 */
export class DdgEngine extends BaseEngine {
  constructor(descriptor: EngineDescriptor = DDG_DESCRIPTOR) {
    super(descriptor)
  }

  /** 搜索：出站必经安全管道（未接线抛统一 transport 错），解析失败不致命。 */
  async search(req: EngineSearchRequest): Promise<EngineSearchResponse> {
    return await this.runSearch(req, async () => {
      const { outboundFetch } = await this.pipeline()
      const headers: Record<string, string> = {}
      const acceptLanguage = ddgAcceptLanguage(req.hints.locale)
      if (acceptLanguage !== undefined) headers['Accept-Language'] = acceptLanguage
      const response = await outboundFetch({
        url: buildDdgUrl(req.query, req.hints.siteFilter),
        method: 'GET',
        headers,
        ...(req.signal !== undefined ? { signal: req.signal } : {}),
        timeoutMs: this.descriptor.latencyBudgetMs,
        maxBytes: DDG_MAX_BYTES,
      })
      if (response.status >= 400) {
        throw engineError(
          response.status === 429 ? 'rate-limited' : 'http-upstream',
          `ddg upstream status ${response.status}`,
          { engineId: this.descriptor.id, httpStatus: response.status },
        )
      }
      const bodyText = await response.text()
      return parseDdgHtml(bodyText, req.count)
    })
  }
}
