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
import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type Schema from '@deepseek-ai/schemastery'
import type { Session } from '@deepseek-ai/dsh-session'
import { MODEL_SLOT_COMPACTION_SUMMARIZE, MODEL_SLOT_IDS, MODEL_SLOT_PLAN, MODEL_SLOT_SOURCES, MODEL_SLOT_TITLE, MODEL_SLOT_VISION, SlotId } from './vocabulary.ts'
import { guardModelSlots } from './compat.ts'

export { MODEL_SLOT_COMPACTION_SUMMARIZE, MODEL_SLOT_IDS, MODEL_SLOT_PLAN, MODEL_SLOT_SOURCES, MODEL_SLOT_TITLE, MODEL_SLOT_VISION, SlotId }

/**
 * Profile entry id carrying the user-editable slot policy. The 0.1.7 settings
 * face addresses a plugin entry's own Config by its Loader id (a namespace is
 * derived from the entry, never registered), so a deployment row for this
 * plugin must use this id for the settings mirror and the Models page's slot
 * block to reach it — the client constant `MODEL_SLOTS_SETTINGS_NAMESPACE` in
 * ui-settings-models pins the same literal.
 */
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

/** Origin tier that produced one resolved auxiliary route. */
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

/** One resolved auxiliary route with its origin tier. */
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

/** One slot-route entry: the provider/model pair plus the derived credential reference the slot editor records. */
const slotRouteSchema = z.object({
  provider: z.string().default(''),
  model: z.string().default(''),
  // A derived reference (`deriveKeyRef` spelling) only: an API-key literal
  // like `sk-…` carries lowercase/dashes and is refused at the schema layer.
  apiKeyEnv: z.string().pattern(/^[A-Z][A-Z0-9_]*$/),
})

/** One entry per built-in slot id: the key schema pins the closed vocabulary on
 * the dict itself, so a foreign slot id is refused while the configuration is
 * still being validated — before the settings face persists it — instead of
 * landing in the profile and leaving the next boot without this service. */
const slotRoutesSchema = z.dict(slotRouteSchema, z.union([...MODEL_SLOT_IDS].map(id => z.const(id))))

/**
 * Settings-mirror schema: the same field set the registry's own Config
 * declares, without the volatile carriers the Loader materializes — the shape
 * a settings consumer projects out of the `llm-model-slots` entry value
 * (composition base merged with the user layer) plus the derived `apiKeyEnv`
 * reference the slot editor records.
 */
export const MODEL_SLOTS_SETTINGS_SCHEMA: Schema<ModelSlotsConfig> = z.object({
  slots: slotRoutesSchema,
  fallback: slotRouteSchema,
})

declare module '@deepseek-ai/cordis' {
  interface Context {
    modelSlots: ModelSlotRegistry
  }
}

/** One live slot-map field: the volatile reference schema resolution creates, or plain direct-construction data. */
type LiveSlotsField = ModelSlotsConfig['slots'] | Volatile<Readonly<Record<string, ModelSlotRouteConfig>> | undefined>

/** One live deployment-default field: the volatile reference schema resolution creates, or plain direct-construction data. */
type LiveFallbackField = ModelSlotsConfig['fallback'] | Volatile<ModelSlotRouteConfig | undefined>

/** The registry's runtime Config: once the Loader resolved the schema, both policy fields are live references. */
interface LiveModelSlotsConfig {
  readonly slots?: LiveSlotsField
  readonly fallback?: LiveFallbackField
}

/**
 * Whether one resolved Config field is a live reference rather than plain
 * direct-construction data. The check is structural on purpose: `isVolatile`
 * lives in `@deepseek-ai/cosmokit`, which this package does not depend on, and
 * the field set here is closed (a slot map or a route entry), so a `get`
 * member can only be the volatile carrier.
 */
function isLiveRef<T>(value: unknown): value is Volatile<T | undefined> {
  if (typeof value !== 'object' || value === null || !('get' in value)) return false
  return typeof value.get === 'function'
}

/** Read the current slot map behind a live reference, or pass direct-construction data through. */
function liveSlots(value: LiveSlotsField): ModelSlotsConfig['slots'] {
  return isLiveRef<Readonly<Record<string, ModelSlotRouteConfig>>>(value) ? value.get() : value
}

/** Read the current deployment default behind a live reference, or pass direct-construction data through. */
function liveFallback(value: LiveFallbackField): ModelSlotsConfig['fallback'] {
  return isLiveRef<ModelSlotRouteConfig>(value) ? value.get() : value
}

/**
 * Assemble the plain policy the live Config currently carries. Every other key
 * of the runtime Config is preserved, so an unknown configuration key still
 * fails validation loudly instead of being dropped on the way; a policy field
 * the runtime carries no value for is omitted rather than left as a reference.
 */
function livePolicy(config: LiveModelSlotsConfig): ModelSlotsConfig {
  const { slots, fallback, ...rest } = config
  const plainSlots = liveSlots(slots)
  const plainFallback = liveFallback(fallback)
  return {
    ...rest,
    ...plainSlots === undefined ? {} : { slots: plainSlots },
    ...plainFallback === undefined ? {} : { fallback: plainFallback },
  }
}

/**
 * Registry of deployment-level auxiliary-model routes keyed by slot identity.
 * Consumers consult it right before each auxiliary dispatch; every successful
 * resolution with a session sink appends the durable `slots/dispatch` audit
 * record naming the exact route and the tier that produced it.
 * Both policy fields of the Config schema are volatile, which is the surface
 * the 0.1.7 entry-derived settings face can write (it replaced the retired
 * `SettingsProvider.register` namespace registration): the user layer lands in
 * the entry's own Config, the Loader commits such a change in place, and this
 * registry re-reads those live references on every consult, so a user-layer
 * override re-points later auxiliary calls without a remount.
 */
export class ModelSlotRegistry extends Service {
  static Config: Schema<ModelSlotsConfig, LiveModelSlotsConfig> = z.object({
    // Volatile on purpose: only volatile paths are settings-writable, and a
    // volatile-only change commits into the running entry (vendor/loader
    // `_commitVolatile`) instead of remounting it.
    slots: slotRoutesSchema.volatile(),
    fallback: slotRouteSchema.volatile(),
  })

  private readonly routes = new Map<SlotId, ModelRoute>()
  /** Slots owned by deployment configuration; programmatic registration may not override them. */
  private readonly pinned = new Set<SlotId>()
  private fallbackRoute: ModelRoute | undefined
  /**
   * Runtime Config captured at construction. After schema resolution both
   * policy fields are live references, so the current policy is read through
   * them; direct construction carries plain values instead and never rebuilds.
   */
  private readonly live: LiveModelSlotsConfig
  /** Slot map the current routes were derived from; a changed snapshot rebuilds them. */
  private syncedSlots: ModelSlotsConfig['slots']
  /** Deployment default the current routes were derived from. */
  private syncedFallback: ModelSlotsConfig['fallback']

  /**
   * Create the registry over the entry's own slot policy.
   * @param ctx - Cordis context owning the service.
   * @param config - untrusted slot policy after Loader normalization, or plain
   *   data from direct construction; a Loader mount resolves it through
   *   {@link ModelSlotRegistry.Config}, so the policy fields arrive as live
   *   references.
   */
  constructor(ctx: Context, config: ModelSlotsConfig = {}) {
    super(ctx, 'modelSlots')
    this.live = config
    const resolved = resolveModelSlotsConfig(livePolicy(this.live))
    for (const [slot, route] of resolved.routes.entries()) {
      this.routes.set(slot, route)
      this.pinned.add(slot)
    }
    this.fallbackRoute = resolved.fallback
    this.syncedSlots = liveSlots(this.live.slots)
    this.syncedFallback = liveFallback(this.live.fallback)
    // Book the user-layer surface verdict in the process-level compat roster.
    // Composition config is served on every host, so this probe reports
    // whether the host carries the settings forms face the user layer rides
    // on; a missing face is warned about by the guard itself, never silent.
    // The guard never throws by contract.
    void guardModelSlots(ctx.logger)
  }

  /**
   * Rebuild the configuration-owned routes when the live policy changed. The
   * Loader commits a settings-writable (volatile-only) change into the same
   * references without remounting the entry, so the snapshots are compared by
   * identity on every consult: no notification can be missed, and a rejected
   * policy warns once and keeps the previous routes serving.
   */
  private syncRoutes(): void {
    const slots = liveSlots(this.live.slots)
    const fallback = liveFallback(this.live.fallback)
    if (slots === this.syncedSlots && fallback === this.syncedFallback) return
    this.syncedSlots = slots
    this.syncedFallback = fallback
    let resolved: ResolvedModelSlotsConfig
    try {
      resolved = resolveModelSlotsConfig(livePolicy(this.live))
    } catch (error) {
      this.ctx.logger.warn('model-slots: live slot policy rejected; keeping the previous routes', error)
      return
    }
    // Clear config-owned routes while preserving programmatic registrations.
    for (const slot of this.pinned) this.routes.delete(slot)
    this.pinned.clear()
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
    this.syncRoutes()
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
    this.syncRoutes()
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
