/**
 * 统一错误机制：EngineError 类、守卫与翻译入口（W-B-40/44/45）。
 * 错误码闭集 union 与三分类映射表（契约数据）冻结于 kernel/types.ts；
 * 本文件只提供运行时机制。TODO(W2-DIAG): 双语翻译层接入 i18n 包。
 * @module webstack/kernel/errors
 */

import {
  type EngineErrorCode,
  type EngineErrorExtras,
  type EngineErrorShape,
  ERROR_CLASSIFICATION,
  type ErrorClass,
} from './types.ts'

/** 统一错误对象：引擎适配器、安全闸、窄化层抛错的唯一合法形状。 */
export class EngineError extends Error implements EngineErrorShape {
  override readonly name = 'EngineError' as const

  readonly code: EngineErrorCode
  readonly engineId?: string
  readonly httpStatus?: number
  readonly retryAfterMs?: number
  readonly detail?: string
  override readonly cause?: unknown

  constructor(code: EngineErrorCode, message: string, extras: EngineErrorExtras = {}) {
    super(message)
    this.code = code
    // exactOptionalPropertyTypes: 只在确实提供时赋值，保持缺省字段缺席。
    if (extras.engineId !== undefined) this.engineId = extras.engineId
    if (extras.httpStatus !== undefined) this.httpStatus = extras.httpStatus
    if (extras.retryAfterMs !== undefined) this.retryAfterMs = extras.retryAfterMs
    if (extras.detail !== undefined) this.detail = extras.detail
    if (extras.cause !== undefined) this.cause = extras.cause
  }
}

/** 构造统一错误的工厂函数。 */
export function engineError(
  code: EngineErrorCode,
  message: string,
  extras: EngineErrorExtras = {},
): EngineError {
  return new EngineError(code, message, extras)
}

/** 运行时守卫：判定任意抛出值是否为统一错误对象。 */
export function isEngineError(value: unknown): value is EngineError {
  return (
    value instanceof Error &&
    value.name === 'EngineError' &&
    typeof (value as EngineError).code === 'string'
  )
}

/**
 * 归一化任意未知抛出值：EngineError 原样返回；其余包一层 transport。
 * TODO(W2-KERNEL): fallback 链据此三分类决策——retryable 退避重试，
 * non-retryable 换候选，terminal 立即结算整场操作。
 */
export function normalizeThrown(value: unknown, engineId?: string): EngineError {
  if (isEngineError(value)) return value
  const message = value instanceof Error ? value.message : String(value)
  return engineError('transport', message, engineId === undefined ? {} : { engineId })
}

/** 查询某错误码的三分类。映射表完整性由 tests/kernel-errors.test.ts 锁死。 */
export function errorClass(code: EngineErrorCode): ErrorClass {
  return ERROR_CLASSIFICATION[code]
}
