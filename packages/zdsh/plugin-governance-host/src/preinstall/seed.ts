/**
 * Seed manifest reader for the factory preinstall pass.
 *
 * The seed file (`zdsh-factory/seed.json`, schema frozen in
 * DESIGN-intake-tech.md §1.1) is an untrusted, declarative document. This
 * module consumes it through an explicit **field whitelist** (reviewer
 * 建议②): only the fields the executor actually acts on are read; every
 * other key — the manifest-level `$comment` / `entryFields` prose and any
 * future explanatory fields — is ignored wholesale rather than validated.
 *
 * The whitelist is a deny-by-default surface: an entry is kept only when its
 * `id` and `source` are present and well-formed. A seed whose `entries` is
 * empty (the current skeleton state) parses to a zero-length list, so the
 * preinstall pass is a pure no-op passthrough (TC-B1-1.2b 验收直通用例).
 * @module @deepseek-ai/dsh-plugin-governance-host/src/preinstall/seed
 */

// FB6 (TC-B4-H1 face 5): the exact-version contract branch shares ONE spec
// grammar with the install channel (parseNpmSpec) — no second npm: dialect.
// No cycle: registry-source imports only node builtins.
import { parseNpmSpec } from '../install/registry-source.ts'

/** One whitelisted seed entry as the executor consumes it (§1.1 schema). */
export interface SeedEntry {
  /** Canonical governance id (`namespace/name`, same key space as the registry). */
  readonly id: string
  /** npm package name the source resolves against (parse anchor). */
  readonly package: string
  /** Exact semver the entry pins (V25 exact-version-only policy). */
  readonly version: string
  /** 40-hex git commit the supply chain pins (local: integrity carrier). */
  readonly pin: string
  /** Two-state source: `local:<in-repo path>` or `npm:<name>[@<ver>]`. */
  readonly source: string
  /** sha512 for `npm:` sources (V25 tarball check; mandatory, S2); `null` for `local:` (§1.1-D1). */
  readonly integrity: string | null
  /** Whether the plugin activates at boot; `false` = installed-but-disabled. */
  readonly enabledAtBoot: boolean
  /** Family tag (webstack / -bridge / -verticals batch grouping). */
  readonly family: string
  /** Failure posture; `fail-open` is the only legal value (S2 rejects others, never silently). */
  readonly failPolicy: string
}

/** Parsed seed manifest: the version gate plus the whitelisted entries. */
export interface SeedManifest {
  /** Schema version, always the accepted constant for a valid seed. */
  readonly version: number
  /** Entries the whitelist accepted, in file order. Empty ⇒ zero-action pass. */
  readonly entries: readonly SeedEntry[]
}

/** The only seed schema version this reader understands. */
export const SEED_SCHEMA_VERSION = 1

/** The only failure posture this executor implements (R-1.1.4, §1.1 schema). */
export const SUPPORTED_FAIL_POLICY = 'fail-open'

/** Narrow one parsed JSON value to a plain object view. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Trimmed non-empty string, else `null`. */
function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

/** Read one whitelisted entry, or `null` when it is missing a load-bearing field. */
function parseEntry(value: unknown): SeedEntry | null {
  if (!isRecord(value)) return null
  // id + source are load-bearing: without them the entry is inert and skipped.
  const id = str(value.id)
  const source = str(value.source)
  if (id === null || source === null) return null
  // `local:` must name a path, `npm:` a package spec; anything else is dropped.
  if (!(source.startsWith('local:') || source.startsWith('npm:'))) return null
  return {
    id,
    package: str(value.package) ?? id,
    version: str(value.version) ?? '0.0.0',
    pin: str(value.pin) ?? '',
    source,
    integrity: str(value.integrity),
    // Absent or non-boolean reads as disabled: boot-activation is opt-in.
    enabledAtBoot: value.enabledAtBoot === true,
    family: str(value.family) ?? '',
    // S2 (EXEC7 建议②): an absent field keeps the documented default, but a
    // present-but-unusable one (non-string, blank, or any string other than
    // fail-open) must not be laundered into that default — it is surfaced as
    // an `invalid:<type>` marker that {@link seedEntryContractIssue} rejects.
    failPolicy: value.failPolicy === undefined
      ? 'fail-open'
      : str(value.failPolicy) ?? `invalid:${typeof value.failPolicy}`,
  }
}

/**
 * The S2 seed-entry contract check (EXEC7 建议②, DESIGN §1.1 schema notes):
 * the executor refuses — as a queryable `failed` ledger row, never a silent
 * downgrade — any entry whose declared posture it cannot honor:
 *
 * - `failPolicy` other than the only implemented value `fail-open` (a seed
 *   declaring `fail-closed` must NOT be quietly installed fail-open, or the
 *   "single legal value this campaign" declaration loses its teeth);
 * - an `npm:` source without a mandatory `sha512-…` integrity value (§1.1-D1
 *   marks it required; the parser previously treated the constraint as prose
 *   only, so the executor now rejects the contract violation up front rather
 *   than downloading through an unpinned spec);
 * - an `npm:` source without an exact `@<version>` pin (FB6, TC-B4-H1 face 5,
 *   D1b §3-FB6): `parseNpmSpec` accepts an unversioned `npm:<name>` for
 *   OPERATOR installs — the documented "omitting the version picks the
 *   registry's latest stable" semantics — but a boot-time seed row floating
 *   to whatever `latest` means today is a supply-chain drift window, so the
 *   seed contract is stricter than the operator channel (V25 exact-version-
 *   only policy) and rejects the row up front as a queryable failed ledger
 *   entry instead of downloading through an unpinned spec.
 *
 * @param entry - one whitelist-accepted seed entry.
 * @returns a correction-oriented reason, or `null` when the entry is honored.
 */
export function seedEntryContractIssue(entry: SeedEntry): string | null {
  if (entry.failPolicy !== SUPPORTED_FAIL_POLICY) {
    return `failPolicy ${JSON.stringify(entry.failPolicy)} is not implemented; the only supported value is ${JSON.stringify(SUPPORTED_FAIL_POLICY)}`
  }
  if (entry.source.startsWith('npm:')) {
    if (entry.integrity === null || !entry.integrity.startsWith('sha512-')) {
      return 'npm: sources must declare a sha512- integrity value (§1.1-D1: mandatory for the npm: form)'
    }
    // FB6: exact-version pin mandatory for boot rows (grammar shared with the
    // install channel — one parseNpmSpec, no second spec dialect).
    const spec = parseNpmSpec(entry.source)
    if (spec === null || spec.version === undefined) {
      return 'npm: sources must pin an exact @<version> in a seed row (boot-time installs never float to the registry latest; V25 exact-version-only policy)'
    }
  }
  return null
}

/**
 * Parse a raw seed document into the whitelisted view. A missing, non-object,
 * or wrong-version document yields an empty entry list (the caller treats a
 * file that is not present as a whole-pass no-op; a malformed or versioned-
 * differently file is likewise inert rather than fatal — fail-open, R-1.1.4).
 * @param raw - the parsed JSON value read from the seed file, or `undefined`.
 * @returns the accepted schema version and the whitelist-accepted entries.
 */
export function parseSeedManifest(raw: unknown): SeedManifest {
  if (!isRecord(raw)) return { version: SEED_SCHEMA_VERSION, entries: [] }
  if (raw.version !== SEED_SCHEMA_VERSION) return { version: SEED_SCHEMA_VERSION, entries: [] }
  const list = Array.isArray(raw.entries) ? raw.entries : []
  const entries: SeedEntry[] = []
  for (const value of list) {
    const entry = parseEntry(value)
    if (entry !== null) entries.push(entry)
  }
  return { version: SEED_SCHEMA_VERSION, entries }
}
