/**
 * Framework-agnostic upload queue for the M1 upload domain (P01 §6-A
 * FR-A1/A5/A6). Zero DOM dependency: the only browser surface is the default
 * XHR transport, which callers may replace via `options.transport` (tests do).
 *
 * State machine per item:  pending → uploading → done
 *                                ↘ cancelled (abort by user)
 *                          pending/error/cancelled → uploading (retry)
 * Error items carry a stable `code` plus a `retryable` hint; the human text
 * mapping is bilingual (`UPLOAD_ERROR_MESSAGES` + `formatUploadError`).
 */

import { basename, normalizeRelativePath } from '../util.js'
import type { Lang } from '../util.js'

/** Wire response of POST /api/filehub/upload (mirrors contract.UploadResultSchema). */
export interface UploadedFileResult {
  readonly path: string
  readonly relativePath: string
  readonly sniffedType: string
  readonly label: string
  /** M6 caption passthrough (defensive): present only when the vision waterfall produced one. */
  readonly imageCaption?: string
}

export type UploadItemStatus = 'pending' | 'uploading' | 'done' | 'error' | 'cancelled'

export type UploadErrorCode =
  /** Server 403: session id not known to the host. */
  | 'sessionUnknown'
  /** Client-side: no current session resolved at dispatch time. */
  | 'sessionMissing'
  /** Server 413: file exceeds the configured size limit. */
  | 'tooLarge'
  /** Server 415: extension on the dangerous list. */
  | 'dangerousExtension'
  /** Server 429: server concurrency gate full. */
  | 'concurrencyFull'
  /** Server 507: per-session quota exhausted. */
  | 'quotaExhausted'
  /** Other 5xx from the upload endpoint. */
  | 'serverError'
  /** Other non-ok status (4xx and stray codes). */
  | 'badResponse'
  /** 2xx but the body was not a usable upload result. */
  | 'invalidResponse'
  /** Transport-level failure (offline, CORS, reset). */
  | 'network'

export interface UploadItemError {
  readonly httpStatus?: number
  readonly code: UploadErrorCode
  /** UI affordance hint; retry() itself stays user-authority. */
  readonly retryable: boolean
}

/** One row in the queue snapshot. Treated as immutable by consumers. */
export interface UploadQueueItem {
  readonly id: string
  /** Display name: basename of the relative path, else the File's own name. */
  readonly name: string
  /** Normalized forward-slash path carried in x-file-relpath ('' = plain file). */
  readonly relativePath: string
  readonly sizeBytes: number
  readonly status: UploadItemStatus
  /** Bytes confirmed sent so far (xhr upload.onprogress authority). */
  readonly sentBytes: number
  readonly result?: UploadedFileResult | undefined
  readonly error?: UploadItemError | undefined
}

/** Input accepted by enqueue(): a raw File/Blob plus optional folder-relative path. */
export interface EnqueueInput {
  readonly file: File | Blob
  readonly relativePath?: string | undefined
}

/** Request handed to a transport. The queue owns headers/URL; transport owns IO. */
export interface OutgoingUploadRequest {
  readonly url: string
  readonly body: Blob
  readonly headers: Readonly<Record<string, string>>
  onProgress: (loadedBytes: number) => void
  readonly signal: AbortSignal
}

export type UploadTransport = (request: OutgoingUploadRequest) => Promise<UploadedFileResult>

export class UploadHttpError extends Error {
  constructor(readonly status: number, message?: string) {
    super(message ?? `upload failed with HTTP ${status}`)
    this.name = 'UploadHttpError'
  }
}

export class UploadResponseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UploadResponseError'
  }
}

export function makeAbortError(): Error {
  const error = new Error('upload aborted')
  error.name = 'AbortError'
  return error
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

/**
 * Structural guard over the wire payload. Hand-rolled instead of importing the
 * zod schema so the client bundle stays free of zod; the schema remains the
 * single source of truth on the host half. Exported for direct adversarial
 * testing (the default XHR transport funnels every 2xx body through here).
 */
export function parseUploadResult(status: number, text: string): UploadedFileResult {
  if (status < 200 || status > 299) throw new UploadHttpError(status, text.slice(0, 300))
  let value: unknown
  try {
    value = JSON.parse(text) as unknown
  } catch {
    throw new UploadResponseError('upload endpoint returned non-JSON body')
  }
  if (
    typeof value !== 'object' ||
    value === null ||
    typeof (value as Record<string, unknown>).path !== 'string' ||
    typeof (value as Record<string, unknown>).relativePath !== 'string' ||
    typeof (value as Record<string, unknown>).sniffedType !== 'string' ||
    typeof (value as Record<string, unknown>).label !== 'string'
  ) {
    throw new UploadResponseError('upload endpoint returned an unexpected body shape')
  }
  const record = value as Record<string, unknown>
  if (
    typeof record.path !== 'string' ||
    typeof record.relativePath !== 'string' ||
    typeof record.sniffedType !== 'string' ||
    typeof record.label !== 'string'
  ) {
    throw new UploadResponseError('upload endpoint returned an unexpected body shape')
  }
  return {
    path: record.path,
    relativePath: record.relativePath,
    sniffedType: record.sniffedType,
    label: record.label,
    // M6 caption passthrough (defensive optional): forwarded only when the
    // server attached a non-empty caption; never fabricated client-side.
    ...(typeof record.imageCaption === 'string' && record.imageCaption.length > 0
      ? { imageCaption: record.imageCaption }
      : {}),
  }
}

/** Map an HTTP status onto the stable error code + retryable hint. */
export function classifyUploadFailure(status: number): UploadItemError {
  switch (status) {
    case 403:
      return { httpStatus: status, code: 'sessionUnknown', retryable: false }
    case 413:
      return { httpStatus: status, code: 'tooLarge', retryable: false }
    case 415:
      return { httpStatus: status, code: 'dangerousExtension', retryable: false }
    case 429:
      return { httpStatus: status, code: 'concurrencyFull', retryable: true }
    case 507:
      return { httpStatus: status, code: 'quotaExhausted', retryable: true }
    default:
      if (status >= 500) return { httpStatus: status, code: 'serverError', retryable: true }
      return { httpStatus: status, code: 'badResponse', retryable: false }
  }
}

/** Bilingual copy for every error code ("错误码→人话映射，双语键"). */
export const UPLOAD_ERROR_MESSAGES: Readonly<Record<UploadErrorCode, { en: string; zh: string }>> = {
  sessionUnknown: { en: 'Session expired or unknown; reopen the conversation.', zh: '会话未知或已失效，请重新打开会话。' },
  sessionMissing: { en: 'No active session yet — open a conversation first.', zh: '会话未就绪——请先打开一个会话。' },
  tooLarge: { en: 'File exceeds the size limit.', zh: '文件超过大小上限。' },
  dangerousExtension: { en: 'This file type is blocked for safety.', zh: '该扩展名被安全策略拒绝。' },
  concurrencyFull: { en: 'Server busy; retry in a moment.', zh: '服务端并发已满，请稍后重试。' },
  quotaExhausted: { en: 'Session storage quota is full; remove some files and retry.', zh: '会话配额已满，请删除部分文件后重试。' },
  serverError: { en: 'Server error; you can retry.', zh: '服务端错误，可重试。' },
  badResponse: { en: 'Upload rejected by server.', zh: '上传被服务端拒绝。' },
  invalidResponse: { en: 'Upload endpoint returned malformed data.', zh: '上传接口返回数据异常。' },
  network: { en: 'Network error; check connection and retry.', zh: '网络错误，请检查连接后重试。' },
}

export function formatUploadError(error: UploadItemError | undefined, lang: Lang): string {
  if (!error) return ''
  return UPLOAD_ERROR_MESSAGES[error.code][lang]
}

/** Default transport: XHR because fetch has no upload progress events (FR-A6). */
export function createXhrTransport(): UploadTransport {
  return request =>
    new Promise<UploadedFileResult>((resolve, reject) => {
      if (typeof XMLHttpRequest === 'undefined') {
        reject(new Error('XMLHttpRequest is not available in this environment'))
        return
      }
      const xhr = new XMLHttpRequest()
      const onAbort = () =>{  xhr.abort() }
      request.signal.addEventListener('abort', onAbort, { once: true })
      const cleanup = () =>{  request.signal.removeEventListener('abort', onAbort) }
      xhr.open('POST', request.url)
      for (const [name, value] of Object.entries(request.headers)) xhr.setRequestHeader(name, value)
      xhr.upload.onprogress = (event: ProgressEvent) => {
        request.onProgress(event.loaded)
      }
      xhr.onload = () => {
        cleanup()
        try {
          resolve(parseUploadResult(xhr.status, typeof xhr.responseText === 'string' ? xhr.responseText : ''))
        } catch (cause) {
          reject(cause instanceof Error ? cause : new Error(String(cause)))
        }
      }
      xhr.onerror = () => {
        cleanup()
        reject(new Error('network failure during upload'))
      }
      xhr.onabort = () => {
        cleanup()
        reject(makeAbortError())
      }
      xhr.send(request.body)
    })
}

export interface UploadQueueOptions {
  /** Absolute-path-on-origin endpoint. Default '/api/filehub/upload'. */
  uploadUrl?: string | undefined
  /** Simultaneous in-flight uploads. Default 4 (mirrors the server gate). */
  concurrency?: number | undefined
  /**
   * Session resolver consulted at DISPATCH time (not enqueue time). Returning
   * null fails items loudly with code 'sessionMissing' — never silently.
   */
  sessionId?: (() => string | null) | undefined
  /** Replace the XHR transport (tests inject fakes here). */
  transport?: UploadTransport | undefined
}

const DEFAULT_UPLOAD_URL = '/api/filehub/upload'
const DEFAULT_CONCURRENCY = 4

/**
 * The one upload queue behind all three entry points (P01 §8 UX-1: 三处入口一个队列).
 * Subscribe/getItems follow the observable-store shape so React components can
 * bind through useSyncExternalStore without any adapter.
 */
export class UploadQueue {
  private items: UploadQueueItem[] = []
  private listeners = new Set<() => void>()
  private controllers = new Map<string, AbortController>()
  /** Payload storage keyed by item id (kept out of the immutable snapshot). */
  private blobs = new Map<string, File | Blob>()
  private activeCount = 0
  private nextId = 1

  private readonly uploadUrl: string
  private readonly concurrency: number
  private readonly resolveSessionId: () => string | null
  private readonly transport: UploadTransport

  constructor(options: UploadQueueOptions = {}) {
    this.uploadUrl = options.uploadUrl ?? DEFAULT_UPLOAD_URL
    this.concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY)
    this.resolveSessionId = options.sessionId ?? (() => null)
    this.transport = options.transport ?? createXhrTransport()
  }

  /** Stable snapshot reference between mutations (useSyncExternalStore-safe). */
  getItems(): readonly UploadQueueItem[] {
    return this.items
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Aggregate counters for dock headers. */
  stats(): { total: number; uploading: number; pending: number; done: number; errored: number } {
    const stats = { total: this.items.length, uploading: 0, pending: 0, done: 0, errored: 0 }
    for (const item of this.items) {
      if (item.status === 'uploading') stats.uploading += 1
      else if (item.status === 'pending') stats.pending += 1
      else if (item.status === 'done') stats.done += 1
      else if (item.status === 'error') stats.errored += 1
    }
    return stats
  }

  enqueue(inputs: readonly EnqueueInput[]): UploadQueueItem[] {
    const added: UploadQueueItem[] = []
    for (const input of inputs) {
      const relativePath = normalizeRelativePath(input.relativePath ?? '')
      const fallbackName = 'name' in input.file && typeof input.file.name === 'string' ? input.file.name : 'blob'
      const name = basename(relativePath) || basename(fallbackName) || fallbackName || 'blob'
      const item: UploadQueueItem = {
        id: `up-${this.nextId++}`,
        name,
        relativePath,
        sizeBytes: Math.max(0, input.file.size),
        status: 'pending',
        sentBytes: 0,
        result: undefined,
        error: undefined,
      }
      added.push(item)
    }
    if (added.length === 0) return []
    for (let index = 0; index < added.length; index += 1) {
      const item = added[index]
      const input = inputs[index]
      if (item === undefined || input === undefined) continue
      this.blobs.set(item.id, input.file)
    }
    this.items = [...this.items, ...added]
    this.emit()
    this.pump()
    return added
  }

  /** Re-dispatch a failed/cancelled item. Returns false when not retryable-state. */
  retry(id: string): boolean {
    const item = this.items.find(candidate => candidate.id === id)
    if (!item || (item.status !== 'error' && item.status !== 'cancelled')) return false
    this.patch(id, { status: 'pending', sentBytes: 0, error: undefined })
    this.emit()
    this.pump()
    return true
  }

  /** Abort an in-flight item but keep its row (state 'cancelled'). */
  cancel(id: string): boolean {
    const item = this.items.find(candidate => candidate.id === id)
    if (!item || item.status !== 'uploading') return false
    this.controllers.get(id)?.abort()
    return true
  }

  /** Abort (if needed) and drop the row entirely. */
  remove(id: string): boolean {
    const index = this.items.findIndex(candidate => candidate.id === id)
    if (index < 0) return false
    const item = this.items[index]
    if (item !== undefined && item.status === 'uploading') {
      this.controllers.get(id)?.abort()
      this.controllers.delete(id)
    }
    this.blobs.delete(id)
    this.items = this.items.filter(candidate => candidate.id !== id)
    this.emit()
    return true
  }

  /** Abort everything and empty the queue (the dock's clear-all). */
  clear(): void {
    for (const controller of this.controllers.values()) controller.abort()
    this.controllers.clear()
    this.blobs.clear()
    this.activeCount = 0
    if (this.items.length === 0) return
    this.items = []
    this.emit()
  }

  private patch(id: string, patch: Partial<Omit<UploadQueueItem, 'id'>>): void {
    const index = this.items.findIndex(candidate => candidate.id === id)
    if (index < 0) return
    const next = [...this.items]
    const current = next[index]
    if (current === undefined) return
    next[index] = { ...current, ...patch }
    // Progress events mutate frequently; keep identity stable when nothing changed.
    this.items = next
    this.emit()
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }

  /** Dispatch pending items while below the concurrency ceiling. Reentrant-safe. */
  private pump(): void {
    while (this.activeCount < this.concurrency) {
      const next = this.items.find(item => item.status === 'pending')
      if (!next) return
      this.start(next)
    }
  }

  private start(item: UploadQueueItem): void {
    const sessionId = this.resolveSessionId() ?? null
    const normalizedSession = sessionId !== null && sessionId.trim() !== '' ? sessionId : null
    if (normalizedSession === null) {
      // Fail LOUD: the item surfaces "会话未就绪" in the dock instead of vanishing.
      this.patch(item.id, {
        status: 'error',
        error: { code: 'sessionMissing', retryable: true },
      })
      return
    }
    const controller = new AbortController()
    this.controllers.set(item.id, controller)
    this.activeCount += 1
    this.patch(item.id, { status: 'uploading', sentBytes: 0, error: undefined })

    // A retried item re-reads its stored blob; a missing entry (should not
    // happen outside clear()) fails loud instead of sending undefined.
    const blob = this.blobs.get(item.id)
    if (!blob) {
      this.controllers.delete(item.id)
      this.activeCount -= 1
      this.patch(item.id, {
        status: 'error',
        error: { code: 'invalidResponse', retryable: false },
      })
      return
    }
    const fileType = typeof blob.type === 'string' && blob.type !== '' ? blob.type : ''
    const contentType = fileType !== '' ? fileType : 'application/octet-stream'
    const request: OutgoingUploadRequest = {
      url: this.uploadUrl,
      body: blob,
      headers: {
        'x-file-name': encodeURIComponent(item.name),
        'x-file-relpath': encodeURIComponent(item.relativePath),
        'x-session-id': normalizedSession,
        'content-type': contentType,
      },
      onProgress: (loaded) => {
        if (controller.signal.aborted) return
        this.patch(item.id, { sentBytes: loaded })
      },
      signal: controller.signal,
    }

    this.transport(request)
      .then((result) => {
        if (controller.signal.aborted) return
        this.patch(item.id, {
          status: 'done',
          sentBytes: item.sizeBytes,
          result,
          error: undefined,
        })
      })
      .catch((cause: unknown) => {
        if (isAbort(cause) || controller.signal.aborted) {
          this.patchIfUploading(item.id, { status: 'cancelled', error: undefined })
          return
        }
        const error =
          cause instanceof UploadHttpError
            ? classifyUploadFailure(cause.status)
            : cause instanceof UploadResponseError
              ? ({ code: 'invalidResponse', retryable: false } satisfies UploadItemError)
              : ({ code: 'network', retryable: true } satisfies UploadItemError)
        this.patchIfUploading(item.id, { status: 'error', error })
      })
      .finally(() => {
        this.controllers.delete(item.id)
        this.activeCount -= 1
        this.pump()
      })
  }

  /** Patch that ignores late arrivals after remove()/clear(). */
  private patchIfUploading(id: string, patch: Partial<Omit<UploadQueueItem, 'id'>>): void {
    const item = this.items.find(candidate => candidate.id === id)
    if (!item || item.status !== 'uploading') return
    this.patch(id, patch)
  }
}
