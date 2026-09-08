/**
 * XLSX stage of the M3 waterfall via read-excel-file (P01 §6-C FR-C2).
 *
 * API facts verified against node_modules/read-excel-file@5.8.7:
 * - the `/node` entry accepts a Buffer (`readXlsxFile(input: Stream | Buffer |
 *   PathLike)`) and exposes `readSheetNames(input): Promise<string[]>`;
 * - `ParseWithoutSchemaOptions.sheet?: number | string` selects the worksheet
 *   (1-based index or name).
 *
 * "Probe first, then read": sheet NAMES are enumerated before any body is
 * parsed, so `probe: true` on the tool never dumps cell contents.
 * read-excel-file accepts no AbortSignal; the waterfall's abort race wraps it.
 */

import { DocumentInputError } from './types.js'
import type { DocumentOverview } from './types.js'

interface XlsxRowData {
  rows: unknown[][]
  columns: number
}

/** Structural subset of 'read-excel-file/node'. */
interface XlsxNodeModule {
  // The node entry ships readXlsxFile as the DEFAULT export (plus the named
  // readSheetNames); normalize both spellings at load time.
  default?: (input: Buffer, options?: { sheet?: number | string }) => Promise<unknown[][]>
  readXlsxFile?: (input: Buffer, options?: { sheet?: number | string }) => Promise<unknown[][]>
  readSheetNames: (input: Buffer) => Promise<string[]>
}

interface ResolvedXlsxModule {
  readXlsxFile(input: Buffer, options?: { sheet?: number | string }): Promise<unknown[][]>
  readSheetNames(input: Buffer): Promise<string[]>
}

let cachedModule: ResolvedXlsxModule | undefined

async function loadXlsx(): Promise<ResolvedXlsxModule> {
  if (!cachedModule) {
    // Node entry (Buffer input + readSheetNames); the bare entry targets
    // browsers and needs DOMParser, which Node lacks. The INDIRECT specifier
    // is deliberate: read-excel-file/node's `unzipper` unpacker statically
    // requires the OPTIONAL @aws-sdk/client-s3 (absent at install time), which
    // breaks bundling when esbuild can resolve the path. An indeterminate
    // specifier stays a runtime import() — resolved from node_modules, where
    // unzipper only touches the AWS path for S3 URLs we never open.
    const nodeEntry = 'read-excel-file/node'
    const imported = (await import(nodeEntry)) as unknown as XlsxNodeModule
    const readXlsxFile = imported.readXlsxFile ?? imported.default
    if (readXlsxFile === undefined) {
      throw new Error('read-excel-file/node did not expose the expected API')
    }
    cachedModule = { readXlsxFile, readSheetNames: input => imported.readSheetNames(input) }
  }
  return cachedModule
}

function renderCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (value instanceof Date) return value.toISOString()
  switch (typeof value) {
    case 'string':
      return value
    case 'number':
    case 'boolean':
      return `${value}`
    // Symbols/bigints stringify; objects/functions have no cell rendering,
    // so they degrade to explicit JSON.
    default: {
      if (typeof value === 'bigint' || typeof value === 'symbol') return value.toString()
      const json = JSON.stringify(value)
      return json
    }
  }
}

async function readSheet(
  module: ResolvedXlsxModule,
  bytes: Uint8Array,
  sheet: number | string | undefined,
  maxRows: number,
): Promise<XlsxRowData> {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const raw: unknown[][] = await module.readXlsxFile(buffer, sheet === undefined ? undefined : { sheet })
  const rows: unknown[][] = []
  let columns = 0
  let sawContentEnd = false
  // Walk from the end to drop fully-empty trailing rows (cosmetic padding).
  for (let i = raw.length - 1; i >= 0; i -= 1) {
    const row = raw[i] ?? []
    const hasValue = row.some(cell => cell !== null && cell !== undefined && cell !== '')
    if (!hasValue && !sawContentEnd) continue
    sawContentEnd = true
    if (rows.length >= maxRows) continue
    rows.push(row)
    columns = Math.max(columns, row.length)
  }
  rows.reverse()
  return { rows, columns }
}

export interface ExtractXlsxOptions {
  /** Sheet selector: 1-based index or workbook name. Undefined = first sheet. */
  sheet?: number | string
  /** Hard cap on rendered rows per sheet (row-cap protection). */
  maxRows?: number
  /**
   * Compute dimensions for EVERY sheet (probe mode) instead of only the
   * selected one (plain read mode).
   */
  allDimensions?: boolean
}

export async function extractXlsx(
  bytes: Uint8Array,
  options: ExtractXlsxOptions = {},
): Promise<{ text: string; overview: DocumentOverview; warnings: string[] }> {
  const warnings: string[] = []
  const module = await loadXlsx()
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)

  // Probe first: names come from the workbook manifest before any body read.
  const sheetNames = await module.readSheetNames(buffer)
  if (sheetNames.length === 0) throw new Error('workbook contains no sheets')

  // Resolve the selector against the enumerated names BEFORE parsing so a bad
  // selector fails fast with an actionable message (a caller-input mistake,
  // hence DocumentInputError — it must not degrade silently).
  let selected: number
  if (options.sheet === undefined) {
    selected = 1
  } else if (typeof options.sheet === 'number') {
    if (!Number.isInteger(options.sheet) || options.sheet < 1 || options.sheet > sheetNames.length) {
      throw new DocumentInputError(
        `sheet index ${options.sheet} out of range (workbook has ${sheetNames.length} sheet(s))`,
      )
    }
    selected = options.sheet
  } else {
    const index = sheetNames.indexOf(options.sheet)
    if (index === -1) {
      throw new DocumentInputError(`no sheet named "${options.sheet}" (sheets: ${sheetNames.join(', ')})`)
    }
    selected = index + 1
  }

  const maxRows = Math.max(1, options.maxRows ?? 50_000)
  const data = await readSheet(module, bytes, selected, maxRows)
  if (data.rows.length > maxRows) warnings.push(`sheet "${sheetNames[selected - 1]}" truncated at ${maxRows} rows`)

  const lines: string[] = [`[sheet: ${sheetNames[selected - 1]}]`]
  for (const row of data.rows) {
    lines.push(row.map(renderCell).join('\t'))
  }

  const dimensionsFor = options.allDimensions === true ? sheetNames.map((_, i) => i + 1) : [selected]
  const sheetDimensions: Array<{ rows: number; columns: number }> = []
  for (const sheetNumber of dimensionsFor) {
    const dim =
      sheetNumber === selected
        ? { rows: data.rows.length, columns: data.columns }
        : await readSheet(module, bytes, sheetNumber, maxRows).then(d => ({
          rows: d.rows.length,
          columns: d.columns,
        }))
    sheetDimensions.push(dim)
  }

  const overview: DocumentOverview = {
    format: 'xlsx',
    sheetNames,
    ...(sheetDimensions.length > 0 ? { sheetDimensions } : {}),
  }
  return { text: lines.join('\n'), overview, warnings }
}
