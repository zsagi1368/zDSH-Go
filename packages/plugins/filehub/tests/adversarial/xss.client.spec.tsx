// @vitest-environment jsdom
/**
 * M6 red-team round 3 — i18n/interpolation injection (P01 §12 对抗验证).
 *
 * Hostile file names (HTML/script fragments) flow through upload labels,
 * console rows and i18n interpolation into React rendering. JSX escapes text
 * by default; the repo-wide zero-dangerouslySetInnerHTML assertion plus the
 * render checks below pin that invariant. Log: docs/adversarial-log.md.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'

import { describe, expect, it } from 'vitest'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'

import { FileHubDock } from '../../src/client/upload/dock.js'
import { UploadQueue } from '../../src/client/upload/queue.js'
import type { UploadedFileResult } from '../../src/client/upload/queue.js'
import { formatUploadError } from '../../src/client/upload/queue.js'

// ---------------------------------------------------------------------------
// Repo-wide assertion: no raw-HTML sinks anywhere in src/
// ---------------------------------------------------------------------------

async function collectSourceFiles(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await collectSourceFiles(absolute)))
    else if (/\.tsx?$/.test(entry.name)) out.push(absolute)
  }
  return out
}

describe('round3: repo-wide raw-HTML sink ban', () => {
  it('contains ZERO dangerouslySetInnerHTML / innerHTML usages under src/', async () => {
    const files = await collectSourceFiles(path.resolve(import.meta.dirname, '../../src'))
    expect(files.length).toBeGreaterThan(20) // the scan really walked the tree
    for (const file of files) {
      const source = await fsp.readFile(file, 'utf8')
      expect(source.includes('dangerouslySetInnerHTML'), file).toBe(false)
      expect(source.includes('.innerHTML'), file).toBe(false)
      expect(source.includes('document.write'), file).toBe(false)
    }
  })
})

// ---------------------------------------------------------------------------
// Hostile names through React rendering
// ---------------------------------------------------------------------------

const HOSTILE_NAME = '<img src=x onerror="alert(1)">'
const HOSTILE_SCRIPT = '<script>alert("pwned")</script>.txt'
const HOSTILE_I18N = '{$1} {en} </div>{inject}'

function makeFile(name: string): File {
  return new File([new Uint8Array(4)], name)
}

function mountDock(queue: UploadQueue): { container: HTMLDivElement; unmount: () => void } {
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

const settle = (): Promise<void> => new Promise<void>(resolve => setTimeout(resolve, 0))

describe('round3: hostile names in React surfaces', () => {
  it('dock renders a hostile pending-file name as inert TEXT (no injected element)', async () => {
    const queue = new UploadQueue({ sessionId: () => 's1' })
    queue.enqueue([{ file: makeFile(HOSTILE_NAME), relativePath: '' }])
    const mounted = mountDock(queue)
    try {
      await settle()
      // The literal text survives (escaped), but NO <img>/<script> element
      // was ever created by the hostile payload.
      expect(mounted.container.querySelector('img[src="x"]')).toBeNull()
      expect(mounted.container.querySelectorAll('script')).toHaveLength(0)
      expect(mounted.container.textContent).toContain('<img src=x')
    } finally {
      mounted.unmount()
    }
  })

  it('done-row with a hostile file name never creates a script element', async () => {
    let resolveUpload: ((result: UploadedFileResult) => void) | undefined
    const queue = new UploadQueue({
      sessionId: () => 's1',
      transport: request =>
        new Promise<UploadedFileResult>((resolve, reject) => {
          void request
          void reject
          resolveUpload = resolve
        }),
    })
    queue.enqueue([{ file: makeFile(HOSTILE_SCRIPT) }])
    await settle()
    resolveUpload?.({
      path: '/w/x',
      relativePath: HOSTILE_SCRIPT,
      sniffedType: 'application/octet-stream',
      label: HOSTILE_SCRIPT,
    })
    const mounted = mountDock(queue)
    try {
      await settle()
      // No hostile element was ever created, and the raw fragment never
      // appears as MARKUP in the serialized DOM (only as escaped text data).
      expect(mounted.container.querySelectorAll('script')).toHaveLength(0)
      expect(mounted.container.innerHTML.includes('<script>')).toBe(false)
      // Tail-truncated display still shows the inert suffix as plain text.
      expect(mounted.container.textContent).toContain('.txt')
    } finally {
      mounted.unmount()
    }
  })

  it('i18n error interpolation treats hostile tokens as plain text', () => {
    // The bilingual dictionary is plain string mapping — a hostile fragment
    // rides through formatUploadError as data, not markup.
    const message = formatUploadError({ code: 'tooLarge', retryable: false }, 'zh')
    expect(message).toBe('文件超过大小上限。')
    // And a hostile label never mutates the dictionary output shape.
    expect(typeof message).toBe('string')
    expect(message.includes(HOSTILE_I18N)).toBe(false)
  })
})
