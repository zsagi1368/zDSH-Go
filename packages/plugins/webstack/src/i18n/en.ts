/**
 * 统一错误码双语处置文本（W-B-44/45 / F-009/F-014）：「发生了什么 + 用户能
 * 做什么」。键集 = `webstack.error.<code>`，由 ENGINE_ERROR_CODES 机械派生；
 * zh/en 键集奇偶一致性由 tests/kernel-errors.test.ts 锁死。
 * @module webstack/i18n/en
 */

import type { ErrorI18nKey } from './zh.ts'

/** English resolution copy. */
export const errorMessagesEn: Readonly<Record<ErrorI18nKey, string>> = Object.freeze({
  'webstack.error.transport':
    'Network connection failed. Retry shortly, or run `/webstack doctor` to inspect engine status.',
  'webstack.error.http-upstream':
    'The search/fetch service had a temporary server error (5xx). Just retry later; no config change needed.',
  'webstack.error.unrepresentable':
    'The upstream returned a result format that cannot be parsed. Run `/webstack doctor` and report the engine.',
  'webstack.error.aborted':
    'This request was cancelled (timeout or manual abort). Issue it again to continue.',
  'webstack.error.auth':
    'Credentials are invalid or expired. Update the API key for this engine in settings.',
  'webstack.error.quota':
    "This engine's quota is exhausted. Replace the key, switch layers, or enable another engine in settings.",
  'webstack.error.cooldown':
    'This engine is cooling down after repeated failures and was skipped automatically. It recovers on its own.',
  'webstack.error.ssrf-blocked':
    'The target address was rejected by the safety policy (private/reserved address or non-HTTP scheme). This is a protective block.',
  'webstack.error.narrow-failed':
    'The upstream response format was malformed and unusable this time. Retrying usually resolves it.',
  'webstack.error.rate-limited':
    'Rate limited due to too many requests. The system backs off automatically as instructed by the server; retry later.',
})
