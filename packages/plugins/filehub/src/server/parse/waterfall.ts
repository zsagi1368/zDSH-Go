/**
 * The M3 parse waterfall (P01 §6-C FR-C1..C4): a NEVER-FAILING pipeline that
 * turns uploaded bytes into readable text, degrading loudly stage by stage.
 *
 * Stages, in spec order:
 *   1. text fast path — decode per the sniffed charset (utf-8/utf-16/gb18030);
 *   2. pdf — pdfjs-dist paginated extraction;
 *   3. docx — mammoth extractRawText;
 *   4. xlsx — read-excel-file with probe-first sheet handling;
 *   5. fallback — best-effort text decode; genuinely binary data becomes a
 *      binary placeholder note instead of mojibake.
 *
 * A stage only runs when the sniff verdict says it applies; when its parser
 * throws, the failure is logged as a warning and the NEXT applicable stage
 * (eventually the fallback) takes over — e.g. a corrupt .docx degrades to the
 * text path instead of rejecting the read.
 *
 * Cancellation: every stage is wrapped in an abort race. Parsers that accept
 * no signal natively (mammoth, read-excel-file) are abandoned by the race,
 * and the whole run is bounded by a hard timeout so a session teardown never
 * leaves zombie work pending on this thread.
 */

import { sniff } from '../../detect.js'
import type { DocumentFormat, ParseOptions, ParsedDocument } from './types.js'
import { DocumentInputError } from './types.js'
import { charsetOfMime, decodeBestEffort } from './textDecode.js'
import { extractPdf } from './pdf.js'
import { extractDocx } from './docx.js'
import { extractXlsx } from './xlsx.js'

/** Default hard ceiling for one parse run (FR-C4: timeout default 120s). */
export const DEFAULT_PARSE_TIMEOUT_MS = 120_000

/** Default pdf page-render cap (page-count protection). */
export const DEFAULT_MAX_PDF_PAGES = 300

/** Error thrown when a run is cancelled via signal or timeout. */
export class ParseAbortedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ParseAbortedError'
  }
}

export { DocumentInputError }

/**
 * Race `work` against `signal`'s abort. When the signal wins, the returned
 * promise REJECTS even though `work` may still be running — callers must not
 * treat that as completion; the underlying result is discarded.
 */
export function abortRace<T>(work: Promise<T>, signal: AbortSignal | undefined, label: string): Promise<T> {
  if (signal === undefined) return work
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const onAbort = (): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(new ParseAbortedError(`${label} aborted`))
    }
    const cleanup = (): void => {
      signal.removeEventListener('abort', onAbort)
    }
    if (signal.aborted) {
      reject(new ParseAbortedError(`${label} aborted`))
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
    void work.then(
      (value) => {
        if (settled) return
        settled = true
        cleanup()
        resolve(value)
      },
      (error: unknown) => {
        if (settled) return
        settled = true
        cleanup()
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

/**
 * Compose one combined deadline controller: aborts when the caller's signal
 * aborts OR after timeoutMs elapse. Returns the controller's signal plus a
 * disposer that stops the timer (the caller invokes it once the run settles).
 */
function deadlineScope(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): { scopedSignal: AbortSignal; dispose(): void } {
  const controller = new AbortController()
  const timer = setTimeout(() =>{  controller.abort(new ParseAbortedError('parse timed out')) }, timeoutMs)
  // Never hold the process open for a parse.
  if (typeof timer.unref === 'function') timer.unref()
  const onOuterAbort = (): void =>{
    controller.abort(signal?.reason ?? new ParseAbortedError('aborted by caller')) }
  if (signal !== undefined) {
    if (signal.aborted) onOuterAbort()
    else signal.addEventListener('abort', onOuterAbort, { once: true })
  }
  return {
    scopedSignal: controller.signal,
    dispose(): void {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onOuterAbort)
    },
  }
}

interface StageOutcome {
  text: string
  overview: ParsedDocument['overview']
  warnings: string[]
}

type Stage = {
  format: DocumentFormat
  applies: () => boolean
  describe: () => string
  run: (bytes: Uint8Array, signal: AbortSignal) => Promise<StageOutcome>
}

/**
 * Run the waterfall. Always resolves with a {@link ParsedDocument}; rejects
 * ONLY on cancellation (caller signal / timeout).
 */
export async function parseDocument(bytes: Uint8Array, fileName: string | undefined, options: ParseOptions = {}): Promise<ParsedDocument> {
  const verdict = sniff(bytes, fileName)
  const warnings: string[] = []
  const timeoutMs = options.timeoutMsOverride ?? DEFAULT_PARSE_TIMEOUT_MS
  const maxPdfPages = options.maxPdfPages ?? DEFAULT_MAX_PDF_PAGES

  const stages: Stage[] = [
    {
      format: 'text',
      applies: () => verdict.kind === 'text',
      describe: () => `text fast path (${verdict.mime})`,
      async run(bytes_) {
        await Promise.resolve()
        const charset = charsetOfMime(verdict.mime)
        const text = decodeBestEffort(bytes_, charset)
        return { text, overview: { format: 'text' }, warnings: [] }
      },
    },
    {
      format: 'pdf',
      applies: () => verdict.mime.startsWith('application/pdf'),
      describe: () => 'pdf extraction (pdfjs-dist)',
      async run(bytes_, signal) {
        const outcome = await abortRace(extractPdf(bytes_, maxPdfPages), signal, 'pdf parse')
        if (outcome.warnings.length > 0) warnings.push(...outcome.warnings)
        return outcome
      },
    },
    {
      format: 'docx',
      applies: () => verdict.label.includes('.docx'),
      describe: () => 'docx extraction (mammoth)',
      run: (bytes_, signal) => abortRace(extractDocx(bytes_), signal, 'docx parse'),
    },
    {
      format: 'xlsx',
      applies: () => verdict.label.includes('.xlsx'),
      describe: () => 'xlsx extraction (read-excel-file)',
      run: (bytes_, signal) =>
        abortRace(
          extractXlsx(bytes_, {
            ...(options.sheet !== undefined ? { sheet: options.sheet } : {}),
            allDimensions: options.allSheetDimensions === true,
          }),
          signal,
          'xlsx parse',
        ),
    },
  ]

  const scope = deadlineScope(options.signal, timeoutMs)
  try {
    for (const stage of stages) {
      if (!stage.applies()) continue
      // Honor cancellation even before a pure-sync stage begins.
      if (scope.scopedSignal.aborted) {
        throw new ParseAbortedError('parse aborted before stage dispatch')
      }
      // Indirection defeats control-flow narrowing of `.aborted` across awaits.
      const abortedNow = (): boolean => scope.scopedSignal.aborted
      try {
        const outcome = await stage.run(bytes, scope.scopedSignal)
        return { format: outcome.overview.format, text: outcome.text, overview: outcome.overview, warnings }
      } catch (error) {
        if (abortedNow()) throw error instanceof Error ? error : new ParseAbortedError(String(error))
        // Input mistakes skip the degradation ladder entirely (see class note).
        if (error instanceof DocumentInputError) throw error
        const message = `[filehub] ${stage.format} parse failed (${stage.describe()}): ${String(error)}; falling through`
        options.log?.warn(message)
        warnings.push(`${stage.format} parse failed: normalized to next stage`)
      }
    }

    // ---- Final fallback: best-effort text, else a binary placeholder ------
    const isOfficeContainer =
      verdict.label.includes('.docx') || verdict.label.includes('.xlsx') || verdict.label.includes('.pptx')
    if (verdict.kind !== 'text' && !isOfficeContainer) {
      // Genuinely non-text payloads (images, media, non-office archives,
      // opaque binaries) get a placeholder note instead of mojibake. A FAILED
      // office container still degrades to best-effort decoding below — its
      // XML parts are text and often partially recoverable.
      const text =
        `[binary content: ${verdict.label}, ${bytes.length} bytes — not decoded]\n` +
        '(no document parser applies to this file type)'
      warnings.push(`no document parser applies (${verdict.label}); emitted binary placeholder`)
      return { format: 'binary', text, overview: { format: 'binary' }, warnings }
    }
    // Text-ish data whose structured stage(s) failed (e.g. a corrupt docx
    // that still smells like a ZIP): best-effort decode of whatever survives.
    const charset = verdict.kind === 'text' ? charsetOfMime(verdict.mime) : 'utf-8'
    const text = decodeBestEffort(bytes, charset)
    warnings.push('structured parse unavailable; content served via best-effort text decoding')
    return { format: 'text', text, overview: { format: 'text' }, warnings }
  } finally {
    scope.dispose()
  }
}
