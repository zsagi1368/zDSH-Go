/**
 * M5 settings center (P01 §7, FR-E5): the `filehub.*` namespace persisted in
 * its own KV unit with server-owned normalization semantics.
 *
 * Contract:
 * - GET  /api/filehub/settings → the FULL merged view (defaults + stored).
 * - PUT  /api/filehub/settings → a PARTIAL patch. The server validates against
 *   zod (unknown keys stripped = sanitize; invalid values answered 400 BEFORE
 *   any write), merges onto the stored record, persists the sanitized result,
 *   and answers with the merged view. The host owns normalization: clients
 *   never round-trip raw input.
 *
 * Storage mirrors meta.ts's seam discipline: one dedicated KV unit
 * (`filehub_settings`), single-row table, memory fallback when the host
 * exposes no KV facet. dsh-settings/typert is deliberately NOT used — this is
 * a third-party plugin and the settings center is served over FileHub's own
 * HTTP endpoints.
 */

import type { IncomingMessage } from 'node:http'

import { z } from 'zod'

import { sendError, sendJson } from './httpUtil.js'
import type { KvFacetLike } from './meta.js'
import type { HttpHandler } from './upload.js'

// ---------------------------------------------------------------------------
// Schema + defaults (P01 §7.2 table)
// ---------------------------------------------------------------------------

export const FILEHUB_SETTINGS_SCHEMA = z.object({
  /** Master switch: false hides the console entry and degrades every face. */
  enabled: z.boolean(),
  /** Paste governance: do not offer @candidates for pasted paths. */
  ignorePastedMentions: z.boolean(),
  /** Mention picker candidate ceiling. */
  'candidates.max': z.number().int().min(1).max(200),
  /** Console initial grouping. */
  'console.defaultView': z.enum(['grouped', 'flat']),
  /** Privacy: show local caption-first placeholder before any outbound vision call. */
  'privacy.localFirstVision': z.boolean(),
  /** Vision waterfall posture. */
  'vision.mode': z.enum(['off', 'caption', 'analyze']),
})
export type FileHubSettings = z.infer<typeof FILEHUB_SETTINGS_SCHEMA>
/** Patch shape with explicitly-optional keys (zod output carries | undefined). */
export type FileHubSettingsPatch = { [K in keyof FileHubSettings]?: FileHubSettings[K] | undefined }

export const FILEHUB_SETTINGS_DEFAULTS: Readonly<FileHubSettings> = Object.freeze({
  enabled: true,
  ignorePastedMentions: false,
  'candidates.max': 20,
  'console.defaultView': 'grouped',
  'privacy.localFirstVision': true,
  'vision.mode': 'caption',
})

const PATCH_SCHEMA = FILEHUB_SETTINGS_SCHEMA.partial()

/**
 * Server-side normalization: keep only known keys, drop undefined values.
 * Values are NOT validated here — validation is the caller's (HTTP layer)
 * job; pure functions stay pure.
 */
export function sanitizeSettingsPatch(input: unknown): FileHubSettingsPatch {
  const patch: Record<string, unknown> = {}
  if (input === null || typeof input !== 'object') return patch
  for (const key of Object.keys(FILEHUB_SETTINGS_DEFAULTS)) {
    const value = (input as Record<string, unknown>)[key]
    if (value !== undefined) patch[key] = value
  }
  return patch
}

/** Merge a validated patch onto a base record into a complete settings view. */
export function mergeSettings(base: FileHubSettings, patch: FileHubSettingsPatch): FileHubSettings {
  return {
    enabled: patch.enabled ?? base.enabled,
    ignorePastedMentions: patch.ignorePastedMentions ?? base.ignorePastedMentions,
    'candidates.max': patch['candidates.max'] ?? base['candidates.max'],
    'console.defaultView': patch['console.defaultView'] ?? base['console.defaultView'],
    'privacy.localFirstVision': patch['privacy.localFirstVision'] ?? base['privacy.localFirstVision'],
    'vision.mode': patch['vision.mode'] ?? base['vision.mode'],
  }
}

// ---------------------------------------------------------------------------
// Persistence store
// ---------------------------------------------------------------------------

const SETTINGS_UNIT = 'filehub_settings'
const SETTINGS_TABLE = 'values'
const SETTINGS_KEY = 'filehub'

export interface SettingsStore {
  load(): Promise<FileHubSettingsPatch>
  save(value: FileHubSettingsPatch): Promise<void>
}

export function createMemorySettingsStore(): SettingsStore {
  let stored: FileHubSettingsPatch = {}
  return {
    load() {
      return Promise.resolve({ ...stored })
    },
    save(value) {
      stored = { ...value }
      return Promise.resolve()
    },
  }
}

class KvSettingsStore implements SettingsStore {
  private unitPromise: Promise<import('./meta.js').KvUnitLike> | undefined

  constructor(private readonly kv: KvFacetLike) {}

  private openUnit(): Promise<import('./meta.js').KvUnitLike> {
    if (!this.unitPromise) {
      this.unitPromise = this.kv.open({
        name: SETTINGS_UNIT,
        version: 1,
        tables: [SETTINGS_TABLE],
        hasGlobal: false,
      })
    }
    return this.unitPromise
  }

  async load(): Promise<FileHubSettingsPatch> {
    const unit = await this.openUnit()
    const snapshot = await unit.loadAll()
    const raw = (snapshot.tables[SETTINGS_TABLE] ?? {})[SETTINGS_KEY]
    return typeof raw === 'object' && raw !== null ? { ...(raw as FileHubSettingsPatch) } : {}
  }

  async save(value: FileHubSettingsPatch): Promise<void> {
    const unit = await this.openUnit()
    await unit.putRecord(SETTINGS_TABLE, SETTINGS_KEY, value)
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
      // Vanished registry entry; keep scanning.
    }
  }
  return undefined
}

export interface SettingsServiceDeps {
  storage?: unknown
  logWarn(message: string): void
}

export interface SettingsService {
  get(): Promise<FileHubSettings>
  put(patch: FileHubSettingsPatch): Promise<FileHubSettings>
  reset(): Promise<FileHubSettings>
}

export function createSettingsService(deps: SettingsServiceDeps): SettingsService {
  const kv = pickKvFacet(deps.storage)
  if (!kv) {
    deps.logWarn('[filehub] settings store falling back to memory (no KV facet)')
  }
  const store: SettingsStore = kv ? new KvSettingsStore(kv) : createMemorySettingsStore()

  async function readStored(): Promise<FileHubSettingsPatch> {
    try {
      return await store.load()
    } catch (error: unknown) {
      deps.logWarn(`[filehub] settings load failed, serving defaults: ${String(error)}`)
      return {}
    }
  }

  return {
    async get() {
      return mergeSettings(FILEHUB_SETTINGS_DEFAULTS, sanitizeSettingsPatch(await readStored()))
    },
    async put(patch) {
      const parsed = PATCH_SCHEMA.safeParse(patch)
      if (!parsed.success) {
        throw new SettingsValidationError(
          parsed.error.issues.map(issue => `${issue.path.join('.') || 'body'}: ${issue.message}`).join('; '),
        )
      }
      const current = mergeSettings(FILEHUB_SETTINGS_DEFAULTS, sanitizeSettingsPatch(await readStored()))
      const next = mergeSettings(current, parsed.data)
      await store.save(sanitizeSettingsPatch(next))
      return next
    },
    async reset() {
      await store.save({})
      return { ...FILEHUB_SETTINGS_DEFAULTS }
    },
  }
}

/** Thrown by put() on schema violations; the HTTP layer maps it to 400. */
export class SettingsValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SettingsValidationError'
  }
}

// ---------------------------------------------------------------------------
// HTTP handlers
// ---------------------------------------------------------------------------

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Array<Buffer> = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const text = Buffer.concat(chunks).toString('utf8')
  return text === '' ? {} : JSON.parse(text)
}

/** GET /api/filehub/settings */
export function createSettingsGetHandler(deps: { service: SettingsService }): HttpHandler {
  return async function handleSettingsGet(req, res) {
    if (req.method !== 'GET') {
      sendError(res, 405, 'method not allowed')
      return
    }
    sendJson(res, 200, await deps.service.get())
  }
}

/** PUT /api/filehub/settings — partial patch; invalid values answer 400. */
export function createSettingsPutHandler(deps: { service: SettingsService }): HttpHandler {
  return async function handleSettingsPut(req, res) {
    if (req.method !== 'PUT') {
      sendError(res, 405, 'method not allowed')
      return
    }
    let body: unknown
    try {
      body = await readJsonBody(req)
    } catch {
      sendError(res, 400, 'malformed JSON body')
      return
    }
    try {
      const next = await deps.service.put(sanitizeSettingsPatch(body))
      sendJson(res, 200, next)
    } catch (error: unknown) {
      if (error instanceof SettingsValidationError) {
        sendError(res, 400, `invalid settings: ${error.message}`)
        return
      }
      throw error
    }
  }
}
