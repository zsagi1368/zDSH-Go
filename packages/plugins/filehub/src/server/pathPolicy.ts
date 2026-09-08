/**
 * Path sandbox (P01 §9-F FR-F2): pure functions, the only authority on where
 * bytes may land on disk. Every server-side path decision funnels through
 * here — upload destination, delete containment, sweep roots.
 *
 * Windows hardening notes baked into these helpers:
 * - `path.relative(root, candidate)` returns an ABSOLUTE path when the two
 *   sides sit on different drives (classic cross-drive trap). The containment
 *   check therefore rejects `path.isAbsolute(rel)` explicitly; it does not
 *   rely on the leading-`..` test alone.
 * - Sibling-prefix confusion (`root=/a/b`, `candidate=/a/bc`) produces
 *   `../bc` from relative() and is rejected by that same test.
 */

import path from 'node:path'

/** Error thrown by every assertion in this module. */
export class PathPolicyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PathPolicyError'
  }
}

/** Session ids are host-minted tokens: alphanumerics, dash, underscore. */
export const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

export function isValidSessionId(value: unknown): value is string {
  return typeof value === 'string' && SESSION_ID_PATTERN.test(value)
}

/**
 * Windows reserved device names (case-insensitive, also with an extension:
 * `CON.txt` resolves to the console device on Windows).
 */
const WINDOWS_RESERVED_BASENAMES: readonly string[] = [
  'CON', 'PRN', 'AUX', 'NUL',
  'COM0', 'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT0', 'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]

/** Hard ceiling for one sanitized file name. */
const MAX_FILE_NAME_LENGTH = 120

/** Hard ceiling for the number of segments in an uploaded relative path. */
export const MAX_RELATIVE_SEGMENTS = 32

/** Hard ceiling for the joined relative path length. */
export const MAX_RELATIVE_PATH_LENGTH = 512

function stripReserved(name: string): string {
  const dotIndex = name.indexOf('.')
  const base = (dotIndex === -1 ? name : name.slice(0, dotIndex)).toUpperCase()
  return WINDOWS_RESERVED_BASENAMES.includes(base) ? `_${name}` : name
}

/**
 * Sanitize a single path segment for use as a file/directory name on disk:
 * strips control characters, neutralizes Windows-hostile characters and NTFS
 * alternate-data-stream separators, defuses reserved device names, trailing
 * dots/spaces, and traversal heads. Returns `'unnamed'` when nothing survives.
 */
export function sanitizeFileName(input: string): string {
  let name = input.replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
  // Windows-illegal characters (incl. ':' — ADS + drive-letter separator).
  name = name.replace(/[\\/:*?"<>|]/g, '_')
  // Defuse traversal-style heads ('..', '..hidden') while keeping legitimate
  // dotfiles like '.gitignore'.
  const dotHead = name.match(/^\.{2,}/)
  if (dotHead) name = `_${name.slice(dotHead[0].length)}`
  name = name.trim()
  // Windows silently strips trailing dots and spaces; normalize up front so
  // stored names stay stable across writes.
  name = name.replace(/[.\s]+$/g, '')
  name = stripReserved(name)
  if (name.length > MAX_FILE_NAME_LENGTH) {
    name = name.slice(0, MAX_FILE_NAME_LENGTH).replace(/[.\s]+$/g, '')
  }
  return name === '' ? 'unnamed' : name
}

export type RelativePathResult =
  | { ok: true; segments: string[] }
  | { ok: false; reason: string }

/**
 * Split a wire-side relative path ('a/b/c.txt', forward slashes) into
 * sanitized segments. Rejects outright traversal ('..'), absolute forms,
 * drive letters, over-deep trees, and over-long joins. Every surviving
 * segment passes through {@link sanitizeFileName}. An empty input yields an
 * empty segment list (plain file upload — the file-name header supplies the
 * only segment).
 */
export function sanitizeRelativePath(input: string): RelativePathResult {
  const trimmed = input.replace(/\\/g, '/').trim()
  if (trimmed === '') return { ok: true, segments: [] }
  if (trimmed.startsWith('/')) return { ok: false, reason: 'absolute relative-path is not allowed' }
  if (/^[a-zA-Z]:/.test(trimmed)) return { ok: false, reason: 'drive-letter paths are not allowed' }

  const rawSegments = trimmed.split('/')
  if (rawSegments.some(segment => segment === '..')) {
    return { ok: false, reason: "traversal sequence '..' is not allowed" }
  }
  const segments: string[] = []
  for (const raw of rawSegments) {
    if (raw === '' || raw === '.') continue
    const clean = sanitizeFileName(raw)
    if (clean !== '') segments.push(clean)
    if (segments.length > MAX_RELATIVE_SEGMENTS) {
      return { ok: false, reason: `relative path exceeds ${MAX_RELATIVE_SEGMENTS} segments` }
    }
  }
  if (segments.join('/').length > MAX_RELATIVE_PATH_LENGTH) {
    return { ok: false, reason: `relative path exceeds ${MAX_RELATIVE_PATH_LENGTH} characters` }
  }
  return { ok: true, segments }
}

/**
 * Non-throwing strict-containment check: candidate must resolve to a path
 * STRICTLY inside root (equal-to-root fails). Defensive against both the
 * sibling-prefix confusion and the Windows cross-drive absolute-relative trap.
 */
export function isStrictlyInside(root: string, candidate: string): boolean {
  const resolvedRoot = path.resolve(root)
  const resolvedCandidate = path.resolve(candidate)
  let rel: string
  try {
    rel = path.relative(resolvedRoot, resolvedCandidate)
  } catch {
    return false
  }
  if (rel === '') return false // equal to root → not strictly inside
  if (rel === '..' || rel.startsWith(`..${path.sep}`)) return false
  if (path.isAbsolute(rel)) return false // cross-drive / unparseable → reject
  return true
}

/**
 * Throwing variant of {@link isStrictlyInside}; the message names the rule,
 * never the resolved paths (error bodies must not leak host layout).
 */
export function assertInside(root: string, candidate: string): void {
  if (!isStrictlyInside(root, candidate)) {
    throw new PathPolicyError('target path escapes the session workspace')
  }
}
