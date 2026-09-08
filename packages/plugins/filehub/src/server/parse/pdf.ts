/**
 * PDF stage of the M3 waterfall: paginated text extraction via pdfjs-dist
 * (P01 §6-C FR-C2).
 *
 * Node/vitest loading notes (verified against pdfjs-dist 4.10.38 legacy
 * build, `node_modules/pdfjs-dist/legacy/build/pdf.mjs`):
 * - The LEGACY build must be used under Node (`pdfjs-dist/legacy/build/pdf.mjs`);
 *   the default ESM build assumes browser APIs beyond what Node polyfills.
 * - `PDFWorker`'s static initializer detects Node (`isNodeJS`) and forces the
 *   FAKE-worker path (`#isWorkerDisabled = true`) BEFORE defaulting
 *   `GlobalWorkerOptions.workerSrc ||= "./pdf.worker.mjs"`; its fake-worker
 *   loader then `await import(workerSrc)`s that RELATIVE specifier, which ESM
 *   resolves against pdf.mjs's own URL (the sibling pdf.worker.mjs). No real
 *   Worker thread, canvas, or explicit worker wiring is needed for text
 *   extraction — every parse stays on this thread so the AbortSignal race
 *   plus `loadingTask.destroy()` fully reclaims the document. (The optional
 *   @napi-rs/canvas polyfill load failure only warns; rendering is untouched.)
 */

import type { DocumentOverview } from './types.js'

/** Module shape we rely on (structural — keeps the import site single). */
interface PdfTextItem {
  str?: string
  hasEOL?: boolean
}
interface PdfPageLike {
  getTextContent(): Promise<{ items: ReadonlyArray<unknown> }>
}
interface PdfDocumentLike {
  numPages: number
  getPage(pageNumber: number): Promise<PdfPageLike>
}
interface PdfLoadingTaskLike {
  promise: Promise<PdfDocumentLike>
  destroy(): Promise<void>
}
interface PdfjsModule {
  getDocument(options: { data: Uint8Array }): { destroy(): Promise<void> } & PdfLoadingTaskLike
}

let cachedModule: Promise<PdfjsModule> | undefined

function loadPdfjs(): Promise<PdfjsModule> {
  // One-time dynamic import; see header note for why no worker setup exists.
  cachedModule ??= import('pdfjs-dist/legacy/build/pdf.mjs') as Promise<PdfjsModule>
  return cachedModule
}

/**
 * Extract per-page text. Each page becomes a `[page N]` block joined by blank
 * lines so offsets remain stable and a UI can show page numbers. Pages past
 * the cap contribute nothing but are counted into `pageCountTotal` via the
 * returned overview warning.
 */
export async function extractPdf(
  bytes: Uint8Array,
  maxPages: number,
): Promise<{ text: string; overview: DocumentOverview; warnings: string[] }> {
  const warnings: string[] = []
  const pdfjs = await loadPdfjs()
  // Copy into a STANDALONE Uint8Array: pdfjs-dist's Node branch special-cases
  // `val instanceof Buffer` and that path fails under the fake-worker flow,
  // while a plain typed-array view works. The copy also detaches our result
  // from the caller's pooled ArrayBuffer so parser-side transfers can never
  // mutate unrelated heap data.
  const payload = new Uint8Array(bytes)
  const task = pdfjs.getDocument({ data: payload })
  try {
    const doc = await task.promise
    const total = doc.numPages
    const rendered = Math.min(total, Math.max(1, maxPages))
    if (total > rendered) {
      warnings.push(`pdf has ${total} pages; rendering stopped at the ${rendered}-page cap`)
    }

    const blocks: string[] = []
    const pageLengths: number[] = []
    for (let pageNumber = 1; pageNumber <= rendered; pageNumber += 1) {
      const page: PdfPageLike = await doc.getPage(pageNumber)
      const content = await page.getTextContent()
      let text = ''
      for (const item of content.items as ReadonlyArray<PdfTextItem>) {
        if (typeof item.str === 'string') text += item.str
        if (item.hasEOL === true) text += '\n'
      }
      text = text.replace(/[ \t]+\n/g, '\n').trimEnd()
      pageLengths.push(text.length)
      blocks.push(`[page ${pageNumber}]\n${text}`)
    }
    const overview: DocumentOverview = {
      format: 'pdf',
      pageCount: total,
      ...(pageLengths.length > 0 ? { pageLengths } : {}),
    }
    return { text: blocks.join('\n\n'), overview, warnings }
  } finally {
    // Reclaim parser memory even when the caller's abort race already moved
    // on — no zombie document tasks survive session teardown.
    await task.destroy().catch(() => undefined)
  }
}
