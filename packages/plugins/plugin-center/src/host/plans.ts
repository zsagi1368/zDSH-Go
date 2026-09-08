import { createHash, randomBytes } from 'node:crypto'
import type { CatalogEntry } from '../shared/catalog.js'
import { isValidCommit } from '../shared/catalog.js'
import { CpErrorCode, type PlanState } from '../shared/types.js'

export type PlanAction = 'install' | 'uninstall' | 'update'

export interface InstallPlan {
  planId: string
  action: PlanAction
  profile: string
  entry: CatalogEntry
  confirmCode: string
  createdAt: string
}

export class CpError extends Error {
  constructor(
    public readonly code: CpErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'CpError'
  }
}

function hashPlan(plan: Omit<InstallPlan, 'planId' | 'confirmCode' | 'createdAt'>): string {
  const canonical = JSON.stringify({
    action: plan.action,
    profile: plan.profile,
    id: plan.entry.id,
    source: plan.entry.source,
    pinnedCommit: plan.entry.pinnedCommit ?? null,
    packageName: plan.entry.packageName ?? null,
    version: plan.entry.version ?? null,
  })
  return createHash('sha256').update(canonical).digest('hex')
}

/**
 * Build an install plan from a catalog entry. GitHub entries must pin a full
 * commit; anything else is rejected as untrusted before a plan can exist.
 */
export function createPlan(
  entry: CatalogEntry,
  action: PlanAction,
  profile: string,
): InstallPlan {
  if (entry.source === 'github') {
    if (!entry.pinnedCommit || !isValidCommit(entry.pinnedCommit)) {
      throw new CpError(
        CpErrorCode.untrustedSource,
        `entry ${entry.id} has no pinned 40-hex commit`,
      )
    }
    if (!entry.owner || !entry.repo) {
      throw new CpError(CpErrorCode.invalidPlan, 'github entry missing owner/repo')
    }
  }
  if (entry.source === 'npm' && (!entry.packageName || !entry.version)) {
    throw new CpError(CpErrorCode.invalidPlan, 'npm entry missing packageName/version')
  }
  if (!profile.trim()) {
    throw new CpError(CpErrorCode.invalidPlan, 'profile is required')
  }
  const core = { action, profile, entry }
  const digest = hashPlan(core)
  return {
    // plan id derives from content (stable, auditable); the confirmation
    // code below is deliberately INDEPENDENT randomness so a leaked id —
    // audit logs include them — can never reveal the code.
    planId: `${digest.slice(0, 16)}-${action}`,
    action,
    profile,
    entry,
    confirmCode: randomBytes(6).toString('hex'),
    createdAt: new Date().toISOString(),
  }
}

/**
 * Bilingual confirmation phrase wrapping the one-shot random code. The code
 * is returned exactly once in the staging response and never derivable from
 * public data.
 */
export function confirmationPhrase(plan: InstallPlan): string {
  const verb =
    plan.action === 'install' ? '安装 install' : plan.action === 'update' ? '更新 update' : '卸载 uninstall'
  return `确认 ${verb} ${plan.entry.id} @${plan.confirmCode} / confirm`
}

interface PendingRecord {
  plan: InstallPlan
  state: PlanState
  expiresAtMs: number
}

/** One-shot plan store: confirmation consumes the plan exactly once. */
export class PlanStore {
  private readonly pending = new Map<string, PendingRecord>()

  constructor(private readonly ttlMs = 10 * 60_000) {}

  add(plan: InstallPlan): void {
    const existing = this.pending.get(plan.planId)
    if (existing !== undefined) {
      // Content-derived ids collide when the same target is staged twice.
      // Terminal states may be replaced (re-stage after done/rollback);
      // live plans are never reset, keeping the one-shot window closed.
      const terminal = existing.state === 'restart-pending' || existing.state === 'rolled-back'
      if (!terminal) {
        throw new CpError(CpErrorCode.invalidPlan, `plan ${plan.planId} already exists`)
      }
    }
    this.pending.set(plan.planId, {
      plan,
      state: 'planned',
      expiresAtMs: Date.parse(plan.createdAt) + this.ttlMs,
    })
  }

  get(planId: string): { plan: InstallPlan; state: PlanState } | null {
    const record = this.pending.get(planId)
    return record ? { plan: record.plan, state: record.state } : null
  }

  markState(planId: string, state: PlanState): void {
    const record = this.pending.get(planId)
    if (record) record.state = state
  }

  /** Consume the plan: only the exact code, only once, only unexpired. */
  confirm(planId: string, phrase: string): InstallPlan {
    const record = this.pending.get(planId)
    if (!record) throw new CpError(CpErrorCode.planNotFound, `unknown plan ${planId}`)
    if (Date.now() > record.expiresAtMs) {
      this.pending.delete(planId)
      throw new CpError(CpErrorCode.planNotFound, `plan ${planId} expired`)
    }
    // Only a freshly staged ('planned') record may be confirmed. Anything
    // else — executing, applied, rolled back — refuses as consumed so a
    // terminal plan can never be replayed.
    if (record.state !== 'planned') {
      throw new CpError(CpErrorCode.planConsumed, `plan ${planId} was already confirmed`)
    }
    if (phrase.trim() !== confirmationPhrase(record.plan)) {
      throw new CpError(CpErrorCode.confirmationMismatch, 'confirmation phrase does not match')
    }
    record.state = 'confirmed'
    return record.plan
  }

  /** Drop expired plans; returns the number removed. */
  sweepExpired(nowMs: number = Date.now()): number {
    let removed = 0
    for (const [id, record] of this.pending) {
      if (nowMs > record.expiresAtMs) {
        this.pending.delete(id)
        removed += 1
      }
    }
    return removed
  }
}
