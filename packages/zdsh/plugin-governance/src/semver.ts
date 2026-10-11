/**
 * Shared minimal semver comparison for plugin governance.
 *
 * Single source of truth used by the registry's compatibility check and the
 * LoadGuard's version gate, so both can never disagree about whether a kernel
 * satisfies a manifest's declared window again.
 * @module @deepseek-ai/dsh-plugin-governance/semver
 */

type SemverParts = readonly [number, number, number, string]

/** Parse "major.minor.patch" plus optional "-prerelease" tag and "+build" metadata (ignored per semver spec). */
function parseSemver(version: string): SemverParts {
  const match = version.trim().match(/^(\d+)\.(\d+)\.(\d+)(?:-(.+))?(?:\+(.+))?$/u)
  if (match === null) return [0, 0, 0, version]
  return [Number(match[1]), Number(match[2]), Number(match[3]), match[4] ?? '']
}

/**
 * Compare dot-separated prerelease identifiers per semver precedence:
 * numeric identifiers compare numerically (`10` > `9`, not `'10' < '9'`),
 * numeric sorts below alphanumeric, and a shorter identifier set sorts lower.
 */
function comparePrerelease(a: string, b: string): number {
  const aParts = a.split('.')
  const bParts = b.split('.')
  const length = Math.max(aParts.length, bParts.length)
  for (let index = 0; index < length; index++) {
    const left = aParts[index]
    const right = bParts[index]
    if (left === undefined) return -1
    if (right === undefined) return 1
    const leftNumeric = /^\d+$/u.test(left)
    const rightNumeric = /^\d+$/u.test(right)
    if (leftNumeric && rightNumeric) {
      const delta = Number(left) - Number(right)
      if (delta !== 0) return delta
    } else if (leftNumeric !== rightNumeric) {
      // Numeric identifiers have lower precedence than alphanumeric ones.
      return leftNumeric ? -1 : 1
    } else if (left !== right) {
      return left < right ? -1 : 1
    }
  }
  return 0
}

/**
 * Minimal semver comparison: parses "major.minor.patch" and optional
 * prerelease tags. The SIGN of the result carries the precedence order; the
 * MAGNITUDE is the raw difference of the first differing component — for
 * example `semverCompare('0.1.1-rc.2', '0.1.5-rc.2')` returns `-4`, not `-1`.
 * Unparseable input degrades to the zero-version parse, whose prerelease slot
 * then holds the raw string, so the comparison falls back to a plain string
 * order on the raw value.
 *
 * Callers must compare against 0 (`> 0` / `>= 0` / `< 0`) and never against
 * `-1` / `1` exactly.
 * @param a - the first version string.
 * @param b - the second version string.
 * @returns the signed difference per semver precedence of `a` relative to `b`:
 * negative when `a < b`, `0` when equal, positive when `a > b`. The value is
 * NOT normalized to -1/0/1.
 */
export function semverCompare(a: string, b: string): number {
  const [aMaj, aMin, aPat, aPre] = parseSemver(a)
  const [bMaj, bMin, bPat, bPre] = parseSemver(b)
  if (aMaj !== bMaj) return aMaj - bMaj
  if (aMin !== bMin) return aMin - bMin
  if (aPat !== bPat) return aPat - bPat
  // prerelease has lower precedence than release
  if (aPre !== '' && bPre === '') return -1
  if (aPre === '' && bPre !== '') return 1
  if (aPre === '' && bPre === '') return 0
  return comparePrerelease(aPre, bPre)
}

/**
 * Check whether a version satisfies a semver range.
 *
 * Supports space-separated AND conditions (e.g. `">=0.1.0 <0.2.0"`),
 * and the operators `>=`, `<=`, `>`, `<`, `=`, `^`, `~`, and exact versions.
 * Prerelease versions are included in the comparison (includePrerelease
 * semantics), matching the reader-semantics discipline of `dsh.compatible`.
 *
 * @param version - the version to test.
 * @param range - the semver range expression.
 * @returns `true` when the version satisfies every condition in the range.
 */
export function semverSatisfies(version: string, range: string): boolean {
  const trimmed = range.trim()
  if (trimmed === '' || trimmed === '*') return true

  // Split by whitespace for AND conditions; every part must pass.
  const parts = trimmed.split(/\s+/).filter(part => part !== '')
  for (const part of parts) {
    if (!satisfiesSingle(version, part)) {
      return false
    }
  }
  return true
}

/** Evaluate a single condition (no whitespace) against a version. */
function satisfiesSingle(version: string, condition: string): boolean {
  if (condition.startsWith('^')) {
    return satisfiesCaret(version, condition.slice(1))
  }
  if (condition.startsWith('~')) {
    return satisfiesTilde(version, condition.slice(1))
  }
  if (condition.startsWith('>=')) {
    return semverCompare(version, condition.slice(2)) >= 0
  }
  if (condition.startsWith('<=')) {
    return semverCompare(version, condition.slice(2)) <= 0
  }
  if (condition.startsWith('>')) {
    return semverCompare(version, condition.slice(1)) > 0
  }
  if (condition.startsWith('<')) {
    return semverCompare(version, condition.slice(1)) < 0
  }
  if (condition.startsWith('=')) {
    return semverCompare(version, condition.slice(1)) === 0
  }
  // Bare version = exact match
  return semverCompare(version, condition) === 0
}

/** `^1.2.3` := `>=1.2.3 <2.0.0`; `^0.2.3` := `>=0.2.3 <0.3.0`; `^0.0.3` := `>=0.0.3 <0.0.4`. */
function satisfiesCaret(version: string, base: string): boolean {
  if (semverCompare(version, base) < 0) return false
  const [maj, min] = parseSemver(base)
  if (maj > 0) {
    return parseSemver(version)[0] === maj
  }
  if (min > 0) {
    const [vMaj, vMin] = parseSemver(version)
    return vMaj === 0 && vMin === min
  }
  return semverCompare(version, base) === 0
}

/** `~1.2.3` := `>=1.2.3 <1.3.0`. */
function satisfiesTilde(version: string, base: string): boolean {
  if (semverCompare(version, base) < 0) return false
  const [maj, min] = parseSemver(base)
  const [vMaj, vMin] = parseSemver(version)
  return vMaj === maj && vMin === min
}
