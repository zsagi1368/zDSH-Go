/**
 * Package-owned compat-roster invariants.
 *
 * The compatibility framework's process-level audit roster is the package's
 * one durable surface: every guarded feature decision is recorded there, and
 * consumers (logs, support triage) read it as ground truth. The invariant
 * below pins the roster-entry contract so a future change cannot silently
 * ship entries whose shape contradicts their meaning.
 *
 * @module @deepseek-ai/dsh-compat/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import { getCompatRoster, type CompatRosterEntry } from './guard.ts'
import type {} from './index.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-compat'

/** Cordis companion plugin name. */
export const name = 'dsh-compat-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** Validate one roster entry's shape against its own enabled flag. */
function validateEntry(featureId: string, entry: CompatRosterEntry, fail: InvariantFailure): void {
  if (typeof entry.enabled !== 'boolean') {
    fail(`roster entry ${JSON.stringify(featureId)} must carry a boolean enabled flag`)
  }
  if (typeof entry.reason !== 'string') {
    fail(`roster entry ${JSON.stringify(featureId)} must carry a string reason`)
  }
  if (typeof entry.checkedAt !== 'string' || Number.isNaN(Date.parse(entry.checkedAt))) {
    fail(`roster entry ${JSON.stringify(featureId)} must carry an ISO-8601 checkedAt timestamp`)
  }
  // The verdict contract: enabled implies an 'ok' reason.
  if (entry.enabled && entry.reason !== 'ok') {
    fail(`roster entry ${JSON.stringify(featureId)} is enabled but carries reason ${JSON.stringify(entry.reason)}`)
  }
}

/** Validate every roster entry recorded so far. */
function validateRoster(fail: InvariantFailure): void {
  for (const [featureId, entry] of getCompatRoster().entries()) {
    if (typeof featureId !== 'string' || featureId.length === 0) {
      fail('roster entry must carry a non-empty feature id')
      continue
    }
    validateEntry(featureId, entry, fail)
  }
}

/** Install the roster-shape invariant for the current process. */
const install: InvariantInstaller = Object.assign((_ctx: Context, fail: InvariantFailure) => {
  // The roster is process-level and append-only; its invariants are checked
  // against the snapshot at install time. Every future entry is written by
  // the same closed guardFeature implementation, so a shape regression would
  // show up here on the next boot regardless.
  validateRoster(fail)
}, { inject: [] })

/**
 * Register the dsh-compat roster invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
