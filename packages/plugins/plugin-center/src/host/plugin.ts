/**
 * Cordis plugin shell for the DSH host.
 *
 * Follows the standard third-party bundle contract: the module exports
 * name/inject/apply; HTTP routes attach through the host webServer service's
 * exact-path registration and are disposed on unload.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { handleApiRequest, INTENT_HEADER, ROUTES, type RouterRequest, type RouterResponse } from './api.js'
import { PLUGIN_NAME, PluginCenterServices } from './services.js'

const MAX_BODY_BYTES = 64 * 1024

export interface RouteRegistrar {
  register(route: {
    kind: string
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

export interface WebContextLike {
  webServer: RouteRegistrar
  effect?(teardown: () => unknown, label?: string): void
  logger?: { info?(message: string): void }
}

export interface HostContextLike {
  inject(dependencies: readonly string[], ready: (webCtx: WebContextLike) => void): void
  logger?: { info?(message: string): void }
}

export const name = PLUGIN_NAME
export const inject: readonly string[] = []

function header(req: IncomingMessage, key: string): string | undefined {
  const value = req.headers[key]
  return Array.isArray(value) ? value[0] : value
}

async function readJsonBody(req: IncomingMessage): Promise<{ ok: false } | { ok: true; body: unknown }> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    size += buf.length
    if (size > MAX_BODY_BYTES) return { ok: false }
    chunks.push(buf)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return { ok: true, body: {} }
  try {
    return { ok: true, body: JSON.parse(text) as unknown }
  } catch {
    return { ok: false }
  }
}

function send(res: ServerResponse, response: RouterResponse): void {
  res.writeHead(response.status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(response.payload))
}

/** Adapt one raw node request into a router request and answer it. */
export async function serveRequest(
  services: PluginCenterServices,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://internal.invalid')
  const query: Record<string, string | undefined> = {}
  url.searchParams.forEach((value, key) => {
    query[key] = value
  })
  const method = req.method === 'POST' ? 'POST' : 'GET'
  const needsBody = method === 'POST'
  const parsed = needsBody ? await readJsonBody(req) : ({ ok: true, body: undefined } as const)
  if (!parsed.ok) {
    // Oversized or malformed body: answer once and cut the socket so a
    // slowloris-style dribble cannot hold the connection open.
    send(res, { status: 413, payload: { error: { code: 'invalid_plan', message: 'body rejected' } } })
    req.destroy()
    return
  }
  const request: RouterRequest = {
    method,
    path: url.pathname,
    query,
    headers: {
      host: header(req, 'host'),
      origin: header(req, 'origin'),
      [INTENT_HEADER]: header(req, INTENT_HEADER),
    },
    body: parsed.body,
  }
  try {
    send(res, await handleApiRequest(services, request))
  } catch {
    // Router handlers never throw; this guards against adapter surprises.
    // Internal details (paths etc.) stay server-side.
    send(res, {
      status: 500,
      payload: { error: { code: 'internal', message: 'internal error' } },
    })
  }
}

/** Cordis apply: wire the plugin center onto a running host. */
export function apply(ctx: HostContextLike, config: Record<string, unknown> = {}): void {
  const services = new PluginCenterServices(config)
  ctx.inject(['webServer'], (webCtx) => {
    const disposers = Object.values(ROUTES).map(path =>
      webCtx.webServer.register({
        kind: 'exact',
        path,
        handler: (req, res) => serveRequest(services, req, res),
      }),
    )
    webCtx.effect?.(() => {
      for (const dispose of disposers.reverse()) dispose()
    }, `${PLUGIN_NAME}: routes`)
    webCtx.logger?.info?.(`${PLUGIN_NAME}: market and lifecycle surface ready`)
  })
}
