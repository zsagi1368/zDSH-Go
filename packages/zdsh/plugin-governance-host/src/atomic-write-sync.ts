/**
 * Synchronous atomic ledger write (TC-B4-H1 face 4 = FB5 settlement; D1b
 * §3-FB5: the durable ledgers were written with a direct `writeFileSync` —
 * a crash mid-write corrupted the file into the loader's fail-open empty
 * shape (a lost `userUninstalled` tombstone resurrects a removed preinstall
 * on the next boot), and lock-free readers could observe half-written JSON
 * across processes).
 *
 * Why NOT the in-repo `@deepseek-ai/dsh-atomic-write` `writeFileAtomic`
 * itself (errata 1/2, RECEIPT-H1 §2.2): ① that API is async while this
 * package's ledger commits sit on synchronous contract faces (`approve()` is
 * a sync `@Remote` with a sync compensation try/catch; the executor's
 * `recordOrigin` hook is sync) — async-izing them would extend the
 * published `@Remote` signatures (a contract-face change this card must not
 * make); ② the kernel package carries a "zero new dependencies, node
 * builtins only" discipline and has its own file-local mirror of this shape.
 *
 * Semantics mirror `writeFileAtomic` point by point
 * (atomic-write/src/index.ts:78-93 + renameAtomicTemp): random-suffix
 * sibling temp opened with exclusive create (`wx` — refuses to follow a
 * symlink planted at the temp path), the caller's mode stamped on the fresh
 * inode and carried through the rename, atomic rename commit (lock-free
 * readers observe either the old or the new complete content — the
 * atomic-write module-head protocol "readers stay lock-free because the
 * rename commit is atomic" is what this restores), bounded backoff retries
 * of transient win32 `EACCES`/`EBUSY`/`EPERM` rename failures (20ms doubling
 * to 200ms, 8 attempts), and temp cleanup + rethrow on any remaining failure.
 * Crash durability (fsync) stays out of scope exactly as the package
 * protocol states.
 * @module @deepseek-ai/dsh-plugin-governance-host/src/atomic-write-sync
 */
import { randomBytes } from 'node:crypto'
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** The transient Windows rename interference set (atomic-write package mirror). */
const WINDOWS_TRANSIENT_RENAME_ERRORS: ReadonlySet<string> = new Set(['EACCES', 'EBUSY', 'EPERM'])
const RENAME_RETRY_INITIAL_MS = 20
const RENAME_RETRY_MAX_MS = 200
const RENAME_RETRY_LIMIT = 8

/** Whether Windows reported temporary interference with an atomic replacement. */
function isTransientWindowsRenameError(error: unknown): boolean {
  if (process.platform !== 'win32') return false
  return WINDOWS_TRANSIENT_RENAME_ERRORS.has((error as NodeJS.ErrnoException | null)?.code ?? '')
}

/** Bounded synchronous sleep (Atomics.wait over a throwaway buffer; mirrors the async setTimeout backoff). */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** Rename the completed temp over the target, retrying transient Windows interference. */
function renameAtomicTempSync(temp: string, filename: string): void {
  let delay = RENAME_RETRY_INITIAL_MS
  for (let retries = 0;; retries += 1) {
    try {
      renameSync(temp, filename)
      return
    } catch (error) {
      if (!isTransientWindowsRenameError(error)) throw error
      if (retries >= RENAME_RETRY_LIMIT) throw error
    }
    sleepSync(delay)
    delay = Math.min(delay * 2, RENAME_RETRY_MAX_MS)
  }
}

/**
 * Replace `filename` with `content` in one atomic step (the synchronous
 * mirror of `writeFileAtomic`), creating parent directories. On any failure
 * the temp file is removed, the previous target content stays intact, and the
 * error rethrows so the caller's compensation runs.
 * @param filename - final path receiving the content.
 * @param content - complete next file content.
 * @param mode - permission bits stamped on the fresh temp inode and carried
 *   through the rename (subject to the umask, like every fresh inode); the
 *   ledgers carry user decision data, so callers pass `0o600`.
 */
export function writeFileAtomicSync(filename: string, content: string, mode: number): void {
  mkdirSync(dirname(filename), { recursive: true })
  const temp = `${filename}.${randomBytes(6).toString('hex')}.tmp`
  try {
    writeFileSync(temp, content, { mode, flag: 'wx' })
    renameAtomicTempSync(temp, filename)
  } catch (error) {
    try {
      rmSync(temp, { force: true })
    } catch {
      // Best-effort cleanup: a failing removal must never mask the primary
      // write error the caller's compensation depends on.
    }
    throw error
  }
}
