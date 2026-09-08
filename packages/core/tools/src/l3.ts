/**
 * L3 tool-result pruning vocabulary (CONTEXT-CACHE-MANAGEMENT.md §2 L3).
 *
 * Tools that emit potentially large results declare whether the result is
 * prunable and how many UTF-8 bytes it carries, so the compaction layer can
 * decide head/middle/tail pruning without re-rendering the result. The
 * vocabulary is shared here so every tool and the pruner speak one contract.
 *
 * @module @deepseek-ai/dsh-tools/l3
 */

/** JSON-safe pruning declaration attached to a `tool/result` meta payload. */
export interface ToolResultPruning {
  /**
   * Whether this result's body may be pruned (replaced by a pointer stub)
   * without losing information a re-read cannot recover.
   */
  readonly prunable: boolean
  /** UTF-8 byte size of the model-facing result body. */
  readonly bytes: number
}

/** Meta key under which tools attach the pruning declaration. */
export const PRUNING_META_KEY = 'l3.pruning' as const

/**
 * Build the pruning declaration for one tool result.
 * @param prunable - whether the result body may be pruned.
 * @param bytes - UTF-8 byte size of the model-facing body.
 * @returns the frozen declaration.
 */
export function pruningMeta(prunable: boolean, bytes: number): ToolResultPruning {
  return Object.freeze({ prunable, bytes })
}

/**
 * Narrow an opaque tool-result meta payload to a pruning declaration.
 * Absent or malformed metadata yields `undefined` (the generic fallback), so
 * older logs without the declaration never throw during replay.
 * @param meta - opaque tool-result metadata.
 * @returns the validated declaration, or `undefined`.
 */
export function pruningFromMeta(meta: unknown): ToolResultPruning | undefined {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return undefined
  const record = meta as Record<string, unknown>
  const value = record[PRUNING_META_KEY]
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const { prunable, bytes } = value as Record<string, unknown>
  if (typeof prunable !== 'boolean') return undefined
  if (typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes < 0) return undefined
  return { prunable, bytes }
}

/**
 * Derive a tool-result byte cap from a budget toolCap token limit.
 * The design's L3 rule: 字节上限 = toolCap × 3.5 字符 (UTF-8 bytes).
 * @param toolCapTokens - single tool-result token cap from the budget table.
 * @returns the UTF-8 byte cap (`floor(toolCap × 3.5)`), at least 1.
 */
export function toolCapToByteLimit(toolCapTokens: number): number {
  return Math.max(1, Math.floor(toolCapTokens * 3.5))
}
