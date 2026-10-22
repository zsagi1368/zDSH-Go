/**
 * Irreversible Session deletion: the admission check, the live teardown, the
 * accounting detach, and the durable purge, in that order. The order is the
 * contract: a Session with running work is refused before anything is
 * written, the live Agent is stopped before its log disappears, and the
 * durable artifacts go last, so a failure leaves a still-listed Session
 * rather than a listed Session whose log is gone.
 */

import type { Context } from '@deepseek-ai/cordis'
import { errorChain } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { SessionQueryError } from '@deepseek-ai/dsh-session-query'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { SessionDeleteRequest, SessionDeleteValue } from './types.ts'

/** Implements the irreversible Session deletion delegated by the Session Controller. */
export class SessionDeleteController {
  /**
   * @param ctx - Host context carrying the Agent registry, Session store, Workspace registry, and persistence.
   */
  constructor(private readonly ctx: Context) {}

  /**
   * Delete one Session and everything durable about it.
   *
   * A Session with running work is refused as `session/active` unless
   * `stopActivity` is set, in which case the composed providers stop that
   * work first. The live Agent is then torn down, the Session is detached
   * from its Workspace's accounting and from the registry-global archive and
   * pin sets, and the durable artifacts are purged. Attachments are NOT
   * removed: they are content-addressed and shared between Sessions.
   *
   * @param request - Session identity and whether its running work is stopped.
   * @returns receipt after the durable artifacts are gone.
   * @throws {RemoteError} when the Session is unknown, still active, or its
   *   teardown failed.
   */
  async delete(request: SessionDeleteRequest): Promise<SessionDeleteValue> {
    const sessionId = request.sessionId
    const agent = this.ctx.agents.get(sessionId)
    const attached = this.ctx.sessions.get(sessionId)
    const known = agent !== undefined || attached !== undefined
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
    await this.teardownLiveAgent(sessionId)
    await this.detachFromWorkspace(sessionId)
    await this.purgeArtifacts(sessionId)
    return { deleted: true }
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
   * Tear the live Agent down: cancel its active turn and wait for quiescence
   * so its final events reach the log before the artifacts are purged.
   */
  private async teardownLiveAgent(sessionId: SessionId): Promise<void> {
    const agent = this.ctx.agents.get(sessionId)
    if (agent === undefined) return
    try {
      agent.cancel({ kind: 'disposed' })
      await agent.whenIdle()
    } catch (error: unknown) {
      this.ctx.logger.warn(
        `session-controller: stopping session '${sessionId}' for deletion failed: ${errorChain(error)}`,
      )
    }
  }

  /**
   * Detach the Session from every accounting surface that names it: the
   * Workspace that owns it, the registry-global archive set, and the
   * registry-global pin set. The archive and pin sets are registry-global
   * state, so the registry itself owns their removal.
   */
  private async detachFromWorkspace(sessionId: SessionId): Promise<void> {
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
