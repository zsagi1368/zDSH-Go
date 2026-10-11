/**
 * Feature registration guard for the version-adaptive shim framework.
 *
 * `guardFeature` runs before a fork feature registers itself: every
 * dependency probe and conflict check must pass, otherwise the feature is
 * skipped with a warning — never throwing, never breaking the host tree.
 * The process-level audit roster records every verdict for diagnostics.
 *
 * @module @deepseek-ai/dsh-compat
 */

/** A single health-check step. */
export interface CompatCheck {
  /** Check name for logs and the audit roster (e.g. 'probe:BlockAssembler.truncatedToolCalls'). */
  name: string
  /** Run the check; resolve to `null` when it passes, or a failure reason string when it does not. May be async. */
  run: () => Promise<string | null> | string | null
}

/**
 * Minimal logger accepted by {@link guardFeature}. Hosts pass their own
 * `ctx.logger`; browser clients use {@link consoleCompatLogger}.
 */
export interface CompatLogger {
  /** Record a warning (used for feature-disable diagnostics). */
  warn(message: string, ...args: unknown[]): void
  /** Record an informational message (optional capability). */
  info?(message: string, ...args: unknown[]): void
}

/**
 * Default client-side logger backed by `console`.
 * @returns A {@link CompatLogger} delegating to `console.warn`/`console.info`.
 */
export function consoleCompatLogger(): CompatLogger {
  return {
    warn(message: string, ...args: unknown[]): void {
      console.warn(message, ...args)
    },
    info(message: string, ...args: unknown[]): void {
      console.info(message, ...args)
    },
  }
}

/** Registration options for {@link guardFeature}. */
export interface GuardFeatureOptions {
  /** Dependency probes, run before `check`; the first failure disables the feature. */
  deps?: CompatCheck[]
  /** Conflict checks, usually probing duplicate registration with an already-loaded official module or an API signature mismatch. */
  check?: CompatCheck[]
  /** Prefix for failure logs; defaults to `featureId`. */
  logPrefix?: string
  /** Logger receiving failure records (host `ctx.logger`, client `console`). */
  logger?: CompatLogger
}

/** Result of {@link guardFeature}. */
export interface FeatureVerdict {
  /** Whether the feature may register. */
  enabled: boolean
  /** Verdict reason (`'ok'` when enabled; otherwise the failing check's reason). */
  reason: string
  /** Names of all failed checks (empty when enabled). */
  failures: string[]
}

/** A process-level audit entry for one guarded feature. */
export interface CompatRosterEntry {
  /** Whether the feature was allowed to register. */
  enabled: boolean
  /** Verdict reason (`'ok'` when enabled; otherwise the failing check's reason). */
  reason: string
  /** ISO-8601 timestamp of the check. */
  checkedAt: string
}

/** Process-level audit roster keyed by feature id (module-private; read via {@link getCompatRoster}). */
const compatRoster = new Map<string, CompatRosterEntry>()

/**
 * Read-only snapshot of the process-level audit roster.
 * @returns A copy of the roster; mutating it does not affect future checks.
 */
export function getCompatRoster(): ReadonlyMap<string, Readonly<CompatRosterEntry>> {
  return new Map(compatRoster)
}

/**
 * Feature registration guard: call before a feature registers itself. Every
 * `deps` and `check` must pass for `enabled` to be `true`; on the first
 * failure the remaining checks are skipped (short-circuit), a warning is
 * logged, and `enabled` is `false`. Never throws; a throwing `run` counts as
 * a failure with reason `threw:<message>`. Callers must skip registration
 * when `enabled` is `false` without affecting other features.
 *
 * @param featureId - Feature identifier (e.g. 'dsh-model-slots'), also the roster key.
 * @param options - Registration options (`deps`/`check`/`logPrefix`/`logger`).
 * @returns The verdict with `enabled`/`reason`/`failures`.
 */
export async function guardFeature(
  featureId: string,
  options: GuardFeatureOptions,
): Promise<FeatureVerdict> {
  const logger = options.logger ?? consoleCompatLogger()
  const logPrefix = options.logPrefix ?? featureId
  const failures: string[] = []
  let reason = 'ok'
  let enabled = true

  const runCheck = async (check: CompatCheck): Promise<string | null> => {
    try {
      return await check.run()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return `threw:${message}`
    }
  }

  const runPhase = async (phase: CompatCheck[] | undefined): Promise<boolean> => {
    for (const check of phase ?? []) {
      const result = await runCheck(check)
      if (result !== null) {
        failures.push(check.name)
        reason = result
        return false
      }
    }
    return true
  }

  if (!(await runPhase(options.deps)) || !(await runPhase(options.check))) {
    enabled = false
  }

  compatRoster.set(featureId, { enabled, reason, checkedAt: new Date().toISOString() })

  if (!enabled) {
    try {
      logger.warn(`[compat] ${logPrefix} disabled: ${failures.join('; ')}`)
    } catch {
      // A throwing logger must not take the guard down.
    }
  }

  return { enabled, reason, failures }
}
