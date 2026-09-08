/**
 * Mention pipeline tests (P01 §6-B FR-B3..FR-B6): token grammar matrix,
 * existence validation, structured injection over a fake pre-step waterfall,
 * search endpoint scoring + double-source merge.
 */
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  createMentionInjector,
  createSearchHandler,
  mergeSearchEntries,
  renderReferenceTags,
  scanMentionTokens,
  validateMentionToken,
} from '../../src/server/mention.js'
import type { MentionValidation } from '../../src/server/mention.js'
import { createMemoryMetaStore } from '../../src/server/meta.js'
import type { HttpHandler } from '../../src/server/upload.js'
import { createWorkspaceIndexer, createWorkspaceResolver } from '../../src/server/workspace.js'
import type { SessionsLike } from '../../src/server/workspace.js'

async function makeWorkspace(label: string): Promise<string> {
  const cwd = path.join(os.tmpdir(), `filehub-m-${label}-${process.pid.toString(36)}-${Math.random().toString(36).slice(2, 8)}`)
  await fsp.mkdir(cwd, { recursive: true })
  return cwd
}

/** Narrow the invalid arm for reason assertions. */
function reasonOf(validation: MentionValidation): string {
  if (validation.status === 'ok') return 'ok'
  return validation.reason
}

describe('scanMentionTokens', () => {
  it('matches word-initial tokens only', () => {
    const tokens = scanMentionTokens('see @src/app.ts and @docs')
    expect(tokens.map(token => token.value)).toEqual(['src/app.ts', 'docs'])
    expect(tokens[0]).toMatchObject({ start: 4, end: 15, quoted: false })
  })

  it('never triggers inside an email address', () => {
    expect(scanMentionTokens('mail me at user@example.com')).toEqual([])
    expect(scanMentionTokens('contact a@b')).toEqual([])
  })

  it('scans quoted tokens with spaces and stops cleanly', () => {
    const tokens = scanMentionTokens('@"docs/my notes.md" plus @plain.txt')
    expect(tokens).toHaveLength(2)
    expect(tokens[0]).toMatchObject({ value: 'docs/my notes.md', quoted: true })
    expect(tokens[1]?.value).toBe('plain.txt')
  })

  it('ignores unterminated quotes and mid-word @', () => {
    expect(scanMentionTokens('@"unfinished')).toEqual([])
    expect(scanMentionTokens('word@tail')).toEqual([])
  })

  it('finds repeated tokens independently (multi occurrence)', () => {
    const tokens = scanMentionTokens('@a.md then @a.md again')
    expect(tokens).toHaveLength(2)
    expect((tokens[1]?.start ?? 0)).toBeGreaterThan(tokens[0]!.start)
  })
})

describe('validateMentionToken', () => {
  let workspaceRoots: string[] = []

  afterEach(async () => {
    const roots = workspaceRoots
    workspaceRoots = []
    for (const root of roots) await fsp.rm(root, { recursive: true, force: true }).catch(() => undefined)
  })

  it('accepts existing files and directories, normalizing separators', async () => {
    const cwd = await makeWorkspace('valid')
    workspaceRoots.push(cwd)
    await fsp.mkdir(path.join(cwd, 'sub'))
    await fsp.writeFile(path.join(cwd, 'sub', 'a.ts'), 'content-marker')

    const file = await validateMentionToken('sub/a.ts', cwd)
    expect(file).toMatchObject({ status: 'ok', kind: 'file', path: 'sub/a.ts' })
    const dir = await validateMentionToken('sub/', cwd)
    expect(dir.status === 'ok' && dir.kind).toBe('directory')
  })

  it('rejects absolute paths outright', async () => {
    const cwd = await makeWorkspace('absolute')
    workspaceRoots.push(cwd)
    expect((await validateMentionToken('/etc/passwd', cwd)).status).toBe('invalid')
    expect(reasonOf(await validateMentionToken('/etc/passwd', cwd))).toBe('absolute')
    expect(reasonOf(await validateMentionToken('C:\\Windows\\system32', cwd))).toBe('absolute')
    expect(reasonOf(await validateMentionToken('', cwd))).toBe('absolute')
  })

  it('rejects .. escapes after resolve', async () => {
    const cwd = await makeWorkspace('escape')
    workspaceRoots.push(cwd)
    const outsideDir = path.join(path.dirname(cwd), `outside-${Math.random().toString(36).slice(2, 6)}`)
    await fsp.mkdir(outsideDir, { recursive: true }).catch(() => undefined)
    try {
      expect(reasonOf(await validateMentionToken('../outside-should-not-exist-but-parent-walks', cwd))).toBe('escapes-workspace')
      // Point at the REAL sibling to prove the escape is caught even when the target exists.
      const siblingName = path.basename(outsideDir)
      expect(await validateMentionToken(`../${siblingName}`, cwd)).toMatchObject({ status: 'invalid', reason: 'escapes-workspace' })
      expect(reasonOf(await validateMentionToken('a/../../b', cwd))).toBe('escapes-workspace')
      // A path whose '..' resolves back INSIDE the workspace is fine structurally
      // (missing target → not-found, not an escape).
      expect(reasonOf(await validateMentionToken('./sub/../x', cwd))).toBe('not-found')
    } finally {
      await fsp.rm(outsideDir, { recursive: true, force: true }).catch(() => undefined)
    }
  })

  it('reports not-found for missing targets', async () => {
    const cwd = await makeWorkspace('missing')
    workspaceRoots.push(cwd)
    expect(reasonOf(await validateMentionToken('nope.txt', cwd))).toBe('not-found')
  })
})

// ---------------------------------------------------------------------------
// Injection over a fake agent/pre-step waterfall
// ---------------------------------------------------------------------------

interface Registration {
  event: string
  listener: (...args: unknown[]) => unknown
}

function makeEvents(): { registrations: Registration[]; on: (event: string, listener: (...args: unknown[]) => unknown) => () => void } {
  const registrations: Registration[] = []
  return {
    registrations,
    on(event, listener) {
      registrations.push({ event, listener })
      return () => {
        const index = registrations.findIndex(entry => entry.event === event && entry.listener === listener)
        if (index >= 0) registrations.splice(index, 1)
      }
    },
  }
}

function userMessage(text: string): UserMessageShape {
  return { id: `m-${Math.random().toString(36).slice(2)}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }
}

interface UserMessageShape {
  id: string
  role: string
  source: { kind: string; plugin?: string }
  content: Array<{ type: string; text?: string }>
}

function fakeAgent(cwd: string): unknown {
  return { session: { header: { cwd } } }
}

async function runListener(
  events: ReturnType<typeof makeEvents>,
  payload: Record<string, unknown>,
  messages: unknown[],
): Promise<{ kind: string; messages?: unknown[] }> {
  const registration = events.registrations.find(entry => entry.event === 'agent/pre-step')
  expect(registration).toBeDefined()
  const next = (): { kind: 'enter'; messages: unknown[] } => ({ kind: 'enter', messages })
  return (await registration?.listener(payload, next)) as { kind: string; messages?: unknown[] }
}

describe('mention injector (agent/pre-step seam)', () => {
  let workspaceRoots: string[] = []
  afterEach(async () => {
    const roots = workspaceRoots
    workspaceRoots = []
    for (const root of roots) await fsp.rm(root, { recursive: true, force: true }).catch(() => undefined)
  })

  it('appends one schema-shaped reference block per message and never leaks content', async () => {
    const cwd = await makeWorkspace('inject')
    workspaceRoots.push(cwd)
    await fsp.writeFile(path.join(cwd, 'report.md'), 'TOP SECRET CONTENT THAT MUST NOT CROSS THE WIRE')
    await fsp.mkdir(path.join(cwd, 'src'))

    const warns: string[] = []
    const injector = createMentionInjector({ logWarn: line => warns.push(line) })
    const events = makeEvents()
    injector.attach(events)

    const message = userMessage('please review @report.md and @src')
    const decision = await runListener(events, { agent: fakeAgent(cwd), signal: new AbortController().signal }, [message])
    expect(decision.kind).toBe('enter')
    const modified = decision.messages?.[0] as typeof message
    // Original text byte-identical.
    expect(modified.content[0]!.text).toBe('please review @report.md and @src')
    // Exactly one appended block matching WorkspaceReferenceSchema shape.
    expect(modified.content).toHaveLength(2)
    expect(modified.content[1]!.text).toContain('<workspace-reference path="report.md" kind="file" />')
    expect(modified.content[1]!.text).toContain('<workspace-reference path="src" kind="directory" />')
    // FR-B5 hard rule: CONTENT NEVER CROSSES THE WIRE.
    expect(JSON.stringify(decision.messages)).not.toContain('TOP SECRET CONTENT')
    expect(Object.isFrozen(modified)).toBe(true)
  })

  it('warns on invalid tokens instead of dropping them silently', async () => {
    const cwd = await makeWorkspace('warns')
    workspaceRoots.push(cwd)
    await fsp.writeFile(path.join(cwd, 'real.txt'), 'x')

    const warns: string[] = []
    const injector = createMentionInjector({ logWarn: line => warns.push(line) })
    const events = makeEvents()
    injector.attach(events)

    const decision = await runListener(
      events,
      { agent: fakeAgent(cwd), signal: new AbortController().signal },
      [userMessage('@real.txt @ghost.txt')],
    )
    const modified = decision.messages?.[0] as UserMessageShape
    expect(modified.content).toHaveLength(2) // only the valid token produced a tag
    expect((modified.content[1] as { text: string }).text).toBe('<workspace-reference path="real.txt" kind="file" />')
    expect(warns.join('\n')).toContain('ghost.txt')
  })

  it('leaves non-user messages untouched, dedupes repeated tokens, passthrough without cwd', async () => {
    const cwd = await makeWorkspace('mixed')
    workspaceRoots.push(cwd)
    await fsp.writeFile(path.join(cwd, 'one.ts'), 'x')

    const injector = createMentionInjector({ logWarn: () => undefined })
    const events = makeEvents()
    injector.attach(events)

    const pluginMessage = { id: 'p1', role: 'user', source: { kind: 'plugin', plugin: 'x' }, content: [{ type: 'text', text: '@one.ts' }] }
    const duplicated = userMessage('look @one.ts and @one.ts twice')
    const decision = await runListener(events, { agent: fakeAgent(cwd), signal: new AbortController().signal }, [pluginMessage, duplicated])
    expect(decision.messages?.[0]).toBe(pluginMessage)
    const touched = decision.messages?.[1] as { content: unknown[] }
    expect(touched.content).toHaveLength(2)
    expect(touched.content[1]).toEqual({ type: 'text', text: '<workspace-reference path="one.ts" kind="file" />' })
    expect(warnCount(duplicated.content[0], touched.content[1] as { text?: string })).toBe(1)

    const noCwd = await runListener(events, { agent: {}, signal: new AbortController().signal }, [duplicated])
    expect(noCwd.messages?.[0]).toBe(duplicated)
  })

  it('propagates reject decisions untouched and detaches cleanly', async () => {
    const cwd = await makeWorkspace('reject')
    workspaceRoots.push(cwd)
    const injector = createMentionInjector({ logWarn: () => undefined })
    const events = makeEvents()
    const detach = injector.attach(events)
    const registration = events.registrations.find(entry => entry.event === 'agent/pre-step')
    const rejectingNext = (): { kind: 'reject' } => ({ kind: 'reject' })
    const result = (await registration?.listener({ agent: fakeAgent(cwd), signal: new AbortController().signal }, rejectingNext))
    expect(result).toEqual({ kind: 'reject' })
    detach()
    expect(events.registrations).toHaveLength(0)
  })

  function warnCount(_originalText: unknown, _block: { text?: string }): number {
    return ((_block.text ?? '').match(/<workspace-reference /gu) ?? []).length
  }

  it('renderReferenceTags escapes attribute metacharacters', () => {
    const tags = renderReferenceTags([{ path: 'we"ird<name>.md', kind: 'file' }])
    expect(tags).toBe('<workspace-reference path="we&quot;ird&lt;name&gt;.md" kind="file" />')
  })
})

// ---------------------------------------------------------------------------
// Search handler (double-source merge + scoring + truncation)
// ---------------------------------------------------------------------------

function sessionsOf(cwd: string): SessionsLike {
  return {
    get: (id: string) => (id === 's1' ? { header: { cwd } } : undefined),
    list: () => [{ id: 's1', header: { cwd } }],
  }
}

class MockRequest {
  readonly url: string
  constructor(url: string) {
    this.url = url
  }
}

class MockResponse {
  statusCode = 200
  body = ''
  setHeader(): void {}
  end(payload?: string): void {
    this.body = payload ?? ''
  }
}

/** Narrow view of the JSON search response the assertions traverse. */
interface SearchView {
  sessionId?: unknown
  truncated?: unknown
  entries?: Array<{ relativePath: string; sizeBytes?: number; uploadedAtMs?: number }>
}

async function callSearch(handler: HttpHandler, query: string): Promise<{ status: number; body: SearchView }> {
  const response = new MockResponse()
  await handler(
    new MockRequest(`/api/filehub/search?${query}`) as unknown as Parameters<HttpHandler>[0],
    response as unknown as Parameters<HttpHandler>[1],
  )
  return { status: response.statusCode, body: JSON.parse(response.body || '{}') as SearchView }
}

describe('GET /api/filehub/search', () => {
  let workspaceRoots: string[] = []
  afterEach(async () => {
    const roots = workspaceRoots
    workspaceRoots = []
    for (const root of roots) await fsp.rm(root, { recursive: true, force: true }).catch(() => undefined)
  })

  it('merges index and uploads and ranks exact > prefix > contains > subsequence', async () => {
    const cwd = await makeWorkspace('rank')
    workspaceRoots.push(cwd)
    await fsp.mkdir(path.join(cwd, 'pkg'))
    for (const name of ['exact-name.ts', 'prefix-name.ts', 'middle-name-here.ts', 'unrelated.doc', 'nm.md']) {
      await fsp.writeFile(path.join(cwd, name), 'x')
    }
    await fsp.writeFile(path.join(cwd, 'pkg', 'inner-name.ts'), 'x')

    const sessions = sessionsOf(cwd)
    const indexer = createWorkspaceIndexer({ sessions, storageDirName: '.filehub' })
    const meta = createMemoryMetaStore()
    await meta.record('s1', 'exact-name.ts', { sizeBytes: 7, uploadedAtMs: 1234 })
    const handler = createSearchHandler({
      indexer,
      meta,
      workspaces: createWorkspaceResolver(sessions, '.filehub'),
      limit: 50,
    })
    try {
      const { status, body } = await callSearch(handler, 'sessionId=s1&q=name')
      expect(status).toBe(200)
      expect(body.sessionId).toBe('s1')
      const entries = body.entries ?? []
      const paths: string[] = entries.map(entry => entry.relativePath)
      expect(paths.indexOf('exact-name.ts')).toBe(0)
      expect(paths.indexOf('prefix-name.ts')).toBeGreaterThan(paths.indexOf('exact-name.ts'))
      expect(paths.some(p => p.endsWith('inner-name.ts'))).toBe(true)
      expect(paths).not.toContain('unrelated.doc')
      // Upload row keeps its metadata and the .filehub prefix.
      const uploaded = entries.find(entry => entry.relativePath === '.filehub/exact-name.ts')
      expect(uploaded?.sizeBytes).toBe(7)
      expect(uploaded?.uploadedAtMs).toBe(1234)
      expect(body.truncated).toBe(false)
    } finally {
      indexer.dispose()
    }
  })

  it('marks truncated past the cap and rejects unknown sessions with 403', async () => {
    const cwd = await makeWorkspace('trunc')
    workspaceRoots.push(cwd)
    for (let i = 0; i < 8; i += 1) await fsp.writeFile(path.join(cwd, `item${i}.log`), 'x')

    const sessions = sessionsOf(cwd)
    const indexer = createWorkspaceIndexer({ sessions, storageDirName: '.filehub' })
    const handler = createSearchHandler({
      indexer,
      meta: createMemoryMetaStore(),
      workspaces: createWorkspaceResolver(sessions, '.filehub'),
      limit: 5,
    })
    try {
      const hit = await callSearch(handler, 'sessionId=s1&q=item')
      expect(hit.body.entries).toHaveLength(5)
      expect(hit.body.truncated).toBe(true)

      const denied = await callSearch(handler, 'sessionId=who&q=x')
      expect(denied.status).toBe(403)
    } finally {
      indexer.dispose()
    }
  })

  it('merge helper keeps uploads distinct from identically-named workspace files', () => {
    const merged = mergeSearchEntries(
      '/w',
      { entries: [{ relativePath: 'a.txt', kind: 'file' }] },
      { 'a.txt': { sizeBytes: 3, uploadedAtMs: 9 } },
    )
    const uploadRow = merged.find(entry => entry.relativePath === '.filehub/a.txt')
    expect(uploadRow).toMatchObject({ sizeBytes: 3, kind: 'file', uploadedAtMs: 9 })
    expect(merged.some(entry => entry.relativePath === 'a.txt')).toBe(true)
  })
})
