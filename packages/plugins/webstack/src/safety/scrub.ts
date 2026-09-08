/**
 * 输出边界统一脱敏 scrubber（W-B-56 / W-A-03 反制）：URL userinfo 与敏感
 * query 参数在一切日志、错误文本、诊断输出之前过滤。
 *
 * 两套占位符语义：`redactUrl`（遗留，`[REDACTED]`）用于结构化 URL 字段的
 * 强替换；`scrubUrl`/`scrubText`（`***`）用于自由文本的轻量遮蔽——二者共用
 * 同一套敏感键黑名单与 userinfo 剥除规则。scrubber 自身绝不允许成为新的
 * 故障点：解析失败一律安全占位而非抛错。
 * @module webstack/safety/scrub
 */

/** 敏感 query 键黑名单（小写比较；命中即整值替换为占位符）。 */
export const SENSITIVE_QUERY_KEYS = [
  'api_key',
  'apikey',
  'access_token',
  'token',
  'key',
  'secret',
  'password',
  'sig',
  'signature',
] as const

const REDACTED = '[REDACTED]'
const SCRUB_PLACEHOLDER = '***'

/** 自由文本中的 http(s) URL 字形；排除常见包裹符避免吞掉句子标点。 */
const URL_IN_TEXT = /(https?:\/\/[^\s<>"')\]]+)/gi

/** 敏感 query 键 → 文本级遮蔽模式（动态派生自黑名单，单一事实源）。 */
const QUERY_PAIR = new RegExp(`([?&](?:${SENSITIVE_QUERY_KEYS.join('|')})=)[^\\s&"'<>]+`, 'gi')

/** 共享脱敏核心：剥 userinfo + 遮蔽敏感 query 值；失败返回安全占位。 */
function maskUrl(rawUrl: string, placeholder: string): string {
  try {
    const parsed = new URL(rawUrl)
    if (parsed.username !== '' || parsed.password !== '') {
      parsed.username = placeholder
      parsed.password = ''
    }
    for (const key of [...parsed.searchParams.keys()]) {
      if ((SENSITIVE_QUERY_KEYS as readonly string[]).includes(key.toLowerCase())) {
        parsed.searchParams.set(key, placeholder)
      }
    }
    return String(parsed)
  } catch {
    return REDACTED
  }
}

/**
 * 脱敏 URL：遮蔽黑名单 query 值、剥除 userinfo 段。解析失败时返回占位符
 * 而非抛错——scrubber 自身绝不允许成为新的故障点。
 */
export function redactUrl(rawUrl: string): string {
  return maskUrl(rawUrl, REDACTED)
}

/**
 * 脱敏 URL（`***` 占位变体）：与 redactUrl 同规则，供自由文本通道使用，
 * 保证同一 URL 在结构化与文本两条输出边界上泄露面一致。
 */
export function scrubUrl(url: string): string {
  return maskUrl(url, SCRUB_PLACEHOLDER)
}

/**
 * 脱敏自由文本：先对文本中出现的每个 http(s) URL 应用 scrubUrl 规则
 * （userinfo 与敏感 query 值替换为 `***`），再兜底扫描裸 `?key=value`
 * 形态的敏感参数对——覆盖错误消息里被截断的非完整 URL。
 */
export function scrubText(text: string): string {
  return text
    .replace(URL_IN_TEXT, match => maskUrl(match, SCRUB_PLACEHOLDER))
    .replace(QUERY_PAIR, '$1***')
}
