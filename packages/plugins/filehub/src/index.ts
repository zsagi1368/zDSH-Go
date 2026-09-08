/**
 * zDSH FileHub host half entry.
 *
 * M1 upload domain (P01 §6-A): byte-sniffing layer (src/detect.ts), the HTTP
 * upload service with its guard rails (src/server/upload.ts), the path
 * sandbox (src/server/pathPolicy.ts), lifecycle sweeping and deletion
 * (src/server/lifecycle.ts), and the workspace listing (src/server/list.ts),
 * all wired onto the host `webServer` prefix route `/api/filehub`.
 *
 * Later milestones land per domain: mention pipeline (M2), document reading
 * (M3), vision waterfall (M4), console and settings (M5) — see plan P01 §6.
 */

import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import fsp from 'node:fs/promises'

import { header, sendError, safeDecode } from './server/httpUtil.js'
import { createLifecycle } from './server/lifecycle.js'
import { createListHandler } from './server/list.js'
import { createMemoryMetaStore, createMetaStore } from './server/meta.js'
import type { StorageHubLike } from './server/meta.js'
import { createMentionInjector, createSearchHandler } from './server/mention.js'
import type { HostEventsLike } from './server/mention.js'
import { createUploadHandler } from './server/upload.js'
import type { HttpHandler } from './server/upload.js'
import { isStrictlyInside, isValidSessionId } from './server/pathPolicy.js'
import { DEFAULT_DANGEROUS_EXTENSIONS } from './server/guards.js'
import { createWorkspaceIndexer, createWorkspaceResolver } from './server/workspace.js'
import type { SessionsLike, WorkspaceIndexer } from './server/workspace.js'
import { ParseCache } from './server/parse/cache.js'
import { registerReadingTools } from './server/tools.js'
import type { ReadingBudgets, SystemPromptRegistryLike, ToolsRegistryLike } from './server/tools.js'
import {
  createLibraryHandler,
  createLibraryService,
  createCleanupHandler,
  createSessionDeleteHandler,
  createUsageHandler,
} from './server/library.js'
import type { LibraryService } from './server/library.js'
import {
  createSettingsGetHandler,
  createSettingsPutHandler,
  createSettingsService,
} from './server/settings.js'
import type { SettingsService } from './server/settings.js'
// M4 vision waterfall (additive).
import {
  augmentUploadHandlerWithCaption,
  createImageCapableGate,
  createVisionService,
} from './server/vision.js'
import type { LlmRuntimeFaceLike, VisionService } from './server/vision.js'
import { assertLocalLoopbackUrl, assertPublicHttpUrl, UrlPolicyError } from './server/urlPolicy.js'

export { sniff } from './detect.js'
export type { SniffKind, SniffResult } from './detect.js'

// M3 re-exports (additive).
export { registerReadingTools, ParseCache }
export type { ReadingBudgets, SystemPromptRegistryLike, ToolsRegistryLike }

// M5 re-exports (additive): console services + settings center.
export { createLibraryService, createSettingsService }
export type { LibraryService, SettingsService }

// M4 re-exports (additive): vision waterfall + url policy fences.
export {
  augmentUploadHandlerWithCaption,
  createImageCapableGate,
  createVisionService,
  assertLocalLoopbackUrl,
  assertPublicHttpUrl,
}
export type { LlmRuntimeFaceLike, VisionService }
export { UrlPolicyError }

/** Extension deny list served as the default value of `upload.dangerousExtensions`. */
export { DEFAULT_DANGEROUS_EXTENSIONS }

export interface UploadDomainConfig {
  /** Per-file byte ceiling. Default 50 MiB. */
  maxBytes: number
  /** Simultaneous uploads admitted server-wide. Default 4. */
  maxConcurrent: number
  /** Per-session stored-bytes ceiling. Default 512 MiB. */
  perSessionQuotaBytes: number
  /** Override of the dangerous-extension deny list (lowercase, no dots). */
  dangerousExtensions?: readonly string[]
}

export interface LifecycleDomainConfig {
  /** Upload expiry age. Default 7 days. */
  ttlMs: number
  /** Sweep cadence. Default 1 hour. */
  sweepIntervalMs: number
}

/** M2 mention pipeline knobs (P01 §6-B). */
export interface MentionDomainConfig {
  /** Hard entry ceiling of one workspace walk. Default 5000. */
  indexMaxFiles: number
  /** Fallback freshness window for the index cache. Default 30 s. */
  indexTtlMs: number
  /** Search response page cap. Default 50. */
  searchLimit: number
}

/**
 * M4 vision waterfall knobs (P01 §6-D). All optional; defaults live in the
 * service. Mode/privacy toggles are NOT here — they ride the settings center
 * (`vision.mode`, `privacy.localFirstVision`).
 */
export interface VisionDomainConfig {
  /**
   * Level 1: explicit caption endpoint (http/https, public-only per
   * urlPolicy). Absent = level skipped.
   */
  endpoint?: string
  /**
   * Privacy opt-in counterpart of the panel toggle: when settings
   * privacy.localFirstVision is true (the default) this must be explicitly
   * true before the outbound endpoint ever dials. Default false.
   */
  allowExternalVision?: boolean
  /** Level 2 toggle: local Ollama probe. Default true. */
  ollamaProbe?: boolean
  /** Probe base URL; loopback-locked. Default http://127.0.0.1:11434. */
  ollamaEndpoint?: string
  /** Outbound/generate timeout in ms. Default 20 000. */
  timeoutMs?: number
  /** Tags-probe timeout in ms. Default 3 000. */
  probeTimeoutMs?: number
  /** Memory caption-cache bound (KV-backed caches are unbounded). Default 512. */
  cacheEntries?: number
  /**
   * FR-D1 route hint: exact provider/model interrogated through the host llm
   * face for inputModalities. Absent/faceless = non-native (waterfall runs).
   * TODO(integration): replace with the host session-route seam once exposed.
   */
  nativeRoute?: { readonly provider: string; readonly model: string }
}

export interface FileHubConfig {
  /** Session-workspace subdirectory name created under the session cwd. */
  storageDirName: string
  upload: UploadDomainConfig
  lifecycle: LifecycleDomainConfig
  /** M2 mention domain; defaults apply when omitted (additive, M1-safe). */
  mention?: Partial<MentionDomainConfig>
  /**
   * M3 document-reading domain; defaults apply when omitted (additive,
   * M1/M2-safe). `budgets` overrides per-format character budgets,
   * `cacheEntries`/`cacheBytes` the parse-cache LRU bounds.
   */
  reading?: {
    budgets?: Partial<ReadingBudgets>
    cacheEntries?: number
    cacheBytes?: number
  }
  /**
   * M5 console domain; defaults apply when omitted (additive, M1–M4-safe).
   * `maxEntries` bounds one library/usage aggregation page.
   */
  console?: {
    maxEntries?: number
  }
  /** M4 vision waterfall; defaults apply when omitted (additive, M1–M3-safe). */
  vision?: VisionDomainConfig
}

const MIB = 1024 * 1024

export const filehubConfigDefaults: FileHubConfig = {
  storageDirName: '.filehub',
  upload: {
    maxBytes: 50 * MIB,
    maxConcurrent: 4,
    perSessionQuotaBytes: 512 * MIB,
  },
  lifecycle: {
    ttlMs: 7 * 24 * 60 * 60 * 1000,
    sweepIntervalMs: 60 * 60 * 1000,
  },
  mention: {
    indexMaxFiles: 5000,
    indexTtlMs: 30_000,
    searchLimit: 50,
  },
}

/** Deep-enough merge for the nested config groups. */
function resolveConfig(overrides?: Partial<FileHubConfig>): FileHubConfig & {
  upload: Required<Omit<UploadDomainConfig, 'dangerousExtensions'>> &
    Pick<UploadDomainConfig, 'dangerousExtensions'>
  mention: MentionDomainConfig
  vision: VisionDomainConfig
} {
  return {
    storageDirName: overrides?.storageDirName ?? filehubConfigDefaults.storageDirName,
    upload: {
      ...filehubConfigDefaults.upload,
      ...overrides?.upload,
    },
    lifecycle: {
      ...filehubConfigDefaults.lifecycle,
      ...overrides?.lifecycle,
    },
    mention: {
      ...filehubConfigDefaults.mention,
      ...overrides?.mention,
    } as MentionDomainConfig,
    console: {
      ...overrides?.console,
    },
    vision: {
      ...overrides?.vision,
    },
  }
}

/**
 * Structural seams over the subset of the host context FileHub touches.
 * Every service is optional so a bare context (smoke tests, degraded hosts)
 * still loads the plugin; capabilities degrade loudly instead of crashing.
 */
export interface LoggerLike {
  info(message: string): void
  warn?(message: string): void
  error?(message: string): void
}

export interface WebServerRouteLike {
  kind: 'exact' | 'prefix'
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

export interface WebServerLike {
  register(route: WebServerRouteLike): () => void
}

export interface HostContext {
  readonly logger: LoggerLike
  readonly sessions?: SessionsLike
  readonly webServer?: WebServerLike
  readonly storage?: StorageHubLike
  /**
   * M2: the host cordis event face (`ctx.on(...)`), used for the
   * fs-invalidation listeners and the agent/pre-step injection. Optional so a
   * bare context still loads; without it the mention pipeline degrades to the
   * index TTL fallback and no send-time references are injected.
   */
  readonly events?: HostEventsLike
  /**
   * M3: host tool registry face (`ctx.tools.register(definition)`). The
   * definition objects FileHub registers mirror the verified
   * @deepseek-ai/dsh-tools DefineToolOptions contract field-for-field (see
   * src/server/tools.ts header note). Optional: without it the reading tools
   * are simply not registered.
   */
  readonly tools?: ToolsRegistryLike
  /**
   * M3: system-prompt registry face (`ctx.systemPrompt.section(...)`),
   * mirroring the verified dsh-system-prompt PromptSection signature.
   * Optional; absent = no guidance section is contributed.
   */
  readonly systemPrompt?: SystemPromptRegistryLike
  /**
   * M4: host llm runtime face, structurally mirroring the verified
   * @deepseek-ai/dsh-llm LlmRuntime (Fork/packages/llm/llm/lib/types/
   * index.d.ts:217 class, :313 resolveModelInfo) — the FR-D1 route gate reads
   * the exact route's inputModalities through it. Optional: without it (and
   * without config.vision.nativeRoute) every session counts as non-native
   * and the caption waterfall runs.
   */
  readonly llm?: LlmRuntimeFaceLike
}

/** Host services required by the full feature set (finalized per domain). */
export const inject = [
  'fs',
  'sessions',
  'storage',
  'webServer',
  'tools',
  'systemPrompt',
]

/** The running plugin instance; dispose tears routes + sweeper down. */
export interface FileHubDomain {
  /** Run one TTL sweep immediately (also on the interval when started). */
  sweep(): Promise<{ workspaces: number; scanned: number; deleted: number; prunedDirs: number }>
  /** Stop the sweeper timer and unregister routes. Idempotent. */
  dispose(): void
}

/**
 * Compose the M1 upload domain onto a host context. Exported separately from
 * {@link apply} so tests can drive the real handlers against fake services.
 *
 * TODO(integration): wrap route registration + the sweeper timer in
 * `ctx.effect(...)` once the loader contract for plugin-provided disposers is
 * pinned down; for now callers own disposal through the returned handle.
 */
export function createFileHubDomain(ctx: HostContext, overrides?: Partial<FileHubConfig>): FileHubDomain {
  const resolved = resolveConfig(overrides)
  const logInfo = (message: string): void =>{  ctx.logger.info(message) }
  const logWarn = (message: string): void => ctx.logger.warn?.(message)

  const workspaces = createWorkspaceResolver(ctx.sessions, resolved.storageDirName)
  // Metadata: KV-backed when the host storage hub exposes a KV facet,
  // in-memory otherwise (createMetaStore decides; it warns through logWarn).
  const meta =
    ctx.storage !== undefined ? createMetaStore(ctx.storage, logWarn) : createMemoryMetaStore()

  // ---- M2 mention pipeline: bounded index + invalidation + search ----------
  const indexer: WorkspaceIndexer = createWorkspaceIndexer({
    sessions: ctx.sessions,
    storageDirName: resolved.storageDirName,
    logWarn,
    maxFiles: resolved.mention.indexMaxFiles,
    ttlMs: resolved.mention.indexTtlMs,
  })
  // Event-driven invalidation (FR-B2). Verified event names and payload shape:
  // `fs/write-intent` / `fs/edit-intent` are waterfall events carrying
  // (target: FsTarget {targetKey, displayPath}, actor) — see
  // Fork/packages/fs/fs-observation-policy/src/index.ts:119-122 and
  // Fork/packages/fs/fs/src/types.ts:60-68. They fire on TOOL-mediated writes
  // only; edits made outside the tool pipeline surface through the TTL
  // fallback inside createWorkspaceIndexer instead.
  const eventDisposers: Array<() => void> = []
  if (ctx.events !== undefined) {
    for (const eventName of ['fs/write-intent', 'fs/edit-intent'] as const) {
      try {
        eventDisposers.push(ctx.events.on(eventName, () =>{  indexer.invalidateAll() }))
      } catch (error: unknown) {
        logWarn(`[filehub] could not subscribe ${eventName}: ${String(error)}`)
      }
    }
  } else {
    logWarn('[filehub] host events unavailable; workspace index falls back to TTL refresh only')
  }

  const searchHandler = createSearchHandler({
    indexer,
    meta,
    workspaces,
    limit: resolved.mention.searchLimit,
  })

  // Send-time existence validation + structured injection (FR-B3/B4). The
  // listener wraps next() on the agent/pre-step waterfall; without the events
  // face there is no injection seam and the feature stays off (degrades loud).
  let detachInjector: (() => void) | undefined
  if (ctx.events !== undefined) {
    try {
      detachInjector = createMentionInjector({ logWarn }).attach(ctx.events)
    } catch (error: unknown) {
      logWarn(`[filehub] agent/pre-step registration failed: ${String(error)}`)
    }
  }

  // ---- M3 document reading: tools + prompt section -------------------------
  // Registered only when BOTH host faces exist; otherwise the domain keeps
  // loading and the reading capability degrades loudly (FR-C5 seam contract).
  const toolDisposers: Array<() => void> = []
  if (ctx.tools !== undefined && ctx.systemPrompt !== undefined) {
    try {
      const cache = new ParseCache({
        maxEntries: resolved.reading?.cacheEntries,
        maxBytes: resolved.reading?.cacheBytes,
      })
      toolDisposers.push(
        ...registerReadingTools({
          tools: ctx.tools,
          systemPrompt: ctx.systemPrompt,
          logWarn,
          storageDirName: resolved.storageDirName,
          cache,
          budgets: resolved.reading?.budgets,
        }),
      )
    } catch (error: unknown) {
      logWarn(`[filehub] reading tools registration failed: ${String(error)}`)
    }
  } else {
    logWarn('[filehub] tools/systemPrompt services unavailable; document-reading tools not registered')
  }

  const uploadHandler = createUploadHandler({
    guards: {
      maxBytes: resolved.upload.maxBytes,
      maxConcurrent: resolved.upload.maxConcurrent,
      perSessionQuotaBytes: resolved.upload.perSessionQuotaBytes,
      dangerousExtensions: resolved.upload.dangerousExtensions ?? DEFAULT_DANGEROUS_EXTENSIONS,
    },
    meta,
    workspaces,
    logWarn,
  })

  const lifecycle = createLifecycle({
    ttlMs: resolved.lifecycle.ttlMs,
    meta,
    workspaces,
    storageRootOf: cwd => path.join(path.resolve(cwd), resolved.storageDirName),
    logInfo,
    logWarn,
  })

  const listHandler = createListHandler({ meta, workspaces })

  // ---- M5 file console + settings center (P01 §6-E / §7) -------------------
  // The console reads through the same meta seam as upload/lifecycle and keeps
  // its derived enrichment (kind buckets, backfill stamps) in its own KV unit;
  // settings persist under the `filehub.*` namespace in a second unit.
  const library = createLibraryService({
    meta,
    workspaces,
    storage: ctx.storage,
    storageRootOf: cwd => path.join(path.resolve(cwd), resolved.storageDirName),
    logWarn,
    maxEntries: resolved.console?.maxEntries,
  })
  const libraryHandler = createLibraryHandler({ service: library })
  const usageHandler = createUsageHandler({ service: library })
  const sessionDeleteHandler = createSessionDeleteHandler({ service: library })
  const cleanupHandler = createCleanupHandler({ service: library })

  const settingsService = createSettingsService({ storage: ctx.storage, logWarn })
  const settingsGetHandler = createSettingsGetHandler({ service: settingsService })
  const settingsPutHandler = createSettingsPutHandler({ service: settingsService })

  // ---- M4 vision caption waterfall (P01 §6-D) ------------------------------
  // Route gate first (FR-D1): a natively vision-capable session model keeps
  // the waterfall dormant. Mode/privacy toggles read the live settings center;
  // captions cache into their own KV unit keyed by sha256+channel.
  const visionService: VisionService = createVisionService({
    logWarn,
    storage: ctx.storage,
    resolveImageCapable: createImageCapableGate({
      llm: ctx.llm,
      nativeRoute: resolved.vision.nativeRoute,
      logWarn,
    }),
    readGates: async () => {
      const settings = await settingsService.get()
      return {
        mode: settings['vision.mode'],
        localFirstVision: settings['privacy.localFirstVision'],
      }
    },
    endpoint: resolved.vision.endpoint,
    allowExternalVision: resolved.vision.allowExternalVision,
    ollamaProbe: resolved.vision.ollamaProbe,
    ollamaEndpoint: resolved.vision.ollamaEndpoint,
    timeoutMs: resolved.vision.timeoutMs,
    probeTimeoutMs: resolved.vision.probeTimeoutMs,
  })
  // Additive upload hook: sniffed images get `imageCaption` on their 200 body
  // (synchronous-await variant of the FR-D4 attachment contract — every
  // failure path answers exactly what the inner handler answered).
  //
  // M6 caption passthrough: the produced caption is ALSO persisted into the
  // upload metadata row (meta KV) so GET /list and /library can surface it
  // without re-running the waterfall. The mapping back to the meta key is
  // containment-checked: only paths strictly inside this session's workspace
  // root are ever written.
  const forwardSlashes = (value: string): string => value.replace(/\\/g, '/')
  const uploadHandlerWithVision = augmentUploadHandlerWithCaption({
    inner: uploadHandler,
    vision: visionService,
    readFile: filePath => fsp.readFile(filePath),
    logWarn,
    recordCaption: async (req, absolutePath, caption) => {
      const rawSession = header(req, 'x-session-id')
      if (rawSession === undefined) return
      const sessionId = safeDecode(rawSession)
      if (sessionId === undefined || !isValidSessionId(sessionId)) return
      const workspace = workspaces.resolve(sessionId)
      if (!workspace || !isStrictlyInside(workspace.root, absolutePath)) return
      const relFromRoot = forwardSlashes(path.relative(workspace.root, absolutePath))
      const record = await meta.get(sessionId).catch(() => undefined)
      const row = record?.files[relFromRoot]
      if (!row || typeof caption !== 'string' || caption === '') return
      await meta.record(
        sessionId,
        relFromRoot,
        { ...row, imageCaption: caption },
        workspace.cwd,
      )
    },
  })

  const dispatch: HttpHandler = async (req, res) => {
    await Promise.resolve()
    let pathname = '/'
    try {
      pathname = new URL(req.url ?? '/', 'http://filehub.invalid').pathname
    } catch {
      sendError(res, 400, 'malformed request target')
      return
    }
    // Safety net: a handler bug must surface as a 500, never as an unhandled
    // rejection that could take the host down.
    const run = (handler: HttpHandler): void => {
      void Promise.resolve()
        .then(() => handler(req, res))
        .catch((error: unknown) => {
          logWarn(`[filehub] handler failure (${req.method} ${pathname}): ${String(error)}`)
          if (!res.writableEnded && !res.destroyed) sendError(res, 500, 'internal filehub error')
        })
    }
    if (pathname === '/api/filehub/upload') {
      if (req.method === 'POST') {  run(uploadHandlerWithVision); return }
      sendError(res, 405, 'method not allowed')
      return
    }
    if (pathname === '/api/filehub/file') {
      if (req.method === 'DELETE') {  run(lifecycle.deleteFile); return }
      sendError(res, 405, 'method not allowed')
      return
    }
    if (pathname === '/api/filehub/list') {
      if (req.method === 'GET') {  run(listHandler); return }
      sendError(res, 405, 'method not allowed')
      return
    }
    if (pathname === '/api/filehub/search') {
      if (req.method === 'GET') {  run(searchHandler); return }
      sendError(res, 405, 'method not allowed')
      return
    }
    if (pathname === '/api/filehub/library') {
      if (req.method === 'GET') {  run(libraryHandler); return }
      sendError(res, 405, 'method not allowed')
      return
    }
    if (pathname === '/api/filehub/usage') {
      if (req.method === 'GET') {  run(usageHandler); return }
      sendError(res, 405, 'method not allowed')
      return
    }
    if (pathname.startsWith('/api/filehub/session/')) {
      const sessionId = safeDecode(pathname.slice('/api/filehub/session/'.length))
      if (sessionId === undefined || sessionId === '') {
        sendError(res, 400, 'malformed session id')
        return
      }
      if (req.method === 'DELETE') {  run((rq, rs) => sessionDeleteHandler(rq, rs, sessionId)); return }
      sendError(res, 405, 'method not allowed')
      return
    }
    if (pathname === '/api/filehub/cleanup') {
      if (req.method === 'POST') {  run(cleanupHandler); return }
      sendError(res, 405, 'method not allowed')
      return
    }
    if (pathname === '/api/filehub/settings') {
      if (req.method === 'GET') {  run(settingsGetHandler); return }
      if (req.method === 'PUT') {  run(settingsPutHandler); return }
      sendError(res, 405, 'method not allowed')
      return
    }
    sendError(res, 404, 'unknown filehub endpoint')
  }

  let unregisterRoute: (() => void) | undefined
  if (ctx.webServer !== undefined) {
    unregisterRoute = ctx.webServer.register({
      kind: 'prefix',
      path: '/api/filehub',
      handler: dispatch,
    })
  } else {
    logWarn('[filehub] webServer service unavailable; upload endpoints not registered')
  }

  lifecycle.start(resolved.lifecycle.sweepIntervalMs)

  return {
    sweep: () => lifecycle.sweep(),
    dispose() {
      lifecycle.stop()
      for (const disposeEvent of eventDisposers) {
        try {
          disposeEvent()
        } catch {
          // A host that throws on unsubscribe must not block our teardown.
        }
      }
      eventDisposers.length = 0
      detachInjector?.()
      detachInjector = undefined
      indexer.dispose()
      for (const disposeTool of toolDisposers) {
        try {
          disposeTool()
        } catch {
          // A host that throws on unregister must not block our teardown.
        }
      }
      toolDisposers.length = 0
      library.dispose()
      unregisterRoute?.()
      unregisterRoute = undefined
    },
  }
}

/**
 * Loader entry: compose the domain and announce readiness. The first log line
 * stays stable — smoke tests assert the `[filehub]` prefix plus the effective
 * storageDirName.
 */
export function apply(ctx: HostContext, config?: Partial<FileHubConfig>): FileHubDomain {
  const resolved = resolveConfig(config)
  ctx.logger.info(`[filehub] ready (storageDirName=${resolved.storageDirName})`)
  return createFileHubDomain(ctx, config)
}
