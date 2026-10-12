/**
 * Cross-process exclusion between a repository-corpus walk and the transient
 * probes another spec writes into that corpus.
 *
 * `scripts/persistence-schema.spec.ts` derives its corpus from
 * `tsconfig.host.json` (`packages/<pkg>/<sub>/src/**`), builds one TypeScript
 * program from that file list and throws on any compiler diagnostic, so a file
 * the enumeration saw and the program then cannot read reports
 * `TS6053 File '…' not found.` Measured on 2026-10-12: deleting a probe 3.2 s
 * into that case reproduces it, deleting one before the enumeration does not.
 * `scripts/oxlint-contract.spec.ts` writes `oxlint-contract-<uuid>.ts` probes
 * into those same package `src` trees to prove Oxlint's project ownership, and
 * removes them when its case ends.
 *
 * The probe cannot leave that corpus by placement or naming: it must be a
 * member of the real package project, and Oxlint resolves no project for a
 * dot-prefixed file or directory (measured: `<none>`, `Unmatched file`), while
 * the corpus stays exactly those package `src` trees for both the config
 * enumeration and the filesystem glob. The corpus is therefore serialized
 * instead of narrowed: the probe's lifetime and the walk's enumerate-to-read
 * window each run inside {@link withRepositoryCorpusLock}, which delegates to
 * the repository's `withFileLock` primitive (exclusive `wx` create, holder PID,
 * takeover of a lock whose holder exited), so no enumeration can outlive the
 * probe it saw and no probe can appear inside a running walk.
 *
 * The lock artifact lives in the system temporary directory, keyed by the
 * canonical checkout path: a lock file inside the repository would join the
 * very corpus it guards, and every tree walker would then race with it.
 * @module scripts/repository-corpus-lock
 */

import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withFileLock, type FileLockOptions } from '@deepseek-ai/dsh-atomic-write'

/**
 * How long a contender waits for the corpus lock by default. The walk case
 * holds it for the length of a repository-wide TypeScript program (about 8 s
 * locally, bounded by its own 90 s case budget), so this budget outlasts a
 * realistic holder while still failing inside that budget with the lock path
 * named instead of a bare runner timeout.
 */
const DEFAULT_CORPUS_LOCK_WAIT_MS = 60_000

/**
 * Canonical identity of one checkout, so every process derives one lock path
 * from any spelling of the repository root.
 * @param root - repository root, absolute or relative to the caller's cwd.
 * @returns hex identity of the resolved real path.
 */
function corpusLockIdentity(root: string): string {
  const canonical = realpathSync(root)
  // Windows compares those paths case-insensitively, so two spellings of one
  // checkout must not produce two locks; POSIX path case stays significant.
  const comparable = process.platform === 'win32' ? canonical.toLowerCase() : canonical
  return createHash('sha256').update(comparable).digest('hex').slice(0, 32)
}

/**
 * Path of the lock artifact for one checkout, outside the repository tree.
 * @param root - repository root whose corpus the lock guards.
 * @returns absolute path whose `.lock` sibling is the mutual-exclusion file.
 */
export function repositoryCorpusLockPath(root: string): string {
  return join(tmpdir(), `dsh-repository-corpus-${corpusLockIdentity(root)}`)
}

/**
 * Run one operation while holding the repository-corpus lock. Both the
 * transient-probe window and the corpus walk window run here; nothing else may
 * enumerate or mutate the corpus outside it, and the lock is not reentrant, so
 * an operation must not nest another acquisition. The operation is async like
 * every other holder of this lock primitive, so a sync window states `async`.
 * @param root - repository root whose corpus the operation touches.
 * @param operation - the probe lifetime or corpus walk to run exclusively.
 * @param options - acquisition options; omitted waits {@link DEFAULT_CORPUS_LOCK_WAIT_MS}.
 * @returns the operation's result; the lock releases on both outcomes.
 */
export function withRepositoryCorpusLock<T>(
  root: string,
  operation: () => Promise<T>,
  options?: FileLockOptions,
): Promise<T> {
  return withFileLock(
    repositoryCorpusLockPath(root),
    operation,
    { waitMs: options?.waitMs ?? DEFAULT_CORPUS_LOCK_WAIT_MS },
  )
}
