/**
 * 批量扇出搜索（P1 / F-113 / W-B-20）：保序并发池、逐项结构化隔离、
 * 上限拒绝。设计要点：
 *
 * - **保序**：结果数组下标 = 输入 queries 下标（`index` 字段同值），
 *   与完成顺序无关——慢查询不挤前位。
 * - **并发池 ≤5**：调用方给更大的 concurrency 也被钳到
 *   {@link BATCH_MAX_CONCURRENCY}；≤0/NaN 回落 1（绝不 0 并发卡死）。
 * - **逐项隔离**：单项失败转 `ok:false` 结构化条目（错误码 + 过 scrubber
 *   的 message，W-B-56），部分失败绝不传染整批。
 * - **上限拒绝**：超过 {@link BATCH_MAX_QUERIES} 条整体拒绝（non-retryable，
 *   不做静默截断——宁可显式失败不可悄悄少做）。
 *
 * @module webstack/kernel/batch
 */

import { scrubText } from '../safety/scrub.ts'
import { engineError, normalizeThrown } from './errors.ts'
import type { BatchSearchItem, NormalizedHit } from './types.ts'

/** 单批查询条数硬上限；超出整体拒绝（detail=batch.limit-exceeded）。 */
export const BATCH_MAX_QUERIES = 10

/** 并发池宽度硬上限（钳制调用方传参的上界）。 */
export const BATCH_MAX_CONCURRENCY = 5

/** 批量扇出的执行依赖注入点（聚合器 search 或任意等价实现）。 */
export interface BatchSearchDeps {
  readonly run: (query: string) => Promise<readonly NormalizedHit[]>
}

/**
 * 保序并发批量搜索。返回数组与 `queries` 一一对应；每个条目要么 `ok:true`
 * 携带命中（attempts 由上层审计通道承载，此处恒空数组），要么 `ok:false`
 * 携带闭集错误码与脱敏消息。本函数只在「批次本身非法」（超上限）时抛出；
 * 单项失败一律进结构化条目。
 */
export async function batchSearch(
  deps: BatchSearchDeps,
  queries: readonly string[],
  concurrency: number = BATCH_MAX_CONCURRENCY,
): Promise<BatchSearchItem[]> {
  if (queries.length > BATCH_MAX_QUERIES) {
    throw engineError(
      'unrepresentable',
      `batch of ${queries.length} queries exceeds the limit of ${BATCH_MAX_QUERIES}`,
      { detail: 'batch.limit-exceeded' },
    )
  }

  const requested = Number.isFinite(concurrency) ? Math.floor(concurrency) : 1
  const width = Math.max(1, Math.min(requested, BATCH_MAX_CONCURRENCY, queries.length))

  const items: BatchSearchItem[] = new Array(queries.length)
  let cursor = 0

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor++
      if (index >= queries.length) return
      const query = queries[index] as string
      try {
        const hits = await deps.run(query)
        items[index] = { index, query, ok: true, hits, attempts: [] }
      } catch (thrown) {
        const err = normalizeThrown(thrown)
        items[index] = {
          index,
          query,
          ok: false,
          code: err.code,
          message: scrubText(err.message),
        }
      }
    }
  }

  await Promise.all(Array.from({ length: width }, () => worker()))
  return items
}
