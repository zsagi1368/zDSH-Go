/**
 * 搜索/抓取历史环形账本（P1 / F-205 / pro B-13）：容量默认 200（可配）、
 * record/list(limit)/clear、可选 PersistenceAdapter write-behind 持久化 +
 * load 回放。设计要点：
 *
 * - **内部动作绝不抛错**：record/clear/load 的任何一步（含适配器故障、
 *   JSON 解析失败、非法条目）都被吞掉并保持内存态可用——历史是锦上添花
 *   面，绝不允许它成为新的故障点（与 scrubber 同纪律）。
 * - **write-behind**：record 只动内存；持久化经宏任务去抖异步刷写，
 *   失败静默（下次 record 重试）。绝不阻塞搜索热路径。
 * - **回放**：load() 从适配器读回快照，逐条形状校验后按时间升序重灌环；
 *   垃圾载荷整体丢弃，不污染内存态。
 *
 * @module webstack/kernel/history
 */

import type { HistoryEntry, PersistenceAdapter } from './types.ts'

/** 环形容量默认值（条）；构造 `capacity` 可覆盖（≥1 钳制）。 */
export const HISTORY_CAPACITY_DEFAULT = 200

/** 持久化键（单快照全量写；条目量级 ≤ 容量上限，无需分片）。 */
export const HISTORY_STORE_KEY = 'search-history'

/** 快照持久 TTL（30 天）：历史不是契约数据，过期自然蒸发。 */
const HISTORY_TTL_MS = 30 * 24 * 60 * 60_000

/** 构造选项。 */
export interface HistoryStoreOptions {
  /** 环形容量上限；超限丢最旧。默认 {@link HISTORY_CAPACITY_DEFAULT}。 */
  readonly capacity?: number
  /** 可选持久层适配器；缺省 = 纯内存环形。 */
  readonly adapter?: PersistenceAdapter
}

/** 回放条目的最小形状守卫：不合法条目逐条跳过，绝不让坏数据进环。 */
function isHistoryEntry(value: unknown): value is HistoryEntry {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    (record.kind === 'search' || record.kind === 'fetch') &&
    typeof record.at === 'number' &&
    Number.isFinite(record.at) &&
    typeof record.input === 'string' &&
    Array.isArray(record.sources)
  )
}

/**
 * 历史 store：内存环形 + 可选 write-behind 持久层。全部公开方法对调用方
 * 不抛错；`list` 返回最新在前的新数组（防御性拷贝）。
 */
export class HistoryStore {
  private entries: HistoryEntry[] = []
  private readonly capacity: number
  private readonly adapter: PersistenceAdapter | undefined
  private flushScheduled = false

  constructor(options?: HistoryStoreOptions) {
    const requested = options?.capacity ?? HISTORY_CAPACITY_DEFAULT
    this.capacity = Number.isFinite(requested) && requested >= 1 ? Math.floor(requested) : 1
    this.adapter = options?.adapter
  }

  /**
   * 记录一条历史：入环尾（最新在尾），超容丢环首；有适配器时调度
   * write-behind 刷写。绝不抛错——非法入参按「未记录」处理。
   */
  record(entry: HistoryEntry): void {
    try {
      if (!isHistoryEntry(entry)) return
      this.entries.push(entry)
      while (this.entries.length > this.capacity) this.entries.shift()
      this.scheduleFlush()
    } catch {
      // 历史记录绝不成为故障点。
    }
  }

  /** 最新在前返回至多 `limit` 条（缺省全部）；`limit<=0` 返回空。 */
  list(limit?: number): HistoryEntry[] {
    try {
      const capped =
        limit === undefined || !Number.isFinite(limit)
          ? this.entries.length
          : Math.max(0, Math.floor(limit))
      return [...this.entries].reverse().slice(0, capped)
    } catch {
      return []
    }
  }

  /** 当前环内条数（诊断用）。 */
  size(): number {
    return this.entries.length
  }

  /** 清空内存环；有适配器时异步删除持久快照（失败静默）。绝不抛错。 */
  clear(): void {
    try {
      this.entries = []
      this.scheduleFlush()
    } catch {
      // 同上。
    }
  }

  /**
   * 回放：从适配器读取上次持久化的快照，形状校验后按 `at` 升序重灌环
   * （超容丢最旧）。无适配器/读失败/垃圾载荷 → 原地不动，绝不抛错。
   */
  async load(): Promise<void> {
    try {
      const adapter = this.adapter
      if (adapter === undefined) return
      const remote = await adapter.get(HISTORY_STORE_KEY)
      if (remote === undefined || !Array.isArray(remote.value)) return
      const replayed = remote.value.filter(isHistoryEntry).toSorted((a, b) => a.at - b.at)
      this.entries = replayed.slice(-this.capacity)
      this.scheduleFlush()
    } catch {
      // 回放失败不影响当前内存态。
    }
  }

  /** write-behind 调度：宏任务去抖合并同轮多次 record 为一次全量刷写。 */
  private scheduleFlush(): void {
    const adapter = this.adapter
    if (adapter === undefined || this.flushScheduled) return
    this.flushScheduled = true
    const timer = setTimeout(() => {
      this.flushScheduled = false
      void this.flush()
    }, 0)
    // Node 计时器 unref：持久化不应拖住进程退出（非 Node 环境安全跳过）。
    if (typeof timer === 'object' && timer !== null && typeof timer.unref === 'function') {
      timer.unref()
    }
  }

  private async flush(): Promise<void> {
    try {
      await this.adapter?.set(HISTORY_STORE_KEY, [...this.entries], HISTORY_TTL_MS)
    } catch {
      // 写失败静默；下一次 record 会重新调度。
    }
  }
}
