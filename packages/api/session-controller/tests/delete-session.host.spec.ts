/**
 * Deleting a Session this process has open.
 *
 * The Session's durable write handle belongs to its live Agent, and the JSONL
 * backend refuses to purge a Session a live writer holds — so a deletion that
 * only cancelled the Agent's turn used to be refused every time, after the
 * Session had already been detached from its Workspace. These cases run the
 * REAL AgentLoop factory and the REAL JSONL backend, because a stub factory
 * whose `dispose` resolves without closing anything cannot show the difference
 * between cancelling an Agent and disposing it.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import { meta, oneTurnLog } from '../../../session/session-persistence/tests/contract.ts'
import { createSessionTestRemote, type TestSessionRemote } from './test-remote.ts'

const contexts: Context[] = []
const roots: string[] = []

afterEach(async () => {
  try {
    await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  } finally {
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  }
})

/**
 * A Workspace that records the detaches asked of it, like the registry's own.
 * `sessionIds` reflects the live membership, so a test can assert that a
 * refused deletion left the Session where it was.
 */
interface RecordingWorkspace extends Workspace {
  readonly detaches: SessionId[]
  attach(sessionId: SessionId): void
  /** Make every detach reject (`true`) or accept (`false`), to model a failing bookkeeping write. */
  failDetach(fails: boolean): void
}

function recordingWorkspace(cwd: string): RecordingWorkspace {
  const detaches: SessionId[] = []
  const sessionIds: SessionId[] = []
  let detachFails = false
  return {
    id: 'ws-test',
    path: cwd,
    title: 'test',
    detaches,
    get sessionIds() { return [...sessionIds] },
    attach: (sessionId: SessionId) => { sessionIds.push(sessionId) },
    attachSession: async (sessionId: SessionId) => { sessionIds.push(sessionId) },
    failDetach: (fails: boolean) => { detachFails = fails },
    detachSession: async (sessionId: SessionId) => {
      if (detachFails) throw new Error('workspace storage is read-only')
      detaches.push(sessionId)
      const at = sessionIds.indexOf(sessionId)
      if (at !== -1) sessionIds.splice(at, 1)
    },
  } as unknown as RecordingWorkspace
}

/**
 * A Host with the real AgentLoop, the real JSONL backend, and the production
 * Session Controller over them.
 */
async function harness(): Promise<{
  ctx: Context
  remote: TestSessionRemote
  root: string
  workspace: RecordingWorkspace
}> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-delete-session-'))
  roots.push(root)
  const ctx = new (await import('@deepseek-ai/cordis')).Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await mountAgentLoopTestHarness(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'logs'), compression: 'none' })
  const workspace = recordingWorkspace(root)
  ctx.provide('workspaceRegistry', {
    list: () => [workspace],
    archivedSessionIds: [],
    pinnedSessionIds: [],
    unarchiveSession: async () => {},
    unpinSession: async () => {},
  } as never)
  const selection: ModelSelection = { provider: 'mock', model: 'mock-model' }
  const remote = createSessionTestRemote(ctx, {
    defaultModelSelection: () => selection,
    cwd: root,
  })
  return { ctx, remote, root, workspace }
}

/** Create one Session through the production path and materialize its log. */
async function createStoredSession(
  ctx: Context,
  remote: TestSessionRemote,
  workspace: RecordingWorkspace,
): Promise<SessionId> {
  const created = await remote.create({ cwd: workspace.path })
  if (!created.ok) throw new Error(`session.create failed: ${created.error.message}`)
  const sessionId = created.value.sessionId
  workspace.attach(sessionId)
  // The artifact appears on the first flush; without one there is nothing for
  // the purge to remove and the ownership refusal cannot be told from success.
  await ctx.sessionPersistence.flush()
  expect(await ctx.sessionPersistence.stat(sessionId)).toBeDefined()
  return sessionId
}

describe('Session deletion releases the live writer', () => {
  it('deletes a Session whose live Agent this process resolved', async () => {
    const { ctx, remote, workspace } = await harness()
    const sessionId = await createStoredSession(ctx, remote, workspace)
    expect(ctx.agents.get(sessionId)).toBeDefined()

    const deleted = await remote.delete({ sessionId, stopActivity: true })

    expect(deleted.ok ? undefined : deleted.error.message).toBeUndefined()
    expect(await ctx.sessionPersistence.stat(sessionId)).toBeUndefined()
    expect(ctx.agents.get(sessionId)).toBeUndefined()
    expect(workspace.detaches).toEqual([sessionId])
  })

  it('leaves the Session in its Workspace when another writer still holds it', async () => {
    const { ctx, remote, workspace } = await harness()
    // A Session nobody in this process has opened: its log is written and
    // closed directly, so the only writer below is the one this test opens to
    // stand in for another owner. That models the in-process refusal the
    // production failure showed; the cross-process lease refuses identically.
    const header = meta('session-held-elsewhere', workspace.path)
    const written = await ctx.sessionPersistence.create(header)
    try {
      await written.append(oneTurnLog())
    } finally {
      await written.close()
    }
    workspace.attach(header.id)
    const other = await ctx.sessionPersistence.open(header.id, 'write')

    const refused = await remote.delete({ sessionId: header.id, stopActivity: true })

    expect(refused.ok).toBe(false)
    if (!refused.ok) {
      expect(refused.error.message).toMatch(/already owned by an active write handle/)
    }
    expect(workspace.detaches).toEqual([])
    expect(workspace.sessionIds).toEqual([header.id])

    await other.close()
    const deleted = await remote.delete({ sessionId: header.id, stopActivity: true })
    expect(deleted.ok ? undefined : deleted.error.message).toBeUndefined()
    expect(await ctx.sessionPersistence.stat(header.id)).toBeUndefined()
    expect(workspace.detaches).toEqual([header.id])
  })

  it('deletes a Session this process forked', async () => {
    const { ctx, remote, workspace } = await harness()
    // Fork needs a completed turn to cut at, and its source may be cold.
    const source = meta('session-fork-source', workspace.path)
    const written = await ctx.sessionPersistence.create(source)
    try {
      await written.append(oneTurnLog())
    } finally {
      await written.close()
    }
    workspace.attach(source.id)

    const forked = await remote.fork({ sessionId: source.id })
    if (!forked.ok) throw new Error(`session.fork failed: ${forked.error.message}`)
    const childId = forked.value.sessionId
    expect(ctx.agents.get(childId)).toBeDefined()

    const deleted = await remote.delete({ sessionId: childId, stopActivity: true })

    expect(deleted.ok ? undefined : deleted.error.message).toBeUndefined()
    expect(await ctx.sessionPersistence.stat(childId)).toBeUndefined()
    expect(ctx.agents.get(childId)).toBeUndefined()
  })

  it('owns one identity across successive generations', async () => {
    const { ctx, remote, workspace } = await harness()
    const sessionId = await createStoredSession(ctx, remote, workspace)
    const first = await remote.delete({ sessionId, stopActivity: true })
    expect(first.ok ? undefined : first.error.message).toBeUndefined()

    // The same identity again: a fresh Agent and a fresh write handle. What
    // this pins is that the SECOND generation is reachable — a controller
    // still holding only the first generation's spent capability would leave
    // the new handle open and the deletion would refuse. It does not isolate
    // the map's overwrite rule: the first disposal's `agent/disposed` empties
    // the slot first, so a controller that never overwrote would pass too.
    const recreated = await remote.create({ cwd: workspace.path, sessionId })
    expect(recreated.ok ? undefined : recreated.error.message).toBeUndefined()
    await ctx.sessionPersistence.flush()
    expect(ctx.agents.get(sessionId)).toBeDefined()

    const second = await remote.delete({ sessionId, stopActivity: true })

    expect(second.ok ? undefined : second.error.message).toBeUndefined()
    expect(await ctx.sessionPersistence.stat(sessionId)).toBeUndefined()
    expect(ctx.agents.get(sessionId)).toBeUndefined()
  })

  it('deletes a Session whose log is already gone but is still listed', async () => {
    const { ctx, remote, workspace } = await harness()
    // The residue a deletion whose detach step failed leaves behind: named by
    // its Workspace, with no durable artifact. Refusing it as not-found would
    // strand a listed Session nobody can clean up.
    const orphan = 'session-listed-without-log' as SessionId
    workspace.attach(orphan)

    const deleted = await remote.delete({ sessionId: orphan, stopActivity: true })

    expect(deleted.ok ? undefined : deleted.error.message).toBeUndefined()
    expect(workspace.detaches).toEqual([orphan])
    expect(workspace.sessionIds).toEqual([])
    expect(await ctx.sessionPersistence.stat(orphan)).toBeUndefined()
  })

  it('refuses an identity no surface names and no store holds', async () => {
    const { remote } = await harness()

    // The negative arm of the residue rule above: `isRegistered` must not turn
    // an unknown id into a silent success. Nothing names this one and it has
    // no log, so the storage read decides and the deletion is refused.
    const refused = await remote.delete({
      sessionId: 'session-never-created' as SessionId,
      stopActivity: true,
    })

    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.error.code).toBe('session/not-found')
  })

  it('reports success when the log is gone and only the detach failed', async () => {
    const { ctx, remote, workspace } = await harness()
    const sessionId = await createStoredSession(ctx, remote, workspace)
    workspace.failDetach(true)

    const deleted = await remote.delete({ sessionId, stopActivity: true })

    // The durable deletion happened, so the caller is told it happened; what
    // remains is a listing that names a Session with no log.
    expect(deleted.ok ? undefined : deleted.error.message).toBeUndefined()
    expect(await ctx.sessionPersistence.stat(sessionId)).toBeUndefined()
    expect(workspace.sessionIds).toEqual([sessionId])

    // Once the bookkeeping write works again, the residue case above reaches
    // this identity (no log, still named) and clears the listing.
    workspace.failDetach(false)
    const cleaned = await remote.delete({ sessionId, stopActivity: true })

    expect(cleaned.ok ? undefined : cleaned.error.message).toBeUndefined()
    expect(workspace.sessionIds).toEqual([])
    expect(workspace.detaches).toEqual([sessionId])
  })
})
