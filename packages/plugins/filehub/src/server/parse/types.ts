/**
 * Shared types for the M3 document-reading domain (P01 §6-C).
 *
 * The parse waterfall NEVER fails: every stage that cannot extract content
 * logs a warning and lets the next stage try, and the final fallback always
 * produces SOMETHING readable (best-effort text decode, or a binary
 * placeholder note). Callers therefore always receive a {@link ParsedDocument}.
 */

/** Formats the waterfall can classify a document into. */
export type DocumentFormat = 'text' | 'pdf' | 'docx' | 'xlsx' | 'binary'

/**
 * Structure overview for a parsed document — the payload behind
 * `probe: true` on the read_document tool. Carries shape information only;
 * body text never appears here (probe-then-read economics, FR-C5).
 */
export interface DocumentOverview {
  format: DocumentFormat
  /** pdf only: total page count (after the page cap). */
  pageCount?: number
  /** pdf only: per-page character length of the extracted text. */
  pageLengths?: number[]
  /** xlsx only: sheet names in workbook order. */
  sheetNames?: string[]
  /** xlsx only: row/column counts per sheet (same order as sheetNames). */
  sheetDimensions?: Array<{ rows: number; columns: number }>
  /** docx only: paragraph count of the raw text extraction. */
  paragraphCount?: number
}

/** One successful (or degraded) parse outcome. Never thrown past the caller. */
export interface ParsedDocument {
  /** Format the winning stage produced. */
  format: DocumentFormat
  /** Full extracted text (budget windowing happens at the tool layer). */
  text: string
  overview: DocumentOverview
  /**
   * Human-readable degradation log: one entry per stage that failed or was
   * capped before the winner produced this document.
   */
  warnings: string[]
}

/** Logger facet the waterfall needs (structural subset of HostContext.logger). */
export interface ParseLogger {
  warn(message: string): void
}

/**
 * Caller-input mistakes (e.g. an unknown xlsx sheet selector) are NOT parse
 * failures: they skip the degradation ladder and surface as actionable tool
 * errors instead of silently degrading to mojibake text.
 */
export class DocumentInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DocumentInputError'
  }
}

/** Options for one parse run. */
export interface ParseOptions {
  log?: ParseLogger
  /**
   * Cooperative cancellation. Stages that natively accept no signal are
   * wrapped in an abort race; the whole run is additionally bounded by the
   * configured timeout so a session teardown never leaves zombie tasks.
   */
  signal?: AbortSignal
  /** Hard cap on pdf pages rendered into text. Default {@link DEFAULT_MAX_PDF_PAGES}. */
  maxPdfPages?: number
  /**
   * Test/override hook for the hard run deadline; production callers keep the
   * default {@link DEFAULT_PARSE_TIMEOUT_MS} (120s).
   */
  timeoutMsOverride?: number
  /** xlsx only: worksheet selector (exact name or 1-based index). */
  sheet?: number | string
  /** xlsx only: compute row/column dimensions for EVERY sheet, not just the selected one (probe mode). */
  allSheetDimensions?: boolean
}
