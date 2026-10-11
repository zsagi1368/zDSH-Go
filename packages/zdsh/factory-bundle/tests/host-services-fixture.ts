/**
 * Reusable host-services fixture (DESIGN-intake-tech.md §10, TC-B4-RA1).
 *
 * The gate-p unit harness boots a bare `new Context()` + the real cordis
 * Loader, which — unlike BOTH shipped host faces (web-app / headless CLI) —
 * provides none of the named host services the harness-honest seed rows
 * consume: the six hard-`inject`ed by a boot-enabled artifact
 * (`fs`, `sessions`, `storage`, `webServer`, `tools`, `systemPrompt`) PLUS a
 * seventh, `llm`, that such an artifact reads unguarded in `apply` even though
 * it is not on its own `inject` list — a per-artifact defect recorded in the
 * RA-1 receipt (see the spec's permanent failure-mode lock); the real host
 * supplies `llm` in its ancestor fiber store, so this fixture mounts it for
 * fidelity. DESIGN §10.3's six-service table was authored before that read
 * existed; the RA-F1/RA-F3 close-out is registered in the receipt. This fixture
 * mounts all seven — plus `web`, the eighth service (TC-B4-W3, fidelity ladder
 * below) — onto a caller-owned context so the REAL `loader.create`
 * mount channel can reach LOADED off factory code paths (DESIGN §10.2 verdict
 * = refined plan A).
 *
 * Fidelity ladder per DESIGN §10.3 — real in-tree provider first, faithful
 * contract stub only where a real init would break isolation:
 *  - `systemPrompt` / `tools` / `llm` / `sessions` / `storage` (+ the real JSON
 *    KV backend) / `fs`  → REAL workspace packages, imported from their own src
 *    exactly like gate-p imports the governance host src (test-time relative
 *    import = zero new package.json dependencies, DESIGN §10.6-1). `llm` is
 *    isolation-safe: `LlmRuntime` binds no port/timer/network, and the only
 *    apply-time consumer reaches its `resolveModelInfo` behind a route gate.
 *  - `webServer`      → faithful route-capture registrar, NEVER listening on
 *    a port: the real `WebServer.[Service.init]` calls `server.listen`, which
 *    would drag an HTTP stack into the unit (DESIGN §10.6-3 downgrade, reason
 *    registered in the RA-1 receipt). It mirrors the real `register(route)`
 *    and — since TC-O3 — `registerUpgrade(route)` contracts (exact/prefix
 *    tables + the upgrade table, duplicate rejection, disposers) and adds
 *    the runtime validation the real class leaves to its TypeScript types.
 *  - `web`            → REAL in-tree `WebRuntime` (TC-B4-W3, the eighth
 *    service): isolation-safe — no `[Service.init]` hook, constructor only
 *    reads config/env, zero ports/timers/network at mount. Mounted with the
 *    HOST production-posture selectors (base/cordis.patch.yml `web` row:
 *    search=deepseek-official / fetch=http), which are NOT registered in the
 *    fixture, so any execution-time selection resolves to a clean
 *    CONFIGURED_MISSING error — provider registration is observable while the
 *    data plane stays dormant (the shipped coexist semantics, zero network).
 *
 * Structural constraints honoured here (DESIGN §10.6):
 *  - M2: this module body contains ZERO plugin/artifact names. It provides
 *    host-side services generically; per-artifact differences live in the
 *    consuming spec's probe data table only.
 *  - Pairing iron rule (§10.6-4): `tools` and `systemPrompt` are both mounted
 *    from the REAL packages — a registration that only passes a
 *    non-validating fake registry is exactly the B01 masking class this
 *    fixture exists to prevent (the real `ToolRuntime.register` runs
 *    `assertSupportedJsonSchema` internally; the real `ToolRuntime` itself
 *    `inject: ['systemPrompt']`, so the pair is structural, not decorative).
 *  - Isolation (§10.6-3): no ports, no HTTP server, no subprocess, no
 *    network. The JSON KV backend writes only under the caller-supplied
 *    scratch `storageRoot`.
 *
 * This is NOT production code: it lives in the factory bundle's self-managed
 * tests surface (DESIGN §10.6-2) and the governance host / vendor base stay
 * untouched.
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '../../../fs/fs-local/src/index.ts'
import { SessionStore } from '../../../core/session/src/index.ts'
import { Storage } from '../../../storage/storage/src/index.ts'
import * as StorageJson from '../../../storage/storage-json/src/index.ts'
import { SystemPrompt } from '../../../core/system-prompt/src/index.ts'
import { ToolRuntime } from '../../../core/tools/src/index.ts'
import { LlmRuntime } from '../../../llm/llm/src/index.ts'
import { WebRuntime } from '../../../web/web/src/index.ts'

/** One route as recorded by {@link WebServerRouteCapture}. */
export interface CapturedRoute {
  readonly kind: 'exact' | 'prefix'
  readonly path: string
  readonly handler: (req: unknown, res: unknown) => unknown
}

/** One HTTP-upgrade route as recorded by {@link WebServerRouteCapture}. */
export interface CapturedUpgradeRoute {
  readonly path: string
  readonly handler: (req: unknown, socket: unknown, head: unknown) => unknown
}

/** Validation + storage for registered routes; the capture table is assertable. */
export class WebServerRouteCapture extends Service {
  /** Insertion-ordered capture table shared by both kinds. */
  private readonly table: CapturedRoute[] = []
  private readonly exact = new Map<string, CapturedRoute>()
  private readonly prefixes = new Map<string, CapturedRoute>()
  /** Upgrade-route capture table (TC-O3), keyed by absolute pathname. */
  private readonly upgrades = new Map<string, CapturedUpgradeRoute>()

  constructor(ctx: Context) {
    super(ctx, 'webServer')
  }

  /**
   * Register a route under the real host's contract: kind must be
   * `'exact' | 'prefix'`, path an absolute route path, handler a function,
   * and a duplicate (kind, path) throws — collisions are composition bugs
   * (mirrors `@deepseek-ai/dsh-host-webserver` `register`). Malformed input
   * is REJECTED, never silently accepted: an always-accepting registrar would
   * be the masking stub DESIGN §10.3 warns about.
   * @returns the disposer removing exactly this registration.
   */
  register(route: { kind?: unknown; path?: unknown; handler?: unknown }): () => void {
    if (route === null || typeof route !== 'object') {
      throw new TypeError('webServer capture: route must be an object { kind, path, handler }')
    }
    const { kind, path, handler } = route
    if (kind !== 'exact' && kind !== 'prefix') {
      throw new TypeError(`webServer capture: kind must be 'exact' | 'prefix', got ${JSON.stringify(kind)}`)
    }
    if (typeof path !== 'string' || path === '' || !path.startsWith('/')) {
      throw new TypeError(`webServer capture: path must be a non-empty absolute route path, got ${JSON.stringify(path)}`)
    }
    if (typeof handler !== 'function') {
      throw new TypeError(`webServer capture ${kind} "${path}": handler must be a function`)
    }
    const table = kind === 'exact' ? this.exact : this.prefixes
    if (table.has(path)) {
      throw new Error(`webServer capture: duplicate ${kind} route "${path}"`)
    }
    const captured: CapturedRoute = Object.freeze({ kind, path, handler }) as CapturedRoute
    table.set(path, captured)
    this.table.push(captured)
    return () => {
      if (table.get(path) === captured) {
        table.delete(path)
        const at = this.table.indexOf(captured)
        if (at !== -1) this.table.splice(at, 1)
      }
    }
  }

  /** Every live route, in registration order. */
  routes(): readonly CapturedRoute[] {
    return [...this.table]
  }

  /**
   * Register an exact-path HTTP upgrade route under the real host's contract
   * (TC-O3; mirrors `@deepseek-ai/dsh-host-webserver` `registerUpgrade` and
   * its `WebUpgradeRoute` shape): the real class rejects only duplicate paths
   * at runtime (one socket, one protocol owner) and leaves "absolute pathname,
   * no trailing slash" + the handler signature to its TypeScript types — this
   * capture promotes that documented type contract to runtime validation,
   * exactly like {@link register} does for HTTP routes. An always-accepting
   * registrar would be the masking stub DESIGN §10.3 warns about.
   * @returns the disposer removing exactly this registration.
   */
  registerUpgrade(route: { path?: unknown; handler?: unknown }): () => void {
    if (route === null || typeof route !== 'object') {
      throw new TypeError('webServer capture: upgrade route must be an object { path, handler }')
    }
    const { path, handler } = route
    if (typeof path !== 'string' || path === '' || !path.startsWith('/') || path.endsWith('/')) {
      throw new TypeError(`webServer capture: upgrade path must be a non-empty absolute pathname without a trailing slash, got ${JSON.stringify(path)}`)
    }
    if (typeof handler !== 'function') {
      throw new TypeError(`webServer capture upgrade "${path}": handler must be a function`)
    }
    if (this.upgrades.has(path)) {
      throw new Error(`webServer capture: duplicate upgrade route "${path}"`)
    }
    const captured: CapturedUpgradeRoute = Object.freeze({ path, handler }) as CapturedUpgradeRoute
    this.upgrades.set(path, captured)
    return () => {
      if (this.upgrades.get(path) === captured) {
        this.upgrades.delete(path)
      }
    }
  }

  /** One live upgrade route by absolute pathname, or undefined. */
  findUpgrade(path: string): CapturedUpgradeRoute | undefined {
    return this.upgrades.get(path)
  }

  /** One live route by (kind, path), or undefined. */
  find(kind: 'exact' | 'prefix', path: string): CapturedRoute | undefined {
    return (kind === 'exact' ? this.exact : this.prefixes).get(path)
  }
}

/** Options for {@link provideHostServices}. */
export interface ProvideHostServicesOptions {
  /**
   * Root directory for the REAL JSON storage backend (a test scratch dir).
   * The hub must carry a KV-capable backend so a boot-enabled composition
   * exercises the shipped (KV) branch instead of the plugin's memory
   * fallback (DESIGN §10.3 storage row: 测出厂路径, not the degraded path).
   */
  readonly storageRoot: string
  /**
   * Service names to WITHHOLD — the counterexample knob (DESIGN §10.6-4
   * pairing lock): omitting one of the pair must make the real load gate
   * refuse activation, which the consuming spec asserts red.
   */
  readonly omit?: readonly string[]
}

/** The mounted services, ready to drive a real `loader.create` boot. */
export interface HostServicesFixture {
  readonly tools: ToolRuntime | undefined
  readonly systemPrompt: SystemPrompt | undefined
  readonly sessions: SessionStore | undefined
  readonly storage: Storage | undefined
  readonly fs: unknown
  readonly webServer: WebServerRouteCapture | undefined
  readonly llm: LlmRuntime | undefined
  readonly web: WebRuntime | undefined
}

/**
 * Mount all eight host services onto `ctx` (must be called on a context whose
 * Loader is already mounted). Each name resolves to the REAL service instance
 * when its provider activated, or `undefined` when it was omitted or is still
 * gated behind a missing dependency.
 * @param ctx - the host context the gateway + mount channel run on.
 * @param options - scratch storage root + optional counterexample omissions.
 * @returns typed handles for the consuming spec's assertions.
 */
export async function provideHostServices(
  ctx: Context,
  options: ProvideHostServicesOptions,
): Promise<HostServicesFixture> {
  const omitted = new Set(options.omit ?? [])
  const wants = (name: string): boolean => !omitted.has(name)

  // Pairing iron rule (§10.6-4): systemPrompt FIRST — the real ToolRuntime
  // hard-injects it; mounting the pair from the real packages is what makes
  // a downstream registration pass the real `assertSupportedJsonSchema`.
  if (wants('systemPrompt')) await ctx.plugin(SystemPrompt, {})
  if (wants('tools')) await ctx.plugin(ToolRuntime, {})
  // `llm` is a real host service that BOTH shipped host faces mount, so the
  // fixture mounts it for fidelity. NOTE (M2 §10.6-6, per-artifact detail lives
  // only in the receipt + the spec's probe table): one boot-enabled artifact
  // reads `ctx.llm` in `apply` WITHOUT declaring it on its `inject` list, and
  // cordis gates property reads on that declaration (reflect.ts:144 throws
  // `cannot get property "llm" without inject` regardless of the ancestor
  // store), so providing it here does NOT, alone, let that artifact reach
  // ACTIVE through the production `loader.create` channel (which passes no
  // inject). The consuming spec locks that as a permanent failure-mode
  // assertion; the 〔源〕 follow-up that declares/guards the read will upgrade
  // it to a positive assertion after re-pin. Mounted from the REAL in-tree
  // package (isolation-safe: no port/listen/timer init) per §10.6-1; §10.6-3
  // downgrade not triggered.
  if (wants('llm')) await ctx.plugin(LlmRuntime)
  if (wants('fs')) await ctx.plugin(LocalFileSystem, {})
  if (wants('sessions')) await ctx.plugin(SessionStore)
  if (wants('storage')) {
    await ctx.plugin(Storage)
    // The real JSON backend registers a `.kv` facet on the hub; it writes
    // only under the supplied scratch root (DESIGN §10.3 storage row).
    await ctx.plugin(StorageJson, { root: options.storageRoot })
  }
  if (wants('webServer')) await ctx.plugin(WebServerRouteCapture)
  // `web` (TC-B4-W3): the REAL WebRuntime, mounted with the host production
  // selectors (see the header's fidelity ladder). Init is side-effect-free;
  // registered providers are observable, execution-time selection stays a
  // clean CONFIGURED_MISSING (the shipped coexist dormancy, zero network).
  if (wants('web')) {
    await ctx.plugin(WebRuntime, { searchProvider: 'deepseek-official', fetchProvider: 'http' })
  }

  const get = (name: string): unknown => {
    try {
      return (ctx as unknown as { get: (n: string) => unknown }).get(name)
    } catch {
      // An unresolvable (omitted or still-gated) service reads as absent —
      // honest, because `loader.create` will gate the same way.
      return undefined
    }
  }
  return {
    tools: get('tools') as ToolRuntime | undefined,
    systemPrompt: get('systemPrompt') as SystemPrompt | undefined,
    sessions: get('sessions') as SessionStore | undefined,
    storage: get('storage') as Storage | undefined,
    fs: get('fs'),
    webServer: get('webServer') as WebServerRouteCapture | undefined,
    llm: get('llm') as LlmRuntime | undefined,
    web: get('web') as WebRuntime | undefined,
  }
}
