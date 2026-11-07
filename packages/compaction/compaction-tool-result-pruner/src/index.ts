/**
 * Replay-safe, model-free tool-result pruning service.
 *
 * @module @deepseek-ai/dsh-compaction-tool-result-pruner
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { freezeMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { pruningFromMeta } from '@deepseek-ai/dsh-tools'
import type { ToolResultPruning } from '@deepseek-ai/dsh-tools'
import type { Session, SessionEvent, SessionSeq, ToolResultMessage } from '@deepseek-ai/dsh-session'
// Type-only: the `compaction/*` SessionEventMap merges (the shadow-price event).
import type {} from '@deepseek-ai/dsh-compaction'
// Type-only: the `ctx.tokenMeter` Context merge for the declared injection.
import type {} from '@deepseek-ai/dsh-token-meter'
import { codePointLength, DEFAULTS, PRUNE_MARKER, resolveConfig } from './config.ts'
import type {
  PrunedEntry,
  PruneResult,
  PruneSessionOptions,
  ResolvedConfig,
  ToolResultPruneConfig,
} from './types.ts'

export { codePointLength, DEFAULTS, PRUNE_MARKER, resolveConfig } from './config.ts'
export type {
  PrunedEntry,
  PruneResult,
  PruneSessionOptions,
  ResolvedConfig,
  ToolResultPruneConfig,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    toolResultPruner: ToolResultPruner
  }
}

interface SnapshotCandidate {
  readonly seq: SessionSeq
  readonly event: SessionEvent<'tool/result'>
}

/** Deterministic head/middle/tail pruning for current tool-result surface nodes. */
export class ToolResultPruner extends Service {
  // The token meter prices each shadowed node for its logged shadow-price
  // event, so pruning genuinely requires the pricing capability.
  static inject = ['tokenMeter']

  static Config: z<ToolResultPruneConfig> = z.object({
    thresholdChars: z.number().step(1).min(1).default(DEFAULTS.thresholdChars),
    headChars: z.number().step(1).min(0).default(DEFAULTS.headChars),
    tailChars: z.number().step(1).min(0).default(DEFAULTS.tailChars),
  })

  /** Resolved and immutable character budgets. */
  readonly config: ResolvedConfig

  constructor(ctx: Context, config: ToolResultPruneConfig = {}) {
    super(ctx, 'toolResultPruner')
    this.config = resolveConfig(config)
  }

  /**
   * Measure text content in Unicode code points; non-text blocks cost zero.
   * @param blocks - tool-result content to measure.
   * @returns total Unicode code points across text blocks.
   */
  measureContent(blocks: readonly ContentBlock[]): number {
    let chars = 0
    for (const block of blocks) {
      if (block.type === 'text') chars += codePointLength(block.text)
    }
    return chars
  }

  /**
   * Replace an over-budget text middle while retaining rich-block order.
   * Text slicing is by Unicode code point, not UTF-16 code unit, so a retained
   * boundary cannot split a surrogate pair. Grapheme clusters may still split.
   * @param blocks - original tool-result content.
   * @param limitChars - effective threshold in Unicode code points; defaults
   *   to the configured `thresholdChars`.
   * @returns pruned content, or `null` when the text is within budget.
   * @throws when the budget cannot produce a strictly smaller replacement
   *   within `limitChars` (a caller limit below `headChars + marker +
   *   tailChars`).
   */
  pruneContent(blocks: readonly ContentBlock[], limitChars: number = this.config.thresholdChars): ContentBlock[] | null {
    const totalChars = this.measureContent(blocks)
    if (totalChars <= limitChars) return null

    const removedStart = this.config.headChars
    const removedEnd = totalChars - this.config.tailChars
    const pruned: ContentBlock[] = []
    let consumed = 0
    let markerInserted = false

    for (const block of blocks) {
      if (block.type !== 'text') {
        pruned.push(block)
        continue
      }

      const points = Array.from(block.text)
      const blockStart = consumed
      const blockEnd = blockStart + points.length
      const headEnd = Math.min(points.length, Math.max(0, removedStart - blockStart))
      const tailStart = Math.min(points.length, Math.max(0, removedEnd - blockStart))
      const intersectsRemoved = blockStart < removedEnd && blockEnd > removedStart
      const marker = intersectsRemoved && !markerInserted ? PRUNE_MARKER : ''
      if (marker.length > 0) markerInserted = true
      const text = points.slice(0, headEnd).join('')
        + marker
        + points.slice(tailStart).join('')
      if (text.length > 0) pruned.push({ ...block, text })
      consumed = blockEnd
    }

    /* v8 ignore next -- totalChars > limit and valid budgets guarantee a removed text span. */
    if (!markerInserted) throw new Error('tool-result prune: failed to locate the removed text span')
    const charsAfter = this.measureContent(pruned)
    /* v8 ignore next -- config validation fixes the emitted head + marker + tail budget. */
    if (charsAfter > limitChars || charsAfter >= totalChars) {
      throw new Error('tool-result prune: replacement must be smaller and within threshold')
    }
    return pruned
  }

  /**
   * Prune every over-budget tool result from one stable current-surface snapshot.
   * Results carrying an `l3.pruning` declaration follow that vocabulary instead
   * of the uniform threshold: a `prunable: false` result is exempt from
   * pruning entirely, and a prunable one is capped by `opts.byteCapPerResult`
   * (applied as the Unicode-code-point threshold; the L3 rule derives it as
   * `toolCapToByteLimit(toolCap)`). Undeclared results keep the configured
   * `thresholdChars`, so passes without declarations behave exactly like the
   * uniform pruner. Each replacement preserves the complete event data except
   * for `content`, cites the shadowed node so replay can recover the
   * replacement input, and is immediately preceded by a `compaction/prune`
   * shadow-price event pricing the shadowed node through the injected token
   * meter, so pure consumers can subtract it without per-node state.
   * @param session - session whose current surface is rewritten.
   * @param opts - optional per-pass budgets; omitted budgets keep the
   *   configured thresholds.
   * @returns landed replacements and aggregate Unicode-code-point savings.
   * @throws when the session rejects a replacement; replacements committed
   * earlier in the pass remain durable.
   */
  pruneSession(session: Session, opts: PruneSessionOptions = {}): PruneResult {
    const candidates: SnapshotCandidate[] = []
    for (const seq of [...session.surface.nodes]) {
      // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
      const event = session.eventAt(seq)
      /* v8 ignore next -- surface seqs are validated contiguous log references. */
      if (event?.type === 'tool/result') candidates.push({ seq, event })
    }

    const pruned: PrunedEntry[] = []
    let charsRemoved = 0
    for (const { seq, event } of candidates) {
      const declared = pruningFromMeta(event.data.meta)
      // The tool's declaration outranks the uniform threshold: a non-prunable
      // result is never rewritten, declared prunable ones use their per-tool
      // cap, and only undeclared results fall back to the uniform budget.
      if (declared !== undefined && !declared.prunable) continue
      const original = session.deriveEventMessage(event) as ToolResultMessage
      const content = this.pruneContent(original.content, this.limitFor(declared, opts))
      if (content === null) continue
      const charsBefore = this.measureContent(original.content)
      const charsAfter = this.measureContent(content)
      const message = freezeMessage<ToolResultMessage>({
        ...original,
        content,
      })
      // Shadow-price protocol: the metering event and its replacement are
      // appended synchronously adjacent, so pure consumers subtract the
      // shadowed node's heuristic price without retaining per-node state.
      session.append('compaction/prune', {
        shadowedRange: { start: seq, end: seq },
        shadowedSeqs: [seq],
        shadowedTokenCount: this.ctx.tokenMeter.estimateMessage(original),
      })
      const replacement = session.append('tool/result', {
        ...event.data,
        message,
      }, {
        surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq },
        sourceEventSeqs: [seq],
      })
      pruned.push({
        originalSeq: seq,
        replacementSeq: replacement.seq,
        callId: event.data.message.source.callId,
        charsBefore,
        charsAfter,
      })
      charsRemoved += charsBefore - charsAfter
    }
    return { pruned, charsRemoved }
  }

  /**
   * Resolve the effective code-point threshold for one candidate result.
   * A declared prunable result honors `opts.byteCapPerResult`; the configured
   * uniform threshold applies whenever the declaration is absent or the cap
   * cannot represent a valid replacement — a cap below `headChars + marker +
   * tailChars` would violate the strictly-smaller-within-threshold
   * postcondition because head and tail retention stays fixed, and a
   * non-positive or non-finite cap carries no budget semantics.
   */
  private limitFor(declared: ToolResultPruning | undefined, opts: PruneSessionOptions): number {
    if (declared === undefined) return this.config.thresholdChars
    const cap = opts.byteCapPerResult
    if (typeof cap !== 'number' || !Number.isFinite(cap) || cap <= 0) {
      return this.config.thresholdChars
    }
    const minRepresentable = this.config.headChars
      + codePointLength(PRUNE_MARKER)
      + this.config.tailChars
    return cap >= minRepresentable ? cap : this.config.thresholdChars
  }
}

export default ToolResultPruner
