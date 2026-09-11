/**
 * Package-owned durable governance invariants: the persisted admission
 * posture must never drift from what the runtime enforces. The companion
 * re-reads the durable snapshot and approvals ledger on every process start
 * and reports any enabled plugin that should still be waiting for an
 * admission decision.
 * @module @deepseek-ai/dsh-plugin-governance/invariant
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-plugin-governance'

/** Cordis companion plugin name. */
export const name = 'plugin-governance-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * Storage root agreed with PluginPersistence defaults. Mirror of
 * `resolveBranchStorageRoot` from plugin-persistence.ts (kept inline because
 * this companion entry is built standalone): `DSH_BRANCH_HOME` when set, else
 * `<DSH_HOME>/zdsh` when DSH_HOME is set, else `~/.dsh-zdsh-go`.
 */
function storageRoot(): string {
  const branchHome = process.env.DSH_BRANCH_HOME
  if (branchHome !== undefined && branchHome.trim().length > 0) return resolve(branchHome)
  const dshHome = process.env.DSH_HOME
  if (dshHome !== undefined && dshHome.trim().length > 0) return join(resolve(dshHome), 'zdsh')
  return join(homedir(), '.dsh-zdsh-go')
}

interface PersistedApprovals {
  approvedAt?: Record<string, number>
}

/** Whether one permission posture still demands an admission decision. */
function requiresDecision(permissionLevel: unknown, autoApprove: unknown): boolean {
  if (autoApprove === true) return false
  return permissionLevel === undefined
    || permissionLevel === 'confirm-required'
    || permissionLevel === 'system'
}

/** Sweep the persisted snapshot once and report every failing entry. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  void ctx
  const root = storageRoot()
  // registry.json lives at the storage root (PluginPersistence.save), the
  // approvals ledger lives under data/ (host saveApprovals) — not both in data/.
  const registryPath = join(root, 'registry.json')
  if (!existsSync(registryPath)) return
  let snapshots: unknown
  try {
    snapshots = JSON.parse(readFileSync(registryPath, 'utf8')) as unknown
  } catch {
    return // unreadable snapshot carries no posture worth reporting
  }
  const entries = typeof snapshots === 'object' && snapshots !== null
    ? (snapshots as { plugins?: unknown }).plugins
    : undefined
  if (!Array.isArray(entries)) return
  let approved: PersistedApprovals = {}
  const approvalsPath = join(root, 'data', 'approvals.json')
  if (existsSync(approvalsPath)) {
    try {
      const parsed = JSON.parse(readFileSync(approvalsPath, 'utf8')) as unknown
      if (typeof parsed === 'object' && parsed !== null) approved = parsed
    } catch {
      // Corrupt ledger: treat as no approvals, which fails closed below.
    }
  }
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue
    const row = entry as { id?: unknown; status?: unknown; manifest?: { permissionLevel?: unknown; autoApprove?: unknown } }
    if (typeof row.id !== 'string' || row.status !== 'active') continue
    const manifest = row.manifest
    if (manifest !== undefined && requiresDecision(manifest.permissionLevel, manifest.autoApprove)) {
      if (approved.approvedAt === undefined || approved.approvedAt[row.id] === undefined) {
        fail(`plugin ${JSON.stringify(row.id)} is active on disk without a recorded admission decision`)
      }
    }
  }
}, { inject: ['invariants'] })

/**
 * Register the governance admission-posture invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
