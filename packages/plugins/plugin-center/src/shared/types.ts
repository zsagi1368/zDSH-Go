/** Stable error codes for every failure surface of the plugin center. */
export const CpErrorCode = {
  invalidPlan: 'invalid_plan',
  untrustedSource: 'untrusted_source',
  hashMismatch: 'hash_mismatch',
  backupFailed: 'backup_failed',
  installFailed: 'install_failed',
  healthCheckFailed: 'health_check_failed',
  rollbackFailed: 'rollback_failed',
  planConsumed: 'plan_consumed',
  planNotFound: 'plan_not_found',
  confirmationMismatch: 'confirmation_mismatch',
  scriptBlocked: 'script_blocked',
  sourceUnreachable: 'source_unreachable',
  offlineDegraded: 'offline_degraded',
  unsafeUrl: 'unsafe_url',
  internal: 'internal',
} as const

export type CpErrorCode = (typeof CpErrorCode)[keyof typeof CpErrorCode]

/** Closed result envelope used across every public surface. */
export type CpResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: CpErrorCode; message: string } }

export function cpOk<T>(data: T): CpResult<T> {
  return { ok: true, data }
}

export function cpErr<T = never>(
  code: CpErrorCode,
  message: string,
): CpResult<T> {
  return { ok: false, error: { code, message } }
}

/**
 * Normalize a plugin id to the canonical `namespace/name` form.
 * Accepts `@scope/pkg`, `owner/repo` and bare names; rejects empties and any
 * character outside the safe identifier set (ids flow into command argv).
 */
export function normalizePluginId(raw: string): CpResult<string> {
  const trimmed = raw.trim().replace(/^@/, '')
  if (!trimmed) return cpErr(CpErrorCode.invalidPlan, 'empty plugin id')
  if (trimmed.length > 120) return cpErr(CpErrorCode.invalidPlan, 'plugin id too long')
  const parts = trimmed.split('/').filter(Boolean)
  if (parts.length === 0 || parts.length > 2) {
    return cpErr(CpErrorCode.invalidPlan, `malformed plugin id: ${raw}`)
  }
  for (const part of parts) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part)) {
      return cpErr(CpErrorCode.invalidPlan, `illegal characters in plugin id segment: ${part.slice(0, 30)}`)
    }
  }
  return cpOk(parts.join('/'))
}

/** Lifecycle states of a plan as it moves through the engine. */
export type PlanState =
  | 'draft'
  | 'planned'
  | 'confirmed'
  | 'executing'
  | 'applied'
  | 'rolled-back'
  | 'restart-pending'

export type AuditOutcome = 'ok' | 'error' | 'rolled-back'

export interface AuditEvent {
  ts: string
  action: string
  planId?: string
  step?: string
  outcome: AuditOutcome
  errorCode?: string
  detail?: Record<string, string | number | boolean>
}
