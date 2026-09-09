/**
 * Shared sandbox filesystem gate.
 *
 * Single source of truth for both ProcessSandbox and InlineSandbox so their
 * path semantics cannot drift apart again: the allow list is matched with
 * resolved, component-complete prefixes and an EMPTY allow list denies
 * everything (fail closed), regardless of sandbox type or access mode.
 * @module @deepseek-ai/dsh-plugin-governance/sandbox/path-guard
 */

import { parse, resolve, sep } from 'path'
import { lstatSync, realpathSync } from 'fs'
import type { PluginSandboxConfig } from '../spec/index.js'

/** The `filesystem` section of one sandbox config. */
type FilesystemConfig = PluginSandboxConfig['filesystem']

/**
 * Classify a path component with `lstat` (no symlink following) so the
 * realpath walk can tell "not on disk yet" (safe to walk past) from "present
 * but its real location cannot be established" (must fail closed).
 * @param p - the path component to classify.
 * @returns 'exists' | 'missing' | 'blocked' — 'blocked' when the component is
 * present yet unresolvable (broken symlink/junction, unreadable parent, ...).
 */
function lstatKind(p: string): 'exists' | 'missing' | 'blocked' {
  try {
    lstatSync(p)
    return 'exists'
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    // ENOTDIR/ENOENT mean "not on disk yet" (safe to walk past); anything else
    // (EACCES/EPERM/ELOOP/...) means the component exists but cannot be judged.
    /* v8 ignore next -- hostile-fs failures (EACCES/EPERM/ELOOP) are not synthesizable through the public gate on a writable temp tree. */
    if (code !== 'ENOENT' && code !== 'ENOTDIR') return 'blocked'
    return 'missing'
  }
}

/**
 * Canonicalize a path to its real on-disk location.
 *
 * `resolve()` folds `..`/`.` but never follows symlinks or junctions, so an
 * allow-listed directory containing a symlink can point a plugin outside the
 * boundary. This helper resolves the deepest EXISTING ancestor with
 * `realpathSync.native` (which follows every symlink/junction component,
 * including a symlink leaf) and re-appends any not-yet-existing remainder, so
 * a plugin about to create a new file is still pinned to the real ancestor's
 * location. Any component that exists but refuses to resolve (a dangling
 * symlink/junction whose target cannot be verified — writing through it would
 * land outside the boundary) fails closed.
 * @param path - the path whose real location is wanted (may not exist yet).
 * @returns the canonical real path, or `undefined` when the real location
 * cannot be established (the caller then fails closed).
 */
function resolveReal(path: string): string | undefined {
  try {
    return realpathSync.native(path)
  } catch {
    // Candidate does not resolve as a whole: a component is missing or a
    // symlink/junction along the way is dangling. Resolve what exists below.
  }

  const normalized = resolve(path)
  const { root } = parse(normalized)
  const parts = normalized.slice(root.length).split(sep).filter(part => part.length > 0)

  // The leaf itself exists but realpath failed: it is a dangling
  // symlink/junction whose target cannot be verified, so a write through it
  // could land outside the boundary. Fail closed.
  if (lstatKind(normalized) !== 'missing') return undefined

  for (let depth = parts.length - 1; depth >= 0; depth -= 1) {
    const ancestor = root + parts.slice(0, depth).join(sep)
    const kind = lstatKind(ancestor)
    if (kind === 'missing') continue
    // An existing ancestor that is unreadable leaves the real location
    // unknown -> fail closed.
    /* v8 ignore next 2 -- blocked ancestors are not synthesizable through the public gate on a writable temp tree. */
    if (kind !== 'exists') return undefined
    try {
      const realAncestor = realpathSync.native(ancestor)
      const remainder = parts.slice(depth).join(sep)
      return remainder.length > 0 ? realAncestor + sep + remainder : realAncestor
    } catch {
      // Present but unresolvable ancestor: a dangling symlink/junction mid-path
      // whose target cannot be verified -> fail closed.
      return undefined
    }
  }
  /* v8 ignore next -- every real filesystem has an existing root, so the loop always returns inside. */
  return undefined
}

/**
 * Whether a path matches any configured deny pattern.
 *
 * Patterns are compared as resolved-string containment (historical semantics),
 * plus — in the candidate's realpath coordinate — against each pattern's own
 * realpath, so a short-name logical pattern still matches a long-name real
 * candidate on 8.3-aliasing hosts (GitHub Windows runners).
 * The caller runs this against BOTH the logical path and the real on-disk
 * location, so a symlink alias whose real target falls under a deny pattern
 * cannot hide behind an innocent-looking logical path.
 * @param deniedPatterns - the configured deny patterns.
 * @param candidate - the path to test (logical or real).
 * @returns true when the candidate contains a resolved deny pattern.
 */
function matchesDeniedPattern(deniedPatterns: readonly string[], candidate: string): boolean {
  for (const pattern of deniedPatterns) {
    let resolvedPattern: string
    try {
      resolvedPattern = resolve(pattern)
      if (candidate.includes(resolvedPattern)) return true
    } catch {
      /* v8 ignore next 2 -- resolve() of a configured deny pattern cannot fail on real inputs. */
      continue
    }
    // Re-check the pattern in the candidate's realpath coordinate. On hosts
    // where temp paths carry 8.3 short-name components (GitHub Windows
    // runners: `C:\Users\RUNNER~1\...`), the realpathed candidate expands to
    // the long form while a lexical pattern stays short — a coordinate-only
    // comparison would silently bypass the deny rule.
    const realPattern = resolveReal(resolvedPattern)
    if (realPattern !== undefined && candidate.includes(realPattern)) return true
  }
  return false
}

/**
 * Decide whether one absolute-or-relative plugin path may be touched.
 *
 * Security semantics:
 * - the candidate is normalized (`resolve`) so `..`/`.` components collapse;
 * - a literal `..` surviving in the result, or a leading literal `~` component
 *   (POSIX home-expansion escape) rejects defensively; a `~` MID-path is legal
 *   (Windows 8.3 short names, e.g. `RUNNER~1`) and must not reject;
 * - configured deny patterns win over everything and are checked against BOTH
 *   the logical path and the real on-disk location, so a symlink/junction
 *   alias whose target falls under a deny pattern is still denied;
 * - allow-list entries and the candidate are canonicalized to their REAL
 *   on-disk location (`realpathSync.native`), so symlink/junction escapes are
 *   caught: the real target must still live inside an allow-listed directory;
 * - allow-list entries must match as whole path segments (not raw string
 *   prefixes), so `/work` does not admit `/workshop`;
 * - an empty allow list denies every path — fail closed.
 * @param config - the `filesystem` section of the sandbox config to enforce.
 * @param path - the absolute-or-relative path a plugin wants to touch.
 * @returns whether the path may be touched under the configured rules.
 */
export function checkPathAllowed(config: FilesystemConfig, path: string): boolean {
  // 抵御 POSIX 分叉逃逸：resolve 词法折叠 `..` 后 realpath 可能绕过 symlink 物理分叉。
  // 在 resolve 之前按 `\` 与 `/` 切分原始输入，凡含 `..`/`.` 组件一律 fail-closed：
  // Windows 路径 `C:\foo\..` 的 `..` 经 Win32 词法折叠与 resolve 一致，
  // 但 POSIX 内核在物理解析时 `..` 作用于 junction/symlink 目标，可能与词法折叠结果分叉。
  for (const component of path.split(/[\\/]/)) {
    if (component === '..' || component === '.') {
      return false
    }
  }

  // 路径规范化：解析绝对路径并消除 .. 和 . 组件
  let normalizedPath: string
  try {
    normalizedPath = resolve(path)
    /* v8 ignore next 2 -- resolve() already collapses '..' and never emits '~'; this is defense-in-depth against exotic hosts. */
    if (normalizedPath.includes('..')) {
      return false
    }
  } catch {
    /* v8 ignore next -- path.resolve only rejects on hostile custom fs; unreachable over real paths. */
    return false
  }

  // 字面 `~` 只在「首组件」位置才有 POSIX 主目录展开语义（`~`/`~user`），据此拒绝；
  // 检查按组件而非子串：Windows 8.3 短名（如 runner 临时目录里的 `RUNNER~1`）在
  // 路径中部合法携带 `~`，子串检查会把整棵临时目录树误判为逃逸（fail closed），
  // 在 GitHub 的 Windows runner 上曾导致沙箱拒绝一切 Temp 下的路径。
  const firstComponent = path.split(/[\\/]/).find(component => component.length > 0)
  if (firstComponent !== undefined && firstComponent.startsWith('~')) {
    return false
  }

  // 检查拒绝模式（对逻辑路径；命中即拒绝，deny 优先于 allow）
  if (matchesDeniedPattern(config.deniedPatterns, normalizedPath)) return false

  // 检查白名单（fail closed：未配置白名单时一律拒绝）
  if (config.allowedPaths.length === 0) return false

  // 候选路径落到磁盘的真实位置（跟随 symlink/junction），解析失败即拒绝。
  const realCandidate = resolveReal(normalizedPath)
  if (realCandidate === undefined) return false

  // 对真实位置再次检查拒绝模式：与 allow 使用同一坐标系，防止 symlink 别名
  // 指向被拒路径时，仅凭逻辑路径比较绕过 deny 规则。
  if (matchesDeniedPattern(config.deniedPatterns, realCandidate)) return false

  // 白名单条目同样解析到真实位置（realpath 失败回退 resolve），
  // 保证「候选真实位置」与「允许真实位置」在同一坐标系下比较。
  const allowedReal = config.allowedPaths.map((p) => {
    try {
      return resolveReal(resolve(p)) ?? resolve(p)
    } catch {
      /* v8 ignore next -- resolve() of a configured allow-list entry cannot fail on real inputs. */
      return p
    }
  })

  // 比较前统一大小写（Windows 盘符/路径大小写不敏感），
  // 两种分隔符都参与比较，避免平台差异造成分支不可达。
  const normalizeKey =
    process.platform === 'win32'
      ? (p: string): string => p.toLowerCase()
      : (p: string): string => p
  const candidateKey = normalizeKey(realCandidate)

  return allowedReal.some((p) => {
    const allowedKey = normalizeKey(p)
    const posixPrefix = allowedKey + '/'
    const win32Prefix = allowedKey + '\\'
    return (
      candidateKey === allowedKey ||
      candidateKey.startsWith(posixPrefix) ||
      candidateKey.startsWith(win32Prefix)
    )
  })
}
