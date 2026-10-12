/**
 * One contender for `scripts/repository-corpus-lock.spec.ts`: announce
 * readiness, wait for the spec's barrier so every contender attempts the lock
 * at the same moment, hold the corpus lock for the stated time, and report the
 * timeline the spec asserts on.
 *
 * Arguments: `<root> <barrier> <report> <holdMs>`.
 */

import { existsSync, writeFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { withRepositoryCorpusLock } from '../repository-corpus-lock.ts'

/** One contender's hold, in epoch milliseconds. */
interface ContenderTimeline {
  attemptAt: number
  acquiredAt: number
  releasedAt: number
}

/** Bound on the barrier wait, so a lost spec run cannot wedge this child. */
const BARRIER_WAIT_MS = 60_000

async function awaitBarrier(barrier: string): Promise<void> {
  const deadline = Date.now() + BARRIER_WAIT_MS
  while (!existsSync(barrier)) {
    if (Date.now() >= deadline) throw new Error(`repository-corpus-lock.fixture: barrier ${barrier} never appeared`)
    await delay(5)
  }
}

const [root, barrier, report, hold] = process.argv.slice(2)
if (root === undefined || barrier === undefined || report === undefined || hold === undefined) {
  throw new Error('repository-corpus-lock.fixture: expected <root> <barrier> <report> <holdMs>')
}
const holdMs = Number(hold)
if (!Number.isSafeInteger(holdMs) || holdMs < 0) {
  throw new Error(`repository-corpus-lock.fixture: invalid hold ${hold}`)
}

writeFileSync(`${report}.ready`, '')
await awaitBarrier(barrier)
const attemptAt = Date.now()
await withRepositoryCorpusLock(root, async () => {
  const acquiredAt = Date.now()
  await delay(holdMs)
  const timeline: ContenderTimeline = { attemptAt, acquiredAt, releasedAt: Date.now() }
  writeFileSync(report, JSON.stringify(timeline))
})
