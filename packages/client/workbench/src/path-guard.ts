/**
 * Workspace path guard: the security boundary every filesystem operation
 * passes through. Rules, in the order an attacker would try to break them:
 *
 * 1. The request names an absolute path; relative input is refused outright.
 * 2. The resolved path must stay inside the workspace root — including the
 *    win32 cross-drive trap where `path.relative` returns an ABSOLUTE path
 *    instead of a `..`-prefixed one, which silently defeats naive
 *    `!rel.startsWith('..')` containment checks.
 * 3. Symbolic links must not smuggle the operation out: every EXISTING entry
 *    between the target and the root is checked, and any link whose realpath
 *    leaves the workspace fails the call.
 * 4. Every check runs against the CURRENT filesystem at call time — results
 *    are never cached across operations.
 */
import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, join, parse, relative, resolve } from 'node:path'

/** Verdict of the workspace path guard: an allowed target, or a refused code with message. */
export type PathGuardResult =
  | { allowed: true; root: string; target: string }
  | { allowed: false; code: 'bad-request' | 'outside-workspace'; message: string }

/**
 * Resolve the authoritative workspace root once per session cwd value.
 * @param cwd - the working directory to realpath.
 * @returns the realpathed workspace root; throws when the cwd does not exist.
 */
export async function resolveWorkspaceRoot(cwd: string): Promise<string> {
  return realpath(cwd)
}

function escapesRoot(root: string, target: string): boolean {
  const rel = relative(root, target)
  // The cross-drive trap: on win32, relative('C:\\root', 'D:\\x') returns an
  // absolute path with no '..' prefix. Treat any absolute result as escape.
  if (isAbsolute(rel)) return true
  if (rel === '' || rel === '.') return false
  return rel.startsWith('..') || parse(rel).root !== ''
}

function outside(message: string): PathGuardResult {
  return { allowed: false, code: 'outside-workspace', message }
}

/**
 * Canonicalize a candidate path into the realpath coordinate — the coordinate
 * `resolveWorkspaceRoot` produced the workspace root in. A fully existing path
 * realpaths directly; a path with absent segments (a file about to be
 * created) realpaths its deepest existing ancestor and re-appends the
 * remainder. This matters on hosts whose temp root is addressed through an
 * 8.3 short name (GitHub Windows runners: `C:\Users\RUNNER~1\...`): the root
 * was canonicalized at boot (expanding `RUNNER~1` to the long form), so a
 * purely lexical `relative()` between a short-name request and a long-name
 * root would brand every temp-dir path an escape. Windows case-correcting
 * readdir makes plain `realpath` expand the short components too, so both
 * sides land in one coordinate.
 * @param requestedPath - the absolute candidate path to canonicalize.
 * @returns the canonical candidate, or `undefined` when no ancestor resolves.
 */
async function canonicalizeRequestTarget(requestedPath: string): Promise<string | undefined> {
  const normalized = resolve(requestedPath)
  let anchor = normalized
  let remainder = ''
  for (;;) {
    try {
      return join(await realpath(anchor), remainder)
    } catch {
      const parent = resolve(anchor, '..')
      // The filesystem root always exists, so this is defensive against
      // hostile filesystem failures rather than reachable through real input.
      if (parent === anchor) return undefined
      remainder = join(parse(anchor).base, remainder)
      anchor = parent
    }
  }
}

/**
 * Judge one absolute candidate path against the workspace root. Purely
 * lexical; callers layer filesystem-aware checks (below) on top.
 * @param root - the authoritative workspace root (already realpathed for full checks).
 * @param requestedPath - the absolute candidate path to judge.
 * @returns the allowed target or a refused verdict.
 */
export function judgeInsideWorkspace(root: string, requestedPath: string): PathGuardResult {
  if (typeof requestedPath !== 'string' || requestedPath.length === 0) {
    return { allowed: false, code: 'bad-request', message: 'path is required' }
  }
  if (!isAbsolute(requestedPath)) {
    return { allowed: false, code: 'bad-request', message: 'path must be absolute' }
  }
  const target = resolve(requestedPath)
  if (escapesRoot(root, target)) {
    return outside('path escapes the workspace')
  }
  return { allowed: true, root, target }
}

/**
 * Full pre-flight for read/write/delete/rename targets. `root` MUST be the
 * already-realpathed workspace root (see resolveWorkspaceRoot).
 *
 * Checks every existing entry from the target up to (and including) the
 * root: any symbolic link along that chain resolving outside fails. The walk
 * deliberately STOPS at the root — ancestry above the workspace belongs to
 * the deployment, not the request.
 * @param root - the already-realpathed workspace root (see resolveWorkspaceRoot).
 * @param requestedPath - the absolute candidate path to pre-flight.
 * @returns the allowed target or a refused verdict.
 */
export async function ensureRealPathInside(root: string, requestedPath: string): Promise<PathGuardResult> {
  // Rule 1 from the header: the RAW request names an absolute path; relative
  // input is refused outright (resolve() would silently pin it to process cwd).
  if (typeof requestedPath !== 'string' || requestedPath.length === 0 || !isAbsolute(requestedPath)) {
    return { allowed: false, code: 'bad-request', message: 'path must be absolute' }
  }
  // Canonicalize the request into the root's realpath coordinate BEFORE the
  // lexical containment judgment: `relative()` is purely lexical and cannot
  // know that `C:\Users\RUNNER~1\...` and `C:\Users\runneradmin\...` name the
  // same directory (see canonicalizeRequestTarget).
  const canonical = await canonicalizeRequestTarget(requestedPath)
  if (canonical === undefined) {
    return outside('path cannot be resolved to a real location')
  }
  const judged = judgeInsideWorkspace(root, canonical)
  if (!judged.allowed) return judged

  let cursor = judged.target
  for (;;) {
    try {
      const stats = await lstat(cursor)
      if (stats.isSymbolicLink()) {
        const resolvedTargetOfLink = await realpath(cursor)
        if (escapesRoot(root, resolvedTargetOfLink)) {
          return outside('symlink resolves outside the workspace')
        }
      }
    } catch {
      // Absent entry: nothing to verify at this level.
    }
    if (cursor === root) break
    const parent = resolve(cursor, '..')
    if (parent === cursor) break
    cursor = parent
  }

  // Deepest-existing-anchor confirmation: when the target chain contains
  // absent segments, realpath the nearest existing ancestor and re-judge.
  let anchor = judged.target
  for (;;) {
    try {
      const real = await realpath(anchor)
      if (escapesRoot(root, real)) {
        return outside('path resolves outside the workspace')
      }
      break
    } catch {
      if (anchor === root) break
      const parent = resolve(anchor, '..')
      if (parent === anchor) break
      anchor = parent
    }
  }

  return judged
}
