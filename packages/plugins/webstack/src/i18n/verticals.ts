/**
 * 垂直频道/站选规则双语提示文案（W-B-79 双语全覆盖 / W-B-53 键即白名单）。
 * 键集 = `webstack.verticals.*`，供垂直卫星包（实验性）与站选选择器规则的
 * attempts/warnings 回显与设置面引用——只允许 i18n 键，禁止自由文本拼接。
 * zh/en 键集奇偶一致性由 tests/fetch-selectors.test.ts 与 i18n 合并表锁死。
 * @module webstack/i18n/verticals
 */

/** 垂直频道与站选规则提示键的封闭 union（新增键 = 先加 zh，en 缺失直接红）。 */
export type VerticalsI18nKey =
  | 'webstack.verticals.disabled-notice'
  | 'webstack.verticals.enabled-notice'
  | 'webstack.verticals.x.degraded-oembed'
  | 'webstack.verticals.x.no-results'
  | 'webstack.verticals.x.search-leg-failed'
  | 'webstack.verticals.selectors.applied'
  | 'webstack.verticals.selectors.fallback'
  | 'webstack.verticals.selectors.truncated'

/** 中文提示文案。 */
export const verticalsMessagesZh: Readonly<Record<VerticalsI18nKey, string>> = Object.freeze({
  'webstack.verticals.disabled-notice':
    '垂直频道为实验性能力且默认关闭；如需启用，请在设置中显式开启对应频道。',
  'webstack.verticals.enabled-notice':
    '垂直频道已开启：本次结果中带「via」标注的条目来自垂直降级链。',
  'webstack.verticals.x.degraded-oembed':
    '该推文经免费池 site: 检索命中后，又通过官方 oEmbed 公开端点富化了摘要。',
  'webstack.verticals.x.no-results': 'X 垂直频道两条腿均未取得结果，已静默返回空列表。',
  'webstack.verticals.x.search-leg-failed':
    'X 垂直频道的 site: 检索腿失败，本次跳过该频道并回退常规引擎。',
  'webstack.verticals.selectors.applied': '目标站命中站选规则，正文按自定义 CSS 选择器抽取。',
  'webstack.verticals.selectors.fallback': '站选规则未命中或抽取为空，已回落默认抓取管线。',
  'webstack.verticals.selectors.truncated': '站选规则抽取结果超出预算上限，已被截断。',
})

/** English copy. */
export const verticalsMessagesEn: Readonly<Record<VerticalsI18nKey, string>> = Object.freeze({
  'webstack.verticals.disabled-notice':
    'Vertical channels are experimental and off by default; enable them explicitly in settings.',
  'webstack.verticals.enabled-notice':
    'A vertical channel is enabled: entries carrying a "via" mark came from the vertical fallback chain.',
  'webstack.verticals.x.degraded-oembed':
    'This tweet was matched via free-pool site: search, then enriched through the official oEmbed endpoint.',
  'webstack.verticals.x.no-results':
    'Both legs of the X vertical channel produced nothing; an empty list was returned silently.',
  'webstack.verticals.x.search-leg-failed':
    'The site: search leg of the X vertical failed; the channel was skipped this round and regular engines took over.',
  'webstack.verticals.selectors.applied':
    'The target host matched a selector rule; content was extracted with the custom CSS selectors.',
  'webstack.verticals.selectors.fallback':
    'No selector rule matched or extraction was empty; fell back to the default fetch pipeline.',
  'webstack.verticals.selectors.truncated':
    'Selector-extracted content exceeded its budget and was truncated.',
})

/** 取垂直频道提示文案；未知 locale 安全回落中文。 */
export function verticalsText(key: VerticalsI18nKey, locale: 'zh' | 'en' = 'zh'): string {
  return locale === 'en' ? verticalsMessagesEn[key] : verticalsMessagesZh[key]
}
