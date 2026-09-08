/**
 * Upload lifecycle (P01 §6-A / §9-F): TTL sweeping and idempotent deletion.
 *
 * Sweeper rules:
 * - walks EVERY session workspace, not just the first one — the union of the
 *   live session store's workspaces AND the workspaces remembered in upload
 *   metadata (sessions may have left the store while their files remain);
 * - a file expires when `now - uploadedAtMs > ttl` (metadata is authoritative;
 *   mtime is the fallback for unrecorded files);
 * - deleted files leave their empty parent chain pruned back to — but never
 *   including — the workspace root;
 * - metadata rows for deleted files are cleaned up;
 * - the interval handle is disposable.
 */

import fsp from 'node:fs/promises'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

import type { MetaStore } from './meta.js'
import type { Workspace, WorkspaceResolver } from './workspace.js'
import { isStrictlyInside } from './pathPolicy.js'
import { sendError } from './httpUtil.js'
import type { HttpHandler } from './upload.js'

export interface SweepReport {
  /** Workspaces visited. */
  workspaces: number
  /** Files inspected. */
  scanned: number
  /** Files removed. */
  deleted: number
  /** Empty directories pruned. */
  prunedDirs: number
}

export interface LifecycleDeps {
  /** Expiry age in milliseconds. */
  ttlMs: number
  meta: MetaStore
  workspaces: WorkspaceResolver
  /** Join a session cwd into its workspace root (<cwd>/<storageDirName>). */
  storageRootOf(cwd: string): string
  logInfo(message: string): void
  logWarn(message: string): void
}

/** Safety bounds so a hostile tree cannot pin the event loop. */
const MAX_WALK_DEPTH = 24
const MAX_WALK_FILES = 20_000

interface RootEntry {
  sessionId: string | undefined
  root: string
}

function resolveKey(value: string): string {
  return process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value)
}

/**
 * Union of candidate roots: every live workspace plus every workspace
 * remembered through upload metadata (keyed by resolved root so duplicates
 * collapse).
 */
async function collectRootEntries(deps: LifecycleDeps): Promise<RootEntry[]> {
  const byKey = new Map<string, RootEntry>()
  for (const workspace of deps.workspaces.list()) {
    byKey.set(resolveKey(workspace.root), { sessionId: workspace.sessionId, root: workspace.root })
  }
  for (const sessionId of await deps.meta.sessionIds()) {
    if ([...byKey.values()].some(entry => entry.sessionId === sessionId)) continue
    const record = await deps.meta.get(sessionId)
    if (record.cwd !== undefined && record.cwd !== '') {
      const root = deps.storageRootOf(record.cwd)
      byKey.set(resolveKey(root), { sessionId, root })
    }
  }
  return [...byKey.values()]
}

interface WalkedFile {
  absolutePath: string
  /** Path relative to the walked root, forward-slashed. */
  relativePath: string
}

async function walkFiles(root: string): Promise<WalkedFile[]> {
  const files: WalkedFile[] = []
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > MAX_WALK_DEPTH || files.length >= MAX_WALK_FILES) return
    let entries
    try {
      entries = await fsp.readdir(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        await visit(absolute, depth + 1)
      } else if (entry.isFile()) {
        files.push({
          absolutePath: absolute,
          relativePath: forwardSlashes(path.relative(root, absolute)),
        })
      }
      if (files.length >= MAX_WALK_FILES) return
    }
  }
  await visit(root, 0)
  return files
}

function forwardSlashes(value: string): string {
  return value.replace(/\\/g, '/')
}

/** Remove the empty parent chain of `deletedDir`, stopping at (not incl.) root. */
async function pruneEmptyParents(root: string, deletedDir: string): Promise<number> {
  let pruned = 0
  let current = deletedDir
  while (true) {
    if (resolveKey(current) === resolveKey(root)) break
    if (!isStrictlyInside(root, current)) break
    try {
      await fsp.rmdir(current)
      pruned += 1
    } catch {
      break // ENOTEMPTY / EACCES / vanished — stop climbing
    }
    current = path.dirname(current)
  }
  return pruned
}

export interface LifecycleController {
  sweep(now?: number): Promise<SweepReport>
  deleteFile: HttpHandler
  start(intervalMs: number): void
  stop(): void
}

export function createLifecycle(deps: LifecycleDeps): LifecycleController {
  let timer: ReturnType<typeof setInterval> | undefined

  async function sweep(now = Date.now()): Promise<SweepReport> {
    const report: SweepReport = { workspaces: 0, scanned: 0, deleted: 0, prunedDirs: 0 }
    const entries = await collectRootEntries(deps)
    for (const entry of entries) {
      report.workspaces += 1
      let files: WalkedFile[]
      try {
        files = await walkFiles(entry.root)
      } catch {
        continue
      }
      report.scanned += files.length
      const record =
        entry.sessionId !== undefined ? await deps.meta.get(entry.sessionId) : undefined
      for (const file of files) {
        const recordedAt = record?.files[file.relativePath]?.uploadedAtMs
        let ageReference = recordedAt
        if (ageReference === undefined) {
          try {
            ageReference = (await fsp.stat(file.absolutePath)).mtimeMs
          } catch {
            continue // vanished between walk and stat
          }
        }
        if (typeof ageReference !== 'number' || now - ageReference <= deps.ttlMs) continue
        try {
          await fsp.unlink(file.absolutePath)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            deps.logWarn(`[filehub] sweep could not remove ${file.relativePath}: ${String(error)}`)
            continue
          }
        }
        report.deleted += 1
        report.prunedDirs += await pruneEmptyParents(entry.root, path.dirname(file.absolutePath))
        if (entry.sessionId !== undefined) {
          await deps.meta.remove(entry.sessionId, file.relativePath).catch(() => undefined)
        }
      }
    }
    if (report.deleted > 0) {
      deps.logInfo(`[filehub] sweep removed ${report.deleted} expired file(s) across ${report.workspaces} workspace(s)`)
    }
    return report
  }

  /**
   * DELETE /api/filehub/file?path=<absolute path>
   * Containment assertion FIRST (strictly inside SOME known workspace root —
   * sibling-prefix confusion and cross-drive absolutes both fail this), then
   * idempotent removal: missing targets answer 204 like successful ones.
   */
  const deleteFile = async function handleDelete(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let target: string | null = null
    try {
      const url = new URL(req.url ?? '/', 'http://filehub.invalid')
      target = url.searchParams.get('path')
    } catch {
      target = null
    }
    if (!target || target === '') {
      sendError(res, 400, 'missing path query parameter')
      return
    }

    const entries = await collectRootEntries(deps)
    const owner = entries.find(entry => isStrictlyInside(entry.root, target as string))
    if (!owner) {
      sendError(res, 403, 'target path escapes every session workspace')
      return
    }

    let stats
    try {
      stats = await fsp.stat(target)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        res.statusCode = 204
        res.end()
        return
      }
      sendError(res, 500, 'failed to inspect target')
      return
    }
    if (!stats.isFile()) {
      sendError(res, 409, 'target is not a regular file')
      return
    }
    // M6 adversarial fix (round 1): lexical containment cannot see through a
    // directory symlink/junction planted inside the workspace. Resolve BOTH
    // the owner root and the target to their REAL paths and re-assert strict
    // containment before the unlink; a junctioned escape answers 403.
    let resolvedRoot = owner.root
    try {
      const [realRoot, realTarget] = await Promise.all([
        fsp.realpath(owner.root),
        fsp.realpath(target),
      ])
      if (!isStrictlyInside(realRoot, realTarget)) {
        sendError(res, 403, 'target path escapes every session workspace')
        return
      }
      resolvedRoot = realRoot
      target = realTarget
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        res.statusCode = 204
        res.end()
        return
      }
      sendError(res, 500, 'failed to inspect target')
      return
    }
    try {
      await fsp.unlink(target)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        res.statusCode = 204
        res.end()
        return
      }
      sendError(res, 500, 'failed to delete file')
      return
    }

    await pruneEmptyParents(resolvedRoot, path.dirname(target))
    if (owner.sessionId !== undefined) {
      const relativeFromRoot = forwardSlashes(path.relative(resolvedRoot, target))
      await deps.meta.remove(owner.sessionId, relativeFromRoot).catch(() => undefined)
    }
    res.statusCode = 204
    res.end()
  }

  return {
    sweep,
    deleteFile,
    start(intervalMs) {
      if (timer !== undefined) return
      timer = setInterval(() => {
        void sweep().catch((error: unknown) => {
          deps.logWarn(`[filehub] scheduled sweep failed: ${String(error)}`)
        })
      }, Math.max(1, intervalMs))
      // An unref'd timer must never keep the process (or a test run) alive.
      if (typeof timer.unref === 'function') timer.unref()
    },
    stop() {
      if (timer === undefined) return
      clearInterval(timer)
      timer = undefined
    },
  }
}

export type { Workspace }
