// @vitest-environment jsdom
/**
 * UploadQueue state machine unit tests (FR-A6). All IO goes through an
 * injected transport; the XHR default transport gets its own suite against a
 * stubbed global XMLHttpRequest.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  UploadHttpError,
  UploadQueue,
  UploadResponseError,
  UPLOAD_ERROR_MESSAGES,
  classifyUploadFailure,
  createXhrTransport,
  formatUploadError,
  makeAbortError,
} from '../../src/client/upload/queue.js'
import type { OutgoingUploadRequest, UploadedFileResult, UploadTransport } from '../../src/client/upload/queue.js'

const RESULT: UploadedFileResult = {
  path: '/w/.filehub/s1/a.png',
  relativePath: 'a.png',
  sniffedType: 'image/png',
  label: 'a.png',
}

function makeFile(name: string, size = 10, type = ''): File {
  return new File([new Uint8Array(size)], name, { type })
}

interface ControlledCall {
  request: OutgoingUploadRequest
  resolve: (result: UploadedFileResult) => void
  reject: (cause: unknown) => void
}

function makeTransport(): { calls: ControlledCall[]; transport: UploadTransport } {
  const calls: ControlledCall[] = []
  const transport: UploadTransport = request =>
    new Promise<UploadedFileResult>((resolve, reject) => {
      calls.push({ request, resolve, reject })
    })
  return { calls, transport }
}

/** Drain the promise chain (.then/.finally/pump all settle in microtasks). */
const settle = (): Promise<void> => new Promise<void>(resolve => setTimeout(resolve, 0))

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('UploadQueue dispatch and concurrency', () => {
  it('starts up to `concurrency` uploads and keeps the rest pending', () => {
    const { calls, transport } = makeTransport()
    const queue = new UploadQueue({ sessionId: () => 's1', concurrency: 2, transport })
    const added = queue.enqueue([
      { file: makeFile('a') },
      { file: makeFile('b') },
      { file: makeFile('c') },
      { file: makeFile('d') },
    ])
    expect(added).toHaveLength(4)
    expect(calls).toHaveLength(2)
    const statuses = queue.getItems().map(item => item.status)
    expect(statuses).toEqual(['uploading', 'uploading', 'pending', 'pending'])
    expect(queue.stats()).toEqual({ total: 4, uploading: 2, pending: 2, done: 0, errored: 0 })
  })

  it('dispatches the next pending item after one settles', async () => {
    const { calls, transport } = makeTransport()
    const queue = new UploadQueue({ sessionId: () => 's1', concurrency: 1, transport })
    queue.enqueue([{ file: makeFile('a') }, { file: makeFile('b') }])
    expect(calls).toHaveLength(1)
    calls[0]!.resolve(RESULT)
    await settle()
    expect(queue.getItems()[0]!.status).toBe('done')
    expect(calls).toHaveLength(2)
    expect(queue.getItems()[1]!.status).toBe('uploading')
  })

  it('sends the wire contract: POST url, x-* headers, bare body', async () => {
    const { calls, transport } = makeTransport()
    const queue = new UploadQueue({
      uploadUrl: '/api/filehub/upload',
      sessionId: () => 'session-42',
      transport,
    })
    const body = makeFile('photo.png', 16, 'image/png')
    queue.enqueue([{ file: body }])
    expect(calls).toHaveLength(1)
    const { request } = calls[0]!
    expect(request.url).toBe('/api/filehub/upload')
    expect(request.headers['x-session-id']).toBe('session-42')
    expect(request.headers['x-file-name']).toBe(encodeURIComponent('photo.png'))
    expect(request.headers['x-file-relpath']).toBe(encodeURIComponent(''))
    expect(request.headers['content-type']).toBe('image/png')
    expect(request.body).toBe(body)

    calls[0]!.resolve(RESULT)
    await settle()
    const item = queue.getItems()[0]!
    expect(item.status).toBe('done')
    expect(item.result).toEqual(RESULT)
    expect(item.sentBytes).toBe(16)
  })

  it('derives display name from the relative path and normalizes separators', () => {
    const { calls, transport } = makeTransport()
    const queue = new UploadQueue({ sessionId: () => 's1', transport })
    queue.enqueue([
      { file: makeFile('ignored.txt'), relativePath: 'docs/sub/report.txt' },
      { file: makeFile('win.txt'), relativePath: 'a\\b\\win.txt' },
      { file: makeFile('./dot.txt'), relativePath: './dot.txt' },
      { file: new Blob([new Uint8Array(4)]) },
    ])
    const first = queue.getItems()[0]!
    const second = queue.getItems()[1]!
    const third = queue.getItems()[2]!
    const fourth = queue.getItems()[3]!
    expect(first.name).toBe('report.txt')
    expect(first.relativePath).toBe('docs/sub/report.txt')
    expect(second.relativePath).toBe('a/b/win.txt')
    expect(second.name).toBe('win.txt')
    expect(third.relativePath).toBe('dot.txt')
    expect(fourth.name).toBe('blob')
    expect(fourth.sizeBytes).toBe(4)
    expect(calls[3]!.request.headers['x-file-relpath']).toBe(encodeURIComponent(''))
  })
})

describe('UploadQueue progress callbacks', () => {
  it('updates sentBytes and notifies subscribers on progress events', async () => {
    const { calls, transport } = makeTransport()
    const queue = new UploadQueue({ sessionId: () => 's1', transport })
    queue.enqueue([{ file: makeFile('big.bin', 10) }])
    const versions: number[] = []
    const unsubscribe = queue.subscribe(() => versions.push(queue.getItems()[0]!.sentBytes))
    calls[0]!.request.onProgress(3)
    calls[0]!.request.onProgress(7)
    unsubscribe()
    expect(queue.getItems()[0]!.sentBytes).toBe(7)
    expect(versions).toEqual([3, 7])
    calls[0]!.resolve(RESULT)
    await settle()
    expect(queue.getItems()[0]!.sentBytes).toBe(10)
    // After unsubscribe the late mutation must not notify again.
    expect(versions).toEqual([3, 7])
  })

  it('ignores progress arriving after cancellation', async () => {
    const { calls, transport } = makeTransport()
    const queue = new UploadQueue({ sessionId: () => 's1', transport })
    const item = queue.enqueue([{ file: makeFile('slow.bin') }])[0]!
    calls[0]!.request.signal.addEventListener('abort', () => {})
    queue.cancel(item.id)
    expect(calls[0]!.request.signal.aborted).toBe(true)
    calls[0]!.request.onProgress(9)
    expect(queue.getItems()[0]?.sentBytes ?? -1).toBeLessThan(9)
  })
})

describe('UploadQueue failure mapping', () => {
  interface Case {
    status: number
    code: string
    retryable: boolean
  }
  const cases: Case[] = [
    { status: 403, code: 'sessionUnknown', retryable: false },
    { status: 413, code: 'tooLarge', retryable: false },
    { status: 415, code: 'dangerousExtension', retryable: false },
    { status: 429, code: 'concurrencyFull', retryable: true },
    { status: 507, code: 'quotaExhausted', retryable: true },
    { status: 500, code: 'serverError', retryable: true },
    { status: 400, code: 'badResponse', retryable: false },
  ]

  for (const example of cases) {
    it(`maps HTTP ${example.status} to ${example.code}`, async () => {
      const { calls, transport } = makeTransport()
      const queue = new UploadQueue({ sessionId: () => 's1', transport })
      queue.enqueue([{ file: makeFile('f.bin') }])
      calls[0]!.reject(new UploadHttpError(example.status))
      await settle()
      // Read through getItems(): enqueue returns pre-dispatch snapshots and
      // the queue replaces rows immutably on every patch.
      expect(queue.getItems()[0]!.status).toBe('error')
      expect(queue.getItems()[0]!.error?.code).toBe(example.code)
      expect(queue.getItems()[0]!.error?.httpStatus).toBe(example.status)
      expect(queue.getItems()[0]!.error?.retryable).toBe(example.retryable)
    })
  }

  it('maps malformed 2xx bodies and transport failures distinctly', async () => {
    const { calls, transport } = makeTransport()
    const queue = new UploadQueue({ sessionId: () => 's1', transport })
    queue.enqueue([{ file: makeFile('one') }, { file: makeFile('two') }])
    calls[0]!.reject(new UploadResponseError('bad json'))
    calls[1]!.reject(new Error('socket reset'))
    await settle()
    expect(queue.getItems()[0]!.error?.code).toBe('invalidResponse')
    expect(queue.getItems()[0]!.error?.retryable).toBe(false)
    expect(queue.getItems()[1]!.error?.code).toBe('network')
    expect(queue.getItems()[1]!.error?.retryable).toBe(true)
  })

  it('exposes bilingual human copy for every error code', () => {
    for (const [code, copy] of Object.entries(UPLOAD_ERROR_MESSAGES)) {
      expect(copy.en.length).toBeGreaterThan(0)
      expect(copy.zh.length).toBeGreaterThan(0)
      expect(code.length).toBeGreaterThan(0)
    }
    const error = classifyUploadFailure(507)
    expect(formatUploadError(error, 'zh')).toContain('配额')
    expect(formatUploadError(error, 'en')).toContain('quota')
    expect(formatUploadError(undefined, 'zh')).toBe('')
  })
})

describe('UploadQueue session readiness', () => {
  it('fails items loud with sessionMissing when no session resolves', async () => {
    const { calls, transport } = makeTransport()
    let sessionId: string | null = null
    const queue = new UploadQueue({ sessionId: () => sessionId, transport })
    const item = queue.enqueue([{ file: makeFile('later.bin') }])[0]!
    expect(calls).toHaveLength(0)
    expect(queue.getItems()[0]!.status).toBe('error')
    expect(queue.getItems()[0]!.error?.code).toBe('sessionMissing')
    expect(queue.getItems()[0]!.error?.retryable).toBe(true)

    sessionId = 'later-session'
    expect(queue.retry(item.id)).toBe(true)
    await settle()
    expect(calls).toHaveLength(1)
    expect(calls[0]!.request.headers['x-session-id']).toBe('later-session')
    expect(queue.getItems()[0]!.status).toBe('uploading')
  })
})

describe('UploadQueue cancel / remove / retry / clear', () => {
  it('cancel aborts the signal and parks the row as cancelled', async () => {
    const { calls, transport } = makeTransport()
    const queue = new UploadQueue({ sessionId: () => 's1', transport })
    const item = queue.enqueue([{ file: makeFile('cancel.bin') }])[0]!
    expect(queue.cancel(item.id)).toBe(true)
    expect(calls[0]!.request.signal.aborted).toBe(true)
    calls[0]!.reject(makeAbortError())
    await settle()
    expect(queue.getItems()).toHaveLength(1)
    expect(queue.getItems()[0]!.status).toBe('cancelled')
  })

  it('retries cancelled and errored items; retry is a no-op elsewhere', async () => {
    const { calls, transport } = makeTransport()
    const queue = new UploadQueue({ sessionId: () => 's1', concurrency: 1, transport })
    const [first, second, third] = queue.enqueue([
      { file: makeFile('a') },
      { file: makeFile('b') },
      { file: makeFile('c') },
    ])
    expect(calls).toHaveLength(1)
    calls[0]!.reject(new UploadHttpError(507))
    await settle()
    expect(calls).toHaveLength(2) // second row auto-started
    calls[1]!.resolve(RESULT)
    await settle()
    expect(queue.retry(second!.id)).toBe(false) // done
    expect(queue.retry(third!.id)).toBe(false) // uploading
    expect(queue.retry(first!.id)).toBe(true) // error → pending
    await settle()
    // Concurrency 1: first waits behind the in-flight third row.
    expect(calls).toHaveLength(3)
    expect(queue.getItems()[0]!.status).toBe('pending')
    // Cancel the in-flight third row; its slot frees and the waiting first
    // row takes it immediately.
    expect(queue.cancel(third!.id)).toBe(true)
    expect(calls[2]!.request.signal.aborted).toBe(true)
    calls[2]!.reject(makeAbortError())
    await settle()
    expect(queue.getItems()[2]!.status).toBe('cancelled')
    expect(queue.getItems()[0]!.status).toBe('uploading')
    expect(calls).toHaveLength(4)
    // Cancelled rows accept retry too (stays queued while the slot is busy).
    expect(queue.retry(queue.getItems()[2]!.id)).toBe(true)
    await settle()
    expect(queue.getItems()[2]!.status).toBe('pending')
  })

  it('remove during flight drops the row and swallows the late rejection', async () => {
    const { calls, transport } = makeTransport()
    const queue = new UploadQueue({ sessionId: () => 's1', transport })
    const item = queue.enqueue([{ file: makeFile('gone.bin') }])[0]!
    expect(queue.remove(item.id)).toBe(true)
    expect(queue.getItems()).toHaveLength(0)
    expect(() =>{  calls[0]!.reject(makeAbortError()) }).not.toThrow()
    await settle()
    expect(queue.getItems()).toHaveLength(0)
    expect(queue.remove(item.id)).toBe(false)
  })

  it('clear aborts every in-flight upload and empties the queue', () => {
    const { calls, transport } = makeTransport()
    const queue = new UploadQueue({ sessionId: () => 's1', concurrency: 2, transport })
    queue.enqueue([
      { file: makeFile('a') },
      { file: makeFile('b') },
      { file: makeFile('c') },
    ])
    queue.clear()
    expect(queue.getItems()).toHaveLength(0)
    expect(calls.every(call => call.request.signal.aborted)).toBe(true)
    expect(queue.stats().total).toBe(0)
  })
})

describe('createXhrTransport (default transport)', () => {
  class FakeXhr {
    static instances: FakeXhr[] = []
    open = vi.fn()
    setRequestHeader = vi.fn()
    send = vi.fn(() => {
      FakeXhr.instances.push(this)
    })
    upload = { onprogress: null as ((event: { loaded: number }) => void) | null }
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    onabort: (() => void) | null = null
    status = 0
    responseText = ''
    abortCount = 0

    respond(status: number, text: string): void {
      this.status = status
      this.responseText = text
      this.onload?.()
    }

    abort(): void {
      this.abortCount += 1
      this.onabort?.()
    }
  }

  function install(): void {
    FakeXhr.instances = []
    vi.stubGlobal('XMLHttpRequest', FakeXhr)
  }

  it('opens POST, forwards headers and progress, parses JSON results', async () => {
    install()
    const transport = createXhrTransport()
    const progress: number[] = []
    const promise = transport({
      url: '/api/filehub/upload',
      body: new Blob([new Uint8Array(4)]),
      headers: { 'x-session-id': 's9', 'content-type': 'text/plain' },
      onProgress: loaded => progress.push(loaded),
      signal: new AbortController().signal,
    })
    const xhr = FakeXhr.instances[0]!
    expect(xhr.open).toHaveBeenCalledWith('POST', '/api/filehub/upload')
    expect(xhr.setRequestHeader).toHaveBeenCalledWith('x-session-id', 's9')
    expect(xhr.setRequestHeader).toHaveBeenCalledWith('content-type', 'text/plain')
    xhr.upload.onprogress?.({ loaded: 2 })
    xhr.respond(200, JSON.stringify(RESULT))
    await expect(promise).resolves.toEqual(RESULT)
    expect(progress).toEqual([2])
  })

  it('surfaces HTTP failures as UploadHttpError carrying the status', async () => {
    install()
    const promise = createXhrTransport()(emptyRequest())
    FakeXhr.instances[0]!.respond(413, 'too big')
    const cause = await promise.catch((error: unknown) => error)
    expect(cause).toBeInstanceOf(UploadHttpError)
    expect((cause as UploadHttpError).status).toBe(413)
  })

  it('maps non-JSON 2xx bodies to UploadResponseError', async () => {
    install()
    const promise = createXhrTransport()(emptyRequest())
    FakeXhr.instances[0]!.respond(200, '<html>not json</html>')
    const cause = await promise.catch((error: unknown) => error)
    expect(cause).toBeInstanceOf(UploadResponseError)
  })

  it('rejects with AbortError when the signal aborts mid-flight', async () => {
    install()
    const controller = new AbortController()
    const promise = createXhrTransport()(emptyRequest(controller.signal))
    const xhr = FakeXhr.instances[0]!
    controller.abort()
    const cause = await promise.catch((error: unknown) => error)
    expect(xhr.abortCount).toBe(1)
    expect((cause as Error).name).toBe('AbortError')
  })

  it('rejects with a network error on xhr.onerror', async () => {
    install()
    const promise = createXhrTransport()(emptyRequest())
    FakeXhr.instances[0]!.onerror?.()
    const cause = await promise.catch((error: unknown) => error)
    expect((cause as Error).message).toContain('network')
  })

  function emptyRequest(signal = new AbortController().signal): OutgoingUploadRequest {
    return {
      url: '/api/filehub/upload',
      body: new Blob([new Uint8Array(1)]),
      headers: {},
      onProgress: () => {},
      signal,
    }
  }
})
