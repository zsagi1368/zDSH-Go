/**
 * Path hardening for Windows-first judgment.
 *
 * All predicates are pure and I/O-free. normalizePath never touches the disk:
 * casing folds, trailing dots/spaces strip, NT namespace prefixes collapse,
 * reserved device names and drive-relative ambiguity are detected explicitly.
 */

export interface PathRoots {
  workspaceRoot: string
  homePath: string
  /** DSH config home, e.g. ~/.dsh-zdsh */
  dshHomePath: string
}

const RESERVED_DEVICE_NAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
])

/** POSIX critical prefixes judged on normalized separators too. */
const POSIX_CRITICAL = ['/etc', '/bin', '/usr', '/sbin', '/boot', '/sys', '/proc', '/dev']

export interface NormalizedPath {
  raw: string
  normalized: string
  /** True when the path is absolute after normalization. */
  isAbsolute: boolean
  driveRelativeAmbiguity: boolean
  reservedDeviceName: boolean
}

export function normalizePath(raw: string): NormalizedPath {
  let p = raw.trim()
  // Strip Win32 trailing dots/spaces that the filesystem silently ignores.
  p = p.replace(/[. ]+$/, '')
  const hadNtPrefix = /^\\\\\?\\|^\\\.\\/i.test(p)
  if (hadNtPrefix) p = p.replace(/^\\\\\?\\|^\\\.\\/i, '')
  const unc = p.startsWith('\\\\')
  p = p.replace(/\/+/g, '\\')

  let driveRelativeAmbiguity = false
  // "C:.." style drive-relative paths resolve against the drive's cwd — treat as ambiguous.
  if (/^[A-Za-z]:(?![\\/])/.test(p)) driveRelativeAmbiguity = true

  const isAbsolute = /^[A-Za-z]:[\\/]/.test(p) || unc || p.startsWith('\\')
  // Case-fold for comparison purposes only (Windows-insensitive judgement).
  const normalized = (unc ? '\\\\' : '') + p

  const firstSegment = normalized.split(/[\\/]/).find(s => s.length > 0) ?? ''
  const baseName = firstSegment.split('.').slice(0, -1).join('.') || firstSegment
  const reservedDeviceName = RESERVED_DEVICE_NAMES.has(baseName.toLowerCase())

  return { raw, normalized, isAbsolute, driveRelativeAmbiguity, reservedDeviceName }
}

/**
 * Containment check. On win32, `path.relative` across drives returns an
 * ABSOLUTE path (no '..' prefix), which defeats naive startsWith('..')
 * checks — the isAbsolute guard below is therefore load-bearing, not style.
 */
export function isWithin(root: string, candidate: string): boolean {
  const r = normalizePath(root)
  const c = normalizePath(candidate)
  if (!c.isAbsolute) return false // relative targets are judged by the caller
  if (r.isAbsolute && r.normalized.slice(0, 2) !== c.normalized.slice(0, 2)) return false
  const rel = relativePosix(r.normalized, c.normalized)
  if (rel === '') return true // identical path counts as contained
  return !rel.startsWith('..') && !isAbsoluteLike(rel)
}

function relativePosix(from: string, to: string): string {
  const f = from.toLowerCase().split('\\').filter(Boolean)
  const t = to.toLowerCase().split('\\').filter(Boolean)
  let i = 0
  while (i < f.length && i < t.length && f[i] === t[i]) i++
  if (i < f.length) {
    const rest = f.slice(i)
    void rest
    return '..' // not a descendant at all
  }
  return t.slice(i).join('/')
}

function isAbsoluteLike(s: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(s) || s.startsWith('\\\\') || s.startsWith('\\')
}

function segments(norm: NormalizedPath): string[] {
  return norm.normalized.split(/[\\/]/).filter(Boolean)
}

export function isCriticalPath(roots: PathRoots, candidate: string): boolean {
  const c = normalizePath(candidate)
  if (!c.isAbsolute) return false
  if (c.reservedDeviceName) return true

  const segs = segments(c).map(s => s.toLowerCase())
  const joined = segs.join('/')

  // Filesystem / drive roots and one-level-below roots.
  if (/^[a-z]:$/.test(joined) || joined === '') return true
  if (isWithin(roots.homePath, c.normalized) && segments(c).length === segments(normalizePath(roots.homePath)).length) {
    return true // the Home directory itself
  }
  if (
    isWithin(roots.dshHomePath, c.normalized) ||
    isWithin('C:\\Windows', c.normalized) ||
    isWithin('C:\\Program Files', c.normalized) ||
    isWithin('C:\\Program Files (x86)', c.normalized) ||
    isWithin('C:\\ProgramData', c.normalized)
  ) {
    return true
  }
  return POSIX_CRITICAL.some(prefix => joined === prefix.slice(1) || joined.startsWith(`${prefix.slice(1)}/`))
}

const CREDENTIAL_TREE_SEGMENTS = new Set([
  '.ssh', '.gnupg', '.aws', '.kube', '.config', 'gcloud', '.azure', '.docker',
])

export function isCredentialTree(candidate: string): boolean {
  const c = normalizePath(candidate)
  return segments(c).some(s => CREDENTIAL_TREE_SEGMENTS.has(s.toLowerCase()))
}

const PROTECTED_TOP_DIRS = new Set(['.git', '.vscode', '.idea', '.husky'])
const PROTECTED_BASE_NAMES = new Set(['.gitconfig', '.bashrc', '.mcp.json'])

export function isProtectedProjectMeta(workspaceRoot: string, candidate: string): boolean {
  const c = normalizePath(candidate)
  if (!isWithin(workspaceRoot, c.normalized)) return false
  const segs = segments(c)
  const rootDepth = segments(normalizePath(workspaceRoot)).length
  if (segs.length > rootDepth && PROTECTED_TOP_DIRS.has(segs[rootDepth]?.toLowerCase() ?? '')) {
    return true
  }
  const base = segs[segs.length - 1] ?? ''
  return PROTECTED_BASE_NAMES.has(base.toLowerCase())
}
