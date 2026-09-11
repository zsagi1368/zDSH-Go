/**
 * Subagent result return-cap: bounded return per budget formula §1.2
 * (CONTEXT-CACHE-MANAGEMENT.md v2.3) and structured truncation.
 *
 * The formula mirrors `computeSubagentReturn` from
 * `@deepseek-ai/dsh-model-slots/src/budget.ts` (v2.3) — the authoritative
 * implementation matching `tools/budget_table.py` v3.
 *
 * @module @deepseek-ai/dsh-subagent/return-cap
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'

// ── Constants ───────────────────────────────────────────────────────────────

/**
 * Minimum subagent return cap in tokens. Also the floor of the budget formula
 * (§1.2: `max(2048, floor(0.25 × (reserve - maxTokens)))`).
 */
export const MIN_SUBAGENT_RETURN_CAP = 2048

// ── Token estimation ────────────────────────────────────────────────────────

/**
 * Rough token estimate for ASCII-dense text, matching the L0 counting rule
 * "上下文估算 chars/3（ASCII 密集）" (§1.2 / L0).
 * @param text - the text to estimate.
 * @returns approximate token count (ceil of chars/3 for non-empty text, 0 for empty).
 */
export function estimateApproxTokens(text: string): number {
  if (text.length === 0) return 0
  return Math.ceil(text.length / 3)
}

// ── Cap computation ─────────────────────────────────────────────────────────

/**
 * Compute the subagent return cap from the parent's maxTokens, using the
 * budget formula §1.2:
 *   reserve = ceil(maxTokens × 1.25) + 4096
 *   return  = max(2048, floor(0.25 × (reserve - maxTokens)))
 *
 * This is the same formula as `computeSubagentReturn` in
 * `@deepseek-ai/dsh-model-slots/src/budget.ts` (v2.3).
 *
 * @param maxTokens - the parent agent's maxTokens (min(C, floor(W × 0.10))).
 * @returns the return cap in tokens, always >= MIN_SUBAGENT_RETURN_CAP.
 * @throws {RangeError} when maxTokens is not a finite positive number.
 */
export function computeSubagentReturnCap(maxTokens: number): number {
  if (!Number.isFinite(maxTokens) || maxTokens <= 0) {
    throw new RangeError(
      `computeSubagentReturnCap: maxTokens must be a finite positive number, got ${maxTokens}`,
    )
  }
  const reserve = Math.ceil(maxTokens * 1.25) + 4096
  return Math.max(MIN_SUBAGENT_RETURN_CAP, Math.floor(0.25 * (reserve - maxTokens)))
}

// ── Structured truncation ───────────────────────────────────────────────────

/** Default ratio of the budget allocated to the head slice (start of the output). */
const HEAD_RATIO = 0.6

/** Marker inserted between the preserved head and tail sections. */
const TRUNCATION_MARKER = '\n\n--- [中间工作转录已截断] ---\n\n'

/**
 * Truncate a subagent's final output to fit within a token budget, using
 * structured truncation: a purely positional split that keeps the first ~60%
 * and the last ~40% of the budget and drops the middle.
 *
 * Which semantic sections survive is a property of the child's output layout,
 * not of this function: the conclusion (结论), changed-files summary (改动文件)
 * and unfinished-items section (未尽事项) are preserved only when the child
 * writes them at the head or tail of its text. A section buried mid-transcript
 * is dropped with the middle work transcript (中间工作转录).
 *
 * Algorithm:
 * 1. Estimate token count via chars/3 (L0 rule).
 * 2. Under budget → return the original output unchanged.
 * 3. Over budget → join text blocks, keep the first ~60% of the budget for
 *    the head and the last ~40% for the tail, connected by a truncation
 *    marker. The result's length equals the budget exactly (marker chars are
 *    reserved first), so the output always fits. Non-text blocks are dropped
 *    (the return channel is text per §1.2).
 *
 * The cap is honored as given: the 2048 floor belongs to the default formula
 * path (`computeSubagentReturnCap`), not to an explicitly configured cap.
 *
 * @param output - the child's final assistant output (ContentBlock[]).
 * @param maxTokens - the token budget for the return. Non-positive values are
 *   not re-validated here by design: every caller path already bounds it — the
 *   tool Config schema enforces `min(1)` on an explicit cap, the formula path
 *   floors at {@link MIN_SUBAGENT_RETURN_CAP}, and the fallback branch passes
 *   the floor constant directly. A raw non-positive call degrades to an empty
 *   (or head-only) text block rather than throwing.
 * @returns the truncated (or unchanged) ContentBlock[].
 */
export function truncateSubagentOutput(
  output: ContentBlock[],
  maxTokens: number,
): ContentBlock[] {
  // Extract text from all text blocks.
  const textBlocks = output.filter(
    (block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text',
  )
  const fullText = textBlocks.map(b => b.text).join('')

  // Estimate tokens.
  const estimatedTokens = estimateApproxTokens(fullText)

  // Under budget → return unchanged.
  if (estimatedTokens <= maxTokens) return output

  const budgetChars = maxTokens * 3 // chars/3 → chars

  // A budget too small to hold the marker gets a plain head-only truncation.
  if (budgetChars <= TRUNCATION_MARKER.length) {
    return [{ type: 'text', text: fullText.slice(0, Math.max(0, budgetChars)) }]
  }

  const availableChars = budgetChars - TRUNCATION_MARKER.length
  const headChars = Math.floor(availableChars * HEAD_RATIO)
  const tailChars = availableChars - headChars

  const head = fullText.slice(0, headChars)
  const tail = fullText.slice(Math.max(0, fullText.length - tailChars))

  // headChars + tailChars + marker length === budgetChars, so the result fits
  // the budget by construction.
  return [{ type: 'text', text: head + TRUNCATION_MARKER + tail }]
}
