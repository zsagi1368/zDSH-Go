/**
 * 缓存语义指纹（W-B-30/33）：canonical JSON → sha256。键维度 =
 * CacheKeyInput 字段清单；相邻调用差异由 tests/cache-fingerprint.test.ts 锁死。
 * @module webstack/cache/fingerprint
 */

import { createHash } from 'node:crypto'
import type { CacheKeyInput } from '../kernel/types.ts'

/**
 * 规范化序列化：对象键递归排序、数组保序、undefined 字段整体缺席——
 * 同一逻辑输入永远得到同一字节串。
 */
export function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`
  const keys = Object.keys(value).sort()
  const body = keys
    .map(
      key =>
        `${JSON.stringify(key)}:${canonicalStringify((value as Record<string, unknown>)[key])}`,
    )
    .join(',')
  return `{${body}}`
}

/** 由缓存键输入计算十六进制指纹。engineSet 先排序，消除集合顺序噪声。 */
export function cacheKey(input: CacheKeyInput): string {
  const normalized: CacheKeyInput = {
    ...input,
    engineSet: [...input.engineSet].toSorted(),
  }
  return createHash('sha256').update(canonicalStringify(normalized)).digest('hex')
}
