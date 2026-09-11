/**
 * Unified auxiliary-model slot registry: named deployment-level routes for
 * side-task model calls (title generation, compaction summarization)
 * resolved through one fixed precedence — explicit slot statement, then the
 * deployment default, then the conversation's own main-model route — with a
 * durable `slots/dispatch` record written before every auxiliary dispatch.
 *
 * @module @deepseek-ai/dsh-model-slots
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type Schema from '@deepseek-ai/schemastery'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SettingsScope } from '@deepseek-ai/dsh-settings'
import { MODEL_SLOT_COMPACTION_SUMMARIZE, MODEL_SLOT_IDS, MODEL_SLOT_PLAN, MODEL_SLOT_SOURCES, MODEL_SLOT_TITLE, MODEL_SLOT_VISION, SlotId } from './vocabulary.ts'
import { guardModelSlots } from './compat.ts'

export { MODEL_SLOT_COMPACTION_SUMMARIZE, MODEL_SLOT_IDS, MODEL_SLOT_PLAN, MODEL_SLOT_SOURCES, MODEL_SLOT_TITLE, MODEL_SLOT_VISION, SlotId }

/** Settings namespace carrying the user-editable slot policy (composition below, user layer above). */
export const MODEL_SLOTS_SETTINGS_NAMESPACE = 'llm-model-slots'

export type {
  BudgetRow,
  LockedRow,
  Profile,
  ProfileValidation,
} from './budget.ts'
export {
  BATCH_CAP,
  BUDGET_TABLE,
  DEFAULT_OUTPUT_CAP,
  MIN_OUTPUT_CAP,
  MIN_WINDOW,
  computeBudget,
  computeDeltaCap,
  computeInjectionBudget,
  computeKeepRecent,
  computeMaxTokens,
  computeRPess,
  computeRMin,
  computeReserve,
  computeSlo,
  computeSubagentReturn,
  computeSummaryInputMax,
  computeSummaryOutput,
  computeToolCap,
  computeTrigger,
  validateProfile,
} from './budget.ts'

/** One exact provider/model pair an auxiliary call dispatches to. */
export interface ModelRoute {
  /** Registered LLM provider route. */
  readonly provider: string
  /** Provider model id. */
  readonly model: string
}

/** Provenance tier that produced one resolved auxiliary route. */
export type ModelSlotSource = 'slot' | 'deployment-default' | 'main-route'

/** Durable pre-dispatch record for one auxiliary-model dispatch. */
export interface ModelSlotDispatchEventData {
  /** Slot identity the dispatch serves. */
  readonly slot: string
  /** Exact provider route the request will use. */
  readonly provider: string
  /** Exact model id the request will use. */
  readonly model: string
  /** Resolution tier that produced this route. */
  readonly source: ModelSlotSource
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Log-only pre-dispatch record naming the auxiliary route one slot dispatch will use. */
    'slots/dispatch': ModelSlotDispatchEventData
  }
}

/** Caller-supplied context for one slot resolution. */
export interface ModelSlotResolveInput {
  /**
   * Exact main-model route captured for the conversation, consulted as the
   * final tier when no deployment-level statement covers the slot.
   */
  readonly mainRoute?: ModelRoute
  /** Session receiving the durable `slots/dispatch` record before dispatch. */
  readonly session?: Session
}

/** One resolved auxiliary route with its provenance tier. */
export interface ResolvedModelSlot {
  /** Slot identity that was resolved. */
  readonly slot: SlotId
  /** Exact provider route to dispatch to. */
  readonly provider: string
  /** Exact model id to dispatch to. */
  readonly model: string
  /** Tier that produced this route. */
  readonly source: ModelSlotSource
}

/** One configured route entry; `provider` and `model` are a required pair. */
export interface ModelSlotRouteConfig {
  /** Registered LLM provider route. */
  readonly provider: string
  /** Provider model id. */
  readonly model: string
  /** Derived credential reference (`deriveKeyRef(provider)`), stored for audit; never a literal key. */
  readonly apiKeyEnv?: string
}

/** Deployment-level slot policy supplied as plugin configuration or direct construction. */
export interface ModelSlotsConfig {
  /** Explicit route per built-in slot id; a present entry pins that slot. */
  readonly slots?: Readonly<Record<string, ModelSlotRouteConfig>>
  /** Deployment default applied when a slot has no explicit entry. */
  readonly fallback?: ModelSlotRouteConfig
}

/** Validated immutable slot policy held by the registry. */
export interface ResolvedModelSlotsConfig {
  /** Explicit route per pinned slot id. */
  readonly routes: ReadonlyMap<SlotId, ModelRoute>
  /** Deployment default, or `undefined` when unconfigured. */
  readonly fallback: ModelRoute | undefined
}

/** Complete public configuration key set for direct construction validation. */
const CONFIG_KEYS: ReadonlySet<string> = new Set(['slots', 'fallback'])

/** Validate one non-empty string field and return it narrowed. */
function assertNonEmptyString(name: string, value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`model-slots: ${name} must be a non-empty string`)
  }
}

/**
 * Validate one route entry and return it detached and frozen, or `undefined`
 * when it states nothing: both fields are absent or empty, which is how
 * Schemastery materializes an omitted nested object over its empty-string
 * defaults. Any single stated field enforces the complete non-empty pair.
 * Accepts the optional `apiKeyEnv` field (derived credential reference) for
 * settings-mirror entries; the registry ignores it.
 */
function resolveRouteEntry(name: string, value: unknown): ModelRoute | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`model-slots: ${name} must be an object`)
  }
  const record = value as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (key !== 'provider' && key !== 'model' && key !== 'apiKeyEnv') {
      throw new Error(`model-slots: ${name} has unknown key "${key}"`)
    }
  }
  if (blankRouteField(record.provider) && blankRouteField(record.model)) return undefined
  assertNonEmptyString(`${name}.provider`, record.provider)
  assertNonEmptyString(`${name}.model`, record.model)
  if (record.apiKeyEnv !== undefined && record.apiKeyEnv !== '') {
    assertNonEmptyString(`${name}.apiKeyEnv`, record.apiKeyEnv)
  }
  return Object.freeze({ provider: record.provider, model: record.model })
}

/** Whether one route-entry field is absent or explicitly empty. */
function blankRouteField(value: unknown): boolean {
  return value === undefined || value === ''
}

/**
 * Validate and detach deployment-level slot policy.
 * @param config - untrusted plugin configuration after Loader normalization,
 *   or plain data from direct construction.
 * @returns immutable per-slot routes and the optional deployment default.
 */
export function resolveModelSlotsConfig(config: ModelSlotsConfig = {}): ResolvedModelSlotsConfig {
  const candidate: unknown = config
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
    throw new Error('model-slots: configuration must be an object')
  }
  const value = candidate as ModelSlotsConfig
  for (const key of Object.keys(value)) {
    if (!CONFIG_KEYS.has(key)) throw new Error(`model-slots: unknown config key "${key}"`)
  }
  const routes = new Map<SlotId, ModelRoute>()
  if (value.slots !== undefined) {
    if (typeof value.slots !== 'object' || Array.isArray(value.slots)) {
      throw new Error('model-slots: slots must be an object')
    }
    for (const [id, entry] of Object.entries(value.slots)) {
      if (!MODEL_SLOT_IDS.has(id)) {
        throw new Error(`model-slots: unknown slot "${id}"; built-in slots are ${[...MODEL_SLOT_IDS].map(quoted).join(', ')}`)
      }
      const route = resolveRouteEntry(`slots.${id}`, entry)
      if (route !== undefined) routes.set(SlotId(id), route)
    }
  }
  const fallback = value.fallback === undefined
    ? undefined
    : resolveRouteEntry('fallback', value.fallback)
  return Object.freeze({ routes: Object.freeze(routes), fallback: fallback ?? undefined })
}

/** Quote one vocabulary member for error text. */
function quoted(id: string): string {
  return JSON.stringify(id)
}

/** Settings namespace schema: composition base + user overrides with optional apiKeyEnv reference. */
export const MODEL_SLOTS_SETTINGS_SCHEMA: Schema<ModelSlotsConfig> = z.object({
  slots: z.dict(z.object({
    provider: z.string().default(''),
    model: z.string().default(''),
    // A derived reference (`deriveKeyRef` spelling) only: an API-key literal
    // like `sk-…` carries lowercase/dashes and is refused at the schema layer.
    apiKeyEnv: z.string().pattern(/^[A-Z][A-Z0-9_]*$/),
  })),
  fallback: z.object({
    provider: z.string().default(''),
    model: z.string().default(''),
    apiKeyEnv: z.string().pattern(/^[A-Z][A-Z0-9_]*$/),
  }),
})

declare module '@deepseek-ai/cordis' {
  interface Context {
    modelSlots: ModelSlotRegistry
  }
}

/**
 * Registry of deployment-level auxiliary-model routes keyed by slot identity.
 * Consumers consult it right before each auxiliary dispatch; every successful
 * resolution with a session sink appends the durable `slots/dispatch` audit
 * record naming the exact route and the tier that produced it.
 * The registry also registers the `llm-model-slots` settings namespace so the
 * settings-mirror tier (user layer) can override the composition base.
 */
export class ModelSlotRegistry extends Service {
  static Config: Schema<ModelSlotsConfig> = z.object({
    slots: z.dict(z.object({
      provider: z.string().default(''),
      model: z.string().default(''),
    })),
    fallback: z.object({
      provider: z.string().default(''),
      model: z.string().default(''),
    }),
  })

  private readonly routes = new Map<SlotId, ModelRoute>()
  /** Slots owned by deployment configuration; programmatic registration may not override them. */
  private readonly pinned = new Set<SlotId>()
  private fallbackRoute: ModelRoute | undefined
  /** Settings scope carrying the merged slot policy, or undefined when the settings service is absent. */
  private settingsScope: SettingsScope<ModelSlotsConfig> | undefined
  /** Raw config at construction time, used as fallback when no settings scope is attached. */
  private readonly baseConfig: ModelSlotsConfig

  /**
   * Create the registry over validated deployment policy.
   * @param ctx - Cordis context owning the service.
   * @param config - untrusted slot policy after Loader normalization.
   */
  constructor(ctx: Context, config: ModelSlotsConfig = {}) {
    super(ctx, 'modelSlots')
    this.baseConfig = config
    const resolved = resolveModelSlotsConfig(config)
    for (const [slot, route] of resolved.routes.entries()) {
      this.routes.set(slot, route)
      this.pinned.add(slot)
    }
    this.fallbackRoute = resolved.fallback
    // Register the settings namespace.  The injection effect must be created
    // synchronously on the service's active fiber (a later microtask would
    // assert against an inactive fiber).  The compat guard resolves
    // asynchronously; a disabled verdict skips registration inside the
    // effect, and a context disposed before the verdict simply never installs
    // the section — the service still runs on the raw config.
    const guard = guardModelSlots(ctx.logger)
    ctx.inject(['settings'], async (settingsCtx) => {
      if (!(await guard)) {
        ctx.logger.warn('model-slots: disabled by compat guard (settings section skipped)')
        return
      }
      this.settingsScope = settingsCtx.settings.register(
        MODEL_SLOTS_SETTINGS_NAMESPACE,
        MODEL_SLOTS_SETTINGS_SCHEMA,
        { base: config },
      )
      this.settingsScope.watch(() => { this.rebuildFromSource() })
    })
  }

  /** Re-read the effective config from the settings scope and rebuild routes. */
  private rebuildFromSource(): void {
    // Clear config-owned routes while preserving programmatic registrations.
    for (const slot of this.pinned) this.routes.delete(slot)
    this.pinned.clear()
    const resolved = resolveModelSlotsConfig(this.settingsScope?.get() ?? this.baseConfig)
    for (const [slot, route] of resolved.routes.entries()) {
      this.routes.set(slot, route)
      this.pinned.add(slot)
    }
    this.fallbackRoute = resolved.fallback
  }

  /**
   * Register one programmatic slot route. Configuration-pinned slots reject
   * registration so a deployment statement cannot be silently replaced at
   * runtime.
   * @param slot - slot identity the route serves.
   * @param route - exact provider/model pair dispatched under the slot.
   * @returns an effect-scoped disposer removing the route again.
   */
  register(slot: SlotId, route: ModelRoute): () => void {
    assertNonEmptyString('slot', slot)
    const resolved = resolveRouteEntry(`registration for slot "${slot}"`, route)
    if (resolved === undefined) {
      throw new Error(`model-slots: registration for slot "${slot}" requires both provider and model`)
    }
    if (this.pinned.has(slot)) {
      throw new Error(`model-slots: slot "${slot}" is owned by deployment configuration`)
    }
    if (this.routes.has(slot)) {
      throw new Error(`model-slots: slot "${slot}" is already registered`)
    }
    this.routes.set(slot, resolved)
    return () => {
      // A later re-registration owns the slot; only the captured route's own
      // disposer removes it.
      if (this.routes.get(slot) === resolved) this.routes.delete(slot)
    }
  }

  /**
   * Resolve one auxiliary-model route through the fixed precedence: the
   * slot's own statement, then the deployment default, then the conversation's
   * main-model route. With a session sink, the durable `slots/dispatch`
   * record is appended before the caller dispatches.
   * @param slot - slot identity to resolve.
   * @param input - main-model route fallback and audit sink.
   * @returns the frozen resolution, or `null` when no tier can supply a route.
   */
  resolve(slot: SlotId, input: ModelSlotResolveInput = {}): ResolvedModelSlot | null {
    const own = this.routes.get(slot)
    if (own !== undefined) return this.dispatch(slot, own, 'slot', input)
    if (this.fallbackRoute !== undefined) {
      return this.dispatch(slot, this.fallbackRoute, 'deployment-default', input)
    }
    if (input.mainRoute !== undefined) {
      return this.dispatch(slot, input.mainRoute, 'main-route', input)
    }
    return null
  }

  /** Append the audit record when a session sink is present and freeze the result. */
  private dispatch(
    slot: SlotId,
    route: ModelRoute,
    source: ModelSlotSource,
    input: ModelSlotResolveInput,
  ): ResolvedModelSlot {
    if (input.session !== undefined) {
      input.session.append('slots/dispatch', {
        slot,
        provider: route.provider,
        model: route.model,
        source,
      })
    }
    return Object.freeze({ slot, provider: route.provider, model: route.model, source })
  }
}

export default ModelSlotRegistry
