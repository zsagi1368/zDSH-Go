/**
 * i18n 入口：语言协商与键查找（W-B-79 双语全覆盖）。所有用户可见文案均
 * 必须有 zh/en 双语键；覆盖率由测试断言。
 *
 * 统一查找表 text(key, locale) 合并八册文案（错误处置 / 引擎状态 /
 * 缓存凭据联网模式 / 抓取安全 / 诊断 / 垂直频道 / keyed 引擎 / MCP 与基础
 * 设施 / P1 内核增强）；errorText 保持向后兼容并委托本表。
 * @module webstack/i18n
 */

import type { EngineErrorCode } from '../kernel/types.ts'
import {
  type CacheCredsI18nKey,
  cacheCredsMessagesEn,
  cacheCredsMessagesZh,
} from './cache-creds.ts'
import { type DoctorI18nKey, doctorMessagesEn, doctorMessagesZh } from './doctor.ts'
import { errorMessagesEn } from './en.ts'
import { type EngineStatusKey, engineMessagesEn, engineMessagesZh } from './engines.ts'
import {
  type FetchSafetyBlockedKey,
  type FetchSafetyKey,
  fetchMessagesEn,
  fetchMessagesZh,
  fetchSafetyBlockedEn,
  fetchSafetyBlockedZh,
} from './fetch-safety.ts'
import { type KernelP1I18nKey, kernelP1MessagesEn, kernelP1MessagesZh } from './kernel-p1.ts'
import {
  type KeyedEngineStatusKey,
  keyedEngineMessagesEn,
  keyedEngineMessagesZh,
} from './keyed-engines.ts'
import { type McpInfraI18nKey, mcpInfraMessagesEn, mcpInfraMessagesZh } from './mcp-infra.ts'
import { type VerticalsI18nKey, verticalsMessagesEn, verticalsMessagesZh } from './verticals.ts'
import { type ErrorI18nKey, errorMessagesZh } from './zh.ts'

export type {
  CacheCredsI18nKey,
  DoctorI18nKey,
  EngineStatusKey,
  ErrorI18nKey,
  FetchSafetyBlockedKey,
  FetchSafetyKey,
  KernelP1I18nKey,
  KeyedEngineStatusKey,
  McpInfraI18nKey,
  VerticalsI18nKey,
}
export type Locale = 'zh' | 'en'

/** 全部分册键的联合（新增分册 = 并入 union + 两张查找表）。 */
export type WebstackI18nKey =
  | ErrorI18nKey
  | EngineStatusKey
  | CacheCredsI18nKey
  | FetchSafetyKey
  | FetchSafetyBlockedKey
  | DoctorI18nKey
  | VerticalsI18nKey
  | KeyedEngineStatusKey
  | McpInfraI18nKey
  | KernelP1I18nKey

/** 中文统一查找表（对象展开一次性合并；键冲突会在测试奇偶断言中暴露）。 */
const TABLE_ZH: Readonly<Record<WebstackI18nKey, string>> = Object.freeze({
  ...errorMessagesZh,
  ...engineMessagesZh,
  ...cacheCredsMessagesZh,
  ...fetchMessagesZh,
  ...fetchSafetyBlockedZh,
  ...doctorMessagesZh,
  ...verticalsMessagesZh,
  ...keyedEngineMessagesZh,
  ...mcpInfraMessagesZh,
  ...kernelP1MessagesZh,
})

/** English unified lookup table. */
const TABLE_EN: Readonly<Record<WebstackI18nKey, string>> = Object.freeze({
  ...errorMessagesEn,
  ...engineMessagesEn,
  ...cacheCredsMessagesEn,
  ...fetchMessagesEn,
  ...fetchSafetyBlockedEn,
  ...doctorMessagesEn,
  ...verticalsMessagesEn,
  ...keyedEngineMessagesEn,
  ...mcpInfraMessagesEn,
  ...kernelP1MessagesEn,
})

/**
 * 统一文案查找：任意分册键 → 双语文案。未知 locale 安全回落中文；
 * 未知 key 返回键本身（调用方可辨识，绝不伪造文案）。
 */
export function text(key: WebstackI18nKey, locale: Locale = 'zh'): string {
  return locale === 'en' ? (TABLE_EN[key] ?? key) : (TABLE_ZH[key] ?? key)
}

/** 取统一错误码的处置文本（兼容入口，委托 text）。 */
export function errorText(code: EngineErrorCode, locale: Locale = 'zh'): string {
  return text(`webstack.error.${code}` as ErrorI18nKey, locale)
}
