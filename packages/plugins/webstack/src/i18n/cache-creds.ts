/**
 * 缓存 / 凭据 / 联网模式模块的用户可见文案（W-B/boost A-08 派生）：
 * 「发生了什么 + 用户能做什么」双语处方。键集以 `webstack.cache.*` /
 * `webstack.creds.*` / `webstack.mode.*` 为前缀；zh/en 键集奇偶一致性由
 * tests 断言锁死。文案只进 i18n 键，不拼自由文本（W-B-53 防注入）。
 *
 * @module webstack/i18n/cache-creds
 */

/** 本册全部文案键的闭集 union。 */
export type CacheCredsI18nKey =
  | 'webstack.creds.placeholder-detected'
  | 'webstack.creds.legacy-literal-migration'
  | 'webstack.creds.absent'
  | 'webstack.creds.rotated'
  | 'webstack.cache.cleared'
  | 'webstack.cache.persist-unavailable'
  | 'webstack.mode.off-hint'
  | 'webstack.mode.ask-hint'

/** 中文处置文案。 */
export const cacheCredsMessagesZh: Readonly<Record<CacheCredsI18nKey, string>> = Object.freeze({
  'webstack.creds.placeholder-detected':
    '检测到该引擎配置的是占位符密钥（示例值），已按未配置处理。请到设置中填入真实 API 密钥，或改用 credentialRef / 环境变量。',
  'webstack.creds.legacy-literal-migration':
    '该引擎仍在使用设置中的明文密钥（遗留方式）。建议迁移为 credentialRef 引用或环境变量，避免明文随配置导出泄露。',
  'webstack.creds.absent':
    '该引擎未配置任何凭据。三种途径任选其一：设置中填写 API 密钥；创建 credentialRef 引用；或设置环境变量 WEBSTACK_<引擎>_API_KEY。',
  'webstack.creds.rotated': '凭据已轮换，下一次操作将使用新密钥并自动切换缓存键。',
  'webstack.cache.cleared': '搜索缓存已清空（内存与持久层同步失效），下次查询将重新抓取。',
  'webstack.cache.persist-unavailable':
    '平台持久存储服务不可用，本次仅使用内存缓存（重启后不保留）。功能不受影响。',
  'webstack.mode.off-hint':
    '当前会话联网已关闭。需要实时信息时，可开启会话联网或在提问中显式要求搜索。',
  'webstack.mode.ask-hint': '当前会话联网为询问模式：每次需要联网前会先征求你的确认。',
})

/** English resolution copy. */
export const cacheCredsMessagesEn: Readonly<Record<CacheCredsI18nKey, string>> = Object.freeze({
  'webstack.creds.placeholder-detected':
    'A placeholder key (sample value) was detected for this engine and treated as unconfigured. Enter a real API key in settings, or switch to a credentialRef / environment variable.',
  'webstack.creds.legacy-literal-migration':
    "This engine still uses a plaintext key from settings (legacy style). Migrate to a credentialRef reference or an environment variable so secrets don't leak via config exports.",
  'webstack.creds.absent':
    'No credentials configured for this engine. Pick one: set the API key in settings, create a credentialRef reference, or export WEBSTACK_<ENGINE>_API_KEY.',
  'webstack.creds.rotated':
    'Credentials rotated; the next operation uses the new key and switches cache keys automatically.',
  'webstack.cache.cleared':
    'Search cache cleared (memory and persistent layer invalidated together); queries will be refetched.',
  'webstack.cache.persist-unavailable':
    'The platform storage service is unavailable; only in-memory caching is active this session (not kept across restarts). Functionality is unaffected.',
  'webstack.mode.off-hint':
    'Session online mode is off. Enable it or explicitly ask for a search when you need live information.',
  'webstack.mode.ask-hint':
    'Session online mode is set to ask: you will be prompted for confirmation before each web search.',
})

/** 取本册文案；未知 locale 安全回落中文（与 i18n/index 的 errorText 同约定）。 */
export function cacheCredsText(key: CacheCredsI18nKey, locale: 'zh' | 'en' = 'zh'): string {
  return locale === 'en' ? cacheCredsMessagesEn[key] : cacheCredsMessagesZh[key]
}
