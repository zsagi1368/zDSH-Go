/**
 * Loop guard: detects idle-loop spinning and interrupts with a restart prompt.
 *
 * Three complementary signals — "change is progress" is the reset rule:
 *  - same full assistant text repeated N times (strongest)
 *  - short sentences without any tool activity within a time window
 *  - same tool + same arguments + same RESULT repeated N times
 *
 * Defaults are deliberately conservative: interrupting real work costs more
 * than missing one loop for another turn.
 */
import type { LoopSignal } from '../kernel/types.js'

export interface LoopGuardThresholds {
  sameTextCount: number
  shortChars: number
  shortCount: number
  shortWindowMs: number
  toolRepeatCount: number
}

export const LOOP_GUARD_DEFAULTS: LoopGuardThresholds = {
  sameTextCount: 4,
  shortChars: 40,
  shortCount: 12,
  shortWindowMs: 30_000,
  toolRepeatCount: 5,
}

interface ToolRunRecord {
  count: number
  lastResultDigest: string
  lastAt: number
}

function digest(text: string): string {
  let h = 5381
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0
  return String(h)
}

export class LoopGuard {
  private lastText = ''
  private sameTextRuns = 0
  /** Timestamps of recent short, tool-free assistant messages. */
  private shortRuns: number[] = []
  private toolRuns = new Map<string, ToolRunRecord>()
  private firedThisTurn = false

  constructor(
    private readonly thresholds: LoopGuardThresholds = LOOP_GUARD_DEFAULTS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  beginTurn(): void {
    this.firedThisTurn = false
    this.shortRuns = []
    // Text and tool streaks persist across turns on purpose: a loop often
    // spans turn boundaries after an auto-resume.
  }

  feedAssistant(text: string): void {
    if (text === this.lastText) {
      this.sameTextRuns += 1
    } else {
      this.lastText = text
      this.sameTextRuns = 1
    }
    if (text.length <= this.thresholds.shortChars) {
      const now = this.now()
      this.shortRuns.push(now)
      this.shortRuns = this.shortRuns.filter(t => now - t <= this.thresholds.shortWindowMs)
    }
  }

  /**
   * Feed a completed tool call. Changed arguments OR changed result reset that
   * tool's streak and the short-run window (something moved → progress).
   */
  feedTool(name: string, argsJson: string, resultJson: string): void {
    const key = `${name}#${digest(argsJson)}`
    const resultKey = digest(resultJson)
    const record = this.toolRuns.get(key)
    const at = this.now()
    if (!record || record.lastResultDigest !== resultKey) {
      this.toolRuns.set(key, { count: 1, lastResultDigest: resultKey, lastAt: at })
      this.shortRuns = []
    } else {
      record.count += 1
      record.lastAt = at
    }
  }

  /** Signals currently over their thresholds (empty array when healthy). */
  trippedSignals(): LoopSignal[] {
    const signals: LoopSignal[] = []
    if (this.sameTextRuns >= this.thresholds.sameTextCount) signals.push('same-text')
    if (this.shortRuns.length >= this.thresholds.shortCount) signals.push('short-run')
    for (const record of this.toolRuns.values()) {
      if (record.count >= this.thresholds.toolRepeatCount) {
        signals.push('tool-repeat')
        break
      }
    }
    return signals
  }

  /** At most ONE interrupt per turn; callers must check before cancelling. */
  shouldInterrupt(): boolean {
    return !this.firedThisTurn && this.trippedSignals().length > 0
  }

  markFired(): void {
    this.firedThisTurn = true
  }
}
