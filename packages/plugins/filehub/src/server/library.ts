/**
 * M5 file console services (P01 §6-E, FR-E1..E4): the cross-session library
 * aggregate, storage usage statistics, whole-session cleanup, and the
 * two-step TTL cleanup.
 *
 * Data model: the upload metadata KV (src/server/meta.ts) stays the authority
 * for "which files exist" (sessionId → {relPath → size/uploadedAt}). This
 * module adds a SECOND, separate KV unit (`filehub_console`) that caches only
 * derived enrichment — the sniffed kind bucket per (sessionId, relPath) and
 * the once-per-process lazy backfill stamp. meta.ts is deliberately untouched:
 * M5 reads through its seam and never widens it.
 *
 * Lazy backfill (FR-E1): a session whose workspace directory holds files but
 * whose meta record is empty (pre-M1 leftovers, a wiped KV) is walked ONCE;
 * the discovered entries are answered from disk stats and remembered via the
 * backfill stamp so later requests stay KV-driven instead of re-walking.
 */

import fsp from 'node:fs/promises'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { z } from 'zod'

import { sniff } from '../detect.js'
import type { SniffKind } from '../detect.js'
import type { KvFacetLike, KvUnitLike, MetaStore, StorageHubLike } from './meta.js'
import { isStrictlyInside } from './pathPolicy.js'
import { sendError, sendJson } from './httpUtil.js'
import type { HttpHandler } from './upload.js'
import type { WorkspaceResolver } from './workspace.js'
import { isValidSessionId } from './pathPolicy.js'

// ---------------------------------------------------------------------------
// Wire schemas (M5-local; contract.ts is frozen at the M3 shape)
// ---------------------------------------------------------------------------

/** The five usage buckets of P01 §6-E byKind. */
export const USAGE_KINDS = ['image', 'document', 'text', 'binary', 'media'] as const
export type UsageKind = (typeof USAGE_KINDS)[number]

const UsageKindSchema = z.enum(USAGE_KINDS)

export const LibraryEntrySchema = z.object({
  /** Absolute path inside the owning session workspace. */
  path: z.string().min(1),
  /** Forward-slash path relative to that workspace root. */
  relativePath: z.string(),
  name: z.string().min(1),
  sessionId: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  uploadedAtMs: z.number().int().nonnegative(),
  kind: UsageKindSchema,
  /** M6 caption passthrough: persisted vision caption when one exists. */
  imageCaption: z.string().min(1).optional(),
})
export type LibraryEntry = z.infer<typeof LibraryEntrySchema>

export const LibraryResultSchema = z.object({
  sessions: z.array(
    z.object({
      sessionId: z.string().min(1),
      cwd: z.string().optional(),
      entries: z.array(LibraryEntrySchema),
      totalBytes: z.number().int().nonnegative(),
    }),
  ),
  totalBytes: z.number().int().nonnegative(),
  truncated: z.boolean(),
})
export type LibraryResult = z.infer<typeof LibraryResultSchema>

export const UsageResultSchema = z.object({
  totalBytes: z.number().int().nonnegative(),
  files: z.number().int().nonnegative(),
  byKind: z.record(UsageKindSchema, z.object({ files: z.number().int().nonnegative(), bytes: z.number().int().nonnegative() })),
  bySession: z.array(z.object({ sessionId: z.string(), files: z.number().int().nonnegative(), bytes: z.number().int().nonnegative() })),
})
export type UsageResult = z.infer<typeof UsageResultSchema>

export const CleanupRequestSchema = z.object({
  scope: z.enum(['expired', 'session']),
  sessionId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(),
  ttlMs: z.number().int().positive().optional(),
  dryRun: z.boolean().optional(),
})
export type CleanupRequest = z.infer<typeof CleanupRequestSchema>

export const CleanupReportSchema = z.object({
  scope: z.enum(['expired', 'session']),
  dryRun: z.boolean(),
  wouldDelete: z.number().int().nonnegative(),
  deleted: z.number().int().nonnegative(),
  wouldFreeBytes: z.number().int().nonnegative(),
  freedBytes: z.number().int().nonnegative(),
})
export type CleanupReport = z.infer<typeof CleanupReportSchema>

/**
 * Map a detect verdict onto one of the five usage buckets. PDF sniffs as
 * kind:'binary' with an application/pdf mime — documents are common enough
 * that the mime refines the bucket; generic archives (zip/docx/xlsx/pptx all
 * carry kind:'archive') count as documents too.
 */
export function usageBucketOf(kind: SniffKind, mime: string): UsageKind {
  if (kind === 'image' || mime.startsWith('image/')) return 'image'
  if (mime === 'application/pdf') return 'document'
  if (kind === 'archive') return 'document'
  if (kind === 'text') return 'text'
  if (kind === 'media') return 'media'
  return 'binary'
}

// ---------------------------------------------------------------------------
// Enrichment index store (own KV unit; memory fallback mirrors meta.ts)
// ---------------------------------------------------------------------------

const INDEX_UNIT = 'filehub_console'
const INDEX_TABLE = 'sessions'

interface IndexedFile {
  kind: UsageKind
}

interface SessionIndexRecord {
  /** Lazy-backfill watermark: when set, empty-meta sessions are not re-walked. */
  scannedAtMs?: number | undefined
  files: Record<string, IndexedFile>
}

function emptySessionIndex(): SessionIndexRecord {
  return { files: {} }
}

export interface ConsoleIndexStore {
  get(sessionId: string): Promise<SessionIndexRecord>
  putKind(sessionId: string, relPath: string, kind: UsageKind): Promise<void>
  putScannedAt(sessionId: string, atMs: number): Promise<void>
  removeSession(sessionId: string): Promise<void>
  sessionIds(): Promise<string[]>
}

export function createMemoryConsoleIndexStore(): ConsoleIndexStore {
  const records = new Map<string, SessionIndexRecord>()
  return {
    get(sessionId) {
      const existing = records.get(sessionId)
      if (!existing) return Promise.resolve(emptySessionIndex())
      return Promise.resolve({ ...existing, files: { ...existing.files } })
    },
    async putKind(sessionId, relPath, kind) {
      await Promise.resolve()
      const existing = records.get(sessionId) ?? emptySessionIndex()
      existing.files[relPath] = { kind }
      records.set(sessionId, existing)
    },
    async putScannedAt(sessionId, atMs) {
      await Promise.resolve()
      const existing = records.get(sessionId) ?? emptySessionIndex()
      existing.scannedAtMs = atMs
      records.set(sessionId, existing)
    },
    removeSession(sessionId) {
      records.delete(sessionId)
      return Promise.resolve()
    },
    sessionIds() {
      return Promise.resolve([...records.keys()])
    },
  }
}

class KvConsoleIndexStore implements ConsoleIndexStore {
  private unit: KvUnitLike | undefined
  private chain: Promise<unknown> = Promise.resolve()

  constructor(private readonly kv: KvFacetLike) {}

  private async openUnit(): Promise<KvUnitLike> {
    if (!this.unit) {
      this.unit = await this.kv.open({
        name: INDEX_UNIT,
        version: 1,
        tables: [INDEX_TABLE],
        hasGlobal: false,
      })
    }
    return this.unit
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.chain.then(operation, operation)
    this.chain = next.catch(() => undefined)
    return next
  }

  async get(sessionId: string): Promise<SessionIndexRecord> {
    const unit = await this.openUnit()
    const snapshot = await unit.loadAll()
    const raw = (snapshot.tables[INDEX_TABLE] ?? {})[sessionId] as SessionIndexRecord | undefined
    if (!raw || typeof raw !== 'object') return emptySessionIndex()
    return { scannedAtMs: raw.scannedAtMs, files: { ...raw.files } }
  }

  private write(sessionId: string, mutate: (record: SessionIndexRecord) => void): Promise<void> {
    return this.enqueue(async () => {
      const unit = await this.openUnit()
      const snapshot = await unit.loadAll()
      const table = snapshot.tables[INDEX_TABLE] ?? {}
      const existing = (table[sessionId] as SessionIndexRecord | undefined) ?? emptySessionIndex()
      const next: SessionIndexRecord = { ...existing, files: { ...existing.files } }
      mutate(next)
      await unit.putRecord(INDEX_TABLE, sessionId, next)
    })
  }

  putKind(sessionId: string, relPath: string, kind: UsageKind): Promise<void> {
    return this.write(sessionId, (record) => {
      record.files[relPath] = { kind }
    })
  }

  putScannedAt(sessionId: string, atMs: number): Promise<void> {
    return this.write(sessionId, (record) => {
      record.scannedAtMs = atMs
    })
  }

  removeSession(sessionId: string): Promise<void> {
    return this.enqueue(async () => {
      const unit = await this.openUnit()
      await unit.deleteRecord(INDEX_TABLE, sessionId)
    })
  }

  async sessionIds(): Promise<string[]> {
    const unit = await this.openUnit()
    const snapshot = await unit.loadAll()
    return Object.keys(snapshot.tables[INDEX_TABLE] ?? {})
  }
}

/** Pick the first backend exposing a KV facet (same policy as meta.ts). */
function pickKvFacet(storage: StorageHubLike | undefined): KvFacetLike | undefined {
  if (!storage) return undefined
  for (const name of storage.backend.names()) {
    try {
      const kv = storage.backend.get(name).kv
      if (kv) return kv
    } catch {
      // Registry entry vanished mid-scan; keep looking.
    }
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Library service core
// ---------------------------------------------------------------------------

/** Hard entry ceiling of one library response (bounded aggregation). */
export const MAX_LIBRARY_ENTRIES = 2000

/** Head bytes read per unclassified file for kind detection. */
const SNIFF_READ_BYTES = 65_536 + 8_192

export interface LibraryDeps {
  meta: MetaStore
  workspaces: WorkspaceResolver
  /** Storage hub face used ONLY to open the console's own KV unit. */
  storage?: unknown
  /** Join a session cwd into its workspace root (<cwd>/<storageDirName>). */
  storageRootOf(cwd: string): string
  logWarn(message: string): void
  now?: () => number
  maxEntries?: number | undefined
}

interface SessionRoot {
  sessionId: string
  /** Workspace root (<cwd>/<storageDirName>) or undefined when unknowable. */
  root?: string | undefined
  cwd?: string | undefined
}

/** Classify one file by sniffing its head bytes; failures fall back to binary. */
async function detectKind(root: string, relativePath: string): Promise<UsageKind> {
  const absolute = path.join(root, relativePath)
  try {
    const handle = await fsp.open(absolute, 'r')
    try {
      const buffer = Buffer.alloc(SNIFF_READ_BYTES)
      const { bytesRead } = await handle.read(buffer, 0, SNIFF_READ_BYTES, 0)
      const result = sniff(buffer.subarray(0, bytesRead), relativePath)
      return usageBucketOf(result.kind, result.mime)
    } finally {
      await handle.close().catch(() => undefined)
    }
  } catch {
    return 'binary'
  }
}

export interface LibraryService {
  /** Aggregate entries across every known session (FR-E1). */
  listLibrary(opts: { q?: string; filter?: string }): Promise<LibraryResult>
  /** Storage occupancy statistics (FR-E2). */
  computeUsage(topSessions?: number): Promise<UsageResult>
  /** Delete every file of one session; idempotent (FR-E3). */
  deleteSession(sessionId: string): Promise<{ deleted: number; freedBytes: number }>
  /** Two-step cleanup: preview counts, then execute (FR-E4). */
  cleanup(request: CleanupRequest & { dryRun: boolean }): Promise<CleanupReport>
  dispose(): void
}

export function createLibraryService(deps: LibraryDeps): LibraryService {
  const now = deps.now ?? (() => Date.now())
  const maxEntries = Math.max(1, deps.maxEntries ?? MAX_LIBRARY_ENTRIES)
  const kv = pickKvFacet(deps.storage as Parameters<typeof pickKvFacet>[0])
  if (!kv) {
    deps.logWarn('[filehub] console enrichment index falling back to memory (no KV facet)')
  }
  const index: ConsoleIndexStore = kv ? new KvConsoleIndexStore(kv) : createMemoryConsoleIndexStore()

  /**
   * Union of candidate sessions: live workspaces, meta-remembered sessions,
   * and anything still carrying console-index rows (a wiped meta KV must not
   * orphan previously listed sessions).
   */
  async function collectRoots(): Promise<SessionRoot[]> {
    const byId = new Map<string, SessionRoot>()
    for (const workspace of deps.workspaces.list()) {
      byId.set(workspace.sessionId, {
        sessionId: workspace.sessionId,
        root: workspace.root,
        cwd: workspace.cwd,
      })
    }
    const metaIds = await deps.meta.sessionIds().catch(() => [] as string[])
    const indexIds = await index.sessionIds().catch(() => [] as string[])
    for (const sessionId of [...metaIds, ...indexIds]) {
      if (byId.has(sessionId)) continue
      const record = await deps.meta.get(sessionId).catch(() => undefined)
      const cwd = typeof record?.cwd === 'string' && record.cwd !== '' ? record.cwd : undefined
      byId.set(sessionId, {
        sessionId,
        cwd,
        root: cwd !== undefined ? deps.storageRootOf(cwd) : undefined,
      })
    }
    return [...byId.values()]
  }

  /**
   * One bounded walk of a workspace root used ONLY for the lazy backfill of
   * sessions whose meta record is empty. Mirrors lifecycle's safety bounds.
   */
  async function backfillScan(root: string): Promise<Array<{ relativePath: string; sizeBytes: number; mtimeMs: number }>> {
    const found: Array<{ relativePath: string; sizeBytes: number; mtimeMs: number }> = []
    const MAX_DEPTH = 24
    const visit = async (directory: string, depth: number): Promise<void> => {
      if (depth > MAX_DEPTH || found.length >= maxEntries) return
      let entries
      try {
        entries = await fsp.readdir(directory, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        if (found.length >= maxEntries) return
        const absolute = path.join(directory, entry.name)
        if (entry.isDirectory()) {
          await visit(absolute, depth + 1)
          continue
        }
        if (!entry.isFile()) continue
        const relativePath = path.relative(root, absolute).replace(/\\/g, '/')
        try {
          const stats = await fsp.stat(absolute)
          found.push({ relativePath, sizeBytes: stats.size, mtimeMs: stats.mtimeMs })
        } catch {
          // Vanished between readdir and stat; skip.
        }
      }
    }
    await visit(root, 0)
    return found
  }

  /**
   * Resolve kind for (sessionId, relPath), consulting + filling the cache.
   * The sniff verdict is cached in the console index so each file's bytes are
   * read at most once per cache lifetime.
   */
  async function kindOf(sessionId: string, root: string | undefined, relPath: string): Promise<UsageKind> {
    const cached = (await index.get(sessionId).catch(() => emptySessionIndex())).files[relPath]?.kind
    if (cached) return cached
    const kind = root !== undefined ? await detectKind(root, relPath) : 'binary'
    await index.putKind(sessionId, relPath, kind).catch(() => undefined)
    return kind
  }

  interface RawEntry {
    relativePath: string
    sizeBytes: number
    uploadedAtMs: number
    imageCaption?: string
    fromBackfill: boolean
  }

  /**
   * Meta-driven entries for one session plus the lazy disk backfill.
   *
   * M6 adversarial fix (round 3, KV/disk divergence): every meta-driven row is
   * stat-verified against the workspace root BEFORE being served; a row whose
   * file vanished out-of-band (manual deletion, external tooling) is pruned
   * from the metadata and SKIPPED — the library never surfaces ghost entries,
   * and the KV self-heals on the same request that noticed the drift.
   */
  async function entriesFor(sessionRoot: SessionRoot): Promise<{ entries: RawEntry[]; truncated: boolean }> {
    const record = await deps.meta.get(sessionRoot.sessionId).catch(() => undefined)
    const entries: RawEntry[] = []
    let truncated = false
    for (const [relativePath, row] of Object.entries(record?.files ?? {})) {
      if (sessionRoot.root !== undefined) {
        const absolute = path.join(sessionRoot.root, relativePath)
        let alive: boolean
        try {
          alive = (await fsp.stat(absolute)).isFile()
        } catch {
          alive = false
        }
        if (!alive) {
          await deps.meta
            .remove(sessionRoot.sessionId, relativePath)
            .catch(() => undefined)
          continue
        }
      }
      entries.push({
        relativePath,
        sizeBytes: row.sizeBytes,
        uploadedAtMs: row.uploadedAtMs,
        ...(typeof row.imageCaption === 'string' && row.imageCaption !== ''
          ? { imageCaption: row.imageCaption }
          : {}),
        fromBackfill: false,
      })
    }
    if (entries.length === 0 && sessionRoot.root !== undefined) {
      const stamp = await index.get(sessionRoot.sessionId).catch(() => emptySessionIndex())
      if (stamp.scannedAtMs === undefined) {
        // One lazy scan per cache lifetime: discover on-disk files the meta KV
        // never recorded, backfill them INTO the meta store through its public
        // record() seam so later requests are KV-driven, then stamp the scan
        // so a failing write cannot turn every request into a full walk.
        const discovered = await backfillScan(sessionRoot.root)
        for (const item of discovered) {
          await deps.meta
            .record(sessionRoot.sessionId, item.relativePath, {
              sizeBytes: item.sizeBytes,
              uploadedAtMs: Math.floor(item.mtimeMs),
            }, sessionRoot.cwd)
            .catch(() => undefined)
          entries.push({
            relativePath: item.relativePath,
            sizeBytes: item.sizeBytes,
            uploadedAtMs: Math.floor(item.mtimeMs),
            fromBackfill: true,
          })
        }
        await index.putScannedAt(sessionRoot.sessionId, Math.floor(now())).catch(() => undefined)
      }
    }
    if (entries.length > maxEntries) {
      truncated = true
      entries.length = maxEntries
    }
    return { entries, truncated }
  }

  function matchesQuery(entry: { relativePath: string }, q: string): boolean {
    if (q === '') return true
    const needle = q.toLowerCase()
    const normalized = entry.relativePath.toLowerCase()
    const base = normalized.slice(normalized.lastIndexOf('/') + 1)
    return base.includes(needle) || normalized.includes(needle)
  }

  async function listLibrary(opts: { q?: string; filter?: string }): Promise<LibraryResult> {
    const q = (opts.q ?? '').trim()
    const filter = opts.filter !== undefined && opts.filter !== '' && opts.filter !== 'all' ? opts.filter : undefined
    const roots = await collectRoots()

    const sessions: LibraryResult['sessions'] = []
    let totalBytes = 0
    let collected = 0
    let truncated = false

    // Most-recently-active session first; ties break on id for determinism.
    const prepared: Array<{ root: SessionRoot; entries: RawEntry[] }> = []
    for (const root of roots) {
      const { entries, truncated: sessionTruncated } = await entriesFor(root)
      if (sessionTruncated) truncated = true
      if (entries.length === 0) continue
      entries.sort((a, b) => b.uploadedAtMs - a.uploadedAtMs || (a.relativePath < b.relativePath ? -1 : 1))
      prepared.push({ root, entries })
    }
    prepared.sort((a, b) => latest(b.entries) - latest(a.entries) || (a.root.sessionId < b.root.sessionId ? -1 : 1))

    for (const group of prepared) {
      if (collected >= maxEntries) {
        truncated = true
        break
      }
      const outEntries: LibraryEntry[] = []
      let sessionBytes = 0
      for (const entry of group.entries) {
        if (collected + outEntries.length >= maxEntries) {
          truncated = true
          break
        }
        if (!matchesQuery(entry, q)) continue
        const kind = await kindOf(group.root.sessionId, group.root.root, entry.relativePath)
        if (filter !== undefined && kind !== filter) continue
        const name = entry.relativePath.slice(entry.relativePath.lastIndexOf('/') + 1)
        outEntries.push({
          path: group.root.root !== undefined ? path.join(group.root.root, entry.relativePath) : entry.relativePath,
          relativePath: entry.relativePath,
          name,
          sessionId: group.root.sessionId,
          sizeBytes: entry.sizeBytes,
          uploadedAtMs: entry.uploadedAtMs,
          kind,
          ...(entry.imageCaption !== undefined ? { imageCaption: entry.imageCaption } : {}),
        })
        sessionBytes += entry.sizeBytes
      }
      if (outEntries.length === 0) continue
      collected += outEntries.length
      totalBytes += sessionBytes
      sessions.push({
        sessionId: group.root.sessionId,
        ...(group.root.cwd !== undefined ? { cwd: group.root.cwd } : {}),
        entries: outEntries,
        totalBytes: sessionBytes,
      })
    }

    return LibraryResultSchema.parse({ sessions, totalBytes, truncated })
  }

  function latest(entries: RawEntry[]): number {
    return entries.reduce((max, entry) => (entry.uploadedAtMs > max ? entry.uploadedAtMs : max), 0)
  }

  async function computeUsage(topSessions = 5): Promise<UsageResult> {
    const buckets: Record<UsageKind, { files: number; bytes: number }> = {
      image: { files: 0, bytes: 0 },
      document: { files: 0, bytes: 0 },
      text: { files: 0, bytes: 0 },
      binary: { files: 0, bytes: 0 },
      media: { files: 0, bytes: 0 },
    }
    const perSession: Array<{ sessionId: string; files: number; bytes: number }> = []
    let totalBytes = 0
    let files = 0

    const roots = await collectRoots()
    for (const root of roots) {
      const { entries } = await entriesFor(root)
      if (entries.length === 0) continue
      let sessionBytes = 0
      for (const entry of entries) {
        const kind = await kindOf(root.sessionId, root.root, entry.relativePath)
        buckets[kind].files += 1
        buckets[kind].bytes += entry.sizeBytes
        sessionBytes += entry.sizeBytes
      }
      files += entries.length
      totalBytes += sessionBytes
      perSession.push({ sessionId: root.sessionId, files: entries.length, bytes: sessionBytes })
    }
    perSession.sort((a, b) => b.bytes - a.bytes || (a.sessionId < b.sessionId ? -1 : 1))
    return UsageResultSchema.parse({
      totalBytes,
      files,
      byKind: buckets,
      bySession: perSession.slice(0, Math.max(1, topSessions)),
    })
  }

  /**
   * Remove one file inside `root` with a strict containment assertion.
   * M6 adversarial fix (round 1): the containment check runs on REAL paths —
   * a directory symlink/junction planted inside the workspace must not carry
   * an unlink outside it. Unresolvable targets are treated as escapes.
   */
  async function removeContainedFile(root: string, relativePath: string): Promise<boolean> {
    const absolute = path.join(root, relativePath)
    if (!isStrictlyInside(root, absolute)) return false
    let realRoot: string
    let realTarget: string
    try {
      ;[realRoot, realTarget] = await Promise.all([fsp.realpath(root), fsp.realpath(absolute)])
    } catch {
      return false // vanished or unresolvable: nothing contained to remove
    }
    if (!isStrictlyInside(realRoot, realTarget)) {
      deps.logWarn(`[filehub] console refused removal outside the workspace: ${relativePath}`)
      return false
    }
    try {
      await fsp.unlink(realTarget)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        deps.logWarn(`[filehub] console could not remove ${relativePath}: ${String(error)}`)
      }
      return false
    }
  }

  /** Prune empty parents after deletion, stopping below the root. */
  async function pruneEmptyParents(root: string, startDir: string): Promise<void> {
    let current = startDir
    while (isStrictlyInside(root, current)) {
      try {
        await fsp.rmdir(current)
      } catch {
        return
      }
      current = path.dirname(current)
    }
  }

  async function dropMetaRows(sessionIds: readonly string[]): Promise<void> {
    for (const sessionId of sessionIds) {
      const record = await deps.meta.get(sessionId).catch(() => undefined)
      for (const relPath of Object.keys(record?.files ?? {})) {
        await deps.meta.remove(sessionId, relPath).catch(() => undefined)
      }
      await index.removeSession(sessionId).catch(() => undefined)
    }
  }

  async function deleteSession(sessionId: string): Promise<{ deleted: number; freedBytes: number }> {
    const roots = await collectRoots()
    const target = roots.find(root => root.sessionId === sessionId)
    if (!target || target.root === undefined) {
      // Unknown session or no discoverable workspace: already clean → idempotent success.
      await dropMetaRows([sessionId])
      return { deleted: 0, freedBytes: 0 }
    }
    const { entries } = await entriesFor(target)
    let deleted = 0
    let freedBytes = 0
    for (const entry of entries) {
      const removed = await removeContainedFile(target.root, entry.relativePath)
      if (!removed) continue
      deleted += 1
      freedBytes += entry.sizeBytes
      await pruneEmptyParents(target.root, path.dirname(path.join(target.root, entry.relativePath)))
    }
    await dropMetaRows([sessionId])
    return { deleted, freedBytes }
  }

  /**
   * Enumerate deletable candidates for the two-step cleanup WITHOUT touching
   * the filesystem: expired scope = every recorded/backfilled file older than
   * ttl across all sessions; session scope = every file of that session.
   */
  async function cleanupCandidates(request: CleanupRequest): Promise<Array<{ sessionId: string; root: string; entry: RawEntry }>> {
    const ttlMs = request.ttlMs ?? DEFAULT_CLEANUP_TTL_MS
    const candidates: Array<{ sessionId: string; root: string; entry: RawEntry }> = []
    const roots = await collectRoots()
    for (const root of roots) {
      if (root.root === undefined) continue
      if (request.scope === 'session') {
        if (root.sessionId !== request.sessionId) continue
      }
      const { entries } = await entriesFor(root)
      for (const entry of entries) {
        if (request.scope === 'expired' && now() - entry.uploadedAtMs <= ttlMs) continue
        candidates.push({ sessionId: root.sessionId, root: root.root, entry })
      }
    }
    return candidates
  }

  async function cleanup(request: CleanupRequest & { dryRun: boolean }): Promise<CleanupReport> {
    const candidates = await cleanupCandidates(request)
    const wouldFreeBytes = candidates.reduce((sum, item) => sum + item.entry.sizeBytes, 0)
    if (request.dryRun) {
      return CleanupReportSchema.parse({
        scope: request.scope,
        dryRun: true,
        wouldDelete: candidates.length,
        deleted: 0,
        wouldFreeBytes,
        freedBytes: 0,
      })
    }
    let deleted = 0
    let freedBytes = 0
    const touchedSessions = new Set<string>()
    for (const item of candidates) {
      const removed = await removeContainedFile(item.root, item.entry.relativePath)
      if (!removed) continue
      deleted += 1
      freedBytes += item.entry.sizeBytes
      touchedSessions.add(item.sessionId)
      await pruneEmptyParents(item.root, path.dirname(path.join(item.root, item.entry.relativePath)))
      await deps.meta.remove(item.sessionId, item.entry.relativePath).catch(() => undefined)
    }
    for (const sessionId of touchedSessions) {
      await index.removeSession(sessionId).catch(() => undefined)
    }
    return CleanupReportSchema.parse({
      scope: request.scope,
      dryRun: false,
      wouldDelete: candidates.length,
      deleted,
      wouldFreeBytes,
      freedBytes,
    })
  }

  return {
    listLibrary,
    computeUsage,
    deleteSession,
    cleanup,
    dispose() {
      // The KV unit closes lazily with the host; nothing owned here outlives
      // the plugin besides the in-memory fallback map, which dies with it.
    },
  }
}

/** Default expiry age for the expired-scope cleanup (matches lifecycle default). */
export const DEFAULT_CLEANUP_TTL_MS = 7 * 24 * 60 * 60 * 1000

// ---------------------------------------------------------------------------
// HTTP handlers
// ---------------------------------------------------------------------------

function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://filehub.invalid').searchParams
  } catch {
    return new URLSearchParams()
  }
}

export interface LibraryHandlersDeps {
  service: LibraryService
}

/** GET /api/filehub/library?filter=<kind|all>&q=<substring> */
export function createLibraryHandler(deps: LibraryHandlersDeps): HttpHandler {
  return async function handleLibrary(req, res) {
    if (req.method !== 'GET') {
      sendError(res, 405, 'method not allowed')
      return
    }
    const params = queryOf(req)
    const result = await deps.service.listLibrary({
      q: params.get('q') ?? '',
      filter: params.get('filter') ?? '',
    })
    sendJson(res, 200, result)
  }
}

/** GET /api/filehub/usage */
export function createUsageHandler(deps: LibraryHandlersDeps): HttpHandler {
  return async function handleUsage(req, res) {
    if (req.method !== 'GET') {
      sendError(res, 405, 'method not allowed')
      return
    }
    const result = await deps.service.computeUsage()
    sendJson(res, 200, result)
  }
}

/** Route-shaped handler for paths carrying a trailing /session/:id segment. */
export type SessionRouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  sessionId: string,
) => Promise<void>

/** DELETE /api/filehub/session/:sessionId — whole-session cleanup, idempotent. */
export function createSessionDeleteHandler(deps: LibraryHandlersDeps): SessionRouteHandler {
  return async function handleSessionDelete(req, res, sessionId) {
    if (req.method !== 'DELETE') {
      sendError(res, 405, 'method not allowed')
      return
    }
    if (!isValidSessionId(sessionId)) {
      sendError(res, 400, 'malformed session id')
      return
    }
    const result = await deps.service.deleteSession(sessionId)
    sendJson(res, 200, { sessionId, ...result })
  }
}

/** POST /api/filehub/cleanup — body {scope, sessionId?, ttlMs?, dryRun}. */
export function createCleanupHandler(deps: LibraryHandlersDeps): HttpHandler {
  return async function handleCleanup(req, res) {
    if (req.method !== 'POST') {
      sendError(res, 405, 'method not allowed')
      return
    }
    let parsedBody: unknown
    try {
      const chunks: Array<Buffer> = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      const text = Buffer.concat(chunks).toString('utf8')
      parsedBody = text === '' ? {} : JSON.parse(text)
    } catch {
      sendError(res, 400, 'malformed JSON body')
      return
    }
    const parsed = CleanupRequestSchema.safeParse(parsedBody)
    if (!parsed.success) {
      sendError(res, 400, `invalid cleanup request: ${parsed.error.issues.map(issue => issue.message).join('; ')}`)
      return
    }
    if (parsed.data.scope === 'session' && !parsed.data.sessionId) {
      sendError(res, 400, 'scope "session" requires sessionId')
      return
    }
    const report = await deps.service.cleanup({ ...parsed.data, dryRun: parsed.data.dryRun ?? true })
    sendJson(res, 200, report)
  }
}
