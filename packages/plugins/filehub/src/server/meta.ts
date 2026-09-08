/**
 * Metadata seam for the M1 upload domain (P01 §6-A): per-session bookkeeping
 * of uploaded files (size + uploadedAtMs) used for quota enforcement and
 * lifecycle TTL sweeps, plus the session→workspace cwd memory the sweeper
 * needs after a session has left the live store.
 *
 * Default implementation: in-memory. When the host `storage` service exposes
 * a backend with a KV facet (dsh-storage KvFacet: open/putRecord/deleteRecord,
 * unit names ^[a-z][a-z0-9_]*$), {@link createMetaStore} returns a KV-backed
 * implementation with identical semantics — records survive restarts and are
 * shared across processes. The KV shape is one record per session id:
 * `{ cwd?: string, files: { [storedRelPath]: { sizeBytes, uploadedAtMs } } }`.
 *
 * TODO(integration): confirm at wiring time which backend name carries the
 * KV facet in the shipped composition; for now the first registered backend
 * exposing `.kv` wins (see pickKvFacet).
 */

/** One stored file's bookkeeping row. */
export interface UploadMetaEntry {
  sizeBytes: number
  uploadedAtMs: number
  /**
   * M6 caption passthrough (P01 §6-D FR-D4): the vision waterfall's caption
   * for images, persisted so list/library surfaces can read it without
   * re-running the waterfall. Optional — text/binary files and degraded
   * waterfalls carry no caption.
   */
  imageCaption?: string
}

/** Per-session metadata record persisted as a single KV value. */
export interface SessionMetaRecord {
  /** Session cwd captured at first upload (lets the sweeper find dead sessions' workspaces). */
  cwd?: string
  files: Record<string, UploadMetaEntry>
}

export interface MetaStore {
  /** Upsert one file row (and remember cwd when provided). */
  record(sessionId: string, relPath: string, entry: UploadMetaEntry, cwd?: string): Promise<void>
  /** Remove one file row; missing rows are a no-op. */
  remove(sessionId: string, relPath: string): Promise<void>
  /** Read one session's full record (empty when unknown). */
  get(sessionId: string): Promise<SessionMetaRecord>
  /** Every session id that has at least one recorded row. */
  sessionIds(): Promise<string[]>
}

const UNIT_NAME = 'filehub'
const UNIT_VERSION = 1
const TABLE = 'sessions'

export function createMemoryMetaStore(): MetaStore {
  const records = new Map<string, SessionMetaRecord>()
  return {
    record(sessionId, relPath, entry, cwd) {
      const existing = records.get(sessionId) ?? { files: {} }
      if (cwd !== undefined) existing.cwd = cwd
      existing.files[relPath] = entry
      records.set(sessionId, existing)
      return Promise.resolve()
    },
    remove(sessionId, relPath) {
      const existing = records.get(sessionId)
      if (existing !== undefined) {
        const { [relPath]: _removed, ...rest } = existing.files
        existing.files = rest
      }
      return Promise.resolve()
    },
    get(sessionId) {
      const existing = records.get(sessionId)
      if (!existing) return Promise.resolve({ files: {} })
      return Promise.resolve({ ...existing, files: { ...existing.files } })
    },
    sessionIds() {
      return Promise.resolve([...records.keys()])
    },
  }
}

// ---- KV-backed seam over dsh-storage ---------------------------------------

/** Structural subset of the host storage hub this plugin touches. */
export interface StorageHubLike {
  backend: {
    names(): string[]
    get(name: string): { readonly kv?: KvFacetLike | undefined }
  }
}

/**
 * Structural subset of dsh-storage's KvFacet/KvUnit (backend.d.ts):
 *   kv.open({ name, version, tables, hasGlobal }) → unit
 *   unit.loadAll() / putRecord(table,key,value) / deleteRecord / close()
 */
export interface KvUnitLike {
  loadAll(): Promise<{ tables: Record<string, Record<string, unknown>>; global: unknown }>
  putRecord(table: string, key: string, value: unknown): Promise<void>
  deleteRecord(table: string, key: string): Promise<void>
  close(): Promise<void>
}

export interface KvFacetLike {
  open(descriptor: {
    name: string
    version: number
    tables: readonly string[]
    hasGlobal: boolean
  }): Promise<KvUnitLike>
}

function pickKvFacet(storage: StorageHubLike): KvFacetLike | undefined {
  for (const name of storage.backend.names()) {
    try {
      const backend = storage.backend.get(name)
      const kv = backend.kv
      if (kv) return kv
    } catch {
      // Registry entry vanished between names() and get(); keep scanning.
    }
  }
  return undefined
}

class KvMetaStore implements MetaStore {
  private unit: KvUnitLike | undefined
  /** Serialized write chain — the KV unit does not order concurrent writes. */
  private chain: Promise<unknown> = Promise.resolve()

  constructor(private readonly kv: KvFacetLike) {}

  private async openUnit(): Promise<KvUnitLike> {
    if (!this.unit) {
      this.unit = await this.kv.open({
        name: UNIT_NAME,
        version: UNIT_VERSION,
        tables: [TABLE],
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

  record(sessionId: string, relPath: string, entry: UploadMetaEntry, cwd?: string): Promise<void> {
    return this.enqueue(async () => {
      const unit = await this.openUnit()
      const snapshot = await unit.loadAll()
      const table = snapshot.tables[TABLE] ?? {}
      const existing = (table[sessionId] as SessionMetaRecord | undefined) ?? { files: {} }
      const next: SessionMetaRecord = {
        ...(cwd !== undefined ? { cwd } : existing.cwd !== undefined ? { cwd: existing.cwd } : {}),
        files: { ...existing.files, [relPath]: entry },
      }
      await unit.putRecord(TABLE, sessionId, next)
    })
  }

  remove(sessionId: string, relPath: string): Promise<void> {
    return this.enqueue(async () => {
      const unit = await this.openUnit()
      const snapshot = await unit.loadAll()
      const table = snapshot.tables[TABLE] ?? {}
      const existing = table[sessionId] as SessionMetaRecord | undefined
      if (!existing || !(relPath in existing.files)) return
      const { [relPath]: _removed, ...files } = existing.files
      const next: SessionMetaRecord = {
        ...(existing.cwd !== undefined ? { cwd: existing.cwd } : {}),
        files,
      }
      await unit.putRecord(TABLE, sessionId, next)
    })
  }

  async get(sessionId: string): Promise<SessionMetaRecord> {
    const unit = await this.openUnit()
    const snapshot = await unit.loadAll()
    const existing = (snapshot.tables[TABLE] ?? {})[sessionId] as SessionMetaRecord | undefined
    if (!existing) return { files: {} }
    return { ...existing, files: { ...existing.files } }
  }

  async sessionIds(): Promise<string[]> {
    const unit = await this.openUnit()
    const snapshot = await unit.loadAll()
    return Object.keys(snapshot.tables[TABLE] ?? {})
  }
}

/**
 * Build the metadata store: KV-backed when the host exposes a KV facet,
 * in-memory otherwise (single-process fallback — quota resets on restart).
 */
export function createMetaStore(
  storage: StorageHubLike | undefined,
  logWarn: (message: string) => void,
): MetaStore {
  const kv = storage ? pickKvFacet(storage) : undefined
  if (!kv) {
    logWarn('[filehub] no storage backend with a KV facet found; using in-memory upload metadata')
    return createMemoryMetaStore()
  }
  return new KvMetaStore(kv)
}
