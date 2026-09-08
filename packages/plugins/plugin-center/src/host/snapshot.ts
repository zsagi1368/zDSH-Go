import { createHash } from 'node:crypto'
import type { CatalogEntry } from '../shared/catalog.js'
import { validateCatalogEntry } from '../shared/catalog.js'
import { cpErr, cpOk, type CpResult } from '../shared/types.js'
import type { HttpPort } from './ports.js'

export interface CatalogLoadInput {
  seedPath: string
  cachePath: string
  remoteUrl?: string | undefined
}

export interface LoadedCatalog {
  entries: CatalogEntry[]
  mode: 'fresh' | 'cached' | 'seed'
  fetchedAt?: string | undefined
}

interface SnapshotFile {
  version: 1
  fetchedAt: string
  entries: unknown[]
}

function digestOf(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * A remote snapshot is only trusted when it ships a matching
 * `catalog.json.sha256` sidecar — an unsigned document must never be able to
 * promote itself to `recommended` or relax scripts policy.
 */
async function fetchVerifiedRemote(
  http: HttpPort,
  remoteUrl: string,
): Promise<CpResult<SnapshotFile>> {
  const [body, expectedDigest] = await Promise.all([
    http.fetchText(remoteUrl),
    http.fetchText(`${remoteUrl}.sha256`).catch(() => ({ ok: false as const, error: { code: 'source_unreachable' as const, message: 'no sidecar' } })),
  ])
  if (!body.ok || !expectedDigest.ok) {
    return cpErr('source_unreachable', 'remote catalog unreachable')
  }
  const declared = expectedDigest.data.match(/^[0-9a-f]{64}/)?.[0]
  if (declared === undefined || declared !== digestOf(body.data)) {
    return cpErr('untrusted_source', 'remote catalog failed integrity verification')
  }
  try {
    return cpOk(JSON.parse(body.data) as SnapshotFile)
  } catch {
    return cpErr('source_unreachable', 'remote catalog returned invalid JSON')
  }
}

function parseEntries(raw: unknown[]): CpResult<CatalogEntry[]> {
  const entries: CatalogEntry[] = []
  for (const item of raw) {
    const validated = validateCatalogEntry(item)
    if (!validated.ok) return validated
    entries.push(validated.data)
  }
  return cpOk(entries)
}

function parseSnapshot(raw: string): CpResult<SnapshotFile> {
  try {
    return cpOk(JSON.parse(raw) as SnapshotFile)
  } catch {
    return cpErr('internal', 'snapshot JSON is corrupted')
  }
}

function entriesOf(snapshot: SnapshotFile): CpResult<CatalogEntry[]> {
  return parseEntries(Array.isArray(snapshot.entries) ? snapshot.entries : [])
}

/**
 * Three-tier catalog loading with graceful degradation:
 * verified remote success → fresh (cache rewritten); anything else falls back
 * to the digest-checked local cache (`cached`), then the bundled seed.
 */
export async function loadCatalog(
  input: CatalogLoadInput,
  ports: { fs: FileSystemPortLike; http: HttpPort },
): Promise<CpResult<LoadedCatalog>> {
  if (input.remoteUrl) {
    const fetched = await fetchVerifiedRemote(ports.http, input.remoteUrl)
    if (fetched.ok) {
      const entries = entriesOf(fetched.data)
      if (!entries.ok) return entries
      const fetchedAt = typeof fetched.data.fetchedAt === 'string' ? fetched.data.fetchedAt : new Date().toISOString()
      try {
        const serialized = JSON.stringify(fetched.data, null, 2)
        ports.fs.writeFileAtomic(input.cachePath, serialized)
        ports.fs.writeFileAtomic(`${input.cachePath}.sha256`, digestOf(serialized))
      } catch {
        // cache write failure must not fail a successful fetch
      }
      return cpOk({ entries: entries.data, mode: 'fresh', fetchedAt })
    }
    // fall through to cache / seed
  }
  const cachedRaw = ports.fs.readFile(input.cachePath)
  if (cachedRaw !== null) {
    const expected = ports.fs.readFile(`${input.cachePath}.sha256`)
    // An unsigned or tampered cache is ignored rather than trusted.
    if (expected === null || digestOf(cachedRaw) !== expected.trim()) {
      return loadSeedOnly(input.seedPath, ports.fs)
    }
    const parsed = parseSnapshot(cachedRaw)
    if (!parsed.ok) return parsed
    const entries = entriesOf(parsed.data)
    if (!entries.ok) return entries
    return cpOk({
      entries: entries.data,
      mode: 'cached',
      fetchedAt: typeof parsed.data.fetchedAt === 'string' ? parsed.data.fetchedAt : undefined,
    })
  }
  return loadSeedOnly(input.seedPath, ports.fs)
}

function loadSeedOnly(
  seedPath: string,
  fs: FileSystemPortLike,
): CpResult<LoadedCatalog> {
  const seedRaw = fs.readFile(seedPath)
  if (seedRaw === null) {
    return cpErr('offline_degraded', 'no catalog source available (offline, no cache, no seed)')
  }
  const parsed = parseSnapshot(seedRaw)
  if (!parsed.ok) return parsed
  const entries = entriesOf(parsed.data)
  if (!entries.ok) return entries
  return cpOk({ entries: entries.data, mode: 'seed' })
}

// Structural subset so the loader stays decoupled from node implementations.
interface FileSystemPortLike {
  readFile(path: string): string | null
  writeFileAtomic(path: string, contents: string): void
}
