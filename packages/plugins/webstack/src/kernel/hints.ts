/**
 * 确定性意图提取（W-B-15）：纯正则双语词表从 query 提取 SearchHints。
 * 无网络、无 LLM、无状态——同一输入永远得到同一输出（可缓存键维度的前提）。
 *
 * 提取规则（冻结）：
 * - `site:` 操作符 → `hard.siteFilter`，并从 topic 中剔除该片段；
 *   片段原文同时进入 `hard[]`（未结构化强制约束清单）；
 * - 时效词 → 软新鲜度 `freshness`（day > week > month > year 优先级判定，
 *   命中即止），命中词原文进入 `soft[]`；软偏好只对 caps.news 引擎生效；
 * - 中文字符占比 > 30% → `locale: 'zh'`，否则 `'en'`；
 * - 双引号短语（半角 `"…"` 与全角「“…”」）视为必须满足的硬片段，进
 *   `hard[]`（保留在 topic 内——它们仍是搜索词）。
 *
 * @module webstack/kernel/hints
 */

import type { SearchHints } from './types.ts'

/** `site:` 操作符：值取到首个空白为止（host 后缀语义由消费方校验）。 */
const SITE_OPERATOR = /\bsite:(\S+)/gi

/** 半角双引号短语。 */
const QUOTED_PHRASE = /"([^"]+)"/g

/** 全角弯引号短语（中文输入法常见形态）。 */
const QUOTED_PHRASE_CJK = /[“”]([^“”]+)[“”]/g

/** 中文（CJK 统一表意文字基本区）字符。 */
const CJK_CHAR = /[\u4e00-\u9fff]/

/** 时效窗口闭集（与 SearchHints.freshness 同形，本地窄化避免 undefined 渗入）。 */
type FreshnessWindow = NonNullable<SearchHints['freshness']>

/** 时效词表：优先级从高到低，同查询多词命中时取最高档（day 最先）。 */
const FRESHNESS_WORDS: readonly {
  readonly window: FreshnessWindow
  readonly words: readonly string[]
}[] = [
  { window: 'day', words: ['今天', '最新', '刚刚', 'latest', 'today'] },
  { window: 'week', words: ['本周', '这周', 'week'] },
  { window: 'month', words: ['本月', 'month'] },
  { window: 'year', words: ['今年', 'year'] },
]

/** 判定时效窗口：按 day→week→month→year 顺序找首个命中的词；全不中为 undefined。 */
function matchFreshness(
  query: string,
): { readonly window: FreshnessWindow; readonly word: string } | undefined {
  const lower = query.toLowerCase()
  for (const tier of FRESHNESS_WORDS) {
    for (const word of tier.words) {
      if (lower.includes(word)) {
        return { window: tier.window, word }
      }
    }
  }
  return undefined
}

/** 中文字符占比（去空白后分母）；>0.3 视为中文语境。 */
export function chineseRatio(query: string): number {
  const compact = [...query.replace(/\s+/g, '')]
  if (compact.length === 0) return 0
  const zh = compact.filter(ch => CJK_CHAR.test(ch)).length
  return zh / compact.length
}

/**
 * 从 query 提取确定性搜索意图。
 *
 * @param query 原始查询串（原样保留在调用方；本函数不改写它）。
 * @returns SearchHints：可选字段仅在确实存在时出现（exactOptionalPropertyTypes
 *   纪律），`hard`/`soft` 恒为数组（可能为空）。
 */
export function extractHints(query: string): SearchHints {
  const hard: string[] = []
  const soft: string[] = []

  // ---- site: 操作符 → siteFilter + hard[]，并从主题词中剔除 ---------------
  let siteFilter: string | undefined
  let topic = query.replace(SITE_OPERATOR, (_full, value: string) => {
    const host = value.trim()
    if (host === '') return ''
    siteFilter = host.toLowerCase()
    hard.push(`site:${host}`)
    return ''
  })

  // ---- 引号短语 → hard[]（保留在主题词内，仍是搜索词）---------------------
  for (const re of [QUOTED_PHRASE, QUOTED_PHRASE_CJK]) {
    re.lastIndex = 0
    for (;;) {
      const m = re.exec(query)
      if (m === null) break
      const phrase = m[1]?.trim() ?? ''
      if (phrase !== '') hard.push(phrase)
    }
  }

  // ---- 时效词 → 软新鲜度 + soft[] -----------------------------------------
  const freshnessHit = matchFreshness(query)
  if (freshnessHit !== undefined) {
    soft.push(freshnessHit.word)
  }

  // ---- 归并主题词：压缩剔除操作符后的空白 ---------------------------------
  topic = topic.replace(/\s{2,}/g, ' ').trim()

  // ---- 语言提示 ------------------------------------------------------------
  const locale = chineseRatio(query) > 0.3 ? 'zh' : 'en'

  // exactOptionalPropertyTypes：只在确实存在时携带可选字段。
  return {
    ...(topic === '' ? {} : { topic }),
    ...(freshnessHit === undefined ? {} : { freshness: freshnessHit.window }),
    ...(siteFilter === undefined ? {} : { siteFilter }),
    locale,
    hard,
    soft,
  }
}
