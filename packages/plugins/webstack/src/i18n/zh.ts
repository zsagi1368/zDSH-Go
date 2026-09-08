/**
 * 统一错误码双语处置文本（W-B-44/45 / F-009/F-014）：「发生了什么 + 用户能
 * 做什么」。键集 = `webstack.error.<code>`，由 ENGINE_ERROR_CODES 机械派生；
 * zh/en 键集奇偶一致性由 tests/kernel-errors.test.ts 锁死。
 * @module webstack/i18n/zh
 */

import type { EngineErrorCode } from '../kernel/types.ts'

export type ErrorI18nKey = `webstack.error.${EngineErrorCode}`

/** 中文处置文案。 */
export const errorMessagesZh: Readonly<Record<ErrorI18nKey, string>> = Object.freeze({
  'webstack.error.transport': '网络连接失败。可稍后重试，或运行 `/webstack doctor` 查看引擎状态。',
  'webstack.error.http-upstream': '搜索/抓取服务端暂时异常（5xx）。稍候重试即可，无需改配置。',
  'webstack.error.unrepresentable':
    '上游返回了无法解析的结果格式。请运行 `/webstack doctor` 并反馈该引擎。',
  'webstack.error.aborted': '本次请求已被取消（超时或手动中止）。如需继续请重新发起。',
  'webstack.error.auth': '凭据无效或已过期。请在设置中更新对应引擎的 API 密钥。',
  'webstack.error.quota': '该引擎配额已用尽。可在设置中更换密钥、切换层或启用其它引擎。',
  'webstack.error.cooldown': '该引擎因连续失败进入冷却期，已自动跳过。稍后会自动恢复。',
  'webstack.error.ssrf-blocked':
    '目标地址被安全策略拒绝（内网/保留地址或非 HTTP 协议）。这是保护性拦截。',
  'webstack.error.narrow-failed': '上游响应格式异常，本次结果不可用。重试通常可以恢复。',
  'webstack.error.rate-limited': '请求过于频繁被限频。系统将按服务端指示自动退避，请稍后重试。',
})
