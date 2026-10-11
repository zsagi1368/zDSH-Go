/**
 * Durable preinstall result ledger (DESIGN-intake-tech.md §1.4).
 *
 * Lives beside the approvals and installed-sources ledgers under the
 * governance persistence data directory (`<storageRoot>/data/
 * preinstall-results.json`) and copies their read/narrow/write discipline.
 * The ledger is the executor's memory of what each seed entry resolved to,
 * the plugin-center hub's discovery surface, and the carrier of the
 * `userUninstalled` tombstone that stops a removed preinstall from being
 * resurrected on the next boot.
 *
 * Callers commit through {@link savePreinstallResults} only while holding the
 * cross-process writer lock on this exact file (K-B1); the loader treats a
 * missing or corrupt file as an empty ledger so a first boot starts clean.
 * @module @deepseek-ai/dsh-plugin-governance-host/src/preinstall/results
 */

import { existsSync, readFileSync } from 'node:fs'
import { writeFileAtomicSync } from '../atomic-write-sync.ts'
import type {
  PreinstallEntryResult,
  PreinstallMountResult,
  PreinstallMountStatus,
  PreinstallReport,
  PreinstallStatus,
} from '../types.ts'

/** On-disk v1 ledger shape. */
export interface PersistedPreinstallResults {
  version: 1
  ranAt: number | null
  entries: Record<string, PreinstallEntryResult>
}

/** The statuses the schema admits, mirroring {@link PreinstallStatus}. */
const STATUSES: readonly PreinstallStatus[] = ['installed', 'skipped', 'failed']

/** The mount outcomes the schema admits, mirroring {@link PreinstallMountStatus}. */
const MOUNT_STATUSES: readonly PreinstallMountStatus[] = ['mounted', 'failed', 'skipped']

/**
 * Empty ledger used when no durable record exists yet.
 * @returns a version-1 ledger with no run timestamp and no entries.
 */
export function emptyPreinstallResults(): PersistedPreinstallResults {
  return { version: 1, ranAt: null, entries: {} }
}

/**
 * Narrow one optional `mount` sub-structure (§9.4). A missing or malformed
 * mount dimension is dropped field-locally — the row's admission `status`
 * stays trustworthy, which is also what keeps a version:1-era ledger (no
 * mount column at all) readable by this code unchanged.
 */
function readMount(value: unknown): PreinstallMountResult | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  if (typeof record.status !== 'string' || !MOUNT_STATUSES.includes(record.status as PreinstallMountStatus)) return undefined
  const reason = typeof record.reason === 'string' ? record.reason : null
  const at = typeof record.at === 'number' && Number.isFinite(record.at) ? record.at : undefined
  return {
    status: record.status as PreinstallMountStatus,
    ...(reason !== null ? { reason } : {}),
    ...(at !== undefined ? { at } : {}),
  }
}

/** Narrow one parsed entry object to a {@link PreinstallEntryResult}. */
function readEntry(value: unknown): PreinstallEntryResult | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  if (typeof record.status !== 'string' || !STATUSES.includes(record.status as PreinstallStatus)) return null
  if (typeof record.at !== 'number' || !Number.isFinite(record.at)) return null
  const reason = typeof record.reason === 'string' ? record.reason : null
  const mount = readMount(record.mount)
  // Key insertion order MATCHES the executor's writeRow (`status, reason,
  // mount, at, userUninstalled`): a re-saved ledger must not shuffle the
  // bytes of untouched rows when a sibling row changes.
  return {
    status: record.status as PreinstallStatus,
    ...(reason !== null ? { reason } : {}),
    ...(mount !== undefined ? { mount } : {}),
    at: record.at,
    ...(record.userUninstalled === true ? { userUninstalled: true } : {}),
  }
}

/**
 * Read the ledger from `path`; a missing or unreadable/corrupt file yields an
 * empty ledger (fail-open: losing the report never blocks boot, R-1.1.4).
 * Entries that are not a well-formed result row are dropped.
 * @param path - absolute path of the durable ledger file.
 * @returns the parsed ledger, or an empty ledger when it is missing/corrupt.
 */
export function loadPreinstallResults(path: string): PersistedPreinstallResults {
  if (!existsSync(path)) return emptyPreinstallResults()
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
  } catch {
    return emptyPreinstallResults()
  }
  if (typeof parsed !== 'object' || parsed === null) return emptyPreinstallResults()
  const record = parsed as Record<string, unknown>
  if (record.version !== 1 || typeof record.entries !== 'object' || record.entries === null) {
    return emptyPreinstallResults()
  }
  const entries: Record<string, PreinstallEntryResult> = {}
  for (const [id, value] of Object.entries(record.entries as Record<string, unknown>)) {
    const entry = readEntry(value)
    if (entry !== null) entries[id] = entry
  }
  const ranAt = typeof record.ranAt === 'number' && Number.isFinite(record.ranAt) ? record.ranAt : null
  return { version: 1, ranAt, entries }
}

/**
 * Commit the ledger to `path` (creating its parent directory) as one atomic
 * replacement (FB5, TC-B4-H1 face 4: a crash mid-write can no longer corrupt
 * the tombstone carrier into the loader's fail-open empty shape — a lost
 * `userUninstalled` tombstone resurrecting a removed preinstall — and the
 * lock-free `report()` reader never observes half-written JSON, restoring the
 * atomic-write module-head protocol "readers stay lock-free because the
 * rename commit is atomic"). Mode `0o600`: the ledger carries user decision
 * data. Throws so the caller's lock-held cycle surfaces a write failure; no
 * compensation is needed because the in-memory model is rebuilt from disk on
 * the next pass.
 * @param path - the ledger file path (parent directories are created).
 * @param payload - the complete ledger to commit (serialized as v1 JSON).
 */
export function savePreinstallResults(path: string, payload: PersistedPreinstallResults): void {
  writeFileAtomicSync(path, JSON.stringify(payload, null, 2), 0o600)
}

/**
 * Project the durable ledger to the read-only client report.
 * @param payload - the durable ledger read from disk.
 * @returns the frozen client-facing preinstall report.
 */
export function toReport(payload: PersistedPreinstallResults): PreinstallReport {
  return Object.freeze({
    ranAt: payload.ranAt,
    entries: Object.freeze({ ...payload.entries }),
  })
}
