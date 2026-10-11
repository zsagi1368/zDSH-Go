/**
 * Session-scope enforcement for project plugin tools (S-43 M3, C-03).
 *
 * Project plugin tools are registered globally at mount time (the entry module
 * registers through the boot context, and subprocess proxies register on the
 * host side), so without an extra boundary every agent in the process would
 * see them regardless of where its session lives. This module closes that gap:
 *
 * - Each project tool is bound to the project root that owns it.
 * - For every live agent whose session cwd does NOT hit that root, the tool is
 *   restricted away through `agent.ctx.tools.restrict({ deny: [...] })`. The
 *   restriction is an effect owned by the agent's scope, so it is removed
 *   automatically when the agent is disposed ("进项目生效离开卸载").
 * - New agents are covered by an `agent/created` listener; agents created
 *   before the layer mounted are swept at mount time.
 *
 * The value this module reads (cwd) is the session's own durable header; the
 * enforcement is host-side, never inferred by the UI.
 * @module @deepseek-ai/dsh-plugin-project-root
 */

import { resolve } from 'node:path'

/**
 * Whether a session cwd is "inside" (or equals) the project root — the C-03
 * visibility predicate. Case-folded on Windows, like the preset-root merge and
 * the path guard. A missing cwd never hits.
 * @param sessionCwd - the calling session's durable header cwd.
 * @param projectRoot - the absolute project root that owns the plugin.
 * @returns true when the session's cwd lies within the project root.
 */
export function cwdHitsProjectRoot(sessionCwd: string | undefined, projectRoot: string): boolean {
  if (sessionCwd === undefined || sessionCwd.trim().length === 0) return false
  const keyOf = (path: string): string => (process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path))
  // Strip a trailing separator so a drive root still prefix-matches after a
  // fresh separator is appended (same convention as the clamp's stemOf).
  const root = keyOf(projectRoot).replace(/[\\/]+$/u, '')
  const cwd = keyOf(sessionCwd).replace(/[\\/]+$/u, '')
  return cwd === root || cwd.startsWith(`${root}/`) || cwd.startsWith(`${root}\\`)
}

/** Structural session view of a live agent (no @deepseek-ai/dsh-agent import). */
export interface SessionAgentLike {
  readonly session?: { readonly header?: { readonly cwd?: string } }
  readonly ctx?: { readonly tools?: { restrict?(filter: { deny: readonly string[] }): () => void } }
}

/** Structural view of the host agents service (presence-probed, never read hot). */
export interface SessionAgentsServiceLike {
  on?(event: 'agent/created', listener: (payload: { agent: SessionAgentLike }) => void): () => void
  list?(): readonly SessionAgentLike[]
}

/** The session-scope wiring handle owned by the project plugin layer. */
export interface SessionScopeWiring {
  /**
   * Bind newly mounted project tools to their owning root and re-apply the
   * per-agent restrictions to every live agent. Safe to call repeatedly: a
   * same-name restriction for an agent that already denies the name is
   * idempotent in effect (denials intersect).
   * @param toolNames - the tool names this root just mounted.
   * @param projectRoot - the absolute project root that owns them.
   */
  applyRestrictions(toolNames: readonly string[], projectRoot: string): void
  /** Remove the `agent/created` listener; per-agent restrictions stay scope-owned. */
  dispose(): void
}

/** A warn sink that never throws (author-facing diagnostics). */
type WarnSink = (message: string) => void

/** Default warn sink mirrors the discovery default. */
function defaultWarn(message: string): void {
  process.stderr.write(`dsh project-plugins: ${message}\n`)
}

/**
 * Install the session-scope enforcement on a settled boot context.
 *
 * The wiring is inert when the context carries no agents service (a host
 * without the agent runtime has no sessions to scope against); it also never
 * fails the boot when the service is present but a restriction cannot be
 * applied — the execute-time cwd check in the project tool wrapper remains as
 * the second line of defense.
 * @param ctx - the settled boot context (post-boot, project layer creation).
 * @param warn - author-facing diagnostics sink (defaults to stderr).
 * @returns the wiring handle.
 */
export function wireSessionScope(ctx: object, warn: WarnSink = defaultWarn): SessionScopeWiring {
  // toolName → owning project root. Only project tools ever enter this map, so
  // a name collision across two project roots resolves to the LAST mount (the
  // later plugin shadows the earlier, matching the tools registry semantics).
  const toolRoots = new Map<string, string>()
  // Per agent, the tool names already denied for it. An agent whose cwd misses
  // one root is re-swept on every applyRestrictions call so LATER mounts (a
  // second plugin, or a plugin whose tools the first sweep predates) are
  // restricted for it too; the set keeps each name restricted exactly once.
  const deniedByAgent = new WeakMap<SessionAgentLike, Set<string>>()
  let disposed = false

  function restrictFor(agent: SessionAgentLike, toolName: string): void {
    const tools = agent.ctx?.tools
    if (typeof tools?.restrict !== 'function') return
    try {
      tools.restrict({ deny: [toolName] })
    } catch (cause) {
      // The name may not be registered YET on this agent's view (a creation
      // listener racing a mount); the next applyRestrictions sweep covers it.
      warn(`session scope: could not restrict ${JSON.stringify(toolName)} for an agent: ${cause instanceof Error ? cause.message : String(cause)}`)
    }
  }

  function applyToAgent(agent: SessionAgentLike): void {
    if (disposed) return
    const cwd = agent.session?.header?.cwd
    const denied = deniedByAgent.get(agent)
    for (const [toolName, projectRoot] of toolRoots) {
      if (cwdHitsProjectRoot(cwd, projectRoot)) continue
      if (denied?.has(toolName)) continue
      restrictFor(agent, toolName)
      const names = denied ?? new Set<string>()
      names.add(toolName)
      deniedByAgent.set(agent, names)
    }
  }

  // Presence-probed, exactly like the governance host's resolveLoader: reading
  // an absent dependency API throws, so the probe is wrapped, never the caller.
  let agents: SessionAgentsServiceLike | undefined
  try {
    const candidate = (ctx as { agents?: SessionAgentsServiceLike }).agents
    if (candidate !== undefined && typeof candidate.list === 'function') agents = candidate
  } catch {
    agents = undefined
  }

  let onCreated: (() => void) | undefined
  if (agents !== undefined && typeof agents.on === 'function') {
    onCreated = agents.on('agent/created', (payload: { agent: SessionAgentLike }) => {
      applyToAgent(payload.agent)
    })
  }

  return {
    applyRestrictions(toolNames: readonly string[], projectRoot: string): void {
      if (disposed) return
      for (const name of toolNames) toolRoots.set(name, projectRoot)
      // Agents created before the project layer mounted (the boot-time agent
      // composition) are only reachable through the sweep — their creation
      // event already fired.
      const live = agents?.list?.() ?? []
      for (const agent of live) applyToAgent(agent)
    },
    dispose(): void {
      disposed = true
      onCreated?.()
      onCreated = undefined
    },
  }
}
