/**
 * Path sandbox (P01 §9-F FR-F2): file-name defusing, relative-path policy,
 * and containment — including the Windows cross-drive absolute-relative trap
 * and the sibling-prefix confusion.
 */
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  PathPolicyError,
  assertInside,
  isStrictlyInside,
  isValidSessionId,
  sanitizeFileName,
  sanitizeRelativePath,
} from '../../src/server/pathPolicy.js'

describe('sessionId whitelist', () => {
  it('accepts [A-Za-z0-9_-]{1,64}', () => {
    expect(isValidSessionId('session-1')).toBe(true)
    expect(isValidSessionId('A_b-c')).toBe(true)
    expect(isValidSessionId('a'.repeat(64))).toBe(true)
  })

  it.each(['', 'a'.repeat(65), 'bad/sid', 'bad sid', '../etc', 'sid%1'])(
    'rejects %j',
    (value) => {
      expect(isValidSessionId(value)).toBe(false)
    },
  )
  it('rejects non-strings', () => {
    expect(isValidSessionId(undefined)).toBe(false)
    expect(isValidSessionId(42)).toBe(false)
  })
})

describe('sanitizeFileName', () => {
  it('keeps ordinary names untouched', () => {
    expect(sanitizeFileName('report v2.txt')).toBe('report v2.txt')
    expect(sanitizeFileName('.gitignore')).toBe('.gitignore')
    expect(sanitizeFileName('数据 表格.csv')).toBe('数据 表格.csv')
  })

  it('strips control characters', () => {
    expect(sanitizeFileName('bad\u0000name\u001f.txt')).toBe('badname.txt')
  })

  it('neutralizes separators and Windows-hostile characters', () => {
    const result = sanitizeFileName('a/b\\c:d*e?f"g<h>i|j.txt')
    for (const hostile of ['/', '\\', ':', '*', '?', '"', '<', '>', '|']) {
      expect(result).not.toContain(hostile)
    }
  })

  it('defuses traversal heads while keeping dotfiles', () => {
    expect(sanitizeFileName('..hidden')).not.toBe('..hidden')
    expect(sanitizeFileName('.gitignore')).toBe('.gitignore')
  })

  it('defuses Windows reserved device names with or without extension', () => {
    expect(sanitizeFileName('CON')).toBe('_CON')
    expect(sanitizeFileName('con.txt')).toBe('_con.txt')
    expect(sanitizeFileName('NUL')).toBe('_NUL')
    expect(sanitizeFileName('Com1.dat')).toBe('_Com1.dat')
    expect(sanitizeFileName('LPT9')).toBe('_LPT9')
    expect(sanitizeFileName('CONTENT.txt')).toBe('CONTENT.txt') // not reserved
  })

  it('strips trailing dots and spaces (Windows silently drops them)', () => {
    expect(sanitizeFileName('file...')).toBe('file')
    expect(sanitizeFileName('file . ')).toBe('file')
  })

  it('caps extreme lengths and never returns an empty name', () => {
    expect(sanitizeFileName('x'.repeat(500)).length).toBeLessThanOrEqual(120)
    expect(sanitizeFileName('')).toBe('unnamed')
    expect(sanitizeFileName('///')).not.toBe('')
  })
})

describe('sanitizeRelativePath', () => {
  it('splits and sanitizes segments, dropping empty parts', () => {
    const result = sanitizeRelativePath('docs/深//report final.txt/')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.segments).toEqual(['docs', '深', 'report final.txt'])
  })

  it('returns no segments for a plain-file upload', () => {
    const result = sanitizeRelativePath('')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.segments).toEqual([])
  })

  it('rejects outright traversal anywhere in the path', () => {
    expect(sanitizeRelativePath('docs/../../../etc/passwd').ok).toBe(false)
    expect(sanitizeRelativePath('..').ok).toBe(false)
  })

  it('rejects absolute forms and drive letters', () => {
    expect(sanitizeRelativePath('/abs/path').ok).toBe(false)
    expect(sanitizeRelativePath('C:/windows/system32').ok).toBe(false)
  })
})

describe('containment (isStrictlyInside / assertInside)', () => {
  const root = path.join(path.sep, 'data', 'ws', '.filehub')

  it('accepts files strictly inside the root', () => {
    expect(isStrictlyInside(root, path.join(root, 'a.png'))).toBe(true)
    expect(isStrictlyInside(root, path.join(root, 'sub', 'b.txt'))).toBe(true)
  })

  it('rejects equality with the root', () => {
    expect(isStrictlyInside(root, root)).toBe(false)
  })

  it('rejects parents and unrelated paths', () => {
    expect(isStrictlyInside(root, path.dirname(root))).toBe(false)
    expect(isStrictlyInside(root, path.join(path.sep, 'elsewhere', 'x'))).toBe(false)
  })

  it('rejects the sibling-prefix attack: root=/a/b vs candidate=/a/bc', () => {
    const base = path.join(path.sep, 'data', 'ws')
    const realRoot = path.join(base, '.filehub')
    const sibling = `${path.join(base, '.filehub')}x`
    expect(isStrictlyInside(realRoot, path.join(sibling, 'secret.txt'))).toBe(false)
  })

  it('rejects ..-laden candidates after resolution', () => {
    const escape = path.join(root, '..', '..', 'etc', 'passwd')
    expect(isStrictlyInside(root, escape)).toBe(false)
  })

  it('assertInside throws PathPolicyError on violations only', () => {
    expect(() =>{  assertInside(root, path.join(root, 'ok.txt')) }).not.toThrow()
    expect(() =>{  assertInside(root, root) }).toThrow(PathPolicyError)
    expect(() =>{  assertInside(root, `${root}x`) }).toThrow(/workspace/)
  })
})

describe('containment against a REAL temporary tree on this drive', () => {
  // Built lazily without fs here — resolve() semantics are what matter; the
  // HTTP-level suites exercise the same helpers over actual temp trees.
  it('nested upload targets stay inside their workspace root', () => {
    const root = path.join(process.cwd(), 'tmp-demo', 'ws', '.filehub')
    const target = path.join(root, 'docs', 'deep', 'h.txt')
    expect(isStrictlyInside(root, target)).toBe(true)
    expect(isStrictlyInside(root, path.dirname(root))).toBe(false)
  })
})
