/**
 * 抓取安全/状态双语提示文案（W-B-79 双语全覆盖）：键集 =
 * `webstack.fetch.<scene>`，用于抓取管线对非 2xx 响应与空正文的「带解释
 * 上呈」（F-004：content 绝不静默为空）。zh/en 键集奇偶一致性由
 * tests/fetch-pipeline.test.ts 锁死。
 * @module webstack/i18n/fetch-safety
 */

import type { SsrfRejectReason } from '../kernel/types.ts'

/** 抓取管线提示键的封闭 union（新增键 = 先加 zh，en 缺失直接红）。 */
export type FetchSafetyKey = 'webstack.fetch.status-prefix' | 'webstack.fetch.empty-fallback'

/** 语言闭包（与 src/i18n/index.ts 的 Locale 同形；就地声明避免反向依赖）。 */
type Locale = 'zh' | 'en'

/** 中文提示文案。`%s` 为 HTTP 状态码占位符。 */
export const fetchMessagesZh: Readonly<Record<FetchSafetyKey, string>> = Object.freeze({
  'webstack.fetch.status-prefix': '[HTTP %s] 目标站返回了非 2xx 状态，以下为其原始响应内容',
  'webstack.fetch.empty-fallback':
    '目标站没有返回可抽取的正文内容。请直接打开链接查看原文，或稍后重试。',
})

/** English copy. `%s` is the HTTP status placeholder. */
export const fetchMessagesEn: Readonly<Record<FetchSafetyKey, string>> = Object.freeze({
  'webstack.fetch.status-prefix':
    '[HTTP %s] The target site returned a non-2xx status; its raw response content follows.',
  'webstack.fetch.empty-fallback':
    'The target site returned no extractable content. Open the link directly or retry later.',
})

/** 取抓取管线提示文案；未知 locale 安全回落中文。 */
export function fetchSafetyText(key: FetchSafetyKey, locale: Locale = 'zh'): string {
  return locale === 'en' ? fetchMessagesEn[key] : fetchMessagesZh[key]
}

/**
 * 组装非 2xx 状态前缀行：把 `status-prefix` 模板中的首个 `%s` 替换为真实
 * 状态码。只替换一次，模板其余字面量原样保留（防注入式重复替换）。
 */
export function formatStatusPrefix(status: number, locale: Locale = 'zh'): string {
  return fetchSafetyText('webstack.fetch.status-prefix', locale).replace('%s', String(status))
}

// ---------------------------------------------------------------------------
// SSRF 安全拒绝文案（webstack.safety.blocked.*）
// ---------------------------------------------------------------------------

/**
 * SSRF 拒绝原因双语处置文本（W-B-44/79）：「发生了什么 + 用户能做什么」。
 * 键集 = `webstack.safety.blocked.<reason-family>`，与 `SsrfRejectReason`
 * 的 G1 三项（scheme/userinfo/port）+ G2 四族（loopback/private/
 * link-local/reserved）对应；link-local 并入 reserved 键（同为「非公网
 * 保留段」的用户语义）。zh/en 键集奇偶一致性由 tests/safety-ssrf.test.ts 锁死。
 */

/** 安全拒绝文案键闭集。 */
export type FetchSafetyBlockedKey =
  | 'webstack.safety.blocked.scheme'
  | 'webstack.safety.blocked.userinfo'
  | 'webstack.safety.blocked.port'
  | 'webstack.safety.blocked.private'
  | 'webstack.safety.blocked.loopback'
  | 'webstack.safety.blocked.reserved'

/** 中文处置文案。 */
export const fetchSafetyBlockedZh: Readonly<Record<FetchSafetyBlockedKey, string>> = Object.freeze({
  'webstack.safety.blocked.scheme':
    '目标协议不被允许（仅支持 http/https）。请改用普通网页链接后重试。',
  'webstack.safety.blocked.userinfo':
    '链接中包含用户名密码段（user:pass@）。请去掉凭据信息后再试。',
  'webstack.safety.blocked.port':
    '目标端口被安全策略禁止（数据库/远程服务等高危端口）。请确认目标地址是否正确。',
  'webstack.safety.blocked.loopback': '目标是本机回环地址，已被保护性拦截。请使用公网地址。',
  'webstack.safety.blocked.private':
    '目标是私有内网地址，已被保护性拦截。如需访问自托管服务，请在配置中添加豁免。',
  'webstack.safety.blocked.reserved': '目标是保留/非公网网段，已被保护性拦截。请使用公网地址重试。',
})

/** English resolution copy. */
export const fetchSafetyBlockedEn: Readonly<Record<FetchSafetyBlockedKey, string>> = Object.freeze({
  'webstack.safety.blocked.scheme':
    'The target protocol is not allowed (only http/https). Retry with a regular web link.',
  'webstack.safety.blocked.userinfo':
    'The link embeds username/password (user:pass@). Remove the credentials and retry.',
  'webstack.safety.blocked.port':
    'The target port is forbidden by safety policy (database/remote-service ports). Verify the target address.',
  'webstack.safety.blocked.loopback':
    'The target is a loopback address and was protectively blocked. Use a public address.',
  'webstack.safety.blocked.private':
    'The target is a private intranet address and was protectively blocked. To reach a self-hosted service, add an exemption in settings.',
  'webstack.safety.blocked.reserved':
    'The target is a reserved/non-public range and was protectively blocked. Retry with a public address.',
})

/**
 * 拒绝原因码 → 文案键映射：G2 网段四族各归其位；link-local 归 reserved；
 * redirect/body 类原因不在本分册语义内，安全回落 reserved 键。
 */
export function fetchSafetyBlockedKey(reason: SsrfRejectReason): FetchSafetyBlockedKey {
  switch (reason) {
    case 'scheme-disallowed':
      return 'webstack.safety.blocked.scheme'
    case 'userinfo-present':
      return 'webstack.safety.blocked.userinfo'
    case 'nonstandard-port':
      return 'webstack.safety.blocked.port'
    case 'loopback':
      return 'webstack.safety.blocked.loopback'
    case 'private-range':
      return 'webstack.safety.blocked.private'
    default:
      // link-local / reserved-range / redirect-* / body-over-bound 统一按保留段语义呈现。
      return 'webstack.safety.blocked.reserved'
  }
}
