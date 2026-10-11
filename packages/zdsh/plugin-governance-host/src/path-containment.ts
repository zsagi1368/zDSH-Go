/**
 * Path-containment guards for untrusted declarative inputs (TC-B4-H1 face 6;
 * D1a F7 [建议] + D1b §4 F7 主判定: the seed file is an UNTRUSTED declarative
 * document — its field whitelist already denies by default, and this module
 * extends the same posture to path semantics).
 *
 * Shape: the filehub `isStrictlyInside` equivalent form (D1a :207 reusable-
 * fix origin): `resolve` + `relative` + reject `''` (equal-root) + reject
 * `..` segments + reject `isAbsolute(rel)` (cross-drive on win32). Deliberately
 * NOT `startsWith` — the zdsh-security-patterns segment-comparison trap
 * (`C:\repo` vs `C:\repo-evil` prefix collision) is immune by construction
 * with the relative form.
 *
 * Junction/symlink mine (the third patterns trap): a textual-inside path whose
 * link body redirects OUT of the root is re-checked through
 * `realpathSync.native` on BOTH sides (same-coordinate-system discipline, the
 * path-guard shape). Erratum vs the report prose (RECEIPT-H1 §2.5 勘误4):
 * D1a/D1b suggested "lstat rejects symlink/junction bodies" — landing that
 * literally would false-kill all eight factory rows, whose bundle
 * `node_modules` entries ARE pnpm junctions (D1b §4.2 self-evidence). The
 * normalized-containment form keeps the junction mine locked (a link escaping
 * the root fails) while in-root pnpm junctions pass — the G1 "junction with a
 * single in-root target = normal" philosophy, and the K-1.2.1 zero-false-kill
 * discipline for the factory eight.
 * @module @deepseek-ai/dsh-plugin-governance-host/src/path-containment
 */
import { realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'

/**
 * Whether `candidate` resolves to a location strictly inside `root`.
 *
 * Rejects: equal-root (`''` relative), any `..` segment (per-segment equality,
 * never a prefix comparison — `..foo` is a legal name), and an absolute
 * relative (win32 cross-drive, and POSIX cross-device forms `relative` cannot
 * express as segments).
 * @param root - the containment root (resolved internally).
 * @param candidate - the path to judge (resolved internally).
 * @returns `true` only when the candidate is a strict descendant of the root.
 */
export function isStrictlyInside(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate))
  if (rel === '') return false
  if (isAbsolute(rel)) return false
  for (const segment of rel.split(sep)) {
    if (segment === '..') return false
  }
  return true
}

/**
 * Resolve one untrusted `local:` path spec against its containment root,
 * enforcing textual AND link-normalized containment (F7 second door).
 *
 * Absent paths are NOT an error here: absence is judged by the install face's
 * own semantics (`not an existing local directory`), keeping this guard's
 * failure surface exactly "escape", so a failed ledger row's reason names the
 * containment violation rather than masking an ordinary missing artifact.
 * @param root - the containment root (the repository root for seed sources).
 * @param pathSpec - the raw path from the untrusted declaration (absolute or
 *   root-relative).
 * @param what - human-readable label of the value being guarded, used in the
 *   correction-oriented error message.
 * @returns the resolved (textual) absolute path — the same value the pre-gate
 *   code produced for legal rows, so downstream shapes are untouched.
 * @throws Error with a queryable reason when the resolved path escapes the
 *   root textually (`..`/outside absolute/cross-drive) or through a link
 *   (junction/symlink whose realpath lands outside the root's realpath).
 */
export function resolveContainedPath(root: string, pathSpec: string, what: string): string {
  const resolvedRoot = resolve(root)
  const resolved = isAbsolute(pathSpec) ? pathSpec : resolve(resolvedRoot, pathSpec)
  if (!isStrictlyInside(resolvedRoot, resolved)) {
    throw new Error(
      `${what} ${JSON.stringify(pathSpec)} escapes its containment root ${JSON.stringify(resolvedRoot)}`
      + ' (untrusted declaration: the resolved path must stay strictly inside the root)',
    )
  }
  // Link-normalized re-check (junction/symlink mine): both sides go through
  // realpathSync.native so they share one coordinate system (win32 `\\?\`
  // prefixing and POSIX `/tmp`-style link roots apply to both or neither).
  let realRoot: string
  try {
    realRoot = realpathSync.native(resolvedRoot)
  } catch {
    // An absent root cannot hold any artifact; the textual gate above already
    // ran, and the install face rejects the absent directory downstream.
    return resolved
  }
  let real: string
  try {
    real = realpathSync.native(resolved)
  } catch {
    // Absent candidate: absence is the install face's judgment, not an escape.
    return resolved
  }
  if (!isStrictlyInside(realRoot, real)) {
    throw new Error(
      `${what} ${JSON.stringify(pathSpec)} resolves through a link to ${JSON.stringify(real)},`
      + ` which is outside the containment root ${JSON.stringify(realRoot)} (junction/symlink escape)`,
    )
  }
  return resolved
}

/**
 * Resolve one artifact-declared service factory path against the artifact's
 * own source directory (F7 third point, D1b §4.1: the factory value comes
 * from the ADMITTED ARTIFACT'S OWN manifest — still an untrusted declaration,
 * and `resolve` semantics would let `..` segments or absolute values escape
 * the source directory into the boot-time import chain).
 *
 * Textual containment only: the source directory itself already passed the
 * link-normalized gate ({@link resolveContainedPath}) at the ledger face, and
 * the artifact tree's internal integrity is carried by the supply-chain pin
 * (D1b §4.7 residual face, registered — boot does not re-verify pin/content).
 * @param sourceDir - the artifact's admitted source directory (absolute).
 * @param factory - the manifest-declared `dsh.capabilities[].service.factory`
 *   value (trimmed by the caller's filter; trimmed again defensively).
 * @returns the resolved absolute module path (caller turns it into a file URL).
 * @throws Error with a queryable reason when the factory path escapes the
 *   source directory (absolute/drive value, `..` segment, or equal-root).
 */
export function resolveFactoryModulePath(sourceDir: string, factory: string): string {
  const trimmed = factory.trim()
  const factoryPath = resolve(sourceDir, trimmed)
  if (!isStrictlyInside(sourceDir, factoryPath)) {
    throw new Error(
      `the admitted manifest's service factory path ${JSON.stringify(trimmed)} escapes the artifact`
      + ` source directory ${JSON.stringify(sourceDir)} (untrusted artifact declaration: relative`
      + ' in-tree segments only — no absolute/drive values, no "..")',
    )
  }
  return factoryPath
}
