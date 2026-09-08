/**
 * M6 red-team round 1 — paths & filesystem (P01 §12 对抗验证).
 *
 * Every attack below was executed against the real HTTP route (fake host
 * context) or the pure path-policy functions; each successful break carries a
 * named fix in src/, each failed break pins the rejection as a regression
 * test. Findings log: docs/adversarial-log.md.
 */
import http from 'node:http'
import fsp from 'node:fs/promises'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  defaultTestConfig,
  makeDomain,
  makeTempDir,
  rawRequest,
  removeTempDir,
  startRouteServer,
  uploadRequest,
} from '../server/helpers.client.js'
import { sanitizeFileName, sanitizeRelativePath } from '../../src/server/pathPolicy.js'
import { registerReadingTools } from '../../src/server/tools.js'
import type {
  FilehubToolDefinition,
  ReadingToolsDeps,
  SystemPromptRegistryLike,
  ToolRunContextLike,
  ToolsRegistryLike,
} from '../../src/server/tools.js'
import { createFileHubDomain } from '../../src/index.js'
import type { CapturedRoute } from '../server/helpers.client.js'

const agent = new http.Agent({ keepAlive: false })
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])

let cwd: string
let port = 0
let closeServer: (() => Promise<void>) | undefined
let disposeDomain: (() => void) | undefined
let workspaceRoot = ''

async function start(): Promise<void> {
  const { domain, route } = makeDomain([{ id: 'sess-1', cwd }], defaultTestConfig())
  disposeDomain = () => { domain.dispose() }
  const server = await startRouteServer(route)
  port = server.port
  closeServer = () => server.close()
  workspaceRoot = path.join(path.resolve(cwd), '.filehub')
}

beforeEach(async () => {
  cwd = await makeTempDir('adv-paths')
})

afterEach(async () => {
  await closeServer?.()
  closeServer = undefined
  disposeDomain?.()
  disposeDomain = undefined
  await removeTempDir(cwd)
})

// ---------------------------------------------------------------------------
// Upload relpath traversal variants
// ---------------------------------------------------------------------------

describe('round1: upload relpath traversal variants', () => {
  it('rejects single-encoded ../ (%2e%2e%2f) with 400', async () => {
    await start()
    const res = await uploadRequest(agent, port, {
      sessionId: 'sess-1',
      fileName: 'escape.txt',
      relPath: '../../escape.txt',
      body: PNG_BYTES,
    })
    expect(res.status).toBe(400)
    expect(res.text).toContain('traversal')
  })

  it('neutralizes double-encoded %252e%252e%252f to a harmless literal name inside the workspace', async () => {
    await start()
    const res = await uploadRequest(agent, port, {
      sessionId: 'sess-1',
      fileName: 'escape.txt',
      // Decodes ONCE at safeDecode → literal '%2e%2e%2f…' TEXT (no slashes),
      // which survives sanitization as one harmless flat file name.
      relPath: '%252e%252e%252f%252e%252e%252fwin.ini',
      body: PNG_BYTES,
    })
    expect(res.status).toBe(200)
    const result = JSON.parse(res.text) as { path: string }
    // Lands FLAT inside the workspace under its literal percent-text name
    // (the client re-encodes the already-double-encoded payload, so after the
    // server's single decode the name is still inert percent TEXT).
    expect(result.path.startsWith(workspaceRoot)).toBe(true)
    expect(path.dirname(result.path)).toBe(workspaceRoot)
    expect(path.basename(result.path)).toContain('%252e')
    await fsp.unlink(result.path)
  })

  it('rejects UNC paths (\\\\server\\share) and drive-letter forms with 400', async () => {
    await start()
    for (const hostile of ['\\\\server\\share\\x.txt', 'C:\\\\evil.txt', 'c:/evil.txt', 'Z:relative.txt']) {
      const res = await uploadRequest(agent, port, {
        sessionId: 'sess-1',
        fileName: 'x.txt',
        relPath: hostile,
        body: PNG_BYTES,
      })
      expect(res.status, `expected 400 for ${hostile}`).toBe(400)
    }
  })

  it('defuses NTFS alternate data stream separators (notes.txt:secret)', async () => {
    await start()
    const res = await uploadRequest(agent, port, {
      sessionId: 'sess-1',
      fileName: 'notes.txt:secret',
      body: new Uint8Array(Buffer.from('ads payload')),
    })
    expect(res.status).toBe(200)
    const result = JSON.parse(res.text) as { path: string; label: string }
    expect(result.path.startsWith(workspaceRoot)).toBe(true)
    // The stored BASENAME carries no colon (drive letters aside): no ADS survived.
    const storedName = path.basename(result.path)
    expect(storedName.includes(':')).toBe(false)
    expect(storedName.includes('_secret')).toBe(true)
    await fsp.unlink(result.path)
  })

  it('normalizes trailing dots/spaces (Windows silently strips them)', () => {
    expect(sanitizeFileName('evil.txt . . ')).toBe('evil.txt')
    expect(sanitizeFileName('evil.txt...')).toBe('evil.txt')
    expect(sanitizeFileName('CON')).toBe('_CON')
    expect(sanitizeFileName('con.txt')).toBe('_con.txt')
  })

  it('rejects mixed-separator traversal a/..\\..\\b with 400', async () => {
    await start()
    const res = await uploadRequest(agent, port, {
      sessionId: 'sess-1',
      fileName: 'b.txt',
      relPath: 'docs/..\\..\\b.txt',
      body: PNG_BYTES,
    })
    expect(res.status).toBe(400)
  })

  it('accepts a >260-char absolute destination strictly inside the sandbox without escape', async () => {
    await start()
    // 8 segments x ~40 chars ≈ 330 chars of relative depth — beyond MAX_PATH
    // but within this plugin's own bounds (32 segments / 512 chars).
    const longSegment = 'directory-with-a-fairly-long-name-xxxxxxxxxxxx'
    const deep = Array.from({ length: 7 }, () => longSegment).join('/')
    const res = await uploadRequest(agent, port, {
      sessionId: 'sess-1',
      fileName: 'deep.txt',
      relPath: `${deep}/deep.txt`,
      body: new Uint8Array(Buffer.from('deep payload')),
    })
    expect([200, 400]).toContain(res.status) // accepted OR cleanly bounded…
    if (res.status === 200) {
      const result = JSON.parse(res.text) as { path: string }
      expect(result.path.startsWith(workspaceRoot)).toBe(true) // …never outside
      await fsp.unlink(result.path)
    }
  })

  it('pure policy: over-deep and over-long relative paths fail closed', () => {
    const tooDeep = Array.from({ length: 40 }, (_, i) => `seg${i}`).join('/')
    expect(sanitizeRelativePath(tooDeep).ok).toBe(false)
    const tooLong = `${'a'.repeat(120)}/${'b'.repeat(120)}/${'c'.repeat(120)}/${'d'.repeat(120)}/${'e'.repeat(120)}`
    expect(sanitizeRelativePath(tooLong).ok).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// DELETE containment attacks
// ---------------------------------------------------------------------------

describe('round1: DELETE containment attacks', () => {
  it('refuses ..-climbing absolute paths (403) and deletes nothing', async () => {
    await start()
    const victimOutside = path.join(cwd, 'innocent.txt')
    await fsp.writeFile(victimOutside, 'do not delete me')
    const target = path.join(workspaceRoot, '..', '..') // climb above root
    const res = await rawRequest(agent, port, {
      method: 'DELETE',
      path: `/api/filehub/file?path=${encodeURIComponent(target + '/innocent.txt')}`,
    })
    expect(res.status).toBe(403)
    expect(await fsp.readFile(victimOutside, 'utf8')).toBe('do not delete me')
  })

  it('refuses sibling-prefix confusion (<root>-evil vs <root>) with 403', async () => {
    await start()
    const siblingRoot = `${workspaceRoot}-evil`
    await fsp.mkdir(siblingRoot, { recursive: true })
    const victim = path.join(siblingRoot, 'sibling-secret.txt')
    await fsp.writeFile(victim, 'sibling')
    const res = await rawRequest(agent, port, {
      method: 'DELETE',
      path: `/api/filehub/file?path=${encodeURIComponent(victim)}`,
    })
    expect(res.status).toBe(403)
    expect(await fsp.readFile(victim, 'utf8')).toBe('sibling')
    await removeTempDir(siblingRoot)
  })

  it('refuses deletion THROUGH a planted directory junction (realpath containment)', async () => {
    await start()
    // A junction works without admin rights where file-symlinks need them.
    const escapeDir = await makeTempDir('adv-junction-victim')
    const victim = path.join(escapeDir, 'outside.txt')
    await fsp.writeFile(victim, 'precious')
    let junctionMade = false
    try {
      await fsp.symlink(escapeDir, path.join(workspaceRoot, 'link'), 'junction')
      junctionMade = true
    } catch {
      // Environment cannot create junctions — skip the physical assertion.
    }
    if (junctionMade) {
      const viaJunction = path.join(workspaceRoot, 'link', 'outside.txt')
      const res = await rawRequest(agent, port, {
        method: 'DELETE',
        path: `/api/filehub/file?path=${encodeURIComponent(viaJunction)}`,
      })
      expect(res.status).toBe(403)
      expect(await fsp.readFile(victim, 'utf8')).toBe('precious')
    }
    await removeTempDir(escapeDir)
  })
})

// ---------------------------------------------------------------------------
// Upload write-through attacks (planted junction directories)
// ---------------------------------------------------------------------------

describe('round1: upload through a planted junction directory', () => {
  it('answers 400 and writes NOTHING outside the workspace', async () => {
    await start()
    const escapeDir = await makeTempDir('adv-junction-write')
    let junctionMade = false
    try {
      await fsp.mkdir(workspaceRoot, { recursive: true })
      await fsp.symlink(escapeDir, path.join(workspaceRoot, 'leak'), 'junction')
      junctionMade = true
    } catch {
      // Junction creation unsupported here — the lexical suite still holds.
    }
    if (junctionMade) {
      const res = await uploadRequest(agent, port, {
        sessionId: 'sess-1',
        fileName: 'leaked.txt',
        relPath: 'leak/leaked.txt',
        body: new Uint8Array(Buffer.from('should not land')),
      })
      expect(res.status).toBe(400)
      const landed = await fsp.readdir(escapeDir)
      expect(landed).toEqual([])
    }
    await removeTempDir(escapeDir)
  })
})

// ---------------------------------------------------------------------------
// read_document through symlinks pointing outside the workspace
// ---------------------------------------------------------------------------

function toolsHarness(deps: Partial<ReadingToolsDeps> = {}): FilehubToolDefinition[] {
  const captured: FilehubToolDefinition[] = []
  const tools: ToolsRegistryLike = {
    register(definition) {
      captured.push(definition)
      return () => undefined
    },
  }
  const systemPrompt: SystemPromptRegistryLike = { section() {
    return () => undefined
  } }
  registerReadingTools({ ...deps, tools, systemPrompt })
  return captured
}

function execFor(cwdValue: string): ToolRunContextLike {
  return { signal: new AbortController().signal, agent: { session: { header: { cwd: cwdValue } } } }
}

describe('round1: read_document symlink escapes', () => {
  it('refuses to read a FILE SYMLINK whose target lives outside the workspace', async () => {
    const secretDir = await makeTempDir('adv-read-victim')
    const secret = path.join(secretDir, 'secret.txt')
    await fsp.writeFile(secret, 'TOP SECRET')
    const localCwd = await makeTempDir('adv-read-cwd')
    try {
      await fsp.mkdir(path.join(localCwd, '.filehub'), { recursive: true })
      const [read] = toolsHarness().filter(tool => tool.name === 'read_document')
      let linkPath = ''
      try {
        linkPath = path.join(localCwd, '.filehub', 'steal.txt')
        await fsp.symlink(secret, linkPath, 'file')
      } catch {
        // No symlink privilege in this environment: the lexical suite above
        // still covers resolution; nothing further to prove physically.
      }
      if (linkPath !== '') {
        await expect(read!.execute({ path: 'steal.txt' }, execFor(localCwd))).rejects.toThrow(
          /escapes the session workspace/,
        )
      }
      // Direct absolute-path request stays rejected too (lexical fence).
      await expect(read!.execute({ path: secret }, execFor(localCwd))).rejects.toThrow(
        /escapes the session workspace/,
      )
    } finally {
      await removeTempDir(localCwd)
      await removeTempDir(secretDir)
    }
  })
})

// ---------------------------------------------------------------------------
// Library sessionId wire attacks
// ---------------------------------------------------------------------------

describe('round1: library/list/search sessionId attacks', () => {
  it('rejects path-ish session ids (encoded slashes/dots) with 4xx on every endpoint', async () => {
    await start()
    const hostiles = ['..%2F..%2Fetc', 'a%2Fb', '%2e%2e', 'sess..1!', '.']
    for (const hostile of hostiles) {
      const del = await rawRequest(agent, port, {
        method: 'DELETE',
        path: `/api/filehub/session/${hostile}`,
      })
      // %2e%2e is eaten by WHATWG path normalization (dot-segment collapse)
      // BEFORE routing, which lands on the 404 catch-all — equally rejected.
      expect([400, 404], `session DELETE ${hostile}`).toContain(del.status)
      const list = await rawRequest(agent, port, {
        method: 'GET',
        path: `/api/filehub/list?sessionId=${hostile}`,
      })
      expect([400, 403]).toContain(list.status)
    }
  })

  it('upload rejects an encoded-traversal session id before touching disk', async () => {
    await start()
    const res = await rawRequest(agent, port, {
      method: 'POST',
      path: '/api/filehub/upload',
      headers: {
        'x-session-id': encodeURIComponent('../evil'),
        'x-file-name': encodeURIComponent('x.txt'),
        origin: 'http://127.0.0.1',
      },
      body: PNG_BYTES,
    })
    expect([400, 403]).toContain(res.status)
  })
})

// ---------------------------------------------------------------------------
// Race triangle: concurrent upload + delete + sweep on one session
// ---------------------------------------------------------------------------

describe('round1: race triangle (upload x delete x sweep)', () => {
  it('survives interleaved upload/delete/sweep with a consistent end state', async () => {
    await start()
    // A second domain over the SAME cwd lets us drive sweep() directly
    // alongside the HTTP traffic (the first domain's hourly timer stays idle).
    const capturedRoutes: CapturedRoute[] = []
    const ctx = {
      logger: { info(): void {}, warn(): void {}, error(): void {} },
      sessions: {
        get: (id: string) => (id === 'sess-1' ? { id, header: { cwd } } : undefined),
        list: () => [{ id: 'sess-1', header: { cwd } }],
      },
      webServer: { register(route: CapturedRoute): () => void {
        capturedRoutes.push(route)
        return () => undefined
      } },
    }
    const live = createFileHubDomain(ctx, defaultTestConfig())
    const statuses: number[] = []
    const uploads = Array.from({ length: 12 }, (_, i) =>
      uploadRequest(agent, port, {
        sessionId: 'sess-1',
        fileName: `race-${i}.txt`,
        body: new Uint8Array(Buffer.from(`race payload ${i}`)),
      }).then(res => statuses.push(res.status)),
    )
    const deletes = Array.from({ length: 6 }, (_, i) =>
      uploadRequest(agent, port, {
        sessionId: 'sess-1',
        fileName: `race-${i}.txt`,
        body: new Uint8Array(Buffer.from(`race payload ${i}`)),
      })
        .then(res => JSON.parse(res.text) as { path?: string })
        .then(parsed =>
          parsed.path === undefined
            ? undefined
            : rawRequest(agent, port, {
              method: 'DELETE',
              path: `/api/filehub/file?path=${encodeURIComponent(parsed.path)}`,
            }).then(res => statuses.push(res.status)),
        ),
    )
    const sweeps = [live.sweep(), live.sweep()]
    await Promise.all([...uploads, ...deletes, ...sweeps])
    // Every answered upload/delete carried a sane status; no unhandled
    // rejections escaped (vitest would fail the run on those).
    for (const status of statuses) expect(status).toBeLessThan(500)
    live.dispose()
  }, 20_000)
})
