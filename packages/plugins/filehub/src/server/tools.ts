/**
 * M3 AI document-reading tools (P01 §6-C FR-C5..C8): `read_document`,
 * `list_workspace_files`, and their system-prompt guidance.
 *
 * EMPIRICAL CONTRACT (clean-room notes — every field below was verified
 * against the Fork sources before being written here; nothing invented):
 *
 * - Tool option fields — `packages/core/tools/lib/types/schema.d.ts`
 *   (`DefineToolOptions`): name / description / parameters /
 *   output.{schema, render(args,value), presentationMeta?(args,value)} /
 *   timeoutMs? / isConcurrencySafe?(args) / execute(args, exec) /
 *   presentCall?(args) / presentResult?(args, result). `defineTool(options)`
 *   validates and returns a registry-ready definition.
 * - Parameter DSL (same file): an IMPLICIT OPEN OBJECT root
 *   (`ParameterSchemaSpec`); requiredness is a per-property `required: true`
 *   annotation; unions via `oneOf` with >= 2 branches.
 * - Execution context — `packages/core/tools/lib/types/index.d.ts`
 *   (`ToolRunContext extends ToolExecution`): `signal: AbortSignal` (caller-
 *   owned cancellation), `agent?: Agent`. How a tool finds the caller's
 *   session cwd was verified against `packages/fs/tool-fs/src/session-cwd.ts`:
 *   `exec.agent?.session.header.cwd`.
 * - Presentation vocabulary — `packages/core/tools/lib/types/presentation.d.ts`:
 *   `GenericCallView { card:'generic', title, kind?, rawInput?, locations? }`
 *   and `GenericResultView { card:'generic', title?, content? }`; text
 *   content blocks are `{ type:'text', text }`.
 * - System prompt — `packages/core/system-prompt/lib/types/index.d.ts`
 *   (`SystemPrompt.section(section: PromptSection)`): `{ name, order, text }`,
 *   ascending concatenation; tool guidance conventionally orders 100–199
 *   (`tool-fs` read registers order 100, hence this domain's 110).
 *
 * This module deliberately declares STRUCTURAL mirrors instead of importing
 * the peer packages: package.json marks every @deepseek-ai dependency optional
 * (peerDependenciesMeta) and M0/M1 guarantee the plugin loads on a bare
 * context, degrading loudly when a service is absent. The registered objects
 * are field-for-field the shapes above, so a host composing the real
 * `ctx.tools.register` / `ctx.systemPrompt.section` accepts them unchanged.
 */

import fsp from 'node:fs/promises'
import path from 'node:path'

import { ParseCache } from './parse/cache.js'
import { parseDocument, ParseAbortedError } from './parse/waterfall.js'
import { sniff } from '../detect.js'
import { assertInside, isStrictlyInside } from './pathPolicy.js'
import type { DocumentFormat, DocumentOverview } from './parse/types.js'

// ---------------------------------------------------------------------------
// Structural seams over the host services (verified shapes, see header note).
// ---------------------------------------------------------------------------

/** Minimal lossless-JSON value type these tools traffic in. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue }

/** Text content block (subset of dsh-llm ContentBlock). */
export interface TextBlock {
  type: 'text'
  text: string
}

/**
 * Mirror of `DefineToolOptions` (see header note). Loose generics on purpose:
 * argument validation is performed by the HOST's defineTool/validateArgs;
 * this side narrows defensively after casting.
 */
export interface FilehubToolDefinition {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, Record<string, unknown>>
  readonly output: {
    readonly schema: Record<string, unknown>
    render(args: unknown, value: JsonValue): TextBlock[]
    presentationMeta?(args: unknown, value: JsonValue): JsonValue
  }
  readonly timeoutMs?: number
  isConcurrencySafe?(args: unknown): boolean
  execute(args: unknown, exec: ToolRunContextLike): Promise<JsonValue>
  presentCall?(args: unknown): GenericCallView | undefined
  presentResult?(args: unknown, result: ToolResultLike): GenericResultView | undefined
}

/** Verified execution-context subset (ToolRunContext: signal + agent chain). */
export interface ToolRunContextLike {
  readonly signal: AbortSignal
  readonly agent?: { readonly session?: { readonly header?: { readonly cwd?: string } } }
}

/** presentation.d.ts GenericCallView subset. */
export interface GenericCallView {
  card: 'generic'
  title: string
  kind?: 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'fetch' | 'other'
  rawInput?: unknown
  locations?: Array<{ path: string; line?: number }>
}

/** presentation.d.ts GenericResultView subset + ToolResult facets it reads. */
export interface GenericResultView {
  card: 'generic'
  title?: string
  content?: TextBlock[]
}
export interface ToolResultLike {
  content: Array<{ type: string; text?: string }>
  isError: boolean
  meta?: JsonValue
}

/** Identity helper shaped exactly like the host's defineTool usage. */
export function defineTool(definition: FilehubToolDefinition): FilehubToolDefinition {
  return definition
}

export interface ToolsRegistryLike {
  register(definition: FilehubToolDefinition): () => void
}

export interface SystemPromptRegistryLike {
  /** PromptSection { name, order, text } — verified system-prompt signature. */
  section(section: { name: string; order: number; text: string }): () => void
}

// ---------------------------------------------------------------------------
// Budgets + windowing
// ---------------------------------------------------------------------------

/** Per-format character budgets (FR-C6 defaults; configurable). */
export interface ReadingBudgets {
  text: number
  xlsx: number
  pdf: number
  docx: number
  binary: number
}

export const DEFAULT_BUDGETS: ReadingBudgets = {
  text: 8_000,
  xlsx: 6_000,
  pdf: 4_000,
  docx: 4_000,
  binary: 2_000,
}

export function resolveBudgets(overrides?: Partial<ReadingBudgets>): ReadingBudgets {
  return { ...DEFAULT_BUDGETS, ...overrides }
}

function budgetFor(budgets: ReadingBudgets, format: DocumentFormat): number {
  return format in budgets ? budgets[format] : DEFAULT_BUDGETS.text
}

export const TRUNCATION_MARKER_PREFIX = '[truncated at char '

/** Explicit continuation guidance appended whenever a window cut content. */
export function truncationMarker(_start: number, end: number, total: number): string {
  return `${TRUNCATION_MARKER_PREFIX}${end} of total ${total} — call again with offset=${end}]`
}

export interface TextWindow {
  slice: string
  start: number
  end: number
  total: number
  truncated: boolean
  marker?: string
}

/**
 * Char-window a body into [offset, offset+limit), clamped to the document,
 * with the explicit continuation marker when content remains beyond the cut.
 */
export function windowText(text: string, offset: number, limit: number): TextWindow {
  const total = text.length
  const start = Math.min(Math.max(0, Math.floor(offset)), total)
  const end = Math.min(start + Math.max(1, Math.floor(limit)), total)
  const slice = text.slice(start, end)
  const truncated = end < total
  return {
    slice,
    start,
    end,
    total,
    truncated,
    ...(truncated ? { marker: truncationMarker(start, end, total) } : {}),
  }
}

// ---------------------------------------------------------------------------
// Path boundary (v1: reads are confined to this session's upload workspace)
// ---------------------------------------------------------------------------

/**
 * Resolve a tool-supplied path against the CALLING session's upload workspace
 * and enforce containment.
 *
 * v1 BOUNDARY: only files under `<session cwd>/.filehub/` (the FileHub upload
 * workspace) are readable. A future milestone may widen this to the whole
 * session cwd (the `tool-fs` read surface already covers plain project files);
 * widening means relaxing ONLY this function — every other layer keys off it.
 */
export function resolveWorkspaceTarget(
  sessionCwd: string,
  storageDirName: string,
  requested: string,
): string {
  const root = path.join(path.resolve(sessionCwd), storageDirName)
  const candidate = path.isAbsolute(requested) ? requested : path.join(root, requested)
  // Throws PathPolicyError ('target path escapes the session workspace') on
  // traversal, sibling-prefix confusion, and cross-drive absolutes alike.
  assertInside(root, candidate)
  return path.resolve(candidate)
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export interface ReadingToolsDeps {
  /** Optional; defaults to a no-op sink when the host logger is absent. */
  logWarn?: (message: string) => void
  /** Upload-workspace directory name under the session cwd. */
  storageDirName?: string
  cache?: ParseCache
  budgets?: Partial<ReadingBudgets> | undefined
}

const READ_DOCUMENT_TIMEOUT_MS = 120_000

interface ReadDocumentArgs {
  path?: unknown
  offset?: unknown
  limit?: unknown
  sheet?: unknown
  probe?: unknown
}

function coerceArgs(raw: unknown): ReadDocumentArgs {
  return typeof raw === 'object' && raw !== null ? (raw) : {}
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} must be a non-empty string`)
  }
  return value
}

function coerceOptionalInteger(value: unknown, name: string, minimum: number): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer >= ${minimum}`)
  }
  return value
}

/** Canonical string for the cache key's options component. */
function optionsKeyOf(sheet: string | number | undefined, probe: boolean): string {
  return `probe=${probe ? 1 : 0};sheet=${sheet === undefined ? '-' : String(sheet)}`
}

function sessionCwdOf(exec: ToolRunContextLike): string {
  const cwd = exec.agent?.session?.header?.cwd
  if (typeof cwd !== 'string' || cwd === '') {
    throw new Error('no session workspace is bound to this call')
  }
  return cwd
}

async function readWorkspaceFile(
  target: string,
  root: string,
  signal: AbortSignal,
): Promise<{ bytes: Buffer; sizeBytes: number }> {
  let stat
  try {
    stat = await fsp.stat(target)
  } catch {
    throw new Error(`document not found: ${target}`)
  }
  if (!stat.isFile()) throw new Error(`not a regular file: ${target}`)
  // M6 adversarial fix (round 1): re-assert containment on REAL paths so a
  // directory symlink/junction planted inside the workspace cannot carry the
  // read outside it. The lexical assertInside in resolveWorkspaceTarget still
  // applies upstream; this closes the one hole lexical resolution cannot see.
  try {
    const [realRoot, realTarget] = await Promise.all([fsp.realpath(root), fsp.realpath(target)])
    if (!isStrictlyInside(realRoot, realTarget)) {
      throw new Error('target path escapes the session workspace')
    }
  } catch (error: unknown) {
    if (error instanceof Error && error.message.includes('escapes the session workspace')) throw error
    throw new Error(`document not found: ${target}`)
  }
  // Defense-in-depth ceiling (uploads are already bounded at 50 MiB upstream).
  if (stat.size > 64 * 1024 * 1024) throw new Error('document exceeds the 64 MiB read ceiling')
  try {
    const bytes = await fsp.readFile(target, { signal })
    return { bytes, sizeBytes: bytes.length }
  } catch (error) {
    if (error instanceof ParseAbortedError || (error instanceof Error && error.name === 'AbortError')) {
      throw error
    }
    throw new Error(`failed to read document: ${String(error)}`)
  }
}

/** Model-facing text envelope for one non-probe read. */
export function buildDocumentBody(value: {
  path: string
  format: DocumentFormat
  window: TextWindow
}): string {
  const lines = [
    `<document path="${value.path}" format="${value.format}" chars ${value.window.start}-${value.window.end} of ${value.window.total}>`,
    value.window.slice,
    '</document>',
  ]
  if (value.window.marker !== undefined) lines.push(value.window.marker)
  return lines.join('\n')
}

/** Model-facing overview block for probe calls (structure only, never body). */
export function buildProbeBody(value: {
  path: string
  format: DocumentFormat
  overview: DocumentOverview
}): string {
  const overview = value.overview
  const lines = [`<document-overview path="${value.path}" format="${overview.format}">`]
  switch (overview.format) {
    case 'pdf':
      lines.push(`pages: ${overview.pageCount ?? 0}`)
      break
    case 'xlsx':
      lines.push('sheets:')
      ;(overview.sheetNames ?? []).forEach((name, i) => {
        const dim = overview.sheetDimensions?.[i]
        lines.push(`  ${i + 1}. ${name}${dim ? ` (${dim.rows} rows x ${dim.columns} columns)` : ''}`)
      })
      lines.push('read with sheet: "<exact name>" or sheet: <1-based index>')
      break
    case 'docx':
      lines.push(`paragraphs: ${overview.paragraphCount ?? 0}`)
      break
    case 'binary':
      lines.push('this file carries no extractable document text')
      break
    default:
      lines.push('structure facts only; call with probe: false to read the content')
  }
  lines.push('</document-overview>')
  if (overview.format !== 'binary') {
    lines.push('call again with probe: false (and offset/limit) to read the content')
  }
  return lines.join('\n')
}

/**
 * Compose and register the M3 reading tools + prompt section. Returns the
 * disposers so wiring code stays effect-shaped.
 */
export function registerReadingTools(
  deps: ReadingToolsDeps & {
    tools: ToolsRegistryLike
    systemPrompt: SystemPromptRegistryLike
  },
): Array<() => void> {
  const disposers: Array<() => void> = []
  const storageDirName = deps.storageDirName ?? '.filehub'
  const budgets = resolveBudgets(deps.budgets)
  const cache = deps.cache ?? new ParseCache()
  const logWarn = deps.logWarn ?? ((): void => {})

  // ---- system-prompt guidance (order 110; read's own section sits at 100) --
  disposers.push(
    deps.systemPrompt.section({
      name: 'filehub-document-reading',
      order: 110,
      text: [
        'Documents uploaded through FileHub live in the session workspace and are read with the read_document tool.',
        'Workflow: run list_workspace_files when unsure what exists; call read_document with probe: true FIRST to see structure',
        '(pdf pages, xlsx sheet names with row/column counts, docx paragraphs, text length), then read bodies in windows.',
        'When a result ends with "[truncated at char N of total M — call again with offset=N]", continue with offset=N.',
        'Do not repeat a window you already read. For spreadsheets select one sheet per call:',
        'sheet: "Exact Sheet Name" or sheet: <1-based index>; probe lists the available names first.',
        'Text results carry up to ~8000 characters, spreadsheets ~6000, pdf/docx ~4000 — plan multi-pass reads for long documents.',
        'Paths outside the session upload workspace are rejected.',
      ].join(' '),
    }),
  )

  // ---- read_document --------------------------------------------------------
  disposers.push(
    deps.tools.register(
      defineTool({
        name: 'read_document',
        description:
          'Read a document uploaded into the session workspace: plain text (utf-8/utf-16/gb18030), PDF, DOCX or XLSX. ' +
          'Use probe: true to inspect structure first; read bodies in windows guided by the truncation marker.',
        parameters: {
          path: { type: 'string', required: true, description: 'File path inside the session upload workspace (absolute, or relative to the workspace root).' },
          offset: { type: 'integer', description: '0-based character offset to start reading from. Defaults to 0.' },
          limit: { type: 'integer', description: 'Maximum characters to return; clamped to the per-format budget.' },
          sheet: {
            oneOf: [{ type: 'string' }, { type: 'integer' }],
            description: 'xlsx only: worksheet selector — exact sheet name (recommended) or 1-based index. Omit for the first sheet.',
          },
          probe: { type: 'boolean', description: 'Return the structure overview (pages/sheets/paragraphs/length) WITHOUT dumping the body. Default false.' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              path: { type: 'string', required: true },
              format: { type: 'string', required: true },
              probe: { type: 'boolean', required: true },
              offset: { type: 'integer', required: true },
              returnedChars: { type: 'integer', required: true },
              totalChars: { type: 'integer', required: true },
              truncated: { type: 'boolean', required: true },
              text: { type: 'string', description: 'The extracted window; omitted for probe calls.' },
              overview: { type: 'json', description: 'Structure overview; present for probe calls (and compact facts otherwise).' },
              continuationHint: { type: 'string', description: 'Present when truncated: the exact follow-up call to make.' },
            },
          },
          render: (_args, rawValue) => {
            const v = rawValue as unknown as {
              path: string
              format: DocumentFormat
              probe: boolean
              offset: number
              text?: string
              totalChars: number
              overview?: DocumentOverview
              continuationHint?: string
            }
            const body = v.probe
              ? buildProbeBody({ path: v.path, format: v.format, overview: v.overview ?? { format: v.format } })
              : buildDocumentBody({
                path: v.path,
                format: v.format,
                window: {
                  slice: v.text ?? '',
                  start: v.offset,
                  end: v.offset + (v.text?.length ?? 0),
                  total: v.totalChars,
                  truncated: v.continuationHint !== undefined,
                  ...(v.continuationHint !== undefined
                    ? { marker: `[truncated at char ${v.offset + (v.text?.length ?? 0)} of total ${v.totalChars} — call again with offset=${v.offset + (v.text?.length ?? 0)}]` }
                    : {}),
                },
              })
            return [{ type: 'text', text: body }]
          },
          presentationMeta: (_args, rawValue) => {
            // UI-side structured projection (persisted for replay): page/table
            // facts + truncation state, mirroring how tool-fs projects its
            // read window through output.presentationMeta.
            const v = rawValue as unknown as {
              path: string
              format: DocumentFormat
              probe: boolean
              offset: number
              returnedChars: number
              totalChars: number
              truncated: boolean
              overview?: DocumentOverview
            }
            const overview = v.overview ?? { format: v.format }
            return {
              path: v.path,
              format: v.format,
              probe: v.probe,
              offset: v.offset,
              returnedChars: v.returnedChars,
              totalChars: v.totalChars,
              truncated: v.truncated,
              ...(overview.pageCount !== undefined ? { pageCount: overview.pageCount } : {}),
              ...(overview.sheetNames !== undefined
                ? {
                  sheets: overview.sheetNames.map((name: string, i: number) => ({
                    name,
                    ...(overview.sheetDimensions?.[i] ?? {}),
                  })),
                }
                : {}),
              ...(overview.paragraphCount !== undefined ? { paragraphCount: overview.paragraphCount } : {}),
            }
          },
        },
        timeoutMs: READ_DOCUMENT_TIMEOUT_MS,
        isConcurrencySafe: () => true,
        async execute(rawArgs, exec) {
          const args = coerceArgs(rawArgs)
          const requestedPath = requireString(args.path, 'path')
          const offset = coerceOptionalInteger(args.offset, 'offset', 0) ?? 0
          const limitArg = coerceOptionalInteger(args.limit, 'limit', 1)
          const probe = args.probe === true
          const sheet =
            typeof args.sheet === 'string'
              ? args.sheet
              : typeof args.sheet === 'number'
                ? args.sheet
                : undefined

          const sessionCwd = sessionCwdOf(exec)
          const target = resolveWorkspaceTarget(sessionCwd, storageDirName, requestedPath)
          const workspaceRoot = path.join(path.resolve(sessionCwd), storageDirName)

          const { bytes } = await readWorkspaceFile(target, workspaceRoot, exec.signal)
          const verdict = sniff(bytes, path.basename(target))
          // Cache key: sha256(content) + format + canonical options (FR-C7).
          const cacheKey = ParseCache.keyOf(bytes, verdict.mime, optionsKeyOf(sheet, probe))
          const doc = await cache.wrap(cacheKey, () =>
            parseDocument(bytes, path.basename(target), {
              log: { warn: logWarn },
              signal: exec.signal,
              // xlsx selectors ride into the waterfall; probe mode additionally
              // computes dimensions for every sheet (probe-then-read economics).
              ...(sheet !== undefined ? { sheet } : {}),
              allSheetDimensions: probe,
            }),
          )

          if (probe) {
            return {
              path: target,
              format: doc.format,
              probe: true,
              offset: 0,
              returnedChars: 0,
              totalChars: doc.text.length,
              truncated: false,
              overview: doc.overview as unknown as JsonValue,
            }
          }

          const budget = budgetFor(budgets, doc.format)
          const window_ = windowText(doc.text, offset, Math.min(limitArg ?? budget, budget))
          return {
            path: target,
            format: doc.format,
            probe: false,
            offset: window_.start,
            returnedChars: window_.slice.length,
            totalChars: window_.total,
            truncated: window_.truncated,
            text: window_.slice,
            ...(window_.truncated
              ? {
                continuationHint: `call read_document with offset=${window_.end}` +
                    (doc.format === 'xlsx' && sheet !== undefined ? ` and sheet: ${JSON.stringify(sheet)}` : ''),
              }
              : {}),
            overview: doc.overview as unknown as JsonValue,
          }
        },
        presentCall(args) {
          const a = coerceArgs(args)
          const target = typeof a.path === 'string' ? a.path : '(unresolved)'
          return {
            card: 'generic',
            title: `Read document ${target}${a.probe === true ? ' (probe)' : ''}`,
            kind: 'read',
            locations: [{ path: target }],
          }
        },
        presentResult(_args, result) {
          if (result.isError) return undefined
          const only = result.content.length === 1 ? result.content[0] : undefined
          const text = only?.type === 'text' ? (only.text ?? '') : undefined
          if (text === undefined) return undefined
          const a = coerceArgs(_args)
          const target = typeof a.path === 'string' ? a.path : ''
          return {
            card: 'generic',
            title: `Read ${target}`,
            content: [{ type: 'text', text }],
          }
        },
      }),
    ),
  )

  // ---- list_workspace_files -------------------------------------------------
  disposers.push(
    deps.tools.register(
      defineTool({
        name: 'list_workspace_files',
        description:
          'List the files in the current session\'s upload workspace (bounded to 500 entries with an explicit truncated flag).',
        parameters: {},
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              entries: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    path: { type: 'string', required: true },
                    kind: { type: 'string', required: true },
                    sizeBytes: { type: 'integer', required: true },
                  },
                },
              },
              truncated: { type: 'boolean', required: true },
              total: { type: 'integer', required: true },
            },
          },
          render: (_args, value) => {
            const v = value as { entries: Array<{ path: string; kind: string; sizeBytes: number }>; truncated: boolean; total: number }
            const lines = v.entries.map(entry => `- ${entry.path} (${entry.kind}, ${entry.sizeBytes} bytes)`)
            if (v.truncated) lines.push(`[truncated — showing ${v.entries.length} of at least ${v.total} entries]`)
            if (lines.length === 0) lines.push('(workspace is empty)')
            return [{ type: 'text', text: lines.join('\n') }]
          },
          presentationMeta: (_args, value) => value,
        },
        timeoutMs: READ_DOCUMENT_TIMEOUT_MS,
        isConcurrencySafe: () => true,
        async execute(rawArgs, exec) {
          void rawArgs
          const sessionCwd = sessionCwdOf(exec)
          const root = path.join(path.resolve(sessionCwd), storageDirName)

          interface Collected {
            relPath: string
            isDirectory: boolean
            sizeBytes: number
          }
          const MAX_LIST_ENTRIES = 500
          const MAX_WALK_DEPTH = 24
          const collected: Collected[] = []
          let truncated = false
          let total = 0

          const visit = async (directory: string, depth: number): Promise<void> => {
            if (truncated || depth > MAX_WALK_DEPTH) return
            let dirents
            try {
              dirents = await fsp.readdir(directory, { withFileTypes: true })
            } catch {
              return
            }
            // Once the page is full we stop COLLECTING and descending, but keep
            // counting this directory so `total` stays a meaningful lower bound.
            for (const dirent of dirents) {
              total += 1
              if (collected.length >= MAX_LIST_ENTRIES) {
                truncated = true
                continue
              }
              const absolute = path.join(directory, dirent.name)
              const relPath = path.relative(root, absolute).replace(/\\/g, '/')
              if (dirent.isDirectory()) {
                collected.push({ relPath, isDirectory: true, sizeBytes: 0 })
                await visit(absolute, depth + 1)
              } else if (dirent.isFile()) {
                let sizeBytes = 0
                try {
                  sizeBytes = (await fsp.stat(absolute)).size
                } catch {
                  sizeBytes = 0
                }
                collected.push({ relPath, isDirectory: false, sizeBytes })
              }
              if (collected.length >= MAX_LIST_ENTRIES) truncated = true
            }
          }
          await visit(root, 0)

          collected.sort((a, b) => (a.relPath < b.relPath ? -1 : 1))
          return {
            entries: collected.map(entry => ({
              path: entry.relPath,
              kind: entry.isDirectory ? 'directory' : 'file',
              sizeBytes: entry.sizeBytes,
            })),
            truncated,
            total,
          }
        },
        presentCall() {
          return { card: 'generic', title: 'List workspace files', kind: 'search' }
        },
      }),
    ),
  )

  return disposers
}
