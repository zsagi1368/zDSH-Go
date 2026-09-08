/**
 * keyed 引擎状态双语提示文案（W-B-79 双语全覆盖 / W-B-53 键即白名单）：键集 =
 * `webstack.engine.<engineId>.<status>`。六家 keyed 引擎各一条「缺密钥」处置
 * 提示，供 attempts/warnings 回显与设置面徽标引用——只允许 i18n 键引用，
 * 禁止自由文本拼接（防注入）。zh/en 键集奇偶一致性由 tests/engines-keyed.test.ts
 * 锁死。
 * @module webstack/i18n/keyed-engines
 */

/** keyed 引擎状态提示键的封闭 union（新增键 = 先加 zh，en 缺失直接红）。 */
export type KeyedEngineStatusKey =
  | 'webstack.engine.tavily.no-key'
  | 'webstack.engine.brave.no-key'
  | 'webstack.engine.exa.no-key'
  | 'webstack.engine.jina.no-key'
  | 'webstack.engine.firecrawl.no-key'
  | 'webstack.engine.anysearch.no-key'

/** 中文状态提示。 */
export const keyedEngineMessagesZh: Readonly<Record<KeyedEngineStatusKey, string>> = Object.freeze({
  'webstack.engine.tavily.no-key': 'Tavily 尚未配置 API 密钥，请在设置中填入 tavilyKey 后重试。',
  'webstack.engine.brave.no-key': 'Brave 搜索尚未配置订阅令牌，请在设置中填入 braveKey 后重试。',
  'webstack.engine.exa.no-key': 'Exa 尚未配置 API 密钥，请在设置中填入 exaKey 后重试。',
  'webstack.engine.jina.no-key': 'Jina 搜索尚未配置 API 密钥，请在设置中填入 jinaKey 后重试。',
  'webstack.engine.firecrawl.no-key':
    'Firecrawl 尚未配置 API 密钥，请在设置中填入 firecrawlKey 后重试。',
  'webstack.engine.anysearch.no-key':
    'AnySearch 尚未配置 API 密钥，请在设置中填入 anysearchKey 后重试。',
})

/** English status copy. */
export const keyedEngineMessagesEn: Readonly<Record<KeyedEngineStatusKey, string>> = Object.freeze({
  'webstack.engine.tavily.no-key':
    'Tavily has no API key configured; set tavilyKey in settings and retry.',
  'webstack.engine.brave.no-key':
    'Brave Search has no subscription token configured; set braveKey in settings and retry.',
  'webstack.engine.exa.no-key': 'Exa has no API key configured; set exaKey in settings and retry.',
  'webstack.engine.jina.no-key':
    'Jina Search has no API key configured; set jinaKey in settings and retry.',
  'webstack.engine.firecrawl.no-key':
    'Firecrawl has no API key configured; set firecrawlKey in settings and retry.',
  'webstack.engine.anysearch.no-key':
    'AnySearch has no API key configured; set anysearchKey in settings and retry.',
})
