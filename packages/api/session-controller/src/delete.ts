/**
 * Irreversible Session deletion: the admission check, the live release, the
 * durable purge, and the accounting detach, in that order. The order is the
 * contract: a Session with running work is refused before anything is written,
 * the live Agent is disposed before its log disappears, and the durable purge
 * runs before any accounting is touched — a purge refusal is the one failure
 * an outside holder can cause, so it must leave the Session exactly as it was
 * rather than detached from its Workspace with its log still on disk.
 */

import type { Context } from '@deepseek-ai/cordis'
import { errorChain } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { SessionQueryError } from '@deepseek-ai/dsh-session-query'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { ApiSessionAgentController } from './agent.ts'
import type { SessionDeleteRequest, SessionDeleteValue } from './types.ts'

/** Implements the irreversible Session deletion delegated by the Session Controller. */
export class SessionDeleteController {
  /**
   * @param ctx - Host context carrying the Agent registry, Session store, Workspace registry, and persistence.
   * @param agents - the controller that resolved this process's Agents, and so holds their disposers.
   */
  constructor(
    private readonly ctx: Context,
    private readonly agents: ApiSessionAgentController,
  ) {}

  /**
   * Delete one Session and everything durable about it.
   *
   * A Session with running work is refused as `session/active` unless
   * `stopActivity` is set, in which case the composed providers stop that
   * work first. The live Agent is then disposed — which is what closes the
   * Session's durable write handle, so the purge below is allowed to run —
   * the durable artifacts are purged, and only then is the Session detached
   * from its Workspace's accounting and from the registry-global archive and
   * pin sets. Attachments are NOT removed: they are content-addressed and
   * shared between Sessions.
   *
   * @param request - Session identity and whether its running work is stopped.
   * @returns receipt after the durable artifacts are gone.
   * @throws {RemoteError} when the Session is unknown, still active, or its
   *   durable artifacts are held by another writer.
   */
  async delete(request: SessionDeleteRequest): Promise<SessionDeleteValue> {
    const sessionId = request.sessionId
    const agent = this.ctx.agents.get(sessionId)
    const attached = this.ctx.sessions.get(sessionId)
    // A Session with no durable log but still named by a Workspace, the
    // archive set, or the pin set is exactly the residue a deletion whose
    // detach step failed leaves behind. It is deletable too: refusing it as
    // not-found would strand a listed Session nobody can clean up.
    const known = agent !== undefined || attached !== undefined
      || this.isRegistered(sessionId)
      || await this.storedSessionExists(sessionId)
    if (!known) {
      throw new RemoteError('session/not-found', `session "${sessionId}" not found`, { sessionId })
    }
    if (request.stopActivity !== true) {
      const activity = await this.ctx.waterfall(
        'workspace/session-activity', { sessionId }, () => Promise.resolve([]),
      )
      if (activity.length > 0) {
        throw new RemoteError(
          'session/active',
          `cannot delete session '${sessionId}': the session is active (${activity.map(entry => entry.kind).join(', ')})`,
          { sessionId, activity },
        )
      }
    }
    if (request.stopActivity === true) await this.stopSessionActivity(sessionId)
    await this.releaseLiveAgent(sessionId)
    await this.purgeArtifacts(sessionId)
    await this.detachFromWorkspace(sessionId)
    return { deleted: true }
  }

  /**
   * Whether any accounting surface still names this Session, independently of
   * its durable log. Cheap and in-memory: it is consulted before the storage
   * read that {@link storedSessionExists} performs.
   *
   * Deliberately narrow: only an identity a surface actually names passes, so
   * a misspelt or never-created id still falls through to the storage read and
   * is refused as not-found. It exists for the one state that is neither live
   * nor stored — the listing a detach that failed after a successful purge
   * leaves behind — and widening it past that would turn every 404 into a
   * silent success.
   */
  private isRegistered(sessionId: SessionId): boolean {
    const registry = this.ctx.workspaceRegistry
    if (registry.archivedSessionIds.includes(sessionId)) return true
    if (registry.pinnedSessionIds.includes(sessionId)) return true
    return registry.list().some(workspace => workspace.sessionIds.includes(sessionId))
  }

  /**
   * Whether the durable store still holds a Session with this identity. A
   * storage fault propagates: an unreadable store must never read as an
   * absent Session.
   */
  private async storedSessionExists(sessionId: SessionId): Promise<boolean> {
    try {
      using observation = await this.ctx.sessionQuery.observeSession(sessionId, { projectionMode: 'none' })
      return observation.header.id === sessionId
    } catch (error: unknown) {
      if (error instanceof SessionQueryError && error.code === 'SESSION_QUERY_SESSION_NOT_FOUND') return false
      throw error
    }
  }

  /** Ask every composed provider to stop the Session's running work. */
  private async stopSessionActivity(sessionId: SessionId): Promise<void> {
    try {
      await this.ctx.parallel('workspace/session-stop', { sessionId })
    } catch (error: unknown) {
      // ctx.parallel settles every listener and rejects with one AggregateError.
      /* v8 ignore next -- the plain arm guards a rethrowing dispatcher. */
      const failures = error instanceof AggregateError ? error.errors : [error]
      for (const failure of failures) {
        this.ctx.logger.warn(`session-controller: stopping session '${sessionId}' for deletion failed: ${String(failure)}`)
      }
    }
  }

  /**
   * Release the Session's live Agent and, with it, the Session's durable write
   * handle. Disposal is the only thing that closes that handle — cancelling
   * the Agent's turn does not, because the handle outlives the turn — and a
   * handle still held here is what makes the purge below refuse. A disposal
   * failure is reported and stepped over: the purge is the authoritative
   * ownership test, and it is about to run before any accounting changes.
   */
  private async releaseLiveAgent(sessionId: SessionId): Promise<void> {
    try {
      await this.agents.disposeAgent(sessionId)
    } catch (error: unknown) {
      this.ctx.logger.warn(
        `session-controller: releasing session '${sessionId}' for deletion failed: ${errorChain(error)}`,
      )
    }
  }

  /**
   * Detach the Session from every accounting surface that names it: the
   * Workspace that owns it, the registry-global archive set, and the
   * registry-global pin set. The archive and pin sets are registry-global
   * state, so the registry itself owns their removal.
   *
   * This runs last, after the durable purge, and a failure is reported and
   * stepped over. By this point the log is gone, so the deletion HAS happened
   * and telling the caller otherwise would be a lie; what a failure leaves is
   * a listing that names a Session with no log — exactly the residue the
   * not-found arm of {@link isRegistered} exists to let a later deletion
   * clean up.
   */
  private async detachFromWorkspace(sessionId: SessionId): Promise<void> {
    try {
      const registry = this.ctx.workspaceRegistry
      for (const workspace of registry.list()) {
        if (!workspace.sessionIds.includes(sessionId)) continue
        await workspace.detachSession(sessionId)
      }
      if (registry.archivedSessionIds.includes(sessionId)) {
        await registry.unarchiveSession(sessionId)
      }
      if (registry.pinnedSessionIds.includes(sessionId)) {
        await registry.unpinSession(sessionId)
      }
    } catch (error: unknown) {
      this.ctx.logger.warn(
        `session-controller: detaching deleted session '${sessionId}' from its accounting surfaces failed; `
        + `it stays listed with no log until a later deletion retries: ${errorChain(error)}`,
      )
    }
  }

  /**
   * Remove the Session's durable artifacts. A missing store or a Session the
   * store never materialized is not a failure: there is nothing left to
   * remove. A live writer refuses the purge, and that refusal is the
   * caller's to see.
   */
  private async purgeArtifacts(sessionId: SessionId): Promise<void> {
    const persistence = this.ctx.get('sessionPersistence')
    if (persistence === undefined) return
    try {
      await persistence.purge(sessionId)
    } catch (error: unknown) {
      throw new RemoteError(
        'gateway/internal',
        `failed to remove the durable artifacts of session "${sessionId}": ${errorChain(error)}`,
        { sessionId },
        { cause: error },
      )
    }
  }
}
