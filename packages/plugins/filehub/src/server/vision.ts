/**
 * M4 image-caption waterfall (P01 §6-D, FR-D1..D5).
 *
 * Evaluation order for every image upload:
 *   0. ROUTE GATE (FR-D1, the single source of truth): when the session model
 *      is natively vision-capable (its resolved route metadata carries
 *      `inputModalities` containing `'image'`, the exact admission pattern the
 *      host's read_image tool and apiproxy use — Fork/packages/fs/tool-fs/src/
 *      read-image.ts:96, packages/host/apiproxy/src/api-proxy.ts:2416), the
 *      whole waterfall stays dormant: zero outbound HTTP, no caption written.
 *      When the gate cannot be resolved (standalone plugin, no host llm face),
 *      the session counts as NON-native and the waterfall proceeds.
 *   1. EXPLICIT ENDPOINT (`vision.endpoint`, http/https, public-only per
 *      urlPolicy.assertPublicHttpUrl). POST {prompt, images:[b64], stream:false};
 *      the caption is read from `response` | `caption` | `text`.
 *   2. LOCAL OLLAMA PROBE (default on): GET http://127.0.0.1:11434/api/tags
 *      within 3 s; when models exist, POST /api/generate with the first
 *      vision-suggesting model name (regex heuristic, else the first listed),
 *      prompt 固定「用一句话描述这张图片的内容」, images=[b64], stream:false.
 *   3. TOTAL FAILURE degrades SILENTLY: the response carries no caption field;
 *      each skip/failure warns once (deduplicated per message).
 *
 * Privacy gate: while settings `privacy.localFirstVision` is true (default)
 * and `vision.allowExternalVision` was not explicitly enabled, level 1 never
 * dials out — the request degrades to the local channel or nothing (server-
 * side enforcement; panel copy lives in the existing i18n dictionary).
 *
 * Cache: captions are keyed by sha256(image bytes)+channel inside their own KV
 * unit (`filehub_vision`; in-memory fallback mirrors meta.ts/library.ts), so a
 * second upload of identical bytes makes ZERO extra calls. Concurrent requests
 * for one digest share a single in-flight promise.
 *
 * Upload hook: {@link augmentUploadHandlerWithCaption} wraps the M1 upload
 * handler (additive wiring — upload.ts stays untouched). The wrapper captures
 * the handler's JSON answer, and for sniffed images reads the persisted file
 * back from disk, awaits the waterfall synchronously, and augments the 200
 * body with `imageCaption` (the contract field added in M4). Every failure
 * path still answers exactly what the inner handler answered.
 */

import { createHash } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { UploadResultSchema } from '../contract.js'
import { assertLocalLoopbackUrl, assertPublicHttpUrl, UrlPolicyError } from './urlPolicy.js'
import type { LookupAllAddresses } from './urlPolicy.js'
import type { KvFacetLike, KvUnitLike } from './meta.js'
import type { HttpHandler } from './upload.js'

/** Fixed Chinese caption instruction (spec §6-D level 2). */
export const CAPTION_PROMPT = '用一句话描述这张图片的内容'

/** Local Ollama base URL (loopback-locked by urlPolicy). */
export const DEFAULT_OLLAMA_ENDPOINT = 'http://127.0.0.1:11434'

/** Explicit-endpoint call ceiling. */
export const DEFAULT_VISION_TIMEOUT_MS = 20_000
/** Ollama /api/tags discovery ceiling. */
export const DEFAULT_PROBE_TIMEOUT_MS = 3_000
/** In-memory caption cache ceiling. */
export const DEFAULT_CACHE_ENTRIES = 512

export type VisionChannel = 'explicit' | 'ollama'

/** Live settings snapshot the gates read per invocation. */
export interface VisionGates {
  /** 'off' disables the waterfall entirely; caption/analyze proceed. */
  mode: 'off' | 'caption' | 'analyze'
  /** settings privacy.localFirstVision (default true). */
  localFirstVision: boolean
}

// ---------------------------------------------------------------------------
// Route gate (FR-D1)
// ---------------------------------------------------------------------------

/**
 * Structural subset of the host @deepseek-ai/dsh-llm LlmRuntime face used by
 * the gate. Evidence (Fork/packages/llm/llm):
 * - lib/types/index.d.ts:217  class LlmRuntime extends Service
 * - lib/types/index.d.ts:313  resolveModelInfo(provider, model, signal?): Promise<LlmResolvedModelInfo>
 * - lib/types/types.d.ts:224  inputModalities?: readonly ModelModality[] on LlmModelInfo
 * - lib/types/types.d.ts:251  LlmResolvedModelInfo extends LlmModelInfo
 * - lib/types/types.d.ts:138  ModelModalityMap { text:'text', image:'image' }
 */
export interface LlmResolvedModelInfoLike {
  inputModalities?: readonly string[]
}

export interface LlmRuntimeFaceLike {
  resolveModelInfo: (provider: string, model: string, signal?: AbortSignal) => Promise<LlmResolvedModelInfoLike>
}

export interface ImageCapableGateDeps {
  /** Host logger sink; degradation warnings only. */
  logWarn: (message: string) => void
  /** Host llm runtime face; absent in bare contexts. */
  llm?: LlmRuntimeFaceLike | undefined
  /**
   * Exact route to interrogate. FileHub cannot reach apiproxy's internal
   * session-route selection, so the route arrives via config until the host
   * exposes it.
   */
  nativeRoute?: Readonly<{ provider: string; model: string }> | undefined
}
/**
 * Build the FR-D1 seam. Default (no llm face or no route): always false —
 * standalone hosts count as non-native and enter the waterfall.
 */
export function createImageCapableGate(deps: ImageCapableGateDeps): () => Promise<boolean> {
  const { llm, nativeRoute, logWarn } = deps
  // TODO(integration): swap config.vision.nativeRoute for the live session
  // route once the host exposes the agent/model selection seam to plugins.
  if (llm === undefined || nativeRoute === undefined || typeof llm.resolveModelInfo !== 'function') {
    return () => Promise.resolve(false)
  }
  const route = nativeRoute
  return async () => {
    try {
      const info = await llm.resolveModelInfo(route.provider, route.model)
      // Same admission pattern as read_image/apiproxy: an ABSENT modality list
      // means "unknown", which is NOT native admission.
      const modalities = info.inputModalities
      return modalities !== undefined && modalities.includes('image')
    } catch (error: unknown) {
      logWarn(`[filehub] vision route gate failed open-to-waterfall: ${String(error)}`)
      return false
    }
  }
}

// ---------------------------------------------------------------------------
// Caption cache (sha256+channel → caption), KV-backed with memory fallback
// ---------------------------------------------------------------------------

export interface CaptionCacheStore {
  get(key: string): Promise<string | undefined>
  put(key: string, value: string): Promise<void>
}

export function captionCacheKey(channel: VisionChannel, digestHex: string): string {
  return `${channel}:${digestHex}`
}

/** Bounded FIFO memory cache (single-process fallback). */
export function createMemoryCaptionCache(maxEntries: number = DEFAULT_CACHE_ENTRIES): CaptionCacheStore {
  const entries = new Map<string, string>()
  return {
    get(key) {
      return Promise.resolve(entries.get(key))
    },
    async put(key, value) {
      await Promise.resolve()
      entries.set(key, value)
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next().value
        if (oldest === undefined) break
        entries.delete(oldest)
      }
    },
  }
}

const VISION_UNIT = 'filehub_vision'
const VISION_TABLE = 'captions'

class KvCaptionCache implements CaptionCacheStore {
  private unitPromise: Promise<KvUnitLike> | undefined

  constructor(private readonly kv: KvFacetLike) {}

  private openUnit(): Promise<KvUnitLike> {
    if (this.unitPromise === undefined) {
      this.unitPromise = this.kv.open({
        name: VISION_UNIT,
        version: 1,
        tables: [VISION_TABLE],
        hasGlobal: false,
      })
    }
    return this.unitPromise
  }

  async get(key: string): Promise<string | undefined> {
    const unit = await this.openUnit()
    const snapshot = await unit.loadAll()
    const raw = (snapshot.tables[VISION_TABLE] ?? {})[key]
    return typeof raw === 'string' && raw.length > 0 ? raw : undefined
  }

  async put(key: string, value: string): Promise<void> {
    const unit = await this.openUnit()
    await unit.putRecord(VISION_TABLE, key, value)
  }
}

function pickKvFacet(storage: unknown): KvFacetLike | undefined {
  const hub = storage as
    | { backend?: { names?(): string[]; get?(name: string): { readonly kv?: KvFacetLike | undefined } } }
    | undefined
  const backend = hub?.backend
  if (!backend || typeof backend.names !== 'function' || typeof backend.get !== 'function') return undefined
  for (const name of backend.names()) {
    try {
      const kv = backend.get(name).kv
      if (kv) return kv
    } catch {
      // Vanished registry entry; keep scanning (mirrors meta.ts/library.ts).
    }
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Waterfall
// ---------------------------------------------------------------------------

export interface VisionServiceDeps {
  logWarn: (message: string) => void
  /** Host storage hub (KV facet pick for the caption cache). Optional. */
  storage?: unknown
  /** FR-D1 route gate; defaults to the non-native seam (always false). */
  resolveImageCapable?: (() => Promise<boolean>) | undefined
  /** Live settings reader; defaults to the documented defaults. */
  readGates?: (() => Promise<VisionGates>) | undefined
  /** Level 1: explicit public endpoint. Absent = level skipped. */
  endpoint?: string | undefined
  /** Privacy opt-in counterpart of the panel toggle; default false. */
  allowExternalVision?: boolean | undefined
  /** Level 2 toggle; default true. */
  ollamaProbe?: boolean | undefined
  /** Loopback-locked base URL; default http://127.0.0.1:11434. */
  ollamaEndpoint?: string | undefined
  /** Outbound/generate timeout; default 20 s. */
  timeoutMs?: number | undefined
  /** Tags-probe timeout; default 3 s. */
  probeTimeoutMs?: number | undefined
  /** Memory-cache bound; default 512. */
  cacheEntries?: number | undefined
  // ---- test seams (defaults are production behavior) ----
  /** Replace the caption cache entirely (tests inject spy stores). */
  cache?: CaptionCacheStore | undefined
  /** Replace the HTTP transport (tests observe request options, e.g. the M6 redirect lock). */
  fetchImpl?: FetchLike | undefined
  /** Replace the public-URL guard (tests inject permissive variants). */
  assertPublicUrl?: ((input: string | URL) => Promise<URL>) | undefined
  /** DNS answers handed to the default public guard (rebinding mocks). */
  lookup?: LookupAllAddresses | undefined
  /** Replace the loopback guard (tests inject permissive variants). */
  assertLoopbackUrl?: ((input: string | URL) => URL) | undefined
}

export interface VisionService {
  /**
   * Run the gated waterfall. Resolves undefined when native-gated, disabled
   * by mode, or degraded after total failure — callers then omit the caption.
   */
  caption(bytes: Uint8Array): Promise<string | undefined>
}

const DEFAULT_GATES: VisionGates = { mode: 'caption', localFirstVision: true }

/** First non-empty trimmed string among the accepted caption fields. */
function extractCaption(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const record = payload as Record<string, unknown>
  for (const field of ['response', 'caption', 'text'] as const) {
    const value = record[field]
    if (typeof value === 'string') {
      const trimmed = value.trim()
      if (trimmed.length > 0) return trimmed
    }
  }
  return undefined
}

/** Ordered heuristic over Ollama model names, preferring vision families. */
const VISION_MODEL_HINT = /(vision|llava|minicpm|moondream|qvq|internvl|glm-4v|-vl|\bvl)/i

export function pickOllamaModel(names: readonly string[]): string | undefined {
  return names.find(name => VISION_MODEL_HINT.test(name)) ?? names[0]
}

export interface FetchLike {
  (url: string, init?: {
    method?: string
    headers?: Record<string, string>
    body?: string
    signal?: AbortSignal
    /**
     * M6 adversarial hardening (round 2): redirects are REFUSED, never
     * followed. A hostile public endpoint must not be able to 302 the caption
     * request onto an intranet/loopback target — the urlPolicy fences judge
     * the CONFIGURED url only, so following a redirect would bypass them one
     * hop in. 'error' turns any 3xx into a failed call (degrade, never dial).
     */
    redirect?: 'error'
  }): Promise<{
    ok: boolean
    status: number
    text(): Promise<string>
  }>
}

const defaultFetch: FetchLike = (url, init) =>
  fetch(url, { ...(init as RequestInit), redirect: 'error' })

export function createVisionService(deps: VisionServiceDeps): VisionService {
  const logWarn = deps.logWarn
  const endpoint = deps.endpoint
  const allowExternalVision = deps.allowExternalVision ?? false
  const ollamaProbe = deps.ollamaProbe ?? true
  const ollamaEndpoint = deps.ollamaEndpoint ?? DEFAULT_OLLAMA_ENDPOINT
  const timeoutMs = deps.timeoutMs ?? DEFAULT_VISION_TIMEOUT_MS
  const probeTimeoutMs = deps.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS
  const resolveImageCapable = deps.resolveImageCapable ?? (() => Promise.resolve(false))
  const readGates = deps.readGates ?? (() => Promise.resolve({ ...DEFAULT_GATES }))
  const assertPublicUrl =
    deps.assertPublicUrl ?? ((input: string | URL) => assertPublicHttpUrl(input, { lookup: deps.lookup }))
  const assertLoopbackUrl = deps.assertLoopbackUrl ?? assertLocalLoopbackUrl
  const doFetch = deps.fetchImpl ?? defaultFetch

  const injectedCache = deps.cache
  const kv = injectedCache !== undefined ? undefined : pickKvFacet(deps.storage)
  if (!kv && injectedCache === undefined) {
    logWarn('[filehub] vision caption cache falling back to memory (no KV facet)')
  }
  const cache: CaptionCacheStore =
    injectedCache ?? (kv ? new KvCaptionCache(kv) : createMemoryCaptionCache(deps.cacheEntries))

  /** One warn per distinct situation, never per upload (silent degradation). */
  const warned = new Set<string>()
  const warnOnce = (message: string): void => {
    if (warned.has(message)) return
    warned.add(message)
    logWarn(message)
  }

  /** Same digest+channel concurrency shares one promise (in-flight 共享). */
  const inflights = new Map<string, Promise<string | undefined>>()

  async function postForCaption(
    url: string,
    body: Record<string, unknown>,
    limitMs: number,
  ): Promise<string> {
    const response = await doFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stream: false, images: [], ...body }),
      signal: AbortSignal.timeout(limitMs),
      redirect: 'error', // M6: never follow redirects (SSRF one-hop bypass).
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const caption = extractCaption(JSON.parse(await response.text()))
    if (caption === undefined) throw new Error('response carried no usable caption field')
    return caption
  }

  async function callExplicit(base64Image: string): Promise<string> {
    if (endpoint === undefined) throw new UrlPolicyError('no explicit endpoint configured')
    return postForCaption(
      endpoint,
      { prompt: CAPTION_PROMPT, images: [base64Image] },
      timeoutMs,
    )
  }

  async function listOllamaModels(): Promise<string[]> {
    const response = await doFetch(`${ollamaEndpoint}/api/tags`, {
      method: 'GET',
      signal: AbortSignal.timeout(probeTimeoutMs),
      redirect: 'error', // M6: the loopback lock judges THIS url only.
    })
    if (!response.ok) throw new Error(`tags HTTP ${response.status}`)
    const payload = JSON.parse(await response.text()) as { models?: unknown }
    const models = Array.isArray(payload.models) ? payload.models : []
    const names: string[] = []
    for (const entry of models) {
      const name = (entry as { name?: unknown }).name
      if (typeof name === 'string' && name.length > 0) names.push(name)
    }
    return names
  }

  async function callOllama(model: string, base64Image: string): Promise<string> {
    return postForCaption(
      `${ollamaEndpoint}/api/generate`,
      { model, prompt: CAPTION_PROMPT, images: [base64Image] },
      timeoutMs,
    )
  }

  async function attempt(channel: VisionChannel, base64Image: string): Promise<string | undefined> {
    if (channel === 'explicit') {
      return callExplicit(base64Image)
    }
    const names = await listOllamaModels()
    if (names.length === 0) throw new Error('local probe found no models')
    const model = pickOllamaModel(names)
    if (model === undefined) throw new Error('local probe found no usable model name')
    return callOllama(model, base64Image)
  }

  return {
    async caption(bytes: Uint8Array): Promise<string | undefined> {
      // ---- FR-D1 route gate: native vision ⇒ dormant waterfall --------------
      if (await resolveImageCapable()) return undefined

      const gates = await readGates().catch(() => ({ ...DEFAULT_GATES }))
      if (gates.mode === 'off') return undefined

      const digest = createHash('sha256').update(bytes).digest('hex')
      const base64Image = Buffer.from(bytes).toString('base64')

      const levels: VisionChannel[] = []
      if (endpoint !== undefined) levels.push('explicit')
      if (ollamaProbe) levels.push('ollama')

      for (const channel of levels) {
        if (channel === 'explicit') {
          // Security fence first: a policy violation skips this level (warn),
          // it never aborts the whole waterfall.
          try {
            await assertPublicUrl(endpoint as string)
          } catch (error: unknown) {
            warnOnce(
              `[filehub] vision endpoint rejected by url policy, skipping explicit channel: ${String(error)}`,
            )
            continue
          }
          // Privacy fence: local-first posture forbids outbound dialing unless
          // explicitly allowed. Local channels stay permitted.
          if (gates.localFirstVision && !allowExternalVision) {
            warnOnce(
              '[filehub] privacy.localFirstVision is active and vision.allowExternalVision is not enabled; outbound caption endpoint skipped',
            )
            continue
          }
        } else {
          // Reverse lock: the probe must target the local machine only.
          try {
            assertLoopbackUrl(ollamaEndpoint)
          } catch (error: unknown) {
            warnOnce(
              `[filehub] ollama endpoint rejected by url policy, skipping local channel: ${String(error)}`,
            )
            break
          }
        }

        const key = captionCacheKey(channel, digest)
        const cached = await cache.get(key).catch(() => undefined)
        if (cached !== undefined) return cached

        const existing = inflights.get(key)
        if (existing !== undefined) return existing

        const task: Promise<string | undefined> = (async () => {
          try {
            const caption = await attempt(channel, base64Image)
            if (caption === undefined) return undefined
            await cache.put(key, caption).catch(() => undefined)
            return caption
          } catch (error: unknown) {
            warnOnce(
              `[filehub] vision ${channel} channel failed (degrading): ${String(error)}`,
            )
            return undefined
          } finally {
            inflights.delete(key)
          }
        })()
        inflights.set(key, task)
        const caption = await task
        if (caption !== undefined) return caption
        // else: fall through to the next level.
      }
      return undefined
    },
  }
}

// ---------------------------------------------------------------------------
// Upload hook: wrap the M1 handler additively (upload.ts untouched)
// ---------------------------------------------------------------------------

export interface UploadVisionDeps {
  /** The composed M1 upload handler. */
  inner: HttpHandler
  /** The M4 vision service. */
  vision: VisionService
  /** Reads the persisted upload back from disk (absolute path). */
  readFile(path: string): Promise<Uint8Array>
  logWarn(message: string): void
  /**
   * M6 caption passthrough (P01 §6-D FR-D4 + list/library surfaces): called
   * after a caption was produced for a stored image so the wiring layer can
   * persist it into upload metadata. Receives the ORIGINAL request (for the
   * session id), the absolute stored path, and the caption. Failures are
   * logged and swallowed — a metadata write must never break the response.
   */
  recordCaption?(req: IncomingMessage, absolutePath: string, caption: string): Promise<void>
}

/**
 * Capture the inner handler's buffered JSON answer (it only ever writes via
 * sendJson/sendError → setHeader/statusCode/end), then — for sniffed images —
 * attach `imageCaption` before flushing to the real socket. Non-images and
 * every error path pass through byte-identical.
 */
export function augmentUploadHandlerWithCaption(deps: UploadVisionDeps): HttpHandler {
  const decoder = new TextDecoder()
  return async function handleUploadWithCaption(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const originalEnd = res.end.bind(res) as (body?: string) => void
    let capturedBody: string | undefined
    let capturedStatus: number | undefined
    let flushed = false

    const flush = (body?: string): void => {
      if (flushed) return
      flushed = true
      if (res.writableEnded || res.destroyed) return
      try {
        // Status writes landed on the shim (property shadowing); copy the
        // effective one onto the real response BEFORE ending.
        res.statusCode = shim.statusCode
        originalEnd(body)
      } catch {
        // Socket died mid-flight; nothing further to answer.
      }
    }

    // Prototype-child shim: property writes land here, header writes delegate.
    const shim = Object.create(res) as ServerResponse
    ;(shim as unknown as { end: (chunk?: unknown) => unknown }).end = (
      chunk?: unknown,
    ): unknown => {
      if (typeof chunk === 'string') capturedBody = chunk
      else if (chunk instanceof Uint8Array) capturedBody = decoder.decode(chunk)
      capturedStatus = shim.statusCode
      return shim
    }

    let failure: unknown
    try {
      await deps.inner(req, shim)
    } catch (error: unknown) {
      failure = error
    }
    if (failure !== undefined) {
      // Mirror the dispatch-level safety net without double-responding.
      const detail =
        failure instanceof Error ? failure.message : typeof failure === 'string' ? failure : JSON.stringify(failure)
      deps.logWarn(`[filehub] upload handler failure (vision wrap): ${detail}`)
      if (capturedStatus === undefined) shim.statusCode = 500
      flush(capturedBody ?? JSON.stringify({ error: 'internal filehub error' }))
      return
    }
    if (capturedStatus !== 200 || capturedBody === undefined) {
      flush(capturedBody)
      return
    }
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(capturedBody) as Record<string, unknown>
    } catch {
      flush(capturedBody)
      return
    }
    const verdict = UploadResultSchema.safeParse(parsed)
    if (!verdict.success || !verdict.data.sniffedType.startsWith('image/')) {
      flush(capturedBody)
      return
    }
    try {
      const stored = await deps.readFile(verdict.data.path)
      const caption = await deps.vision.caption(stored)
      if (caption !== undefined) {
        parsed.imageCaption = caption
        // M6: persist so list/library can surface the caption from metadata.
        await deps.recordCaption?.(req, verdict.data.path, caption).catch((error: unknown) => {
          deps.logWarn(`[filehub] caption persistence degraded: ${String(error)}`)
        })
      }
    } catch (error: unknown) {
      deps.logWarn(`[filehub] vision caption stage degraded: ${String(error)}`)
    }
    flush(JSON.stringify(parsed))
  }
}
