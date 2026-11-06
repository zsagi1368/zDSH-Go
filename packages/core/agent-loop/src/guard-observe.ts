/**
 * Host-side chain maintenance for wire-body guard observation (T3 L5-A):
 * consumes the adapter's per-attempt captures, classifies each against the
 * chain base plus the transition-guard window, and appends the log-only
 * `cache/guard-observe` session event (D1P2-whitelist-design §2.1/§4.5).
 *
 * The observation domain is the session-bound main chain: this object is
 * constructed only for agents whose options opted in (`AgentOptions.guardObserve`),
 * so one-shot streams (no agent, no sink) and subagent agents (no opt-in)
 * never reach here and the adapter installs no wrapper at all.
 *
 * Chain state is in-process only and starts empty on every process start: the
 * first record after a resume is RECORD_ONLY with no previous base (D1P2 §4.5).
 *
 * @module dsh-agent-loop/guard-observe
 */
import type { LlmGuardObserveCapture, LlmGuardObserveEvent, LlmGuardObserveTransitionKind } from '@deepseek-ai/dsh-llm'
import {
  classifyGuardObserve,
  type GuardObserveChainRecord,
  type GuardObserveChainView,
} from '@deepseek-ai/dsh-llm-pi-ai/guard-observe'
import type { Session } from '@deepseek-ai/dsh-session'
import { SessionLogOffset } from '@deepseek-ai/dsh-session'

/**
 * Session-log events that mark a known-legal context rewrite (D1P2 §4.5
 * guard 2). Both `compaction` kinds fold to one kind; `cache/ledger` presence
 * means a registered `tailMerge` rewrite happened (its only production append
 * site is the reset sink), and reading the mark never touches ledger data.
 */
const TRANSITION_MARKS: Record<string, Exclude<LlmGuardObserveTransitionKind, 'route-change'>> = {
  'compaction/start': 'compaction',
  'compaction/end': 'compaction',
  'cache/ledger': 'reset-rewrite',
}

/** Classifies captures and appends `cache/guard-observe` events for one agent's session. */
export class GuardObserver {
  /** The chain base: the most recent record that carried segments. */
  private base: GuardObserveChainRecord | undefined
  /** Attempt-1 record of the current logical request (class-4 comparison base). */
  private firstAttempt: GuardObserveChainRecord | undefined
  /** Whether a non-chain participant (degraded / whole-package fallback) sits after the base. */
  private gap = false

  readonly chainView: GuardObserveChainView = {
    transitionMarkBetween: (fromSeqInclusive, toSeqExclusive) => this.transitionMarkBetween(fromSeqInclusive, toSeqExclusive),
  }

  constructor(
    private readonly session: Session,
    private readonly warn: (message: string) => void,
  ) {}

  /**
   * Sink for `GenerateOptions.onGuardObserve`: invoked synchronously by the
   * adapter's fetch wrapper once per attempt, in fetch order, so the appends
   * land in the log in wire order. The seq this record will occupy is read
   * before the append and bounds the transition-scan window (D1P2 §4.5:
   * `(prevRecord.seq, current]`).
   * @param capture - one attempt's wire capture.
   */
  observe(capture: LlmGuardObserveCapture): void {
    if (capture.segments === undefined) {
      // A7 degraded capture, or the whole-package fallback for a body this
      // surface does not three-segment: log-only, no chain participation, and
      // the next segmented record reads the crossing as a gap.
      this.session.append('cache/guard-observe', {
        schemaVersion: 1,
        attemptSeq: capture.attemptSeq,
        ...capture.wholeHash === undefined ? {} : { wholeHash: capture.wholeHash },
        classified: false,
        ...capture.degraded === undefined ? {} : { degraded: capture.degraded },
        meta: capture.meta,
      })
      this.gap = true
      return
    }
    const currentSeq = this.session.seq
    const decision = classifyGuardObserve({
      prev: this.base,
      first: this.firstAttempt,
      capture: { ...capture, segments: capture.segments },
      chain: this.chainView,
      currentSeq,
      gap: this.gap,
    })
    const event: LlmGuardObserveEvent = { ...capture, ...decision }
    const { seq } = this.session.append('cache/guard-observe', event)
    if (decision.monotonic === 'unclassified') this.warnUnclassified(capture, decision)
    const record: GuardObserveChainRecord = { seq, segments: capture.segments, meta: capture.meta }
    this.base = record
    this.gap = false
    if (capture.attemptSeq === 1) this.firstAttempt = record
  }

  /**
   * Transition-mark scan over the log window, window-bounded by the seq
   * arguments so the read cost stays proportional to the window (D1P2 §4.5
   * R2-5 note), not the whole log.
   */
  private transitionMarkBetween(fromSeqInclusive: number, toSeqExclusive: number): LlmGuardObserveTransitionKind | undefined {
    let kind: LlmGuardObserveTransitionKind | undefined
    // oxlint-disable-next-line typescript/no-deprecated -- D1P2 §5.2 C2-3 names this read face; agent.ts:303 precedent.
    const events = this.session.snapshotEvents(
      SessionLogOffset(fromSeqInclusive),
      SessionLogOffset(toSeqExclusive),
    )
    for (const event of events) {
      const mark = TRANSITION_MARKS[event.type]
      if (mark === undefined) continue
      // Both mark families in one window fold to the coarser compaction.
      if (mark === 'compaction') return 'compaction'
      kind = mark
    }
    return kind
  }

  /** D1P2 §8.2: an unclassified form is visible and searchable on the log face. */
  private warnUnclassified(capture: LlmGuardObserveCapture, decision: { sharedPrefixCount?: number }): void {
    const mismatchAt = decision.sharedPrefixCount
    const kindsAt = mismatchAt === undefined
      ? ''
      : `; kinds at the mismatch: prev=${this.base?.segments.messageKinds[mismatchAt] ?? 'none'}`
        + ` next=${capture.segments?.messageKinds[mismatchAt] ?? 'none'}`
    this.warn(
      `cache/guard-observe: unclassified wire form at attempt ${capture.attemptSeq}`
      + ` (first mismatch after ${mismatchAt ?? 'unknown'} shared messages${kindsAt});`
      + ' recorded in full, no action taken',
    )
  }
}
