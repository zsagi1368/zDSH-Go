/**
 * The Windows quality-gate known-failure roster loader.
 *
 * `scripts/ci-windows-known-failures.json` is the ONLY sanctioned way for a
 * spec file to stay red on the `CI` (Windows quality gate) lane without
 * failing it. Admission rules (TC-CI-GREEN §2, decision D23):
 *
 *  1. the file fails on a pristine reference tree too (upstream or environment
 *     face; evidenced by the P6 comparison run in the campaign logs), or
 *  2. the failure is a REGISTERED Go semantic deviation (the TD-2/TD-3
 *     families already booked in the campaign DEBT ledger).
 *
 * Anything else must keep failing the lane: the roster is never a
 * red-to-green switch, so the guards below fail closed and refuse to load.
 *
 * Guards:
 *  - entries name EXACT repo-relative spec paths (no glob magic), so one entry
 *    cannot mask sibling files or examples added later;
 *  - every entry carries a non-empty reason plus at least one evidence
 *    reference, and every listed file must exist;
 *  - unknown lanes, unknown keys, and non-spec paths are rejected;
 *  - a `..` segment is rejected before the existence check (a traversal path
 *    can resolve outside the repository root, which would make the roster name
 *    a file the repository does not own);
 *  - duplicate paths are rejected: the second entry would be dead weight on a
 *    single exclusion and would split one file's evidence across two rows.
 *
 * Lanes: `github-windows-ci` entries fail on the hosted Windows runner and on
 * workstations alike; `workstation` entries reproduce only in this development
 * machine's shell environment (GNU tar / PATH / symlink faces) and are
 * deliberately NOT excluded while `GITHUB_ACTIONS=true`, so the hosted runner
 * keeps covering those files.
 *
 * @module scripts/ci-windows-known-failures
 */

import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

/** Repository-relative path of the roster file. */
export const KNOWN_FAILURES_PATH = 'scripts/ci-windows-known-failures.json'

/** The lanes the roster may tag entries with. */
export const KNOWN_FAILURE_LANES = ['github-windows-ci', 'workstation'] as const

/** One lane the roster may tag an entry with. */
export type KnownFailureLane = (typeof KNOWN_FAILURE_LANES)[number]

/** One registered known failure. */
export interface KnownFailureEntry {
  /** Exact repo-relative spec path; the lane excludes this file only. */
  readonly path: string
  /** Where the failure is expected: the hosted runner, or this workstation too. */
  readonly lane: KnownFailureLane
  /** Why this failure is admitted to the roster (never a bare "it is red"). */
  readonly reason: string
  /** Where the admission is evidenced (campaign logs, ledgers, comparison runs). */
  readonly evidence: readonly string[]
}

const ENTRY_KEYS = ['path', 'lane', 'reason', 'evidence'] as const
const ROSTER_KEYS = ['$comment', 'entries'] as const

/** Fail-closed roster error: the lane refuses to run on a malformed roster. */
export class KnownFailuresRosterError extends Error {}

/** The repository root, derived from this module's own location (`scripts/`). */
export function repositoryRoot(): string {
  return fileURLToPath(new URL('..', import.meta.url))
}

/**
 * Read and validate the roster.
 * @param root - repository root (defaults to the directory holding `scripts/`).
 * @returns the validated entries, in file order.
 */
export function loadKnownFailures(root: string = repositoryRoot()): readonly KnownFailureEntry[] {
  const file = resolve(root, KNOWN_FAILURES_PATH)
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    throw new KnownFailuresRosterError(`${KNOWN_FAILURES_PATH} is not readable JSON: ${String(error)}`)
  }
  if (!isRecord(parsed)) throw new KnownFailuresRosterError(`${KNOWN_FAILURES_PATH} must be a JSON object`)
  for (const key of Object.keys(parsed)) {
    if (!(ROSTER_KEYS as readonly string[]).includes(key)) {
      throw new KnownFailuresRosterError(`${KNOWN_FAILURES_PATH} carries unknown key ${JSON.stringify(key)}`)
    }
  }
  const { entries } = parsed
  if (!Array.isArray(entries)) throw new KnownFailuresRosterError(`${KNOWN_FAILURES_PATH} must define an entries array`)
  const validated = entries.map((entry, index) => validateEntry(entry, index, root))
  // One file, one entry: a duplicate would split one file's evidence across two
  // rows and silently change nothing on the wire (the same path is excluded once).
  const seen = new Set<string>()
  for (const entry of validated) {
    if (seen.has(entry.path)) {
      throw new KnownFailuresRosterError(`${KNOWN_FAILURES_PATH} lists ${entry.path} more than once`)
    }
    seen.add(entry.path)
  }
  return validated
}

/**
 * The exclusion patterns active for this process: hosted-runner entries apply
 * everywhere, workstation-only entries apply only off the hosted runner.
 * @param env - environment to read `GITHUB_ACTIONS` from.
 * @returns the repo-relative spec paths to exclude.
 */
export function activeKnownFailurePaths(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  const hostedRunner = env.GITHUB_ACTIONS === 'true'
  return loadKnownFailures()
    .filter(entry => entry.lane === 'github-windows-ci' || !hostedRunner)
    .map(entry => entry.path)
}

function validateEntry(entry: unknown, index: number, root: string): KnownFailureEntry {
  const at = `${KNOWN_FAILURES_PATH} entries[${index}]`
  if (!isRecord(entry)) throw new KnownFailuresRosterError(`${at} must be an object`)
  for (const key of Object.keys(entry)) {
    if (!(ENTRY_KEYS as readonly string[]).includes(key)) {
      throw new KnownFailuresRosterError(`${at} carries unknown key ${JSON.stringify(key)}`)
    }
  }
  const { path, lane, reason, evidence } = entry
  if (typeof path !== 'string' || path.length === 0) throw new KnownFailuresRosterError(`${at}.path must be a non-empty string`)
  // Exact paths only: glob magic would silently widen one entry to whole
  // directories, which is exactly the masking this roster must prevent.
  if (/[*?[\]{}!]/.test(path)) throw new KnownFailuresRosterError(`${at}.path must be an exact path without glob magic, got ${JSON.stringify(path)}`)
  if (!/^packages\/|^apps\/|^scripts\/|^website\//.test(path)) throw new KnownFailuresRosterError(`${at}.path must be a repo-relative test path, got ${JSON.stringify(path)}`)
  // Traversal is rejected BEFORE the existence check: `resolve(root, path)`
  // follows `..`, so an escaping path would be validated against a file outside
  // the repository the roster is supposed to speak for.
  if (path.split('/').includes('..')) throw new KnownFailuresRosterError(`${at}.path must not carry a '..' segment, got ${JSON.stringify(path)}`)
  if (!/\.spec\.tsx?$/.test(path)) throw new KnownFailuresRosterError(`${at}.path must name a .spec.ts(x) file, got ${JSON.stringify(path)}`)
  if (!existsSync(resolve(root, path))) throw new KnownFailuresRosterError(`${at}.path does not exist: ${path}`)
  if (typeof lane !== 'string' || !(KNOWN_FAILURE_LANES as readonly string[]).includes(lane)) {
    throw new KnownFailuresRosterError(`${at}.lane must be one of ${KNOWN_FAILURE_LANES.join(' | ')}, got ${JSON.stringify(lane)}`)
  }
  if (typeof reason !== 'string' || reason.trim().length === 0) throw new KnownFailuresRosterError(`${at}.reason must state why the failure is admitted`)
  if (!Array.isArray(evidence) || evidence.length === 0) throw new KnownFailuresRosterError(`${at}.evidence must list at least one reference`)
  for (const reference of evidence) {
    if (typeof reference !== 'string' || reference.trim().length === 0) {
      throw new KnownFailuresRosterError(`${at}.evidence entries must be non-empty strings`)
    }
  }
  return { path, lane: lane as KnownFailureLane, reason, evidence }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
