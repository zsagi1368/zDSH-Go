/**
 * 设置卡 staged-draft 五态状态机（纯逻辑，零框架依赖）。
 *
 * 五态：clean（草稿 == 已提交）/ dirty（有未保存且合法的改动）/
 * invalid（草稿未过校验）/ saving（写宿主进行中，编辑被闸门挡住）/
 * failed（最近一次写入失败，允许重试或回改）。迁移唯一入口是
 * {@link reduceDraft}；校验与宿主 section 的双向映射都是纯函数，
 * 便于表驱动测试穷举五态迁移全图。
 *
 * 字段集（与 src/settings/schema.ts DEFAULT_SETTINGS 对齐）：
 * enabled、layer、maxResults、autoFallback、fusion 三参
 * （timeDecayHalfLifeH / authorityBoost / diversityDiscount）、
 * maxContentChars、ssrfExempts 行编辑（textarea 每行一条 host:port）。
 * 引擎 apiKey / credentialRef 刻意不在字段集内——密钥永不进浏览器
 * 渲染树（见 settings-card.tsx 顶部说明）。
 *
 * @module webstack/client/draft-state
 */

import type { SearchLayer } from '../kernel/types.ts'

/** 状态机五态。 */
export type DraftPhase = 'clean' | 'dirty' | 'invalid' | 'saving' | 'failed'

/** 路由层合法字面值（与 kernel/types.ts SearchLayer 一致，此处本地镜像避免类型耦合）。 */
export const LAYERS = ['native', 'free', 'api', 'selfhosted', 'mcp'] as const

/** 设置卡的扁平可编辑形状。 */
export interface WebstackSettingsShape {
  enabled: boolean
  layer: SearchLayer
  autoFallback: boolean
  maxResults: number
  fusionEnabled: boolean
  /** 时效半衰期（小时），整数 ≥1。 */
  timeDecayHalfLifeH: number
  /** 权威域加成系数，0–10。 */
  authorityBoost: number
  /** 同域重复折价系数，0–1。 */
  diversityDiscount: number
  /** 抓取渲染字符上限，整数 [200, 8_000_000]（8 MiB 封顶）。 */
  maxContentChars: number
  /** SSRF G2 豁免行编辑缓冲：每行一条 host:port。 */
  ssrfExemptsText: string
}

/** 一次不可变状态快照：当前相 + 草稿 + 已提交基线。 */
export interface DraftState {
  phase: DraftPhase
  draft: WebstackSettingsShape
  committed: WebstackSettingsShape
}

/** 校验问题（field 为形状键，message 为 locale 键）。 */
export interface DraftIssue {
  field: keyof WebstackSettingsShape
  message:
    | 'errMaxResults'
    | 'errHalfLife'
    | 'errAuthority'
    | 'errDiversity'
    | 'errMaxContentChars'
    | 'errSsrfLine'
    | 'errLayer'
}

/** 状态机事件集。 */
export type DraftEvent =
  | { type: 'load'; value: WebstackSettingsShape }
  | { type: 'edit'; field: keyof WebstackSettingsShape; value: string | number | boolean }
  | { type: 'discard' }
  | { type: 'save' }
  | { type: 'saveSuccess' }
  | { type: 'saveFailure' }

/** maxResults 合法区间（含端点）。 */
export const MAX_RESULTS_MIN = 1
export const MAX_RESULTS_MAX = 50
/** maxContentChars 合法区间（8 MiB 封顶）。 */
export const MAX_CONTENT_CHARS_MIN = 200
export const MAX_CONTENT_CHARS_MAX = 8_000_000

/**
 * host:port 单行格式校验：主机名为域名标签序列 / IPv4 点分十进制 /
 * `localhost`，端口必填且落在 1–65535。CIDR 与裸主机名不在卡片编辑面
 * （组合入口配置档负责），此处从严——拒绝即高亮，不静默改写。
 */
export function isValidSsrfLine(raw: string): boolean {
  const line = raw.trim()
  const at = line.lastIndexOf(':')
  if (at <= 0 || at === line.length - 1) return false
  const host = line.slice(0, at)
  const portText = line.slice(at + 1)
  if (!/^\d{1,5}$/.test(portText)) return false
  const port = Number.parseInt(portText, 10)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return false
  if (host === 'localhost') return true
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true
  const label = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/
  return host.split('.').every(part => label.test(part))
}

/** 行文本 → 豁免数组：去空白行、trim、按首次出现去重。 */
export function parseSsrfExempts(text: string): string[] {
  const seen = new Set<string>()
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line !== '') seen.add(line)
  }
  return [...seen]
}

const NUMERIC_FIELDS = new Set<keyof WebstackSettingsShape>([
  'maxResults',
  'timeDecayHalfLifeH',
  'authorityBoost',
  'diversityDiscount',
  'maxContentChars',
])

function validateShape(draft: WebstackSettingsShape): DraftIssue[] {
  const issues: DraftIssue[] = []
  if (
    !Number.isInteger(draft.maxResults) ||
    draft.maxResults < MAX_RESULTS_MIN ||
    draft.maxResults > MAX_RESULTS_MAX
  ) {
    issues.push({ field: 'maxResults', message: 'errMaxResults' })
  }
  if (
    !Number.isInteger(draft.timeDecayHalfLifeH) ||
    draft.timeDecayHalfLifeH < 1 ||
    draft.timeDecayHalfLifeH > 8760
  ) {
    issues.push({ field: 'timeDecayHalfLifeH', message: 'errHalfLife' })
  }
  if (!(draft.authorityBoost >= 0 && draft.authorityBoost <= 10)) {
    issues.push({ field: 'authorityBoost', message: 'errAuthority' })
  }
  if (!(draft.diversityDiscount >= 0 && draft.diversityDiscount <= 1)) {
    issues.push({ field: 'diversityDiscount', message: 'errDiversity' })
  }
  if (
    !Number.isInteger(draft.maxContentChars) ||
    draft.maxContentChars < MAX_CONTENT_CHARS_MIN ||
    draft.maxContentChars > MAX_CONTENT_CHARS_MAX
  ) {
    issues.push({ field: 'maxContentChars', message: 'errMaxContentChars' })
  }
  if (parseSsrfExempts(draft.ssrfExemptsText).some(line => !isValidSsrfLine(line))) {
    issues.push({ field: 'ssrfExemptsText', message: 'errSsrfLine' })
  }
  if (!LAYERS.includes(draft.layer)) {
    issues.push({ field: 'layer', message: 'errLayer' })
  }
  return issues
}

function sameShape(a: WebstackSettingsShape, b: WebstackSettingsShape): boolean {
  return (
    a.enabled === b.enabled &&
    a.layer === b.layer &&
    a.autoFallback === b.autoFallback &&
    a.maxResults === b.maxResults &&
    a.fusionEnabled === b.fusionEnabled &&
    a.timeDecayHalfLifeH === b.timeDecayHalfLifeH &&
    a.authorityBoost === b.authorityBoost &&
    a.diversityDiscount === b.diversityDiscount &&
    a.maxContentChars === b.maxContentChars &&
    a.ssrfExemptsText === b.ssrfExemptsText
  )
}

/** 以 committed 基线构造 clean 相。 */
export function cleanDraft(committed: WebstackSettingsShape): DraftState {
  return { phase: 'clean', draft: { ...committed }, committed: { ...committed } }
}

/**
 * 唯一迁移入口。saving 相闸掉 load/edit/discard/save（写入在途不允许旁路
 * 变更）；save 只接受「合法的 dirty」或「failed 重试」；saveSuccess 把草稿
 * 升格为已提交基线并回到 clean。
 */
export function reduceDraft(state: DraftState, event: DraftEvent): DraftState {
  switch (event.type) {
    case 'load': {
      if (state.phase === 'saving') return state
      return cleanDraft(event.value)
    }
    case 'edit': {
      if (state.phase === 'saving') return state
      const next: WebstackSettingsShape = { ...state.draft }
      const { field, value } = event
      if (typeof value === 'boolean') {
        (next as unknown as Record<string, unknown>)[field] = value
      } else if (NUMERIC_FIELDS.has(field)) {
        const parsed = typeof value === 'number' ? value : Number.parseFloat(value)
        if (!Number.isFinite(parsed)) {
          return { ...state, phase: 'invalid' }
        }
        (next as unknown as Record<string, unknown>)[field] = parsed
      } else if (field === 'layer') {
        const layer = String(value) as SearchLayer
        if (!LAYERS.includes(layer)) return { ...state, phase: 'invalid' }
        next.layer = layer
      } else {
        next.ssrfExemptsText = String(value)
      }
      if (sameShape(next, state.committed)) return cleanDraft(state.committed)
      const phase: DraftPhase = validateShape(next).length > 0 ? 'invalid' : 'dirty'
      return { phase, draft: next, committed: state.committed }
    }
    case 'discard': {
      if (state.phase === 'saving') return state
      return cleanDraft(state.committed)
    }
    case 'save': {
      if (state.phase === 'dirty' || state.phase === 'failed') {
        if (validateShape(state.draft).length > 0) return state
        return { ...state, phase: 'saving' }
      }
      return state
    }
    case 'saveSuccess': {
      if (state.phase !== 'saving') return state
      return cleanDraft(state.draft)
    }
    case 'saveFailure': {
      if (state.phase !== 'saving') return state
      return { ...state, phase: 'failed' }
    }
  }
}

/** 卡片按钮/提示用的派生只读量。 */
export function draftIssues(state: DraftState): readonly DraftIssue[] {
  return validateShape(state.draft)
}

export function canSave(state: DraftState): boolean {
  return (
    (state.phase === 'dirty' || state.phase === 'failed') && validateShape(state.draft).length === 0
  )
}

/** 宿主设置 section（嵌套结构，缺字段回落默认）→ 扁平形状。 */
export function shapeFromSection(
  section: unknown,
  fallback: WebstackSettingsShape,
): WebstackSettingsShape {
  const root = (typeof section === 'object' && section !== null ? section : {}) as Record<
    string,
    unknown
  >
  const search = (root.search ?? {}) as Record<string, unknown>
  const fusion = (search.fusion ?? {}) as Record<string, unknown>
  const fetchNode = (root.fetch ?? {}) as Record<string, unknown>
  const safety = (root.safety ?? {}) as Record<string, unknown>
  const num = (value: unknown, alt: number): number =>
    typeof value === 'number' && Number.isFinite(value) ? value : alt
  const bool = (value: unknown, alt: boolean): boolean =>
    typeof value === 'boolean' ? value : alt
  const layer = LAYERS.includes(search.layer as SearchLayer)
    ? (search.layer as SearchLayer)
    : fallback.layer
  const exempts = Array.isArray(safety.ssrfExempts)
    ? safety.ssrfExempts.filter((entry): entry is string => typeof entry === 'string')
    : []
  return {
    enabled: bool(root.enabled, fallback.enabled),
    layer,
    autoFallback: bool(search.autoFallback, fallback.autoFallback),
    maxResults: num(search.maxResults, fallback.maxResults),
    fusionEnabled: bool(fusion.enabled, fallback.fusionEnabled),
    timeDecayHalfLifeH: num(fusion.timeDecayHalfLifeH, fallback.timeDecayHalfLifeH),
    authorityBoost: num(fusion.authorityBoost, fallback.authorityBoost),
    diversityDiscount: num(fusion.diversityDiscount, fallback.diversityDiscount),
    maxContentChars: num(fetchNode.maxContentChars, fallback.maxContentChars),
    ssrfExemptsText: exempts.length > 0 ? `${exempts.join('\n')}\n` : fallback.ssrfExemptsText,
  }
}

/** 草稿与基线的差异 → 宿主点路径写入清单（顺序稳定，供 scope.set 逐条排队）。 */
export function diffToWrites(
  draft: WebstackSettingsShape,
  committed: WebstackSettingsShape,
): ReadonlyArray<{ field: string; value: string | number | boolean | string[] }> {
  const writes: { field: string; value: string | number | boolean | string[] }[] = []
  if (draft.enabled !== committed.enabled) writes.push({ field: 'enabled', value: draft.enabled })
  if (draft.layer !== committed.layer) writes.push({ field: 'search.layer', value: draft.layer })
  if (draft.autoFallback !== committed.autoFallback) {
    writes.push({ field: 'search.autoFallback', value: draft.autoFallback })
  }
  if (draft.maxResults !== committed.maxResults) {
    writes.push({ field: 'search.maxResults', value: draft.maxResults })
  }
  if (draft.fusionEnabled !== committed.fusionEnabled) {
    writes.push({ field: 'search.fusion.enabled', value: draft.fusionEnabled })
  }
  if (draft.timeDecayHalfLifeH !== committed.timeDecayHalfLifeH) {
    writes.push({ field: 'search.fusion.timeDecayHalfLifeH', value: draft.timeDecayHalfLifeH })
  }
  if (draft.authorityBoost !== committed.authorityBoost) {
    writes.push({ field: 'search.fusion.authorityBoost', value: draft.authorityBoost })
  }
  if (draft.diversityDiscount !== committed.diversityDiscount) {
    writes.push({ field: 'search.fusion.diversityDiscount', value: draft.diversityDiscount })
  }
  if (draft.maxContentChars !== committed.maxContentChars) {
    writes.push({ field: 'fetch.maxContentChars', value: draft.maxContentChars })
  }
  if (draft.ssrfExemptsText !== committed.ssrfExemptsText) {
    writes.push({ field: 'safety.ssrfExempts', value: parseSsrfExempts(draft.ssrfExemptsText) })
  }
  return writes
}
