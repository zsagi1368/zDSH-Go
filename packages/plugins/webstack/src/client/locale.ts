/**
 * 客户端双语字典（zh / en）。键奇偶一致由类型 `Record<Key, string>`
 * 静态保证，运行时再由 tests/client-ui.test.tsx 复核一遍。
 *
 * @module webstack/client/locale
 */

import type {} from '@deepseek-ai/dsh-client-ui-slots'

/** 设置卡字典命名空间（settings.plugin.item 条目声明 locale 用）。 */
export const CARD_NS = 'webstack.card'
/** 联网模式按钮字典命名空间（conversation.input.left 条目声明 locale 用）。 */
export const TOGGLE_NS = 'webstack.toggle'

export const CARD_KEYS = [
  'title',
  'subtitle',
  'readOnlyBadge',
  'degradedNotice',
  'fieldEnabled',
  'fieldLayer',
  'fieldMaxResults',
  'fieldAutoFallback',
  'fieldFusionEnabled',
  'fieldHalfLife',
  'fieldAuthority',
  'fieldDiversity',
  'fieldMaxContentChars',
  'fieldSsrfExempts',
  'ssrfHint',
  'valueOn',
  'valueOff',
  'actionSave',
  'actionDiscard',
  'phaseClean',
  'phaseDirty',
  'phaseInvalid',
  'phaseSaving',
  'phaseFailed',
  'errMaxResults',
  'errHalfLife',
  'errAuthority',
  'errDiversity',
  'errMaxContentChars',
  'errSsrfLine',
  'errLayer',
] as const

export type CardKey = (typeof CARD_KEYS)[number]

export const cardZh: Record<CardKey, string> = {
  title: '网栈（WebStack）',
  subtitle: '聚合搜索与抓取内核的运行参数；改动经暂存草稿统一保存。',
  readOnlyBadge: '只读',
  degradedNotice:
    '当前宿主未暴露可写的设置通道（或偏好为进程内记忆模式），此处仅展示生效值；修改请使用配置档（webstack 段）。',
  fieldEnabled: '总开关',
  fieldLayer: '默认路由层',
  fieldMaxResults: '结果条数上限',
  fieldAutoFallback: '候选展开',
  fieldFusionEnabled: '多引擎融合',
  fieldHalfLife: '时效半衰期（小时）',
  fieldAuthority: '权威域加成',
  fieldDiversity: '同域折价系数',
  fieldMaxContentChars: '抓取字符上限',
  fieldSsrfExempts: 'SSRF 豁免清单',
  ssrfHint: '每行一条 host:port，例如 example.com:8443。',
  valueOn: '开启',
  valueOff: '关闭',
  actionSave: '保存',
  actionDiscard: '放弃改动',
  phaseClean: '已同步',
  phaseDirty: '有未保存改动',
  phaseInvalid: '存在校验错误',
  phaseSaving: '正在保存…',
  phaseFailed: '上次保存失败',
  errMaxResults: '结果条数须为 1–50 的整数。',
  errHalfLife: '时效半衰期须为 1–8760 的整数小时。',
  errAuthority: '权威域加成须在 0–10 之间。',
  errDiversity: '同域折价系数须在 0–1 之间。',
  errMaxContentChars: '抓取字符上限须为 200–8000000 的整数。',
  errSsrfLine: '豁免清单每行须为 host:port 格式（端口 1–65535）。',
  errLayer: '路由层取值不合法。',
}

export const cardEn: Record<CardKey, string> = {
  title: 'WebStack',
  subtitle:
    'Runtime parameters of the aggregated search and fetch kernel; edits save via a staged draft.',
  readOnlyBadge: 'Read-only',
  degradedNotice:
    'The host exposes no writable settings channel (or preferences are process-local memory mode). This card shows the effective values only; edit the webstack section of the config profile instead.',
  fieldEnabled: 'Master switch',
  fieldLayer: 'Default routing layer',
  fieldMaxResults: 'Result cap',
  fieldAutoFallback: 'Candidate expansion',
  fieldFusionEnabled: 'Multi-engine fusion',
  fieldHalfLife: 'Recency half-life (hours)',
  fieldAuthority: 'Authority boost',
  fieldDiversity: 'Same-domain discount',
  fieldMaxContentChars: 'Fetch character cap',
  fieldSsrfExempts: 'SSRF exemptions',
  ssrfHint: 'One host:port per line, e.g. example.com:8443.',
  valueOn: 'on',
  valueOff: 'off',
  actionSave: 'Save',
  actionDiscard: 'Discard changes',
  phaseClean: 'In sync',
  phaseDirty: 'Unsaved changes',
  phaseInvalid: 'Validation errors',
  phaseSaving: 'Saving…',
  phaseFailed: 'Last save failed',
  errMaxResults: 'Result cap must be an integer between 1 and 50.',
  errHalfLife: 'Recency half-life must be an integer between 1 and 8760 hours.',
  errAuthority: 'Authority boost must be within 0-10.',
  errDiversity: 'Same-domain discount must be within 0-1.',
  errMaxContentChars: 'Fetch character cap must be an integer between 200 and 8000000.',
  errSsrfLine: 'Each exemption line must be host:port (port 1-65535).',
  errLayer: 'Unknown routing layer value.',
}

export const TOGGLE_KEYS = [
  'toggleLabel',
  'modeOff',
  'modeOn',
  'modeAsk',
  'tipOff',
  'tipOn',
  'tipAsk',
  'tipLocalOnly',
] as const

export type ToggleKey = (typeof TOGGLE_KEYS)[number]

export const toggleZh: Record<ToggleKey, string> = {
  toggleLabel: '联网',
  modeOff: '关',
  modeOn: '开',
  modeAsk: '询问',
  tipOff: '联网已关闭：点击切换为始终联网。',
  tipOn: '始终联网：点击切换为每次询问。',
  tipAsk: '每次询问：点击关闭联网。',
  tipLocalOnly: '当前会话本地生效；宿主写入通道不可用。',
}

export const toggleEn: Record<ToggleKey, string> = {
  toggleLabel: 'Web',
  modeOff: 'off',
  modeOn: 'on',
  modeAsk: 'ask',
  tipOff: 'Web access is off; click to switch to always-on.',
  tipOn: 'Always-on web access; click to switch to ask-every-time.',
  tipAsk: 'Asks every time; click to turn web access off.',
  tipLocalOnly: 'Effective for this session locally; the host write channel is unavailable.',
}

// 命名空间并入框架字典表：register 站点据此获得类型化的 t 座席，
// LocaleDictOf<N> 让缺键/多键在编译期报错。
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'webstack.card': CardKey
    'webstack.toggle': ToggleKey
  }
}
