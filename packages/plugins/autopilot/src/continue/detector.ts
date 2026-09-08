/**
 * Interruption detector: decides whether a turn ending is worth auto-resuming.
 *
 * Two layers:
 *  1. End-reason whitelist — only `error` and `max-tokens` are acted on live;
 *     `aborted` (user stop) and `blocked` (policy denial) NEVER resume;
 *     `interrupted` is written only by crash recovery at host reload, so it is
 *     claimed exclusively by the startup scan.
 *  2. Error classifier — a configurable pattern corpus separates permanent
 *     failures (auth/quota/model/context/invalid-request families) from
 *     transient ones. Unknown errors default to transient (resume attempt),
 *     because a skipped recovery is a lost turn while an extra prompt is cheap.
 */

export type LiveEndReason = 'completed' | 'error' | 'max-tokens' | 'aborted' | 'blocked'

/** Reasons that may ever be resumed live. `interrupted` belongs to boot scan only. */
export type ResumeEligibleReason = 'error' | 'max-tokens' | 'interrupted-boot-scan'

export interface FailureInfo {
  code?: string
  status?: number
  message?: string
}

export interface ClassifyPattern {
  /** Human-readable family name for audits and notifications. */
  family: string
  re: RegExp
}

/** Built-in baseline corpus; extendable via configuration later (M5 settings). */
export const PERMANENT_FAILURE_PATTERNS: readonly ClassifyPattern[] = [
  { family: 'auth', re: /\b(unauthorized|forbidden)\b/i },
  { family: 'auth', re: /(invalid|bad|missing)[ _-]?(api[ _-]?key|token|credential)/i },
  { family: 'auth', re: /\b(authentication|authorization)\b.*\b(fail|denied|error)/i },
  { family: 'quota', re: /\b(quota|billing|balance|insufficient[ _-]funds)\b/i },
  { family: 'model', re: /\b(model|engine)\b.*\b(not[ _-]found|unknown|unsupported)\b|\bunknown\b.*\b(model|engine)\b/i },
  { family: 'context-overflow', re: /\b(context(_| )length|maximum context|too many tokens)\b/i },
  { family: 'invalid-request', re: /\b(invalid[_ ]request|bad[_ ]request)\b/i },
]

export const TRANSIENT_HINT_PATTERNS: readonly RegExp[] = [
  /\bnetwork\b/i,
  /\btimeout\b/i,
  /\beconn(refused|reset|aborted)?\b/i,
  /\bsocket\b/i,
  /\bupstream\b/i,
  /\btemporar/i,
]

function matchesPermanent(info: FailureInfo): ClassifyPattern | undefined {
  if (info.status === 401 || info.status === 403) {
    return { family: 'auth-status', re: /./ }
  }
  const haystack = `${info.code ?? ''} ${info.message ?? ''}`
  return PERMANENT_FAILURE_PATTERNS.find(p => p.re.test(haystack))
}

export interface DetectionOutcome {
  action: 'schedule-resume' | 'skip'
  /** Populated when skipping: why this turn will not be resumed. */
  skipReason?: 'permanent-failure' | 'not-eligible'
  family?: string
}

export function detectLive(
  reason: LiveEndReason,
  failure: FailureInfo | undefined,
  options: { classifyErrors: boolean },
): DetectionOutcome {
  switch (reason) {
    case 'aborted':
    case 'blocked':
    case 'completed':
      return { action: 'skip', skipReason: 'not-eligible' }
    case 'max-tokens':
      return { action: 'schedule-resume' }
    case 'error': {
      if (!options.classifyErrors) return { action: 'schedule-resume' }
      const hit = failure ? matchesPermanent(failure) : undefined
      if (hit) return { action: 'skip', skipReason: 'permanent-failure', family: hit.family }
      return { action: 'schedule-resume' }
    }
    default:
      return { action: 'skip', skipReason: 'not-eligible' }
  }
}

/** Boot-scan variant: `interrupted` becomes eligible here. */
export function detectBootScan(
  reason: LiveEndReason | 'interrupted',
  failure: FailureInfo | undefined,
  options: { classifyErrors: boolean },
): DetectionOutcome {
  if (reason === 'interrupted') return { action: 'schedule-resume' }
  return detectLive(reason, failure, options)
}
