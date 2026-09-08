/**
 * Denial-feedback loop: refused actions get their reason injected back into
 * the tool result so the requesting agent LEARNS why instead of retrying
 * blindly. Entries are callId-keyed with a TTL and consumed at most once.
 */
import { buildMarker } from '../kernel/audit.js'

export interface FeedbackEntry {
  verdictId: string
  toolName: string
  reason: string
  kind: 'deny' | 'fallback' | 'circuit' | 'never'
  expiresAt: number
}

const FEEDBACK_TTL_MS = 5 * 60_000

export class FeedbackLoop {
  private readonly entries = new Map<string, FeedbackEntry>()

  constructor(private readonly now: () => number = () => Date.now()) {}

  record(
    callId: string,
    entry: Omit<FeedbackEntry, 'expiresAt'>,
  ): void {
    this.entries.set(callId, { ...entry, expiresAt: this.now() + FEEDBACK_TTL_MS })
  }

  /**
   * Build the model-visible replacement text for a FAILED (isError) tool
   * result. The marker guarantees "model-visible ⟺ recorded" pairing with the
   * corresponding ap/verdict event. Consumes the entry.
   */
  consume(callId: string, isError: boolean): string | undefined {
    const entry = this.entries.get(callId)
    if (!entry) return undefined
    if (!isError) {
      this.entries.delete(callId) // chain moved on — never touch it
      return undefined
    }
    this.entries.delete(callId)
    if (this.now() >= entry.expiresAt) return undefined
    const marker = buildMarker('ap/verdict', entry.verdictId)
    const prefix =
      entry.kind === 'deny'
        ? 'This action was reviewed and denied.'
        : entry.kind === 'circuit'
          ? 'Review circuit opened after repeated denials; this action was rejected automatically.'
          : entry.kind === 'never'
            ? 'This tool is hard-disabled by policy.'
            : 'The reviewer was unavailable, so this action was rejected by fail-closed policy.'
    return `${prefix} ${marker} Reason: ${entry.reason} Choose a safer alternative or ask the user; do not attempt to bypass this.`
  }

  get size(): number {
    return this.entries.size
  }
}
