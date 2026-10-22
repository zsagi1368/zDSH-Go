/**
 * The durable purge: a Session's artifacts are removed, and a Session a
 * writer still holds is refused rather than pulled out from under it.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { SessionAlreadyOwnedError } from '@deepseek-ai/dsh-session-persistence'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { sessionDir } from '../src/format.ts'
import { meta, oneTurnLog } from '../../session-persistence/tests/contract.ts'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function harness(): Promise<{ ctx: Context; persistence: SessionPersistence; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-purge-'))
  dirs.push(root)
  const ctx = new Context()
  await ctx.plugin(JsonlSessionPersistence, { root })
  return { ctx, persistence: ctx.sessionPersistence, root }
}

/** Create + append + close: persist one whole log through the write handle. */
async function writeLog(
  persistence: SessionPersistence,
  header: SessionHeader,
  events: readonly SessionEvent[],
): Promise<void> {
  const handle = await persistence.create(header)
  try {
    await handle.append(events)
  } finally {
    await handle.close()
  }
}

describe('JsonlSessionPersistence: durable purge', () => {
  it('removes the session artifacts and reports that they are gone', async () => {
    const { persistence, root } = await harness()
    const header = meta('purge-one', '/repo')
    await writeLog(persistence, header, oneTurnLog())

    // The session's directory is there before the purge.
    const dir = sessionDir(root, header.cwd, header.id)
    await expect(stat(dir)).resolves.toBeDefined()

    await expect(persistence.purge(header.id)).resolves.toBe(true)

    // Nothing is left behind, and the session no longer lists.
    await expect(stat(dir)).rejects.toThrow()
    await expect(persistence.open(header.id, 'read')).rejects.toThrow()
    const listed = await persistence.list()
    expect(listed.some(snapshot => snapshot.header.id === header.id)).toBe(false)
  })

  it('reports a session it never stored as absent rather than failing', async () => {
    const { persistence } = await harness()
    await expect(persistence.purge(SessionId('never-stored'))).resolves.toBe(false)
  })

  it('refuses to purge a session a writer still holds', async () => {
    const { persistence } = await harness()
    const header = meta('purge-written', '/repo')
    const handle = await persistence.create(header)
    try {
      await handle.append(oneTurnLog())
      // The handle still owns the session: purging it now would remove the
      // log the writer is about to append to.
      await expect(persistence.purge(header.id)).rejects.toBeInstanceOf(SessionAlreadyOwnedError)
    } finally {
      await handle.close()
    }
    // Once the writer is gone, the same purge succeeds.
    await expect(persistence.purge(header.id)).resolves.toBe(true)
  })

  it('purges a session stored under a different working directory', async () => {
    const { persistence } = await harness()
    const header = meta('purge-elsewhere', '/other/repo')
    await writeLog(persistence, header, oneTurnLog())
    await expect(persistence.purge(header.id)).resolves.toBe(true)
    await expect(persistence.open(header.id, 'read')).rejects.toThrow()
  })
})
