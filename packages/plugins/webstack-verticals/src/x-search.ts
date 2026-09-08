/**
 * 合规版免凭据 X（Twitter）检索降级链（实验性频道，默认关闭）。
 *
 * 两腿结构：
 * - 腿 1（发现）：经 `deps.search` 免费池回调跑
 *   `site:x.com OR site:twitter.com <topic>`，取得结果列表。本腿只消费
 *   公开搜索引擎的公开输出，不登录、不绕墙。
 * - 腿 2（富化）：对其中 `/status/<id>` 形态的推文 URL 逐个调用**官方公开**
 *   oEmbed 端点 `https://publish.twitter.com/oembed`（GET，
 *   `omit_script=true&dnt=true`；出站经注入的 outboundFetch——与内核
 *   outboundFetch 动态探测同款手法：缺席/非函数视为未接线，静默跳过），
 *   用返回 html 的纯文本形态富化 snippet 并记 `provenance.via = 'oembed'`。
 *
 * 治理纪律：
 * - 单飞防重：同主题并发 run 共享同一次执行（in-flight Map）；
 * - 每 URL 一次会话内缓存：oEmbed 成败结果均缓存，会话内不重复出站；
 * - 两腿全失败返回空数组不抛错；成功路径每条结果如实带 via 标注（W-B-17）
 *   与 i18n note 键（W-B-53 键即白名单）。
 *
 * @module dsh-webstack-verticals/x-search
 */

import {
  freezeDeep,
  type NormalizedHit,
  type OutboundFetchLike,
  type SearchHints,
  type VerticalChannel,
  type VerticalDeps,
  type VerticalDescriptor,
  type VerticalSearchRequest,
} from './framework.ts'

export const X_VERTICAL_ID = 'x-vertical'

/** 频道名片：免费档、零凭据、caps.vertical（深冻结防运行期篡改）。 */
export const X_VERTICAL_DESCRIPTOR: VerticalDescriptor = freezeDeep({
  id: X_VERTICAL_ID,
  kind: 'search',
  tier: 'free',
  caps: { vertical: true },
  cost: { keysRequired: 0, quotaHint: 'unknown' },
  latencyBudgetMs: 6000,
})

// ---------------------------------------------------------------------------
// URL 形态判定（纯正则，离线可测）
// ---------------------------------------------------------------------------

/**
 * 推文 URL 形态：scheme 可选 http(s)；host 容忍 www./mobile. 前缀；
 * 路径必须为 `<handle>/status|statuses/<纯数字 id>`。其余一律非推文。
 */
const TWEET_URL_RE =
  // (zDSH-go: [A-Za-z] collapsed under the /i flag — the repo's sonarjs
  // duplicates-in-character-class gate rejects the overlap.)
  /^https?:\/\/(?:(?:www|mobile)\.)?(?:x\.com|twitter\.com)\/[a-z0-9_]{1,20}\/status(?:es)?\/\d+(?:[?#]|$)/i

/** 判定 url 是否推文形态（/status/<id>）。 */
export function isTweetUrl(url: string): boolean {
  return TWEET_URL_RE.test(url.trim())
}

/**
 * 从候选列表抽取推文 URL：保序去重。W-B-35 纪律——url 保留首见原样，
 * 不做任何规范化改写（带查询串的变体是不同字符串，身份归一只发生在
 * 缓存指纹内部）；此处仅对完全相同的字符串按首见保留。
 */
export function extractTweetUrls(urls: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of urls) {
    const url = raw.trim()
    if (!isTweetUrl(url) || seen.has(url)) continue
    seen.add(url)
    out.push(url)
  }
  return out
}

/** 组装腿 1 的 site: 限域双站 OR 查询（硬约束片段直拼 query，ddg 同款语义）。 */
export function buildXSearchQuery(topic: string): string {
  return `site:x.com OR site:twitter.com ${topic}`
}

// ---------------------------------------------------------------------------
// 官方 oEmbed 端点（GET，公开、免凭据、dnt）
// ---------------------------------------------------------------------------

/** X 官方公开 oEmbed 端点基址。 */
export const OEMBED_ENDPOINT = 'https://publish.twitter.com/oembed'

/** G4 有界响应体上限：oEmbed JSON 极小，256KB 封顶。 */
export const OEMBED_MAX_BYTES = 262_144

/**
 * 组装官方 oEmbed GET URL：url 参数整体百分号编码；omit_script/dnt 固定 true
 * （消费端自渲染、不做跟踪加载）。
 */
export function buildOembedUrl(tweetUrl: string): string {
  return `${OEMBED_ENDPOINT}?url=${encodeURIComponent(tweetUrl)}&omit_script=true&dnt=true`
}

// ---------------------------------------------------------------------------
// 本地收窄与文本工具（narrowing/engine 同款语义的最小本地像，零依赖）
// ---------------------------------------------------------------------------

/** 安全收窄 unknown → 字符串记录。 */
function narrowRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

/** 安全收窄 unknown → 非空 string（空白串按缺失处理）。 */
function narrowNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * 噪声块（script/style）整块剔除正则。在实体解码**前后各跑一遍**：前扫剥
 * 原生块，后扫兜住 `&lt;script&gt;…&lt;/script&gt;` 单遍解码即还原的混淆
 * 形态（与 webstack extract.stripNoise 同纪律；全局标志配 String.replace
 * 每次调用重置，无 lastIndex 状态泄漏）。
 */
const NOISE_BLOCK_RE = /<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi

/**
 * 白名单实体单遍解码 + 去标签 → 纯文本（engine.stripHtmlToText 同款语义）。
 * W10 审计加固：script/style 整块内容体剥离——oEmbed html 即便来自官方端点，
 * 也按不可信输入处理，仅剔标签会把 `<script>` 的 JS 源码文本漏进 snippet。
 */
function stripHtmlToText(fragment: string): string {
  const denoised = fragment.replace(NOISE_BLOCK_RE, ' ')
  const decoded = denoised.replace(/&(amp|lt|gt|quot|#x27);/g, (_, name: string) => {
    switch (name) {
      case 'amp':
        return '&'
      case 'lt':
        return '<'
      case 'gt':
        return '>'
      case 'quot':
        return '"'
      default:
        return "'"
    }
  })
  return decoded
    .replace(NOISE_BLOCK_RE, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 解析 oEmbed JSON 文本；任何异常返回 undefined（数据不是错误 W-B-46）。 */
function parseOembedJson(text: string): Record<string, unknown> | undefined {
  try {
    return narrowRecord(JSON.parse(text))
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------

/** 富化成功后的 provenance.note 键（i18n 键引用，禁止自由文本 W-B-53）。 */
export const X_OEMBED_NOTE_KEY = 'webstack.verticals.x.degraded-oembed' as const

/** 腿 1 直通（未经 oEmbed 富化）结果的 via 标注。 */
export const VIA_SITE_SEARCH = 'site-search' as const

/** 腿 2 富化结果的 via 标注（任务契约字面值）。 */
export const VIA_OEMBED = 'oembed' as const

/**
 * X 垂直频道（id `x-vertical`）。实例持有两级状态：
 * - `inflight`：主题级单飞锁（并发 run 共享同一 Promise，结算后释放）；
 * - `oembedCache`：URL → 富化文本缓存（空串 = 会话内已失败的终局标记，
 *   不再重试——「每 URL 一次」的会话纪律）。
 * 两级状态均为实例级会话生命周期，随装配层销毁一并丢弃。
 */
export class XVerticalChannel implements VerticalChannel {
  readonly id = X_VERTICAL_ID

  private readonly inflight = new Map<string, Promise<NormalizedHit[]>>()
  private readonly oembedCache = new Map<string, string>()

  /**
   * canHandle 判定矩阵（确定性、不打网）：
   * - hints.siteFilter 落在 x.com/twitter.com 及其子域 → 出手；
   * - hard/soft 片段含显式 `site:` 限域或站点指称（x.com/twitter.com）→ 出手；
   * - 其余（含空 hints）→ 不出手，交常规引擎。
   */
  canHandle(hints: SearchHints): boolean {
    const siteFilter = hints.siteFilter?.toLowerCase().replace(/\.+$/, '')
    if (
      siteFilter === 'x.com' ||
      siteFilter === 'twitter.com' ||
      (siteFilter?.endsWith('.x.com') ?? false) ||
      (siteFilter?.endsWith('.twitter.com') ?? false)
    ) {
      return true
    }
    const corpus = [...hints.hard, ...hints.soft].join(' ')
    return /(?:^|\s)(?:site:)?(?:www\.)?(?:x|twitter)\.com(?:\s|$)/i.test(` ${corpus} `)
  }

  /** 单飞入口：同主题并发共享一次执行；失败路径同样释放锁。 */
  run(req: VerticalSearchRequest, deps: VerticalDeps): Promise<NormalizedHit[]> {
    const topic =
      req.hints.topic !== undefined && req.hints.topic !== '' ? req.hints.topic : req.query
    const existing = this.inflight.get(topic)
    if (existing !== undefined) return existing
    const job = this.runOnce(req, topic, deps).finally(() => {
      this.inflight.delete(topic)
    })
    this.inflight.set(topic, job)
    return job
  }

  // -------------------------------------------------------------------------
  // 内部机制
  // -------------------------------------------------------------------------

  /** 全链执行：任一环节异常一律收敛为空数组（两腿全失败静默语义）。 */
  private async runOnce(
    req: VerticalSearchRequest,
    topic: string,
    deps: VerticalDeps,
  ): Promise<NormalizedHit[]> {
    try {
      const legOne = await deps.search({
        query: buildXSearchQuery(topic),
        hints: { ...req.hints, topic },
        count: req.count,
        ...(req.signal !== undefined ? { signal: req.signal } : {}),
      })
      const outbound = typeof deps.outboundFetch === 'function' ? deps.outboundFetch : undefined
      const seen = new Set<string>()
      const out: NormalizedHit[] = []
      for (const hit of legOne) {
        if (out.length >= Math.max(0, req.count)) break
        if (seen.has(hit.url)) continue // 保序去重（W-B-20 同款姿态）
        seen.add(hit.url)
        out.push(await this.enrich(hit, outbound))
      }
      return out
    } catch {
      return []
    }
  }

  /** 单条结果富化：推文 + 出站可用才走腿 2；否则如实标注 site-search 直通。 */
  private async enrich(
    hit: NormalizedHit,
    outbound: OutboundFetchLike | undefined,
  ): Promise<NormalizedHit> {
    if (outbound === undefined || !isTweetUrl(hit.url)) return this.relabel(hit, VIA_SITE_SEARCH)
    let text = this.oembedCache.get(hit.url)
    if (text === undefined) {
      text = await this.fetchOembedText(outbound, hit.url)
      this.oembedCache.set(hit.url, text)
    }
    if (text === '') return this.relabel(hit, VIA_SITE_SEARCH)
    return {
      ...hit,
      snippet: text,
      provenance: { ...hit.provenance, via: VIA_OEMBED, note: X_OEMBED_NOTE_KEY },
    }
  }

  /**
   * 调官方 oEmbed 端点并取纯文本：仅接受 2xx + 可解析 JSON + html 字段；
   * 非 2xx 是「数据」（如实降级），管道故障是异常但在此吞掉换空串。
   */
  private async fetchOembedText(outbound: OutboundFetchLike, tweetUrl: string): Promise<string> {
    try {
      const res = await outbound({
        url: buildOembedUrl(tweetUrl),
        timeoutMs: X_VERTICAL_DESCRIPTOR.latencyBudgetMs,
        maxBytes: OEMBED_MAX_BYTES,
      })
      if (res.status < 200 || res.status >= 300) return ''
      const record = parseOembedJson(await res.text())
      if (record === undefined) return ''
      const html = narrowNonEmptyString(record['html'])
      if (html === undefined) return ''
      return stripHtmlToText(html)
    } catch {
      return ''
    }
  }

  /** via 重标注：engine 缺失时兜底为本频道 id（W-B-16 出处可解释性）。 */
  private relabel(hit: NormalizedHit, via: string): NormalizedHit {
    const engine = hit.provenance.engine !== '' ? hit.provenance.engine : X_VERTICAL_ID
    return { ...hit, provenance: { ...hit.provenance, engine, via } }
  }
}
