/**
 * The corpus lock's exclusion is proven with independent processes behind a
 * barrier instead of by repeated runs: the contenders start together, so their
 * attempt windows overlap on any host, and only then must their held windows be
 * disjoint. The lock artifact itself must stay outside the repository tree —
 * every corpus walker globs that tree — and one checkout must derive one lock
 * path from any spelling of its root.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { repositoryCorpusLockPath, withRepositoryCorpusLock } from './repository-corpus-lock.ts'

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
const tsxCli = fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url))
const fixture = fileURLToPath(new URL('./fixtures/repository-corpus-lock.fixture.ts', import.meta.url))

/** Contenders prove real contention, so their holds must span this long. */
const CONTENDER_HOLD_MS = 400

/** One contender's hold, in epoch milliseconds. */
interface ContenderTimeline {
  attemptAt: number
  acquiredAt: number
  releasedAt: number
}

/** One finished contender: its exit status, its stderr, and the hold it reported. */
interface ContenderOutcome {
  report: string
  status: number | null
  signal: NodeJS.Signals | null
  stderr: string
  timeline?: ContenderTimeline
}

/** Start one contender process and resolve once it exits, whatever the outcome. */
function startContender(
  root: string,
  barrier: string,
  report: string,
  pending: ChildProcess[],
): Promise<ContenderOutcome> {
  return new Promise((resolveOutcome, rejectStart) => {
    const child = spawn(process.execPath, [tsxCli, fixture, root, barrier, report, String(CONTENDER_HOLD_MS)], {
      cwd: repositoryRoot,
      env: { ...process.env, NO_COLOR: '1' },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    pending.push(child)
    let stderr = ''
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => { stderr += chunk })
    child.on('error', rejectStart)
    child.on('close', (status, signal) => {
      const timeline = existsSync(report) ? JSON.parse(readFileSync(report, 'utf8')) as ContenderTimeline : undefined
      resolveOutcome({ report, status, signal, stderr, ...timeline === undefined ? {} : { timeline } })
    })
  })
}

/** Poll a readiness condition, naming what stayed missing instead of waiting forever. */
async function waitFor(missing: () => string[], waitMs: number): Promise<void> {
  const deadline = Date.now() + waitMs
  for (;;) {
    const absent = missing()
    if (absent.length === 0) return
    if (Date.now() >= deadline) throw new Error(`repository-corpus-lock.spec: never appeared: ${absent.join(', ')}`)
    await delay(20)
  }
}

describe('repository corpus lock', () => {
  it('derives one lock path outside the repository tree from every spelling of the root', () => {
    const lockPath = repositoryCorpusLockPath(repositoryRoot)

    // The artifact must not join the corpus it guards, and one checkout must
    // resolve to one lock path whatever spelling its callers pass.
    expect(lockPath.startsWith(resolve(repositoryRoot))).toBe(false)
    expect(lockPath.startsWith(resolve(tmpdir()))).toBe(true)
    expect(repositoryCorpusLockPath(join(repositoryRoot, 'scripts', '..'))).toBe(lockPath)
    expect(repositoryCorpusLockPath(`${repositoryRoot}${sep}`)).toBe(lockPath)
  })

  it('holds the corpus exclusively across independent processes', { timeout: 90_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-corpus-lock-'))
    const pending: ChildProcess[] = []
    try {
      const barrier = join(root, 'barrier')
      const reports = [0, 1, 2].map(index => join(root, `contender-${index}.json`))
      const contenders = reports.map(report => startContender(root, barrier, report, pending))
      // Two-phase barrier: every contender is booted and waiting before the
      // gate opens, so spawn timing cannot masquerade as lock exclusion.
      await waitFor(() => reports.filter(report => !existsSync(`${report}.ready`)), 60_000)
      writeFileSync(barrier, '')
      const outcomes = await Promise.all(contenders)

      for (const outcome of outcomes) {
        // A killed contender reports as a timeout, never as a status mismatch.
        expect(outcome.signal, `${outcome.report}: ended through ${String(outcome.signal)}`).toBeNull()
        expect(outcome.status, `${outcome.report}: ${outcome.stderr}`).toBe(0)
      }
      const timelines = outcomes.flatMap(outcome => outcome.timeline === undefined ? [] : [outcome.timeline])
      expect(timelines).toHaveLength(outcomes.length)

      const sorted = [...timelines].sort((left, right) => left.acquiredAt - right.acquiredAt)
      let previous: ContenderTimeline | undefined
      for (const timeline of sorted) {
        if (previous !== undefined) {
          expect(timeline.acquiredAt, 'held windows must not overlap').toBeGreaterThanOrEqual(previous.releasedAt)
        }
        previous = timeline
      }
      // Contention is proven, not assumed: the barrier put every attempt
      // before the first hold ended, and three holds cannot finish in two.
      const attemptedAt = timelines.map(timeline => timeline.attemptAt)
      const releasedAt = timelines.map(timeline => timeline.releasedAt)
      expect(Math.max(...attemptedAt)).toBeLessThan(Math.min(...releasedAt))
      expect(Math.max(...releasedAt) - Math.min(...attemptedAt)).toBeGreaterThanOrEqual(2 * CONTENDER_HOLD_MS)
    } finally {
      for (const child of pending) child.kill()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('releases the corpus lock after a failing operation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-corpus-lock-failure-'))
    try {
      const lockPath = `${repositoryCorpusLockPath(root)}.lock`

      await expect(withRepositoryCorpusLock(root, async () => { throw new Error('fixture operation failed') }))
        .rejects.toThrow('fixture operation failed')
      expect(existsSync(lockPath), 'a failed operation must not leave the lock held').toBe(false)
      await expect(withRepositoryCorpusLock(root, async () => 'acquired after the failure')).resolves.toBe('acquired after the failure')
      expect(existsSync(lockPath)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
