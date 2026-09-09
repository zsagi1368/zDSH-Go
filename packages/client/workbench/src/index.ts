/**
 * Workbench host half. Owns the `/workbench` HTTP prefix and the
 * `/workbench/events` SSE channel. Every request passes the browser-trust
 * fence (see trust.ts) before any work happens. API responses share one
 * envelope (`shared/protocol-envelope.ts`); unknown methods answer with
 * `no-route` on HTTP 200 so transport status stays reserved for transport.
 *
 * Route paths follow the vendored webserver contract: absolute pathnames with
 * no trailing slash — `prefix` p matches p and p/<anything>. The dock SPA face
 * (below) serves the composing web frontend's index for `/workbench` deep
 * paths that no workbench endpoint claims.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ServerResponse } from 'node:http'
import { readFile, realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { WORKBENCH_ROUTE_PREFIX as PREFIX, pingResult } from './shared/protocol.ts'
import type { WorkbenchRouteEnvelope } from './shared/protocol-envelope.ts'
import type {} from '@deepseek-ai/dsh-client-connection'
import type { WebRoute } from './context-types.ts'
import { createGitHandlers } from './git-routes.ts'
import { createFsHandlers, readBody, RootCache } from './fs-routes.ts'
import { TaskLedger } from './task-ledger.ts'
import { createMediaHandler } from './media-route.ts'
import { FsWatcherManager } from './fs-watch.ts'
import { PtyRegistry } from './pty-registry.ts'
import { acceptTerminalSocket } from './terminal-route.ts'
import { assertTrustedAuthorityEntry, isTrustedRequestHost } from './trust.ts'
import { guardWorkbench } from './compat.ts'

/** Services required from the host composition. */
export const inject = ['webServer', 'connection']

/** Deployment options for the host half (cordis plugin row `config`). */
export interface WorkbenchHostConfig {
  /**
   * Additional trusted authorities (`host` or `host:port`) allowed past the
   * Host fence when DSH serves beyond loopback. Must mirror the deployment's
   * own trusted-host posture; entries are validated loudly at load time.
   */
  trustedHosts?: string[]
  /** Text read cap per `fs.read`. Clamped hard at 8 MiB. */
  readLimitBytes?: number
  /** Request-body byte cap (also bounds writes). */
  writeBodyLimitBytes?: number
  /** Directory listing row bound per level. */
  listLimit?: number
  /** Search result bound before truncation. */
  searchLimit?: number
  /** Watcher batch window in milliseconds. */
  watchDebounceMs?: number
  /** Terminals one session may hold open at once. */
  terminalsPerSession?: number
  /** How long a disconnected terminal survives awaiting a reconnect (ms). */
  reconnectGraceMs?: number
  /**
   * Workspace clamp: when non-empty, every request-declared `cwd` must lie
   * inside one of these directories (first match wins per request). Empty
   * means unrestricted — acceptable only because the trust fence limits the
   * API to the user's own machine and page origin; deployments that expose
   * the port beyond loopback SHOULD set this. The branch-integration build
   * derives it from the live session automatically.
   */
  allowedRoots?: string[]
}

const DEFAULTS = {
  readLimitBytes: 512 * 1024,
  writeBodyLimitBytes: 128 * 1024 * 1024,
  listLimit: 1000,
  searchLimit: 200,
  watchDebounceMs: 150,
} as const

function respondJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function fail(code: string, message: string): WorkbenchRouteEnvelope<never> {
  return { ok: false, error: { code, message } }
}

/**
 * Anchor of the composing web frontend's built index. The dist location is
 * workspace knowledge of the web-app bundle, so this resolves through the
 * package graph and degrades to `undefined` (no SPA face) in compositions
 * that do not carry the frontend package.
 */
function resolveSpaIndex(): string | undefined {
  try {
    const require = createRequire(import.meta.url)
    return join(dirname(require.resolve('@deepseek-ai/dsh-web-frontend/package.json')), 'dist', 'index.html')
  } catch {
    return undefined
  }
}

/** Test hooks for the dist anchor; production never mutates them. */
export const internals: { resolveSpaIndex: () => string | undefined } = { resolveSpaIndex }

export async function apply(ctx: Context, options?: WorkbenchHostConfig): Promise<void> {
  const enabled = await guardWorkbench(ctx.logger)
  if (!enabled) {
    ctx.logger.warn('workbench: skipped registration (compat guard disabled the dock)')
    return
  }

  const trustedHosts = options?.trustedHosts ?? []
  for (const entry of trustedHosts) assertTrustedAuthorityEntry(entry)

  const readLimitBytes = options?.readLimitBytes ?? DEFAULTS.readLimitBytes
  const bodyCap = options?.writeBodyLimitBytes ?? DEFAULTS.writeBodyLimitBytes
  const watchers = new FsWatcherManager({ debounceMs: options?.watchDebounceMs ?? DEFAULTS.watchDebounceMs })
  const ptyRegistry = new PtyRegistry({
    ...(options?.terminalsPerSession === undefined ? {} : { terminalsPerSession: options.terminalsPerSession }),
    ...(options?.reconnectGraceMs === undefined ? {} : { reconnectGraceMs: options.reconnectGraceMs }),
  })
  const rootCache = new RootCache()
  // Workspace clamp: resolve once at boot so the clamp itself cannot be
  // influenced by request-time symlink games. The coordinate MUST match the
  // request path (`fs/promises.realpath` in resolveWorkspaceRoot): on win32
  // the promise API expands 8.3 short-name components while fs.realpathSync
  // keeps them, so a sync-canonicalized clamp would never lexically contain a
  // promise-canonicalized request root on 8.3-aliasing hosts (GH Windows
  // runners: RUNNER~1 vs runneradmin) and every inside request would be
  // refused as outside-workspace.
  const allowedRealRoots: string[] = []
  for (const candidate of options?.allowedRoots ?? []) {
    try {
      allowedRealRoots.push(await realpath(candidate))
    } catch {
      // Unresolvable configured root: refuse loudly at composition time.
      throw new Error(`workbench: allowedRoots entry is not an existing directory: ${candidate}`)
    }
  }
  const rootAllowed = (rootReal: string): boolean =>
    allowedRealRoots.length === 0 ||
    allowedRealRoots.some(allowed => rootReal === allowed || rootReal.startsWith(allowed + (allowed.includes('\\') ? '\\' : '/')))

  const handlers = createFsHandlers(rootCache, {
    readLimitBytes,
    listLimit: options?.listLimit ?? DEFAULTS.listLimit,
    searchLimit: options?.searchLimit ?? DEFAULTS.searchLimit,
    rootAllowed,
  })
  const gitHandlers = createGitHandlers({ rootCache, rootAllowed })

  const taskLedger = new TaskLedger()
  const tasksReady = taskLedger.init().catch(() => {})
  const taskHandlers: Record<string, (payload: unknown) => WorkbenchRouteEnvelope<unknown> | Promise<WorkbenchRouteEnvelope<unknown>>> = {
    'tasks.list': () => taskLedger.list(),
    'tasks.create': payload => taskLedger.create(payload),
    'tasks.update': payload => taskLedger.update(payload),
    'tasks.delete': payload => taskLedger.remove(payload),
  }

  // Task changes ride the existing SSE channel so every page stays current.
  taskLedger.subscribe((frame) => {
    watchers.broadcast(frame)
  })

  const dispatch = async (method: string, payload: unknown): Promise<WorkbenchRouteEnvelope<unknown>> => {
    if (method === 'ping') return envelopeValue(pingResult())
    await tasksReady
    const handler = handlers.get(method)
      ?? gitHandlers.get(method)
      ?? taskHandlers[method]
    if (handler === undefined) return fail('no-route', `unknown workbench method ${method}`)
    return handler(payload)
  }

  function envelopeValue<T>(value: T): WorkbenchRouteEnvelope<T> {
    return { ok: true, value }
  }

  const apiRoute: WebRoute = {
    kind: 'prefix',
    // Webserver contract: no trailing slash — `prefix` p matches p and
    // p/<anything>. Deep paths like `/workbench/api/fs/list` route here and
    // the handler strips the `<prefix>/api/` remainder below.
    path: `${PREFIX}/api`,
    handler: async (req, res) => {
      if (!isTrustedRequestHost(req.headers, trustedHosts)) {
        respondJson(res, 403, fail('untrusted-host', 'host header failed the trust fence'))
        return
      }
      const url = new URL(req.url ?? '/', 'http://workbench.invalid')
      const method = decodeURIComponent(url.pathname.slice(`${PREFIX}/api/`.length))
      let payload: unknown = {}
      try {
        if (req.method === 'POST') {
          const body = await readBody(req, bodyCap)
          payload = body.byteLength === 0 ? {} : JSON.parse(body.toString('utf8'))
        } else {
          const raw = url.searchParams.get('payload')
          payload = raw === null ? {} : JSON.parse(raw)
        }
      } catch (cause) {
        const message = cause instanceof Error && cause.message === 'body-too-large'
          ? 'request body exceeds the configured cap'
          : 'request body is not valid JSON'
        const code = cause instanceof Error && cause.message === 'body-too-large' ? 'too-large' : 'bad-request'
        respondJson(res, 200, fail(code, message))
        return
      }
      try {
        respondJson(res, 200, await dispatch(method, payload))
      } catch (cause) {
        // A handler throwing instead of enveloping is a bug; keep the
        // process alive and report it loudly to the caller.
        respondJson(res, 200, fail('handler-crash', cause instanceof Error ? cause.message : String(cause)))
      }
    },
  }

  const eventsRoute: WebRoute = {
    kind: 'exact',
    path: `${PREFIX}/events`,
    handler: async (req, res) => {
      if (!isTrustedRequestHost(req.headers, trustedHosts)) {
        respondJson(res, 403, fail('untrusted-host', 'host header failed the trust fence'))
        return
      }
      const url = new URL(req.url ?? '/', 'http://workbench.invalid')
      let roots: unknown
      try {
        roots = JSON.parse(url.searchParams.get('roots') ?? '[]')
      } catch {
        roots = null
      }
      if (!Array.isArray(roots)) {
        res.destroy()
        return
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      const unsubscribe = watchers.subscribe((frame) => {
        try {
          res.write(`data: ${JSON.stringify(frame)}\n\n`)
        } catch {
          req.destroy()
        }
      })
      const candidateRoots: string[] = []
      for (const root of roots) {
        if (typeof root !== 'string' || root === '') continue
        const real = await rootCache.rootOf(root)
        if (typeof real !== 'string') continue
        if (!rootAllowed(real)) continue
        candidateRoots.push(real)
      }
      const addDisposer = watchers.addRoots(candidateRoots)
      const heartbeat = setInterval(() => {
        try {
          res.write(': heartbeat\n\n')
        } catch {
          req.destroy()
        }
      }, 25_000)
      if (typeof heartbeat.unref === 'function') heartbeat.unref()
      req.on('close', () => {
        clearInterval(heartbeat)
        unsubscribe()
        addDisposer()
      })
    },
  }

  // Dock SPA face: every `/workbench` path no workbench endpoint claims
  // answers with the composing web frontend's index, so `/workbench` and its
  // deep links land in the SPA that mounts the workbench dock. Index
  // responses follow the frontend-static fallback semantics: browser
  // authentication first (never serving the injected index body unauthenticated),
  // then the webserver's index render (structured injection rows, then raw
  // taps), with relative asset URLs anchored at the site root. Endpoint
  // precedence is untouched: exact routes (`/workbench/events`,
  // `/workbench/file`) win first and longest-prefix-wins keeps
  // `/workbench/api` ahead of this catch-all.
  const spaIndex = internals.resolveSpaIndex()
  const spaRoute: WebRoute | undefined = spaIndex === undefined
    ? undefined
    : {
      kind: 'prefix',
      path: PREFIX,
      handler: async (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405)
          res.end()
          return
        }
        if (!isTrustedRequestHost(req.headers, trustedHosts)) {
          respondJson(res, 403, fail('untrusted-host', 'host header failed the trust fence'))
          return
        }
        if (!ctx.connection.authorizeIndex(req, res)) return
        let html: string
        try {
          html = await readFile(spaIndex, 'utf8')
        } catch {
          // Absent dist index answers 404 like the fallback owner does.
          res.writeHead(404)
          res.end()
          return
        }
        const body = ctx.webServer.renderIndex(html)
          .replace(/<head(?:\s[^>]*)?>/i, open => `${open}<base href="/">`)
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(body)
      },
    }

  ctx.effect(() => ctx.webServer.register(apiRoute), 'workbench: /workbench/api routes')
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${PREFIX}/file`,
    handler: createMediaHandler(rootCache, trustedHosts, rootAllowed),
  }), 'workbench: /workbench/file media route')
  ctx.effect(() => ctx.webServer.register(eventsRoute), 'workbench: /workbench/events sse')
  if (spaRoute !== undefined) {
    ctx.effect(() => ctx.webServer.register(spaRoute), 'workbench: /workbench spa face')
  }
  ctx.effect(() => ctx.webServer.registerUpgrade({
    path: `${PREFIX}/ws/terminal`,
    handler: (req, socket, head) => {
      if (!isTrustedRequestHost(req.headers, trustedHosts)) {
        socket.destroy()
        return
      }
      acceptTerminalSocket(ptyRegistry, req, socket, head)
    },
  }), 'workbench: terminal ws upgrade')
}
