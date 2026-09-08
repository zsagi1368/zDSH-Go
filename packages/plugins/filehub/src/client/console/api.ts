/**
 * HTTP client for the M5 FileHub endpoints. Thin fetch wrappers that unwrap
 * the `{ error }` envelope into thrown Errors — components render the message,
 * never inspect status codes.
 */

import type {
  CleanupReportShape,
  LibraryResponse,
  UsageResponse,
} from './model.js'

/** Mirror of the server settings wire shape (src/server/settings.ts). */
export interface ConsoleSettingsShape {
  readonly enabled: boolean
  readonly ignorePastedMentions: boolean
  readonly 'candidates.max': number
  readonly 'console.defaultView': 'grouped' | 'flat'
  readonly 'privacy.localFirstVision': boolean
  readonly 'vision.mode': 'off' | 'caption' | 'analyze'
}

async function fetchJson<T>(input: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(input, init)
  } catch (error: unknown) {
    throw new Error(error instanceof Error ? error.message : String(error))
  }
  const text = await response.text()
  let payload: unknown = undefined
  if (text !== '') {
    try {
      payload = JSON.parse(text)
    } catch {
      // Non-JSON body: fall through to the status check below.
    }
  }
  if (!response.ok) {
    const message =
      payload !== null && typeof payload === 'object' && 'error' in (payload as Record<string, unknown>)
        ? String((payload as Record<string, unknown>).error)
        : `HTTP ${response.status}`
    throw new Error(message)
  }
  return payload as T
}

export async function fetchLibrary(): Promise<LibraryResponse> {
  return fetchJson<LibraryResponse>('/api/filehub/library')
}

export async function fetchUsage(): Promise<UsageResponse> {
  return fetchJson<UsageResponse>('/api/filehub/usage')
}

export async function fetchConsoleSettings(): Promise<ConsoleSettingsShape> {
  return fetchJson<ConsoleSettingsShape>('/api/filehub/settings')
}

export async function putConsoleSettings(patch: Partial<ConsoleSettingsShape>): Promise<ConsoleSettingsShape> {
  return fetchJson<ConsoleSettingsShape>('/api/filehub/settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  })
}

export async function deleteSessionFiles(sessionId: string): Promise<{ sessionId: string; deleted: number; freedBytes: number }> {
  return fetchJson(`/api/filehub/session/${encodeURIComponent(sessionId)}`, { method: 'DELETE' })
}

export async function postCleanup(body: {
  scope: 'expired' | 'session'
  sessionId?: string
  dryRun: boolean
}): Promise<CleanupReportShape> {
  return fetchJson<CleanupReportShape>('/api/filehub/cleanup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}
