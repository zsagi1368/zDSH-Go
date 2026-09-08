/**
 * Total-function treatment of failures.
 *
 * Every failure path in every module converges on the closed `FailureKind`
 * vocabulary and is mapped through ONE total table to a safe outcome. Nothing
 * may fall through implicitly: adding a FailureKind member breaks compilation
 * in every mapping table until it is handled.
 */
import type { FailureKind } from './types.js'

const FAILURE_KINDS: readonly FailureKind[] = [
  'timeout',
  'cancelled',
  'unavailable',
  'schema',
  'budget',
  'circuit-open',
]

export function isFailureKind(value: unknown): value is FailureKind {
  return typeof value === 'string' && (FAILURE_KINDS as readonly string[]).includes(value)
}

/**
 * Exhaustiveness helper. Call inside a `default:` branch:
 *
 * ```ts
 * default: return assertUnreachable(kind);
 * ```
 *
 * If a new FailureKind member appears, every switch using this fails to
 * compile until handled.
 */
export function assertUnreachable(value: never, context = 'value'): never {
  throw new Error(`internal: unhandled ${context} ${JSON.stringify(String(value))}`)
}

/**
 * Map a failure through a caller-supplied total table. The table type forces a
 * decision for every failure kind — there is no implicit fallback.
 */
export function toSafeOutcome<F>(kind: FailureKind, table: Record<FailureKind, F>): F {
  return table[kind]
}

/** Cancelled failures are user-driven and never burn failure budgets. */
export function isCancelled(kind: FailureKind): boolean {
  return kind === 'cancelled'
}

/** Standard classification used by ledger accounting. */
export function countsAgainstFailureBudget(kind: FailureKind): boolean {
  return !isCancelled(kind)
}
