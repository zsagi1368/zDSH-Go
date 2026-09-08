/**
 * M3 tool-layer suites: registration shapes, read_document happy paths across
 * all four formats, probe-then-read economics, budget truncation with the
 * offset continuation closed loop, path-boundary rejection, workspace
 * listing bounds, and prompt-section guidance.
 */

import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { registerReadingTools } from '../../src/server/tools.js'
import type {
  FilehubToolDefinition,
  ReadingToolsDeps,
  SystemPromptRegistryLike,
  ToolsRegistryLike,
  ToolRunContextLike,
} from '../../src/server/tools.js'
import { ParseCache } from '../../src/server/parse/cache.js'
import { makeDocx, makePdf, makeXlsx } from './parse/zipFixture.client.js'
import { removeTempDir } from './helpers.client.js'

// ---- Harness ----------------------------------------------------------------

interface Captured {
  tools: FilehubToolDefinition[]
  sections: Array<{ name: string; order: number; text: string }>
}

function registerHarness(deps: Partial<ReadingToolsDeps> = {}): {
  captured: Captured
  disposers: Array<() => void>
} {
  const captured: Captured = { tools: [], sections: [] }
  const tools: ToolsRegistryLike = {
    register(definition) {
      captured.tools.push(definition)
      return () => undefined
    },
  }
  const systemPrompt: SystemPromptRegistryLike = {
    section(section) {
      captured.sections.push(section)
      return () => undefined
    },
  }
  const disposers = registerReadingTools({ ...deps, tools, systemPrompt })
  return { captured, disposers }
}

function execFor(cwd: string, signal = new AbortController().signal): ToolRunContextLike {
  return { signal, agent: { session: { header: { cwd } } } }
}

function toolOf(captured: Captured, name: string): FilehubToolDefinition {
  const found = captured.tools.find(t => t.name === name)
  if (!found) throw new Error(`tool ${name} not registered`)
  return found
}

async function writeBytes(root: string, relPath: string, data: Buffer | string): Promise<string> {
  const absolute = path.join(root, relPath)
  await fsp.mkdir(path.dirname(absolute), { recursive: true })
  await fsp.writeFile(absolute, data)
  return absolute
}

const rootsToClean: string[] = []
afterEach(async () => {
  while (rootsToClean.length > 0) {
    const root = rootsToClean.pop()
    if (root) await removeTempDir(root)
  }
})

async function makeWorkspace(): Promise<{ cwd: string; root: string }> {
  const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'filehub-tools-'))
  rootsToClean.push(cwd)
  return { cwd, root: path.join(cwd, '.filehub') }
}

// ---- Registration -----------------------------------------------------------

describe('registration', () => {
  it('registers both tools plus one system-prompt section', () => {
    const { captured, disposers } = registerHarness()
    expect(captured.tools.map(t => t.name).sort()).toEqual(['list_workspace_files', 'read_document'])
    expect(captured.sections).toHaveLength(1)
    expect(captured.sections[0]?.name).toBe('filehub-document-reading')
    // Order 110 sits inside the tool-guidance band (100-199), clear of
    // tool-fs `read`'s own section at 100.
    expect(captured.sections[0]?.order).toBe(110)
    expect(captured.sections[0]?.text).toContain('probe')
    expect(captured.sections[0]?.text).toContain('offset=')
    expect(captured.sections[0]?.text).toContain('sheet')
    for (const disposer of disposers) expect(typeof disposer).toBe('function')
  })

  it('declares the empirically verified contract fields', () => {
    const { captured } = registerHarness()
    const read = toolOf(captured, 'read_document')
    expect(typeof read.description).toBe('string')
    expect(read.parameters?.path).toMatchObject({ type: 'string', required: true })
    expect(read.timeoutMs).toBe(120_000)
    expect(read.isConcurrencySafe?.({})).toBe(true)
    expect(typeof read.output.presentationMeta).toBe('function')

    const list = toolOf(captured, 'list_workspace_files')
    expect(list.parameters).toEqual({}) // implicit open object root, no properties
    expect(list.timeoutMs).toBe(120_000)
    expect(list.isConcurrencySafe?.({})).toBe(true)
  })
})

// ---- read_document ----------------------------------------------------------

describe('read_document / format happy paths', () => {
  it('reads plain text through the workspace boundary', async () => {
    const { cwd, root } = await makeWorkspace()
    const stored = await writeBytes(root, 'notes.txt', 'hello 工作区')
    const { captured } = registerHarness()
    const read = toolOf(captured, 'read_document')

    const value = (await read.execute({ path: 'notes.txt' }, execFor(cwd))) as {
      format: string
      text: string
      totalChars: number
      truncated: boolean
      path: string
    }
    expect(value.format).toBe('text')
    expect(value.text).toBe('hello 工作区')
    expect(value.truncated).toBe(false)
    expect(value.path).toBe(stored)

    const rendered = read.output.render({ path: 'notes.txt' }, value)
    expect(rendered).toHaveLength(1)
    expect(rendered[0]?.type).toBe('text')
    expect(rendered[0]?.text).toContain('<document path=')
    expect(rendered[0]?.text).toContain('hello 工作区')
  })

  it('reads docx paragraphs', async () => {
    const { cwd, root } = await makeWorkspace()
    await writeBytes(root, 'docs/report.docx', makeDocx(['Alpha paragraph', 'Beta 段落']))
    const { captured } = registerHarness()
    const read = toolOf(captured, 'read_document')
    const value = (await read.execute({ path: 'docs/report.docx' }, execFor(cwd))) as {
      format: string
      text: string
      overview: { paragraphCount?: number }
    }
    expect(value.format).toBe('docx')
    expect(value.text).toContain('Alpha paragraph')
    expect(value.text).toContain('Beta 段落')
    expect(value.overview.paragraphCount).toBe(2)
  })

  it('reads xlsx sheets by default, by name, and by index', async () => {
    const { cwd, root } = await makeWorkspace()
    await writeBytes(
      root,
      'tables/book.xlsx',
      makeXlsx([
        { name: 'Summary', rows: [['metric', 'value'], ['revenue', 42]] },
        { name: 'Raw 明细', rows: [['cell-a']] },
      ]),
    )
    const { captured } = registerHarness()
    const read = toolOf(captured, 'read_document')

    const first = (await read.execute({ path: 'tables/book.xlsx' }, execFor(cwd))) as { format: string; text: string }
    expect(first.format).toBe('xlsx')
    expect(first.text).toContain('[sheet: Summary]')
    expect(first.text).toContain('revenue\t42')

    const named = (await read.execute({ path: 'tables/book.xlsx', sheet: 'Raw 明细' }, execFor(cwd))) as { text: string }
    expect(named.text).toContain('[sheet: Raw 明细]')
    expect(named.text).toContain('cell-a')

    const indexed = (await read.execute({ path: 'tables/book.xlsx', sheet: 2 }, execFor(cwd))) as { text: string }
    expect(indexed.text).toContain('[sheet: Raw 明细]')

    const badSheet = read.execute({ path: 'tables/book.xlsx', sheet: 'Missing' }, execFor(cwd))
    await expect(badSheet).rejects.toThrow(/no sheet named "Missing"/)
  })

  it('reads a two-page pdf with page markers', async () => {
    const { cwd, root } = await makeWorkspace()
    await writeBytes(root, 'papers/two.pdf', makePdf(['Intro body', 'Conclusion body']))
    const { captured } = registerHarness()
    const read = toolOf(captured, 'read_document')
    const value = (await read.execute({ path: 'papers/two.pdf' }, execFor(cwd))) as {
      format: string
      text: string
      overview: { pageCount?: number }
    }
    expect(value.format).toBe('pdf')
    expect(value.overview.pageCount).toBe(2)
    expect(value.text).toContain('[page 1]')
    expect(value.text).toContain('Conclusion body')
  })
})

describe('read_document / probe economics', () => {
  it('returns structure without dumping the body', async () => {
    const { cwd, root } = await makeWorkspace()
    await writeBytes(
      root,
      'probe.xlsx',
      makeXlsx([
        { name: 'One', rows: [['a', 'b'], [1, 2]] },
        { name: 'Two', rows: [['c']] },
      ]),
    )
    const { captured } = registerHarness()
    const read = toolOf(captured, 'read_document')
    const args = { path: 'probe.xlsx', probe: true }
    const value = (await read.execute(args, execFor(cwd))) as {
      probe: boolean
      text?: string
      returnedChars: number
      overview: { sheetNames?: string[]; sheetDimensions?: unknown }
    }
    expect(value.probe).toBe(true)
    expect(value.text).toBeUndefined() // NO body dump
    expect(value.returnedChars).toBe(0)
    expect(value.overview.sheetNames).toEqual(['One', 'Two'])
    expect(value.overview.sheetDimensions).toEqual([
      { rows: 2, columns: 2 },
      { rows: 1, columns: 1 },
    ])
    // The model-facing projection shows structure only.
    const rendered = read.output.render(args, value as never)
    expect(rendered[0]?.text).toContain('sheets:')
    expect(rendered[0]?.text).toContain('One (2 rows x 2 columns)')
    expect(rendered[0]?.text).not.toContain('cell-a')
  })

  it('probes pdf page counts and docx paragraphs', async () => {
    const { cwd, root } = await makeWorkspace()
    await writeBytes(root, 'p.pdf', makePdf(['one', 'two', 'three']))
    await writeBytes(root, 'd.docx', makeDocx(['p1', 'p2']))
    const { captured } = registerHarness()
    const read = toolOf(captured, 'read_document')
    const pdfProbe = (await read.execute({ path: 'p.pdf', probe: true }, execFor(cwd))) as {
      overview: { pageCount?: number }
    }
    expect(pdfProbe.overview.pageCount).toBe(3)
    const docxProbe = (await read.execute({ path: 'd.docx', probe: true }, execFor(cwd))) as {
      overview: { paragraphCount?: number }
    }
    expect(docxProbe.overview.paragraphCount).toBe(2)
  })

  it('projects UI-side presentationMeta facts', async () => {
    const { cwd, root } = await makeWorkspace()
    await writeBytes(root, 'meta.pdf', makePdf(['only page']))
    const { captured } = registerHarness()
    const read = toolOf(captured, 'read_document')
    const value = (await read.execute({ path: 'meta.pdf' }, execFor(cwd))) as never
    const meta = read.output.presentationMeta?.({ path: 'meta.pdf' }, value) as {
      path: string
      format: string
      truncated: boolean
      pageCount?: number
    }
    expect(meta.format).toBe('pdf')
    expect(meta.pageCount).toBe(1)
    expect(meta.truncated).toBe(false)
  })
})

describe('read_document / budgets and continuation', () => {
  it('truncates at the format budget with an explicit offset marker, and resuming completes the document', async () => {
    const { cwd, root } = await makeWorkspace()
    // 20k chars of patterned text; text budget default is 8000.
    const original = Array.from({ length: 20_000 }, (_, i) => String.fromCharCode(97 + (i % 26))).join('')
    await writeBytes(root, 'long.txt', original)
    const { captured } = registerHarness({ budgets: { text: 8_000 } })
    const read = toolOf(captured, 'read_document')

    const first = (await read.execute({ path: 'long.txt' }, execFor(cwd))) as {
      truncated: boolean
      text: string
      offset: number
      returnedChars: number
      totalChars: number
      continuationHint?: string
    }
    expect(first.truncated).toBe(true)
    expect(first.offset).toBe(0)
    expect(first.returnedChars).toBe(8_000)
    expect(first.totalChars).toBe(20_000)
    expect(first.continuationHint).toContain('offset=8000')

    const renderedFirst = read.output.render({ path: 'long.txt' }, first)[0]?.text ?? ''
    const markerMatch = /\[truncated at char (\d+) of total (\d+) — call again with offset=(\d+)\]/.exec(renderedFirst)
    expect(markerMatch).not.toBeNull()

    // Follow the marker's instruction verbatim.
    const second = (await read.execute({ path: 'long.txt', offset: 8_000 }, execFor(cwd))) as {
      text: string
      truncated: boolean
      offset: number
    }
    expect(second.offset).toBe(8_000)
    expect(second.truncated).toBe(true)
    // Continuity: the resumed window picks up exactly where the first ended.
    expect(second.text).toBe(original.slice(8_000, 16_000))

    const tail = (await read.execute({ path: 'long.txt', offset: 16_000 }, execFor(cwd))) as {
      text: string
      truncated: boolean
      continuationHint?: string
    }
    expect(tail.truncated).toBe(false)
    expect(tail.continuationHint).toBeUndefined()
    expect(tail.text).toBe(original.slice(16_000))
    // Whole-document reconstruction equals the source.
    expect(first.text + second.text + tail.text).toBe(original)
  })

  it('clamps limit to the per-format budget', async () => {
    const { cwd, root } = await makeWorkspace()
    await writeBytes(root, 'big.pdf', makePdf(['word '.repeat(4000)]))
    const { captured } = registerHarness()
    const read = toolOf(captured, 'read_document')
    const greedy = (await read.execute({ path: 'big.pdf', limit: 999_999 }, execFor(cwd))) as {
      returnedChars: number
      truncated: boolean
    }
    expect(greedy.returnedChars).toBeLessThanOrEqual(4_000) // pdf budget
  })

  it('serves repeat reads from the parse cache (single underlying parse)', async () => {
    const { cwd, root } = await makeWorkspace()
    await writeBytes(root, 'cached.txt', 'stable content')
    const cache = new ParseCache()
    const { captured } = registerHarness({ cache })
    const read = toolOf(captured, 'read_document')
    const a = await read.execute({ path: 'cached.txt' }, execFor(cwd))
    const b = await read.execute({ path: 'cached.txt' }, execFor(cwd))
    expect(cache.size).toBe(1)
    expect(b).toEqual(a)
    // Same bytes under a different name still hit (content-addressed key).
    await writeBytes(root, 'alias.txt', 'stable content')
    await read.execute({ path: 'alias.txt' }, execFor(cwd))
    expect(cache.size).toBe(1)
  })
})

describe('read_document / boundaries and failures', () => {
  it('rejects traversal outside the upload workspace', async () => {
    const { cwd } = await makeWorkspace()
    const { captured } = registerHarness()
    const read = toolOf(captured, 'read_document')
    await expect(
      read.execute({ path: '../../outside.txt' }, execFor(cwd)),
    ).rejects.toThrow('target path escapes the session workspace')
  })

  it('rejects absolute paths outside the workspace', async () => {
    const { cwd } = await makeWorkspace()
    const outside = await writeBytes(os.tmpdir(), `filehub-outside-${Date.now()}.txt`, 'secret')
    rootsToClean.push(path.dirname(outside))
    const { captured } = registerHarness()
    const read = toolOf(captured, 'read_document')
    await expect(read.execute({ path: outside }, execFor(cwd))).rejects.toThrow(
      'target path escapes the session workspace',
    )
  })

  it('fails with actionable errors for missing/directory targets and missing sessions', async () => {
    const { cwd, root } = await makeWorkspace()
    await fsp.mkdir(path.join(root, 'folder'), { recursive: true })
    const { captured } = registerHarness()
    const read = toolOf(captured, 'read_document')
    await expect(read.execute({ path: 'nope.txt' }, execFor(cwd))).rejects.toThrow('document not found')
    await expect(read.execute({ path: 'folder' }, execFor(cwd))).rejects.toThrow('not a regular file')
    await expect(
      read.execute({ path: 'folder' }, { signal: new AbortController().signal }),
    ).rejects.toThrow('no session workspace is bound to this call')
    void cwd
  })

  it('validates argument types defensively', async () => {
    const { cwd, root } = await makeWorkspace()
    await writeBytes(root, 'x.txt', 'content')
    const { captured } = registerHarness()
    const read = toolOf(captured, 'read_document')
    await expect(read.execute({}, execFor(cwd))).rejects.toThrow('path must be a non-empty string')
    await expect(read.execute({ path: 'x.txt', offset: -1 }, execFor(cwd))).rejects.toThrow(
      'offset must be an integer >= 0',
    )
    // A bogus `probe` value is coerced (=== true is the only probe mode).
    const value = (await read.execute({ path: 'x.txt', probe: 'yes' }, execFor(cwd))) as { text?: string }
    expect(value.text).toContain('content')
  })
})

// ---- list_workspace_files ---------------------------------------------------

describe('list_workspace_files', () => {
  it('lists sorted relative entries with kinds and sizes', async () => {
    const { cwd, root } = await makeWorkspace()
    await writeBytes(root, 'b.txt', '12345')
    await writeBytes(root, 'sub/a.txt', 'x')
    await fsp.mkdir(path.join(root, 'empty-dir'), { recursive: true })
    const { captured } = registerHarness()
    const list = toolOf(captured, 'list_workspace_files')
    const value = (await list.execute({}, execFor(cwd))) as {
      entries: Array<{ path: string; kind: string; sizeBytes: number }>
      truncated: boolean
      total: number
    }
    expect(value.entries.map(e => e.path)).toEqual(['b.txt', 'empty-dir', 'sub', 'sub/a.txt'])
    expect(value.entries.find(e => e.path === 'b.txt')).toMatchObject({ kind: 'file', sizeBytes: 5 })
    expect(value.entries.find(e => e.path === 'empty-dir')).toMatchObject({ kind: 'directory' })
    expect(value.truncated).toBe(false)
    const rendered = list.output.render({}, value)[0]
    expect(rendered?.text).toContain('- b.txt (file, 5 bytes)')
  })

  it('caps at 500 entries with an explicit truncated flag', async () => {
    const { cwd, root } = await makeWorkspace()
    await Promise.all(
      Array.from({ length: 505 }, (_, i) =>
        writeBytes(root, `bulk/f${String(i).padStart(4, '0')}.txt`, String(i)),
      ),
    )
    const { captured } = registerHarness()
    const list = toolOf(captured, 'list_workspace_files')
    const value = (await list.execute({}, execFor(cwd))) as {
      entries: unknown[]
      truncated: boolean
      total: number
    }
    expect(value.entries).toHaveLength(500)
    expect(value.truncated).toBe(true)
    // `total` is a lower bound once the page is full (the walk stops descending).
    expect(value.total).toBeGreaterThanOrEqual(505)
    const rendered = list.output.render({}, value as never)[0]
    expect(rendered?.text).toContain('[truncated')
  })

  it('degrades to an empty listing when the workspace does not exist', async () => {
    const { cwd } = await makeWorkspace()
    const { captured } = registerHarness()
    const list = toolOf(captured, 'list_workspace_files')
    const value = (await list.execute({}, execFor(cwd))) as { entries: unknown[]; truncated: boolean }
    expect(value.entries).toEqual([])
    expect(value.truncated).toBe(false)
  })
})

// ---- Presentation -----------------------------------------------------------

describe('presenters', () => {
  it('renders generic call/result views per the verified vocabulary', async () => {
    const { cwd, root } = await makeWorkspace()
    await writeBytes(root, 'view.txt', 'visible')
    const { captured } = registerHarness()
    const read = toolOf(captured, 'read_document')

    const callView = read.presentCall?.({ path: 'view.txt' })
    expect(callView).toMatchObject({ card: 'generic', title: 'Read document view.txt', kind: 'read' })

    const value = (await read.execute({ path: 'view.txt' }, execFor(cwd)))
    const content = read.output.render({ path: 'view.txt' }, value)
    const resultView = read.presentResult?.({ path: 'view.txt' }, {
      content,
      isError: false,
    })
    expect(resultView).toMatchObject({ card: 'generic', title: 'Read view.txt' })
    expect(resultView?.content?.[0]?.text).toContain('visible')

    const list = toolOf(captured, 'list_workspace_files')
    expect(list.presentCall?.({})).toMatchObject({ card: 'generic', kind: 'search' })
  })
})
