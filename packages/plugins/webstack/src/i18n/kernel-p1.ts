/**
 * P1 内核增强模块的用户可见文案（W-B-79 双语全覆盖）：会话联网模式标记、
 * 批量扇出、历史账本与融合降级提示。键集以 `webstack.mode.*` /
 * `webstack.kernel-p1.*` 为前缀；zh/en 键集奇偶一致性由
 * tests/kernel-fusion.test.ts 断言锁死。文案只进 i18n 键，不拼自由文本
 * （W-B-53 防注入）。
 *
 * 本分册独立成册、自带查找入口（与 fetch-safety 册同约定），不并入
 * i18n/index 统一表，避免扩大内核冻结面。
 *
 * @module webstack/i18n/kernel-p1
 */

/** 本册全部文案键的闭集 union。 */
export type KernelP1I18nKey =
  | 'webstack.mode.online-marker'
  | 'webstack.kernel-p1.batch.limit-exceeded'
  | 'webstack.kernel-p1.batch.partial-failure'
  | 'webstack.kernel-p1.batch.completed'
  | 'webstack.kernel-p1.history.cleared'
  | 'webstack.kernel-p1.history.replayed'
  | 'webstack.kernel-p1.fusion.degraded'
  | 'webstack.kernel-p1.fusion.timeout-leg'

/** 语言闭包（与 src/i18n/index.ts 的 Locale 同形；就地声明避免反向依赖）。 */
type Locale = 'zh' | 'en'

/** 中文文案。 */
export const kernelP1MessagesZh: Readonly<Record<KernelP1I18nKey, string>> = Object.freeze({
  'webstack.mode.online-marker': '[WebStack] 会话联网模式已开启：以下为本次在线检索结果。',
  'webstack.kernel-p1.batch.limit-exceeded':
    '[WebStack] 批量搜索超出单批 10 条上限，请拆分后再试。',
  'webstack.kernel-p1.batch.partial-failure': '[WebStack] 批量搜索部分查询失败，已逐项标注。',
  'webstack.kernel-p1.batch.completed': '[WebStack] 批量搜索已完成，结果保持输入顺序。',
  'webstack.kernel-p1.history.cleared': '[WebStack] 搜索历史已清空。',
  'webstack.kernel-p1.history.replayed': '[WebStack] 搜索历史已从持久层回放恢复。',
  'webstack.kernel-p1.fusion.degraded':
    '[WebStack] 多引擎融合降级：部分引擎腿超时被裁剪，结果基于其余来源。',
  'webstack.kernel-p1.fusion.timeout-leg':
    '[WebStack] 引擎 {engine} 响应超出复杂度预算，已被本次融合裁剪。',
})

/** English copy. */
export const kernelP1MessagesEn: Readonly<Record<KernelP1I18nKey, string>> = Object.freeze({
  'webstack.mode.online-marker':
    '[WebStack] Session online mode is ON: results below were fetched live.',
  'webstack.kernel-p1.batch.limit-exceeded':
    '[WebStack] Batch search exceeds the limit of 10 queries; split it and retry.',
  'webstack.kernel-p1.batch.partial-failure':
    '[WebStack] Some batch queries failed; failures are annotated per item.',
  'webstack.kernel-p1.batch.completed':
    '[WebStack] Batch search finished; results keep the input order.',
  'webstack.kernel-p1.history.cleared': '[WebStack] Search history cleared.',
  'webstack.kernel-p1.history.replayed':
    '[WebStack] Search history restored from the persistence layer.',
  'webstack.kernel-p1.fusion.degraded':
    '[WebStack] Fusion degraded: some engine legs timed out and were trimmed; results reflect remaining sources.',
  'webstack.kernel-p1.fusion.timeout-leg':
    '[WebStack] Engine {engine} exceeded its complexity budget and was trimmed from this fusion.',
})

/** 取本册文案；未知 locale 安全回落中文（与各分册同约定）。 */
export function kernelP1Text(key: KernelP1I18nKey, locale: Locale = 'zh'): string {
  return locale === 'en' ? kernelP1MessagesEn[key] : kernelP1MessagesZh[key]
}
