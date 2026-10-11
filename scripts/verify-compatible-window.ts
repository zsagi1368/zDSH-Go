/**
 * zDSH compatible-window gate (sync-020 / DECIDE-dsh-compatible-RULING, W-main).
 *
 * Rule R (the single value-shape rule for `dsh.compatible`): the UPPER bound is
 * the base minor's NEXT minor, exclusive; the LOWER bound is the lowest base
 * actually built and is NOT moved by this rule. With the base at
 * `0.<minor>.<patch>` the rule derives `<0.<minor+1>.0`; a base that enters
 * the next minor therefore makes the in-place value disagree with the derived
 * one, which turns this gate RED and forces a rotation.
 *
 * Why this file exists: the eight factory-seeded artifacts each declare
 * `dsh.compatible` in their own source repository, and the shipped products in
 * `node_modules/.pnpm` carry whatever was resolved at pin-rotation time. The
 * pre-existing assertion surface (Workbench `tests/manifest.client.spec.ts`)
 * is a `toBe` literal lock in ONE source repository: it detects a value that
 * changed when it should not have, never a value that SHOULD have changed and
 * did not. This gate reads the RESOLVED products (the bytes a user actually
 * installs) and asserts the value against rule R, so the "should have changed"
 * direction is mechanically enforced instead of remembered.
 *
 * Carrier (evidence card §9.2): the resolved manifest at
 * `node_modules/.pnpm/<dirName>@<lock-hash>/node_modules/<dirName>/package.json`,
 * resolved by WILDCARD over the `<dirName>@` prefix — the directory suffix is a
 * lock hash that changes on every lock regeneration, so a hardcoded hash is a
 * defect. A missing or ambiguous resolved product THROWS (never skips): the
 * point of the gate is that an absent carrier is loudly visible.
 *
 * Waiver (explicit divergence record, ruling step 0.2): the eight products
 * currently ship the pre-rule value, so each known divergence is recorded in
 * `scripts/verify-compatible-window.waiver.json` with the base (major, minor)
 * it was written against plus its removal trigger. An entry is valid only
 * while the current base does not exceed that pair: a larger
 * `validForBaseMajor`, or the same major with `validForBaseMinor >= baseMinor`.
 * Once the base advances past it in EITHER field the entry expires, the
 * divergence is unwaived, and the gate reports the expected bound (rule R
 * self-invalidation, not a human remembering to delete a line). The pair is
 * the key, not the bare minor: at base 1.0.0 the minor resets to 0, so a
 * bare-minor comparison would revive every waiver written for 0.2 and silently
 * keep the gate green across a major bump (REVIEW-EXEC-WMAIN root cause).
 * Evidence lines render the pair as `validForBase <major>.<minor>`.
 * A used waiver whose recorded observed upper no longer matches reality is
 * itself a violation, so the waiver cannot silently lie about what it covers.
 *
 * Deliberately NOT a spec: `scripts/**\/*.spec.ts` lands in the main vitest
 * include and would churn the aggregate baseline count (precedent:
 * `scripts/audit-compat-roster.ts`).
 *
 * CI: the zdsh-ci.yml contract-gates lane runs this after
 * `pnpm install --frozen-lockfile` (the resolved products only exist after an
 * install, the same premise as `scripts/audit-compat-roster.ts`).
 *
 * Run: `pnpm exec tsx scripts/verify-compatible-window.ts`
 * (exit 0 = every artifact matches rule R or a non-expired waiver; non-zero =
 * per-artifact diff on stderr: artifact + actual + expected).
 *
 * Drill (mechanical RED check, ruling step 0.2): `pnpm exec tsx
 * scripts/verify-compatible-window.ts --base-version <next-minor>` simulates
 * the base moving forward. The override may only RAISE the derived bound — a
 * value below the repository manifest version is rejected — and it must stay in
 * the manifest's MAJOR line: the drill rehearses the in-major pin rotation
 * (0.2.x -> 0.3.x), while a genuine cross-major base is exercised by the
 * default path, where the (major, minor) waiver key expires correctly (see
 * below). Both constraints are monotone in the base — raising the base can only
 * expire MORE waivers — so the drill flag cannot be used to fake a green run.
 * @module scripts/verify-compatible-window
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { semverCompare } from '../packages/zdsh/plugin-governance/src/semver.ts'

/** Rule R, verbatim, for evidence lines and waiver cross-reference. */
export const RULE_R =
  'dsh.compatible upper bound = the base minor\'s next minor (exclusive); lower bound = the lowest base actually built (not moved by this rule)'

/** One factory-seeded artifact and where its resolved manifest lives. */
export interface ArtifactSpec {
  /** Stable identity, also the waiver key: the artifact's package short name. */
  id: string
  /**
   * Resolved-product directory name under `node_modules/.pnpm` before the `@`
   * (the `.pnpm` entry is `<dirName>@<lock-hash-suffix>`). Unscoped by
   * construction: the factory artifacts publish under short names.
   */
  dirName: string
  /** Manifest path inside the resolved package directory. */
  relPath: string
}

/**
 * The eight factory-seeded artifacts (seed.json entries). The WebStack trio
 * resolves through one monorepo product; the other five are single packages.
 */
export const ARTIFACTS: readonly ArtifactSpec[] = [
  { id: 'dsh-autopilot', dirName: 'dsh-autopilot', relPath: 'package.json' },
  { id: 'dsh-filehub', dirName: 'dsh-filehub', relPath: 'package.json' },
  { id: 'dsh-omnivision', dirName: 'dsh-omnivision', relPath: 'package.json' },
  { id: 'dsh-plugin-center', dirName: 'dsh-plugin-center', relPath: 'package.json' },
  { id: 'zdsh-workbench', dirName: 'zdsh-workbench', relPath: 'package.json' },
  { id: 'dsh-webstack-bridge', dirName: 'dsh-webstack-monorepo', relPath: 'packages/bridge/package.json' },
  { id: 'dsh-webstack-verticals', dirName: 'dsh-webstack-monorepo', relPath: 'packages/verticals/package.json' },
  { id: 'dsh-webstack', dirName: 'dsh-webstack-monorepo', relPath: 'packages/webstack/package.json' },
]

/** One explicit divergence record. */
export interface WaiverEntry {
  /** Artifact id (must match an {@link ARTIFACT} id). */
  artifact: string
  /** Upper bound the waiver was written for, e.g. `0.2.0` (integrity check). */
  observedUpper: string
  /**
   * Major of the base this waiver was written against, paired with
   * {@link validForBaseMinor}. Expiry compares the (major, minor) PAIR, so a
   * major bump alone expires the entry instead of resetting the minor to 0 and
   * silently reviving it.
   */
  validForBaseMajor: number
  /**
   * Minor of the base this waiver was written against, paired with
   * {@link validForBaseMajor}. The entry is EXPIRED once the current base
   * exceeds the (validForBaseMajor, validForBaseMinor) pair (rule R
   * self-invalidation).
   */
  validForBaseMinor: number
  /** Removal trigger: what the next pin rotation must do to drop this line. */
  removeWhen: string
}

/** Shape of `scripts/verify-compatible-window.waiver.json`. */
export interface WaiverFile {
  /** Rule R restated (cross-reference only; the script owns the rule). */
  rule: string
  /** Lower-bound source record (B3: intake-wide convention, not per-repo). */
  lowerBoundNote: string
  entries: WaiverEntry[]
}

/** Type guard for an untrusted waiver entry. */
function isWaiverEntry(value: unknown): value is WaiverEntry {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const candidate = value as Record<string, unknown>
  return typeof candidate.artifact === 'string'
    && typeof candidate.observedUpper === 'string'
    && typeof candidate.validForBaseMajor === 'number'
    && typeof candidate.validForBaseMinor === 'number'
}

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

/** Read a JSON object, failing loudly on a malformed shape. */
function readJsonObject(file: string): Record<string, unknown> {
  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (error) {
    throw new Error(`compatible-window gate: cannot read ${file} (${String(error)})`)
  }
  const parsed: unknown = JSON.parse(raw)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`compatible-window gate: ${file} must contain a JSON object`)
  }
  return parsed as Record<string, unknown>
}

/** Extract the base `major.minor` from a semantic version, throwing otherwise. */
function baseMajorMinor(version: string): { major: number; minor: number } {
  const match = /^(\d+)\.(\d+)\.\d+/u.exec(version.trim())
  if (match === null) {
    throw new Error(`compatible-window gate: unparseable base version ${JSON.stringify(version)} (expected major.minor.patch…)`)
  }
  return { major: Number(match[1]), minor: Number(match[2]) }
}

/** Rule R: derive the exclusive upper bound from the base version. */
export function deriveUpperBound(baseVersion: string): string {
  const { major, minor } = baseMajorMinor(baseVersion)
  return `${String(major)}.${String(minor + 1)}.0`
}

/** Pull the upper bound out of a `dsh.compatible` window, or undefined. */
export function upperBoundOf(range: string): string | undefined {
  const index = range.indexOf('<')
  if (index < 0) return undefined
  const token = range.slice(index + 1).trim().split(/\s+/u)[0]
  return token === undefined || token === '' ? undefined : token
}

/**
 * Resolve one artifact manifest through the WILDCARD `.pnpm` entry.
 * @returns the absolute manifest path.
 * @throws when the resolved product is missing or ambiguous (fail-closed).
 */
export function resolveArtifactManifest(spec: ArtifactSpec): string {
  const pnpmDir = path.join(repoRoot, 'node_modules', '.pnpm')
  let entries: string[]
  try {
    entries = fs.readdirSync(pnpmDir)
  } catch (error) {
    throw new Error(
      `compatible-window gate: cannot list ${pnpmDir} (${String(error)}) — run \`pnpm install\` first; this gate reads resolved products, it never skips them`,
    )
  }
  const prefix = `${spec.dirName}@`
  const matches = entries.filter(entry => entry.startsWith(prefix))
  const dir = matches[0]
  if (dir === undefined) {
    throw new Error(
      `compatible-window gate: fail-closed — no resolved product for ${spec.id} (looked for ${prefix}* under ${pnpmDir}); a missing carrier is a breach, not a skip`,
    )
  }
  if (matches.length > 1) {
    throw new Error(
      `compatible-window gate: fail-closed — ${String(matches.length)} resolved products match ${prefix}* (${matches.join(', ')}); resolve the duplicate before trusting any verdict`,
    )
  }
  return path.join(pnpmDir, dir, 'node_modules', spec.dirName, spec.relPath)
}

/** Read a flag of the form `--name value`, or undefined when absent. */
function flagValue(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  if (index < 0) return undefined
  const value = process.argv[index + 1]
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`compatible-window gate: --${name} requires a value`)
  }
  return value
}

const rootManifest = readJsonObject(path.join(repoRoot, 'package.json'))
const manifestBase = rootManifest.version
if (typeof manifestBase !== 'string') {
  throw new Error('compatible-window gate: root package.json has no string `version`')
}

// Drill override (ruling step 0.2 acceptance): may only raise the derived
// bound, never lower it, so it cannot manufacture a green run.
const override = flagValue('base-version')
let baseVersion = manifestBase
if (override !== undefined) {
  if (semverCompare(override, manifestBase) < 0) {
    throw new Error(
      `compatible-window gate: --base-version ${override} is below the manifest version ${manifestBase}; the drill may only move the base FORWARD (anti-bypass)`,
    )
  }
  // Same-major constraint on the DRILL (scope, not an anti-bypass necessity):
  // expiry itself is now a (major, minor) tuple comparison, so a cross-major
  // base expires waivers correctly on the default path. The drill keeps the
  // manifest's major line because it exists to rehearse the in-major pin
  // rotation; letting one flag also stand in for a cross-major base would make
  // it mean two different rehearsals. Neither rule can manufacture a green run:
  // raising the base can only expire MORE waivers.
  const overrideBase = baseMajorMinor(override)
  const manifestBaseParts = baseMajorMinor(manifestBase)
  if (overrideBase.major !== manifestBaseParts.major) {
    throw new Error(
      `compatible-window gate: --base-version ${override} crosses a major boundary against the manifest version ${manifestBase} (major ${String(overrideBase.major)} != ${String(manifestBaseParts.major)}); the drill may only move the base WITHIN the manifest major line — it rehearses the in-major pin rotation, and a genuine cross-major base is covered by the default path, where the (major, minor) waiver key expires correctly`,
    )
  }
  baseVersion = override
  console.error(`[compat-window] drill: base version overridden to ${baseVersion} (manifest: ${manifestBase})`)
}

const baseParts = baseMajorMinor(baseVersion)
const baseMinor = baseParts.minor
const expectedUpper = deriveUpperBound(baseVersion)

const waiverPath = path.join(repoRoot, 'scripts', 'verify-compatible-window.waiver.json')
const waiverRaw = readJsonObject(waiverPath)
const waiverEntries = waiverRaw.entries
if (!Array.isArray(waiverEntries)) {
  throw new Error(`compatible-window gate: ${waiverPath} has no "entries" array`)
}
const waivers = new Map<string, WaiverEntry>()
for (const entry of waiverEntries as unknown[]) {
  if (!isWaiverEntry(entry)) {
    throw new Error(`compatible-window gate: malformed waiver entry ${JSON.stringify(entry)}`)
  }
  waivers.set(entry.artifact, entry)
}

interface ArtifactVerdict {
  id: string
  upper: string | undefined
  declared: string
  verdict: 'aligned' | 'waived' | 'violation'
  detail: string
}

const verdicts: ArtifactVerdict[] = []
const usedWaivers = new Set<string>()
const violations: string[] = []

for (const spec of ARTIFACTS) {
  const manifest = readJsonObject(resolveArtifactManifest(spec))
  const dsh = manifest.dsh
  const compatible = typeof dsh === 'object' && dsh !== null && !Array.isArray(dsh)
    ? (dsh as Record<string, unknown>).compatible
    : undefined
  if (typeof compatible !== 'string' || compatible.trim() === '') {
    const detail = `${spec.id}: resolved manifest declares no string dsh.compatible`
    violations.push(detail)
    verdicts.push({ id: spec.id, upper: undefined, declared: '', verdict: 'violation', detail })
    continue
  }
  const upper = upperBoundOf(compatible)
  if (upper === undefined) {
    const detail = `${spec.id}: dsh.compatible ${JSON.stringify(compatible)} has no upper bound`
    violations.push(detail)
    verdicts.push({ id: spec.id, upper: undefined, declared: compatible, verdict: 'violation', detail })
    continue
  }
  if (upper === expectedUpper) {
    verdicts.push({ id: spec.id, upper, declared: compatible, verdict: 'aligned', detail: `${spec.id}: upper ${upper} == rule R derived ${expectedUpper}` })
    continue
  }

  const waiver = waivers.get(spec.id)
  if (waiver === undefined) {
    const detail = `${spec.id}: actual upper ${upper} != rule R derived ${expectedUpper} (no waiver)`
    violations.push(detail)
    verdicts.push({ id: spec.id, upper, declared: compatible, verdict: 'violation', detail })
    continue
  }
  // (major, minor) tuple comparison, NOT a bare minor: a larger major expires
  // the entry even when the bare minor would look "younger" (base 1.0.0 resets
  // the minor to 0, which is how the gate used to stay green across a major
  // bump — REVIEW-EXEC-WMAIN root cause).
  const waiverExpired = waiver.validForBaseMajor < baseParts.major
    || (waiver.validForBaseMajor === baseParts.major && waiver.validForBaseMinor < baseParts.minor)
  if (waiverExpired) {
    const detail = `${spec.id}: actual upper ${upper} != rule R derived ${expectedUpper}; waiver expired (validForBase ${String(waiver.validForBaseMajor)}.${String(waiver.validForBaseMinor)} < base ${String(baseParts.major)}.${String(baseParts.minor)}) — rotate the value and drop the waiver line`
    violations.push(detail)
    verdicts.push({ id: spec.id, upper, declared: compatible, verdict: 'violation', detail })
    continue
  }
  if (waiver.observedUpper !== upper) {
    const detail = `${spec.id}: waiver records observed upper ${waiver.observedUpper} but the resolved product ships ${upper}; the waiver no longer describes the divergence it covers`
    violations.push(detail)
    verdicts.push({ id: spec.id, upper, declared: compatible, verdict: 'violation', detail })
    continue
  }
  usedWaivers.add(spec.id)
  verdicts.push({ id: spec.id, upper, declared: compatible, verdict: 'waived', detail: `${spec.id}: upper ${upper} diverges from rule R derived ${expectedUpper}; covered by waiver (validForBase ${String(waiver.validForBaseMajor)}.${String(waiver.validForBaseMinor)})` })
}

// A waiver line whose artifact now MATCHES rule R covers nothing: the rotation
// that realigned the value is expected to delete its line. Reported as a
// warning, not a violation — the aligned verdict came from the value itself,
// so an inert line cannot manufacture a false green. (Entries that failed the
// expiry check are already violations, so they are excluded here.)
// ORPHAN waivers (artifact not in ARTIFACTS) are also warned: a waiver for a
// non-existent artifact is dead config that should be cleaned up.
const staleWaivers = [...waivers.keys()].filter((id) => {
  const verdict = verdicts.find(v => v.id === id)
  if (verdict === undefined) return true  // orphan: artifact not in ARTIFACTS
  return verdict.verdict === 'aligned'
})

const evidence = {
  baseVersion,
  baseMinor,
  expectedUpper,
  artifacts: Object.fromEntries(verdicts.map(v => [v.id, { declared: v.declared, upper: v.upper ?? null, verdict: v.verdict }])),
}
console.log(`COMPAT_WINDOW_JSON: ${JSON.stringify(evidence)}`)
console.log(`COMPAT_WINDOW_WAIVERS: ${JSON.stringify([...usedWaivers].sort())}`)

console.error(`[compat-window] base ${baseVersion} ⇒ rule R derived upper <${expectedUpper}>; ${String(ARTIFACTS.length)} artifacts checked (${String(usedWaivers.size)} waived)`)
for (const verdict of verdicts) {
  console.error(`[compat-window] ${verdict.verdict.padEnd(9)} ${verdict.detail}`)
}
for (const id of staleWaivers) {
  const verdict = verdicts.find(v => v.id === id)
  if (verdict === undefined) {
    console.error(`[compat-window] warning: waiver entry ${id} is ORPHAN (artifact not in ARTIFACTS); drop the line`)
  } else {
    console.error(`[compat-window] warning: waiver entry ${id} covers no divergence (already aligned); drop the line when convenient`)
  }
}

if (violations.length > 0) {
  console.error(`[compat-window] FAIL: ${String(violations.length)} of ${String(ARTIFACTS.length)} artifacts violate rule R (${RULE_R}):`)
  for (const violation of violations) console.error(`[compat-window]   - ${violation}`)
  process.exitCode = 1
} else {
  console.error('[compat-window] OK: every artifact matches rule R or a non-expired waiver.')
}
