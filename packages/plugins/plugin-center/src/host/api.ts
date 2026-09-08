/**
 * Framework-free HTTP surface for the plugin center.
 *
 * The router is pure: it maps (method, path, headers, body) to JSON responses
 * so the whole API is testable without a socket. `attachRoutes` adapts it to
 * the DSH host webserver's plugin route registration contract at runtime.
 */
import { open, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { PluginCenterServices } from './services.js'
import { PLUGIN_NAME, resolveDataRoot } from './services.js'

export const API_PREFIX = ['/api2', PLUGIN_NAME].join('/')

export const ROUTES = {
  market: [API_PREFIX, 'market'].join('/'),
  entry: [API_PREFIX, 'entry'].join('/'),
  stagePlan: [API_PREFIX, 'plan/stage'].join('/'),
  applyPlan: [API_PREFIX, 'plan/apply'].join('/'),
  audit: [API_PREFIX, 'audit'].join('/'),
  runtime: [API_PREFIX, 'runtime'].join('/'),
  guardianStatus: [API_PREFIX, 'guardian/status'].join('/'),
  guardianToggle: [API_PREFIX, 'guardian/toggle'].join('/'),
  backups: [API_PREFIX, 'backups'].join('/'),
  backupRestore: [API_PREFIX, 'backups/restore'].join('/'),
  backupRestoreApply: [API_PREFIX, 'backups/restore/apply'].join('/'),
  restartRequest: [API_PREFIX, 'restart/request'].join('/'),
} as const

const WRITE_PATHS: ReadonlySet<string> = new Set([
  ROUTES.stagePlan,
  ROUTES.applyPlan,
  ROUTES.guardianToggle,
  ROUTES.backupRestore,
  ROUTES.backupRestoreApply,
  ROUTES.restartRequest,
])

export const INTENT_HEADER = 'x-zdsh-pc-intent'

export interface RouterRequest {
  method: 'GET' | 'POST'
  path: string
  query?: Record<string, string | undefined>
  headers?: Record<string, string | undefined>
  body?: unknown
}

export interface RouterResponse {
  status: number
  payload: unknown
}

interface StageBody {
  action?: string
  entryId?: string
}

interface ApplyBody {
  planId?: string
  phrase?: string
}

function json(status: number, payload: unknown): RouterResponse {
  return { status, payload: payload === undefined ? null : payload }
}

function fromCp(result: { ok: boolean; data?: unknown; error?: { code: string; message: string } }): RouterResponse {
  if (result.ok) return json(200, result.data)
  return json(statusFor(result.error?.code ?? 'internal'), { error: result.error })
}

function statusFor(code: string): number {
  switch (code) {
    case 'invalid_plan':
    case 'confirmation_mismatch':
    case 'unsafe_url':
      return 400
    case 'plan_not_found':
      return 404
    case 'plan_consumed':
    case 'hash_mismatch':
      return 409
    case 'script_blocked':
    case 'untrusted_source':
      return 422
    case 'source_unreachable':
    case 'offline_degraded':
      return 503
    default:
      return 500
  }
}

const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(['127.0.0.1', '::1', '[::1]'])

/**
 * The API is local-first: the Host header must name a loopback literal.
 * This closes the DNS-rebinding hole where an attacker page and this server
 * would otherwise agree on a rebindable hostname for both Origin and Host.
 */
function hostGateOk(headers: Record<string, string | undefined>): boolean {
  const host = headers.host
  if (!host) return false
  const hostname = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0] ?? ''
  const bare = hostname.toLowerCase()
  if (!LOOPBACK_HOSTNAMES.has(bare)) return false
  const origin = headers.origin
  if (!origin) return true // same-origin GETs may omit Origin
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

function matches(request: RouterRequest, method: 'GET' | 'POST', path: string): boolean {
  return request.method === method && request.path === path
}

/** Handle one API request. Never throws — every outcome is a JSON response. */
export async function handleApiRequest(
  services: PluginCenterServices,
  request: RouterRequest,
): Promise<RouterResponse> {
  if (!Object.values(ROUTES).includes(request.path)) {
    return json(404, { error: { code: 'not_found', message: 'unknown path' } })
  }
  if (!hostGateOk(request.headers ?? {})) {
    return json(403, { error: { code: 'cross_origin_denied', message: 'cross-origin denied' } })
  }
  if (WRITE_PATHS.has(request.path)) {
    if (!services.config.mutationsEnabled) {
      return json(403, { error: { code: 'mutations_disabled', message: 'read-only mode' } })
    }
    if (request.method !== 'POST') {
      return json(405, { error: { code: 'method_not_allowed', message: 'writes require POST' } })
    }
    if (request.headers?.[INTENT_HEADER] !== PLUGIN_NAME) {
      return json(403, { error: { code: 'intent_missing', message: 'missing intent header' } })
    }
  }

  if (matches(request, 'GET', ROUTES.market)) {
    const q = request.query ?? {}
    return fromCp(
      await services.marketPage({
        page: toInt(q.page),
        pageSize: toInt(q.pageSize),
        q: q.q,
        category: q.category,
        onlyRecommended: q.onlyRecommended === '1',
      }),
    )
  }
  if (matches(request, 'GET', ROUTES.entry)) {
    return fromCp(await services.entryById(request.query?.id ?? ''))
  }
  if (matches(request, 'GET', ROUTES.runtime)) {
    return json(200, services.runtime)
  }
  if (matches(request, 'GET', ROUTES.guardianStatus)) {
    return json(200, services.guardianStatus())
  }
  if (matches(request, 'GET', ROUTES.backups)) {
    return json(200, services.backupsList())
  }
  if (matches(request, 'POST', ROUTES.guardianToggle)) {
    const body = (request.body ?? {}) as { action?: string }
    if (body.action !== 'start' && body.action !== 'stop') {
      return json(400, {
        error: { code: 'invalid_plan', message: 'action must be start|stop' },
      })
    }
    return fromCp(await services.guardianToggle(body.action))
  }
  if (matches(request, 'POST', ROUTES.backupRestore)) {
    // Two-phase: staging returns a one-shot id/code pair; the apply route
    // consumes it. Parity with the install plan confirmation flow.
    const body = (request.body ?? {}) as { name?: string }
    if (!body.name) {
      return json(400, { error: { code: 'invalid_plan', message: 'name is required' } })
    }
    return fromCp(services.stageRestore(body.name))
  }
  if (matches(request, 'POST', ROUTES.backupRestoreApply)) {
    const body = (request.body ?? {}) as { restoreId?: string; code?: string }
    if (!body.restoreId || !body.code) {
      return json(400, {
        error: { code: 'invalid_plan', message: 'restoreId and code are required' },
      })
    }
    return fromCp(services.applyRestore(body.restoreId, body.code))
  }
  if (matches(request, 'GET', ROUTES.audit)) {
    return json(200, await readAuditTail(resolveDataRoot(services.config)))
  }
  if (matches(request, 'POST', ROUTES.stagePlan)) {
    const body = (request.body ?? {}) as StageBody
    if (!isPlanAction(body.action)) {
      return json(400, {
        error: { code: 'invalid_plan', message: 'action must be install|update|uninstall' },
      })
    }
    if (!body.entryId) {
      return json(400, { error: { code: 'invalid_plan', message: 'entryId is required' } })
    }
    return fromCp(await services.stagePlan(body.action, body.entryId))
  }
  if (matches(request, 'POST', ROUTES.applyPlan)) {
    const body = (request.body ?? {}) as ApplyBody
    if (!body.planId || !body.phrase) {
      return json(400, {
        error: { code: 'invalid_plan', message: 'planId and phrase are required' },
      })
    }
    return fromCp(await services.confirmAndRun(body.planId, body.phrase))
  }
  if (matches(request, 'POST', ROUTES.restartRequest)) {
    // Guardian wiring lands later in M2; stay honest until then.
    return json(501, {
      error: { code: 'not_implemented', message: 'guardian wiring lands later in M2' },
    })
  }
  return json(404, { error: { code: 'not_found', message: 'no handler for this route' } })
}

function isPlanAction(value: unknown): value is 'install' | 'update' | 'uninstall' {
  return value === 'install' || value === 'update' || value === 'uninstall'
}

function toInt(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === '') return undefined
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) ? n : undefined
}

/** Read at most the trailing 128 KiB of the audit log — never the whole file. */
async function readAuditTail(dataRoot: string, maxLines = 200): Promise<unknown[]> {
  const logPath = join(dataRoot, 'audit-log.jsonl')
  let raw = ''
  let truncated = false
  try {
    const stats = await stat(logPath)
    const start = Math.max(0, stats.size - 128 * 1024)
    truncated = start > 0
    const handle = await open(logPath, 'r')
    try {
      const length = Math.min(stats.size - start, 128 * 1024)
      const buffer = Buffer.alloc(length)
      await handle.read(buffer, 0, length, start)
      raw = buffer.toString('utf8')
    } finally {
      await handle.close()
    }
  } catch {
    return []
  }
  // Drop a possibly truncated first line when we started mid-file.
  const lines = raw.split('\n').filter(line => line.trim() !== '')
  if (truncated && lines.length > 0) lines.shift()
  const parsed: unknown[] = []
  for (const line of lines.slice(-maxLines)) {
    try {
      parsed.push(JSON.parse(line) as unknown)
    } catch {
      parsed.push({ parseError: true })
    }
  }
  return parsed
}
