/**
 * M3 waterfall suites: per-format happy paths (incl. GB18030 text and 2-page
 * PDF pagination), never-fail degradation, and abort-race cancellation.
 */

import { describe, expect, it } from 'vitest'

import { parseDocument, abortRace } from '../../../src/server/parse/waterfall.js'
import { makeDocx, makePdf, makeXlsx } from './zipFixture.client.js'
import type { ZipEntry } from './zipFixture.client.js'

class WarnSink {
  readonly messages: string[] = []
  warn(message: string): void {
    this.messages.push(message)
  }
}

describe('parseDocument / text fast path', () => {
  it('decodes utf-8 text including CJK', async () => {
    const sink = new WarnSink()
    const bytes = Buffer.from('hello 世界\nsecond line', 'utf8')
    const doc = await parseDocument(bytes, 'notes.txt', { log: sink })
    expect(doc.format).toBe('text')
    expect(doc.text).toBe('hello 世界\nsecond line')
    expect(doc.overview.format).toBe('text')
    expect(doc.warnings).toHaveLength(0)
    expect(sink.messages).toHaveLength(0)
  })

  it('decodes BOM-less GB18030 Chinese text per the sniffed charset', async () => {
    // Hand-encoded GB18030 pairs: 中=D6D0 文=CEC4 测=B2E2 试=CA D4.
    const bytes = Uint8Array.from([0xd6, 0xd0, 0xce, 0xc4, 0xb2, 0xe2, 0xca, 0xd4])
    const doc = await parseDocument(bytes, 'chinese.txt')
    expect(doc.format).toBe('text')
    expect(doc.text).toBe('中文测试')
  })

  it('decodes UTF-16LE via BOM declaration', async () => {
    const bom = Uint8Array.from([0xff, 0xfe])
    const body = Buffer.from('wide', 'utf16le')
    const doc = await parseDocument(Buffer.concat([Buffer.from(bom), body]), 'wide.txt')
    expect(doc.text).toBe('wide')
  })
})

describe('parseDocument / pdf', () => {
  it('extracts two pages with page markers and overview counts', async () => {
    const pdf = makePdf(['First page body', 'Second page body'])
    const doc = await parseDocument(pdf, 'two-pages.pdf')
    expect(doc.format).toBe('pdf')
    expect(doc.overview.pageCount).toBe(2)
    expect(doc.overview.pageLengths).toHaveLength(2)
    for (const length of doc.overview.pageLengths ?? []) {
      expect(length).toBeGreaterThan(0)
    }
    expect(doc.text).toContain('[page 1]')
    expect(doc.text).toContain('[page 2]')
    expect(doc.text).toContain('First page body')
    expect(doc.text).toContain('Second page body')
  })

  it('honors maxPdfPages cap and records a warning', async () => {
    const pdf = makePdf(['alpha', 'beta', 'gamma'])
    const doc = await parseDocument(pdf, 'three-pages.pdf', { maxPdfPages: 2 })
    expect(doc.format).toBe('pdf')
    expect(doc.overview.pageCount).toBe(3)
    expect(doc.text).toContain('[page 1]')
    expect(doc.text).toContain('[page 2]')
    expect(doc.text).not.toContain('[page 3]')
    expect(doc.warnings.join('\n')).toContain('page cap')
  })
})

describe('parseDocument / docx', () => {
  it('extracts paragraphs and counts them', async () => {
    const docx = makeDocx(['First paragraph', '第二段包含中文', 'third'])
    const doc = await parseDocument(docx, 'report.docx')
    expect(doc.format).toBe('docx')
    expect(doc.overview.paragraphCount).toBe(3)
    expect(doc.text).toContain('First paragraph')
    expect(doc.text).toContain('第二段包含中文')
    expect(doc.text).toContain('third')
  })
})

describe('parseDocument / xlsx', () => {
  it('reads the first sheet by default and reports all sheets', async () => {
    const xlsx = makeXlsx([
      { name: 'Alpha', rows: [['h1', 'h2'], [1, 2]] },
      { name: 'Beta 数据', rows: [['only']] },
    ])
    const doc = await parseDocument(xlsx, 'book.xlsx')
    expect(doc.format).toBe('xlsx')
    expect(doc.overview.sheetNames).toEqual(['Alpha', 'Beta 数据'])
    expect(doc.text).toContain('[sheet: Alpha]')
    expect(doc.text).toContain('h1\th2')
    expect(doc.text).toContain('1\t2')
    expect(doc.text).not.toContain('only')
  })

  it('selects sheets by name and 1-based index', async () => {
    const xlsx = makeXlsx([
      { name: 'Alpha', rows: [['a']] },
      { name: 'Beta', rows: [['b', 'c']] },
    ])
    const { extractXlsx } = await import('../../../src/server/parse/xlsx.js')
    const named = await extractXlsx(new Uint8Array(xlsx), { sheet: 'Beta' })
    expect(named.text).toContain('[sheet: Beta]')
    expect(named.text).toContain('b\tc')
    const indexed = await extractXlsx(new Uint8Array(xlsx), { sheet: 2, allDimensions: true })
    expect(indexed.overview.sheetNames).toEqual(['Alpha', 'Beta'])
    expect(indexed.overview.sheetDimensions).toEqual([
      { rows: 1, columns: 1 },
      { rows: 1, columns: 2 },
    ])
  })
})

describe('parseDocument / degradation (never fails)', () => {
  it('falls back to best-effort text when a docx payload is corrupt', async () => {
    const sink = new WarnSink()
    const corrupt: ZipEntry[] = [
      { name: '[Content_Types].xml', data: '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>' },
      { name: 'word/document.xml', data: 'this is <not valid xml>' },
    ]
    const { buildZip } = await import('./zipFixture.client.js')
    const doc = await parseDocument(buildZip(corrupt), 'broken.docx', { log: sink })
    expect(doc.format).toBe('text')
    expect(doc.text.length).toBeGreaterThan(0)
    expect(doc.warnings.some(w => w.includes('best-effort'))).toBe(true)
    expect(sink.messages.join('\n')).toContain('docx parse failed')
  })

  it('emits a binary placeholder for undecodable media', async () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
    const doc = await parseDocument(png, 'pixel.png')
    expect(doc.format).toBe('binary')
    expect(doc.text).toContain('[binary content: PNG image')
    expect(doc.text).toContain('not decoded')
  })

  it('degrades an unknown archive type through the fallback', async () => {
    const gzip = Uint8Array.from([0x1f, 0x8b, 0x08, 0x00, 1, 2, 3, 4])
    const doc = await parseDocument(gzip, 'blob.gz')
    expect(doc.format).toBe('binary')
    expect(doc.warnings.length).toBeGreaterThan(0)
  })
})

describe('abort races', () => {
  it('rejects abortRace when the signal fires before the work settles', async () => {
    const controller = new AbortController()
    const never = new Promise<string>(() => {})
    const pending = abortRace(never, controller.signal, 'unit')
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'ParseAbortedError' })
  })

  it('resolves normally when the work settles before any abort', async () => {
    const controller = new AbortController()
    await expect(abortRace(Promise.resolve('done'), controller.signal, 'unit')).resolves.toBe('done')
    // A late abort after settlement must not surface anywhere.
    controller.abort()
  })

  it('propagates a pre-aborted caller signal out of parseDocument', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      parseDocument(Buffer.from('plain text'), 'file.txt', { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'ParseAbortedError' })
  })

  it('aborts an in-flight pdf parse mid-flight without resolving', async () => {
    const controller = new AbortController()
    // The pdf stage registers its abort listener synchronously before the
    // first await (pdfjs module load takes many milliseconds), so this abort
    // deterministically lands mid-parse and rejects the whole run.
    const pending = parseDocument(makePdf(['page one', 'page two']), 'abort.pdf', {
      signal: controller.signal,
    })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'ParseAbortedError' })
  })
})
