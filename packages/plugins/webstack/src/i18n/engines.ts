/**
 * 引擎状态双语提示文案（W-B-79 双语全覆盖 / W-B-53 键即白名单）：键集 =
 * `webstack.engine.<engineId>.<status>`。用于 attempts/warnings 回显与设置面
 * 徽标——只允许 i18n 键引用，禁止自由文本拼接（防注入）。zh/en 键集奇偶一致
 * 性由 tests/engines-engine.test.ts 锁死。
 * @module webstack/i18n/engines
 */

/** 引擎状态提示键的封闭 union（新增键 = 先加 zh，en 缺失直接红）。 */
export type EngineStatusKey =
  | 'webstack.engine.ddg.disabled'
  | 'webstack.engine.ddg.degraded'
  | 'webstack.engine.bing-lite.disabled'
  | 'webstack.engine.bing-lite.degraded'
  | 'webstack.engine.searxng.misconfigured'
  | 'webstack.engine.searxng.offline'
  | 'webstack.engine.native.unavailable'

/** 中文状态提示。 */
export const engineMessagesZh: Readonly<Record<EngineStatusKey, string>> = Object.freeze({
  'webstack.engine.ddg.disabled': 'DuckDuckGo 引擎已被禁用，可在设置中重新开启。',
  'webstack.engine.ddg.degraded': 'DuckDuckGo 暂时不可用（免费端点波动），已自动改用备用引擎。',
  'webstack.engine.bing-lite.disabled': 'Bing 轻通道已被禁用，可在设置中重新开启。',
  'webstack.engine.bing-lite.degraded':
    'Bing 轻通道暂时不可用（RSS 端点波动），已自动改用备用引擎。',
  'webstack.engine.searxng.misconfigured': 'SearXNG 实例地址未配置或格式有误，请检查自托管设置。',
  'webstack.engine.searxng.offline': 'SearXNG 实例当前无法访问，请确认实例在线后重试。',
  'webstack.engine.native.unavailable': '宿主内置搜索暂不可用，已自动回退到 WebStack 免费池。',
})

/** English status copy. */
export const engineMessagesEn: Readonly<Record<EngineStatusKey, string>> = Object.freeze({
  'webstack.engine.ddg.disabled': 'The DuckDuckGo engine is disabled; re-enable it in settings.',
  'webstack.engine.ddg.degraded':
    'DuckDuckGo is temporarily unavailable (free endpoint flapping); a fallback engine was used automatically.',
  'webstack.engine.bing-lite.disabled':
    'The Bing lite channel is disabled; re-enable it in settings.',
  'webstack.engine.bing-lite.degraded':
    'The Bing lite channel is temporarily unavailable (RSS endpoint flapping); a fallback engine was used automatically.',
  'webstack.engine.searxng.misconfigured':
    'The SearXNG instance URL is missing or malformed; check your self-hosted settings.',
  'webstack.engine.searxng.offline':
    'The SearXNG instance is unreachable right now; verify it is online and retry.',
  'webstack.engine.native.unavailable':
    'The built-in host search is unavailable; fell back to the WebStack free pool automatically.',
})
