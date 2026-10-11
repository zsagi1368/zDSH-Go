/**
 * Package-owned durable invariant companion: the project trust ledger must
 * stay within the narrowing rules the ledger module enforces at load time.
 * A hand-edited or drifted row that would be silently dropped by narrowing is
 * reported here, so the fail-closed behavior is never invisible.
 * @module @deepseek-ai/dsh-plugin-project-root/invariant
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import { resolveBranchStorageRoot } from '@deepseek-ai/dsh-plugin-governance'

const PACKAGE_NAME = '@deepseek-ai/dsh-plugin-project-root'

/** Cordis companion plugin name. */
export const name = 'plugin-project-root-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * Storage root agreed with PluginPersistence defaults, via the authoritative
 * `resolveBranchStorageRoot` chain (`DSH_BRANCH_HOME` → `<DSH_HOME>/zdsh` →
 * `~/.dsh-zdsh-go`).
 */
function storageRoot(): string {
  return resolveBranchStorageRoot()
}

/** A record (plain object) view check. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Sweep the project trust ledger once and fail on every row that the ledger's
 * own narrowing rules would drop — a drifted or hand-edited decision must not
 * disappear silently.
 */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  void ctx
  const dataDir = join(storageRoot(), 'data')
  const ledgerPath = join(dataDir, 'project-trusts.json')
  if (!existsSync(ledgerPath)) return
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(ledgerPath, 'utf8')) as unknown
  } catch {
    return // unreadable ledger: loadProjectTrusts already fails closed to empty
  }
  if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.roots)) {
    fail(`project trust ledger ${ledgerPath} is not a v1 roots document`)
    return
  }
  for (const [rootKey, trust] of Object.entries(parsed.roots)) {
    if (!isRecord(trust) || typeof trust.trustedAt !== 'number' || !Number.isFinite(trust.trustedAt)) {
      fail(`project trust ledger row ${JSON.stringify(rootKey)} is malformed (trustedAt must be a finite number)`)
      continue
    }
    if (!isRecord(trust.plugins)) {
      fail(`project trust ledger row ${JSON.stringify(rootKey)} is malformed (plugins must be an object)`)
      continue
    }
    for (const [pluginId, decision] of Object.entries(trust.plugins)) {
      if (!isRecord(decision) || typeof decision.decidedAt !== 'number' || !Number.isFinite(decision.decidedAt) || typeof decision.enabled !== 'boolean') {
        fail(`project trust ledger decision for ${JSON.stringify(pluginId)} under ${JSON.stringify(rootKey)} is malformed`)
      }
    }
  }
}, { inject: ['invariants'] })

/**
 * Register the project trust ledger invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
