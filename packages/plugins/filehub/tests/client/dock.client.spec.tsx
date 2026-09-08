// @vitest-environment jsdom
/**
 * Dock render smoke tests: rows reflect queue states, retry affordance
 * follows the retryable hint, done-row removal goes through the wire DELETE.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'

import { FileHubDock } from '../../src/client/upload/dock.js'
import { UploadHttpError, UploadQueue } from '../../src/client/upload/queue.js'
import type { OutgoingUploadRequest, UploadedFileResult } from '../../src/client/upload/queue.js'

const RESULT: UploadedFileResult = {
  path: '/w/.filehub/s1/report.pdf',
  relativePath: 'report.pdf',
  sniffedType: 'application/pdf',
  label: 'report.pdf',
}

interface ControlledCall {
  request: OutgoingUploadRequest
  resolve: (result: UploadedFileResult) => void
  reject: (cause: unknown) => void
}

function makeTransport(): { calls: ControlledCall[]; transport: (request: OutgoingUploadRequest) => Promise<UploadedFileResult> } {
  const calls: ControlledCall[] = []
  return {
    calls,
    transport: request =>
      new Promise<UploadedFileResult>((resolve, reject) => {
        calls.push({ request, resolve, reject })
      }),
  }
}

function makeFile(name: string, size = 10): File {
  return new File([new Uint8Array(size)], name)
}

const settle = (): Promise<void> => new Promise<void>(resolve => setTimeout(resolve, 0))

function mount(queue: UploadQueue): { container: HTMLDivElement; unmount: () => void } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  flushSync(() => {
    root.render(<FileHubDock sessionId="s1" queue={queue} />)
  })
  return {
    container,
    unmount: () => {
      root.unmount()
      container.remove()
    },
  }
}

function click(button: Element): void {
  button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('FileHubDock rendering', () => {
  it('renders nothing while the queue is empty', () => {
    const { calls, transport } = makeTransport()
    const queue = new UploadQueue({ sessionId: () => 's1', transport })
    const mounted = mount(queue)
    try {
      expect(mounted.container.children).toHaveLength(0)
      expect(calls).toHaveLength(0)
    } finally {
      mounted.unmount()
    }
  })

  it('shows name, size, badge and per-status labels for mixed rows', async () => {
    const { calls, transport } = makeTransport()
    const queue = new UploadQueue({ sessionId: () => 's1', concurrency: 3, transport })
    queue.enqueue([
      { file: makeFile('report.pdf', 2048), relativePath: '' },
      { file: makeFile('virus.exe') },
      { file: makeFile('pending.bin') },
    ])
    calls[0]!.resolve(RESULT)
    calls[1]!.reject(new UploadHttpError(415))
    await settle()

    const mounted = mount(queue)
    try {
      const text = mounted.container.textContent ?? ''
      expect(text).toContain('report.pdf')
      expect(text).toContain('2 KB')
      expect(text).toContain('Done')
      expect(text).toContain('PDF') // server sniffedType wins over the name badge
      expect(text).toContain('EXE')
      expect(text).toContain('Failed')

      // 415 is not retryable: no retry glyph anywhere; plain remove exists.
      const buttons = Array.from(mounted.container.querySelectorAll('button'))
      expect(buttons.some(button => button.textContent === '⟳')).toBe(false)

      // Uploading/pending rows carry a progressbar.
      expect(mounted.container.querySelectorAll('[role="progressbar"]')).toHaveLength(1)
      expect(mounted.container.querySelector('.zdsh-filehub-dock')).not.toBeNull()
    } finally {
      mounted.unmount()
    }
  })

  it('offers retry exactly on retryable failures and cancelled rows', async () => {
    const { calls, transport } = makeTransport()
    const queue = new UploadQueue({ sessionId: () => 's1', concurrency: 2, transport })
    queue.enqueue([{ file: makeFile('a.bin') }, { file: makeFile('b.bin') }])
    calls[0]!.reject(new UploadHttpError(507)) // retryable
    calls[1]!.reject(new Error('offline')) // network → retryable
    await settle()

    const mounted = mount(queue)
    try {
      const retries = Array.from(mounted.container.querySelectorAll('button')).filter(
        button => button.title === 'Retry',
      )
      expect(retries).toHaveLength(2)
      click(retries[0]!)
      await settle()
      // Retry re-dispatched the first row through the transport.
      expect(queue.getItems().some(item => item.status === 'uploading')).toBe(true)
    } finally {
      mounted.unmount()
    }
  })

  it('removes done rows through the idempotent DELETE endpoint', async () => {
    const { calls, transport } = makeTransport()
    const queue = new UploadQueue({ sessionId: () => 's1', transport })
    queue.enqueue([{ file: makeFile('report.pdf', 64) }])
    calls[0]!.resolve(RESULT)
    await settle()

    const fetchMock = vi.fn(async () => ({ ok: true, status: 204 }) as Response)
    vi.stubGlobal('fetch', fetchMock)

    const mounted = mount(queue)
    try {
      const remove = Array.from(mounted.container.querySelectorAll('button')).find(
        button => button.title === 'Delete from workspace',
      )
      expect(remove).toBeDefined()
      click(remove as HTMLButtonElement)
      await settle()
      await settle()
      expect(fetchMock).toHaveBeenCalledTimes(1)
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
      expect(url.startsWith('/api/filehub/file?path=')).toBe(true)
      expect(url).toContain(encodeURIComponent(RESULT.path))
      expect(init.method).toBe('DELETE')
      expect(queue.getItems()).toHaveLength(0)
    } finally {
      mounted.unmount()
    }
  })

  it('keeps the done row and shows a reason when DELETE fails', async () => {
    const { calls, transport } = makeTransport()
    const queue = new UploadQueue({ sessionId: () => 's1', transport })
    queue.enqueue([{ file: makeFile('report.pdf', 64) }])
    calls[0]!.resolve(RESULT)
    await settle()

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 500 }) as Response),
    )

    const mounted = mount(queue)
    try {
      const remove = Array.from(mounted.container.querySelectorAll('button')).find(
        button => button.title === 'Delete from workspace',
      ) as HTMLButtonElement
      click(remove)
      await settle()
      await settle()
      expect(queue.getItems()).toHaveLength(1)
      expect(mounted.container.textContent).toContain('Delete failed')
    } finally {
      mounted.unmount()
    }
  })
})
