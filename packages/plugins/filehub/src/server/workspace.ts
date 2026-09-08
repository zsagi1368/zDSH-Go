/**
 * Workspace resolution: maps a wire-side session id to the on-disk upload
 * workspace (`<session cwd>/<storageDirName>`), backed by the host `sessions`
 * service (dsh-session SessionStore.get → Session.header.cwd).
 *
 * Host facts this encodes (verified against @deepseek-ai/dsh-session):
 * - `ctx.sessions.get(id)` returns undefined for unknown ids → HTTP 403.
 * - `session.header.cwd` is OPTIONAL; a session without a cwd has no
 *   workspace to anchor uploads → treated as unresolvable (HTTP 403) rather
 *   than silently writing to process.cwd(). TODO(integration): if the shipped
 *   composition guarantees a default cwd for every session, relax this.
 *
 * M2 mention pipeline (P01 §6-B): this module also hosts the bounded
 * workspace indexer — a streaming opendir BFS over the session cwd that feeds
 * @mention search — plus the candidate scoring shared by the search endpoint.
 */

import fsPromises from 'node:fs/promises'
import type { Dirent, Stats } from 'node:fs'
import path from 'node:path'

/** Structural subset of the host session store + session object. */
export interface SessionsLike {
  get(id: string): { readonly header: { readonly cwd?: string } } | undefined
  list(): ReadonlyArray<{ readonly id: string; readonly header: { readonly cwd?: string } }>
}

export interface Workspace {
  sessionId: string
  /** The session's working directory (relativePath in responses is relative to this). */
  cwd: string
  /** The upload root: <cwd>/<storageDirName>. */
  root: string
}

export interface WorkspaceResolver {
  resolve(sessionId: string): Workspace | undefined
  /** All live workspaces, for DELETE containment and the lifecycle sweeper. */
  list(): Workspace[]
}

export function createWorkspaceResolver(
  sessions: SessionsLike | undefined,
  storageDirName: string,
): WorkspaceResolver {
  const toWorkspace = (
    sessionId: string,
    header: { readonly cwd?: string },
  ): Workspace | undefined => {
    const cwd = header.cwd
    if (typeof cwd !== 'string' || cwd === '') return undefined
    return { sessionId, cwd, root: path.join(path.resolve(cwd), storageDirName) }
  }
  return {
    resolve(sessionId) {
      const session = sessions?.get(sessionId)
      if (!session) return undefined
      return toWorkspace(sessionId, session.header)
    },
    list() {
      const live = sessions?.list() ?? []
      const workspaces: Workspace[] = []
      for (const session of live) {
        const workspace = toWorkspace(session.id, session.header)
        if (workspace) workspaces.push(workspace)
      }
      return workspaces
    },
  }
}

// ---------------------------------------------------------------------------
// M2: bounded workspace indexer (P01 §6-B FR-B1/FR-B2)
// ---------------------------------------------------------------------------

/** One indexed workspace candidate: path relative to the session cwd. */
export interface IndexCandidate {
  readonly relativePath: string
  readonly kind: 'file' | 'directory'
}

/** A completed index snapshot for one session workspace. */
export interface WorkspaceIndex {
  readonly entries: readonly IndexCandidate[]
  /** True when the walk hit maxFiles and stopped before the tree ended. */
  readonly truncated: boolean
  readonly builtAtMs: number
}

/**
 * Directory basenames pruned from the walk (exact match). Covers dependency
 * stores, VCS metadata, build outputs, caches, and language virtualenvs — the
 * high-volume noise that would otherwise burn the maxFiles budget.
 */
export const DEFAULT_IGNORE_DIRS: readonly string[] = [
  '.git', '.hg', '.svn', '.jj',
  'node_modules', 'bower_components', 'jspm_packages', 'vendor',
  'dist', 'build', 'out', 'output', '.next', '.nuxt', '.svelte-kit',
  'coverage', '.nyc_output', '__pycache__', '.pytest_cache', '.mypy_cache',
  '.ruff_cache', '.tox', '.venv', 'venv', 'env',
  'target', '.gradle', '.terraform', 'Pods', 'DerivedData',
  '.idea', '.vscode', '.cache', '.turbo', '.parcel-cache',
]

export interface WorkspaceIndexerDeps {
  /** Session store used to map ids to cwds at rebuild time. */
  sessions?: SessionsLike | undefined
  /** The upload storage directory name; always excluded from mention search. */
  storageDirName: string
  logWarn?: ((message: string) => void) | undefined
  /** Hard entry ceiling per walk (files AND directories count). Default 5000. */
  maxFiles?: number | undefined
  /** Extra ignored basenames merged with {@link DEFAULT_IGNORE_DIRS}. */
  ignoreDirs?: readonly string[] | undefined
  /** Fallback freshness window. Default 30_000. */
  ttlMs?: number | undefined
  /** Injectable clock (tests). */
  now?: (() => number) | undefined
}

export interface WorkspaceIndexer {
  /**
   * Current index for one session; builds (awaited) when missing, dirty, or
   * older than the TTL fallback. Unknown session → undefined.
   */
  get(sessionId: string): Promise<WorkspaceIndex | undefined>
  /** Event hook: mark every cached workspace dirty and rebuild in background. */
  invalidateAll(): void
  /** Drop all cached state and abort any in-flight walks. */
  dispose(): void
}

class AbortError extends Error {
  constructor() {
    super('filehub indexer aborted')
    this.name = 'AbortError'
  }
}

/** Race a fs promise against an AbortSignal so disposal cancels promptly. */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new AbortError())
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      cleanup()
      reject(new AbortError())
    }
    const cleanup = (): void => {
      signal.removeEventListener('abort', onAbort)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        cleanup()
        resolve(value)
      },
      (error: unknown) => {
        cleanup()
        // Non-Error rejections (host string throws) are wrapped, never swallowed.
        if (error instanceof Error) {
          reject(error)
        } else {
          const wrapped = new AbortError()
          ;(wrapped as Error & { cause?: unknown }).cause = error
          reject(wrapped)
        }
      },
    )
  })
}

interface WalkDir {
  readonly absolute: string
  readonly relative: string
  /** Canonical realpaths of every symlinked directory above this node. */
  readonly ancestors: ReadonlySet<string>
}

/**
 * Streaming opendir BFS over `cwd`. Per-call guarantees:
 * - stops hard at maxFiles entries with truncated=true;
 * - prunes ignored basenames (and the upload storage dir);
 * - follows symlinked directories only when their realpath is not already on
 *   the current path's ancestor chain (cycle guard via realpathAsync);
 * - skips unreadable directories with a warn instead of failing the walk;
 * - every fs call races the caller's AbortSignal.
 */
async function walkWorkspace(
  cwd: string,
  opts: { maxFiles: number; ignored: ReadonlySet<string>; logWarn: (message: string) => void; now: () => number },
  signal: AbortSignal,
): Promise<WorkspaceIndex> {
  const builtAtMs = Math.floor(opts.now())
  const rootAncestors = new Set<string>()
  // Seed the ancestor chain with the canonical root so a symlink pointing
  // back at the workspace root itself is caught too.
  try {
    rootAncestors.add(await raceAbort(fsPromises.realpath(cwd), signal))
  } catch (error: unknown) {
    if (signal.aborted) throw error
    rootAncestors.add(path.resolve(cwd))
  }

  const entries: IndexCandidate[] = []
  let truncated = false
  const queue: WalkDir[] = [{ absolute: path.resolve(cwd), relative: '', ancestors: rootAncestors }]
  // Indirection defeats control-flow narrowing of `signal.aborted` across awaits.
  const aborted = (): boolean => signal.aborted

  while (queue.length > 0) {
    if (signal.aborted) throw new AbortError()
    if (entries.length >= opts.maxFiles) {
      truncated = true
      break
    }
    const dir: WalkDir | undefined = queue.shift()
    if (dir === undefined) break

    let handle: AsyncIterable<Dirent> & { close?: () => Promise<void> }
    try {
      handle = await raceAbort(fsPromises.opendir(dir.absolute), signal)
    } catch (error: unknown) {
      if (aborted()) throw error
      opts.logWarn(`[filehub] index skipped unreadable directory ${dir.relative || '.'}: ${String(error)}`)
      continue
    }

    try {
      for await (const dirent of handle as unknown as AsyncIterable<Dirent>) {
        if (aborted()) throw new AbortError()
        if (entries.length >= opts.maxFiles) {
          truncated = true
          break
        }
        const childAbsolute = path.join(dir.absolute, dirent.name)
        const childRelative = dir.relative === '' ? dirent.name : `${dir.relative}/${dirent.name}`

        // Ignore-list pruning: basename exact match (covers VCS dirs,
        // dependency stores, build outputs, caches, virtualenvs, and the
        // plugin's own storage dir).
        if (opts.ignored.has(dirent.name)) continue

        if (dirent.isDirectory()) {
          entries.push({ relativePath: childRelative, kind: 'directory' })
          queue.push({ absolute: childAbsolute, relative: childRelative, ancestors: dir.ancestors })
          continue
        }

        if (dirent.isSymbolicLink()) {
          // stat() follows the link: classify, and guard directories against
          // cycles through the canonical ancestor set.
          let followed: Stats
          try {
            followed = await raceAbort(fsPromises.stat(childAbsolute), signal)
          } catch (error: unknown) {
            if (aborted()) throw error
            continue // dangling or unreadable link: skip silently
          }
          if (followed.isFile()) {
            entries.push({ relativePath: childRelative, kind: 'file' })
            continue
          }
          if (!followed.isDirectory()) continue
          let real: string
          try {
            real = await raceAbort(fsPromises.realpath(childAbsolute), signal)
          } catch (error: unknown) {
            if (aborted()) throw error
            continue
          }
          if (dir.ancestors.has(real)) continue // cycle: do not descend
          const nextAncestors = new Set(dir.ancestors)
          nextAncestors.add(real)
          entries.push({ relativePath: childRelative, kind: 'directory' })
          queue.push({ absolute: childAbsolute, relative: childRelative, ancestors: nextAncestors })
          continue
        }

        if (dirent.isFile()) {
          entries.push({ relativePath: childRelative, kind: 'file' })
        }
        // Other types (sockets, FIFOs, devices): skipped.
      }
    } finally {
      // opendir iterators auto-close on exhaustion; close() releases early on
      // the truncation/abort paths. Best effort — never masks the real result.
      await handle.close?.().catch(() => undefined)
    }
  }

  return { entries, truncated, builtAtMs }
}

interface IndexSlot {
  index?: WorkspaceIndex | undefined
  dirty: boolean
  building?: Promise<WorkspaceIndex | undefined> | undefined
  builtAtMs: number
}

/**
 * Build the bounded indexer. Freshness model:
 * - host fs events (`fs/write-intent` / `fs/edit-intent`, verified in
 *   packages/fs/fs-observation-policy/src/index.ts:119-122) call
 *   invalidateAll() → dirty + ONE background rebuild;
 * - a TTL fallback (default 30 s) covers edits made outside the tool pipeline
 *   (the host emits no general external-change event), so get() rebuilds when
 *   the cached snapshot is older than ttlMs even without a dirty flag;
 * - no event and no TTL expiry → zero rescans (cache hit returns as-is).
 */
export function createWorkspaceIndexer(deps: WorkspaceIndexerDeps): WorkspaceIndexer {
  const sessions = deps.sessions
  const maxFiles = Math.max(1, deps.maxFiles ?? 5000)
  const ttlMs = Math.max(0, deps.ttlMs ?? 30_000)
  const now = deps.now ?? (() => Date.now())
  const logWarn = deps.logWarn ?? (() => {})
  const ignored = new Set<string>([
    ...DEFAULT_IGNORE_DIRS,
    ...(deps.ignoreDirs ?? []),
    deps.storageDirName, // uploaded bytes are served from meta, never re-walked
  ])

  const controller = new AbortController()
  const slots = new Map<string, IndexSlot>()

  const resolveCwd = (sessionId: string): string | undefined => {
    const header = sessions?.get(sessionId)?.header
    const cwd = header?.cwd
    return typeof cwd === 'string' && cwd !== '' ? cwd : undefined
  }

  const startBuild = (sessionId: string, cwd: string): Promise<WorkspaceIndex> => {
    const slot = slots.get(sessionId)
    if (!slot) throw new Error(`filehub indexer: no slot for ${sessionId}`)
    const signal = controller.signal
    const building = walkWorkspace(
      cwd,
      { maxFiles, ignored, logWarn, now },
      signal,
    )
      .then((index) => {
        slot.index = index
        slot.builtAtMs = now()
        slot.dirty = false
        return index
      })
      .finally(() => {
        if (slot.building === building) slot.building = undefined
      })
      .catch((error: unknown) => {
        if (!(error instanceof AbortError)) {
          logWarn(`[filehub] index build failed for ${sessionId}: ${String(error)}`)
        }
        throw error
      })
    slot.building = building
    return building
  }

  return {
    async get(sessionId) {
      const cwd = resolveCwd(sessionId)
      if (cwd === undefined) return undefined
      let slot = slots.get(sessionId)
      if (!slot) {
        slot = { dirty: false, builtAtMs: 0 }
        slots.set(sessionId, slot)
      }
      const cached = slot.index
      const fresh = !slot.dirty && cached !== undefined && now() - slot.builtAtMs < ttlMs
      if (fresh) return cached
      if (slot.building !== undefined) {
        return slot.building.catch(() => slot.index)
      }
      return startBuild(sessionId, cwd).catch(() => slot.index)
    },

    invalidateAll() {
      for (const [sessionId, slot] of slots) {
        slot.dirty = true
        if (slot.building) continue // a rebuild is already in flight
        const cwd = resolveCwd(sessionId)
        if (cwd === undefined) continue
        // Fire-and-forget background rebuild; get() also awaits it lazily.
        void startBuild(sessionId, cwd).catch(() => undefined)
      }
    },

    dispose() {
      controller.abort()
      slots.clear()
    },
  }
}

// ---------------------------------------------------------------------------
// M2: candidate scoring (shared by GET /api/filehub/search)
// ---------------------------------------------------------------------------

/** Greedy subsequence test: every query char appears in order in the target. */
export function isSubsequence(query: string, target: string): boolean {
  let cursor = 0
  for (let index = 0; index < target.length && cursor < query.length; index += 1) {
    if (target[index] === query[cursor]) cursor += 1
  }
  return cursor === query.length
}

/**
 * Score one candidate path against a query. Higher wins; undefined = no match.
 * Tiers: basename exact (4) > basename prefix (3) > basename contains (2) >
 * full-path contains (1) > basename subsequence (0.5).
 */
export function scoreWorkspaceCandidate(query: string, relativePath: string): number | undefined {
  const q = query.toLowerCase()
  if (q === '') return 0
  const normalized = relativePath.replace(/\\/g, '/').toLowerCase()
  const base = normalized.slice(normalized.lastIndexOf('/') + 1)
  if (base === q) return 4
  if (base.startsWith(q)) return 3
  if (base.includes(q)) return 2
  if (normalized.includes(q)) return 1
  if (isSubsequence(q, base)) return 0.5
  return undefined
}

/**
 * Rank candidates by score, then shorter path, then lexicographic. Stable and
 * allocation-light enough for the 50-entry response page.
 */
export function rankWorkspaceCandidates<T extends { readonly relativePath: string }>(
  query: string,
  items: readonly T[],
  compareExtra?: (a: T, b: T) => number,
): Array<T & { readonly score: number }> {
  const scored: Array<T & { score: number }> = []
  for (const item of items) {
    const score = scoreWorkspaceCandidate(query, item.relativePath)
    if (score !== undefined) scored.push({ ...item, score })
  }
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    const byLength = a.relativePath.length - b.relativePath.length
    if (byLength !== 0) return byLength
    const byName = a.relativePath.localeCompare(b.relativePath)
    if (byName !== 0) return byName
    return compareExtra?.(a, b) ?? 0
  })
  return scored
}
