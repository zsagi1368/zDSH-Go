/**
 * The in-process FORK subagent backend: registers a {@link SubagentProvider} on
 * `ctx.subagents` that runs each child as a fresh child {@link Agent} on the same cordis
 * context — its own session, its own system prompt, and NO parent context.
 *
 * Per the L6 minimal-context contract (CONTEXT-CACHE-MANAGEMENT.md v2.3 §2 L6,
 * Phase 7 audit), a subagent receives only {任务描述, 文件指针, 约束} through its
 * initial prompt — never a copy of the parent's conversation history. Forking
 * the parent's completed-turn prefix is therefore removed: copying the full
 * parent log re-sends the inherited history in every child request at real
 * token cost, and the audit (PHASE7-AUDIT.md) records that the `fork` provider
 * previously seeded the child's session with the entire completed parent log.
 * The provider keeps its registered name and capabilities for deployment
 * compatibility; its behavior is now equivalent to a fresh child.
 *
 * @module @deepseek-ai/dsh-subagent-fork-in-process
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {
  ContinuableCreateRequest,
  ContinuableCreateSpec,
  ResolvedSubagentStartRequest,
  SubagentCapabilities,
  SubagentProvider,
} from '@deepseek-ai/dsh-subagent'
import { startInProcessRun } from '@deepseek-ai/dsh-subagent-in-process-driver'

export const name = 'subagent-fork-in-process'
// `tools` is deliberately NOT injected — same rationale as subagent-spawn-in-process: the
// per-run structured runtime gates its capture-tool registration on `tools`
// itself, so this backend's apply timing (and the delegation tool's position
// in the model-visible tool list) is unchanged by structured output.
export const inject = ['subagents']

/** Config: the registry name to register the provider under. */
export interface Config {
  /** Provider name on `ctx.subagents` (default `fork`). */
  providerName: string
}

export const Config: z<Config> = z.object({
  providerName: z.string().default('fork'),
})

/**
 * The fork provider. Supports every start-time capability: `depthLimit` (it
 * constructs the child, so it can enforce a recursion cap), `outputSchema`
 * (the scoped structured runtime), and `toolFilter`/`persona` (scoped
 * `restrict()` and a scoped shadowing persona section, applied in the child's
 * creation window). Children start fresh — they never see the parent
 * conversation (L6 minimal-context contract, see module doc).
 */
class ForkInProcessProvider implements SubagentProvider {
  readonly capabilities: SubagentCapabilities = {
    agentOptions: true,
    outputSchema: true,
    depthLimit: true,
    toolFilter: true,
    persona: true,
  }
  // Context contract: a forked child starts fresh — it never sees the parent conversation.
  readonly inheritsParentContext = false

  constructor(readonly name: string) {}

  start(request: ResolvedSubagentStartRequest) {
    // Fresh child: no seed. The shared driver mints ids, stamps cwd/lineage/
    // depth, drives the one-shot (including the structured capture when the
    // request carries an outputSchema), and maps the result.
    return startInProcessRun(request, {})
  }

  prepareContinuable(_request: ContinuableCreateRequest): Promise<ContinuableCreateSpec> {
    // A forked child starts fresh, so it contributes no seed; the continuation
    // manager owns every later operation on it.
    return Promise.resolve({})
  }
}

export function apply(ctx: Context, config: Config): void {
  ctx.subagents.registerProvider(new ForkInProcessProvider(config.providerName))
}
