/**
 * Offline locks for verify-zdsh-external-links (MAIN-HYGIENE, sync-017 DEBT
 * rulings §5): the pure-function face only — probe-target classification,
 * placeholder-host exclusion, status verdicts (the false-red prevention
 * rules), AST extraction, scope resolution, and probe planning. The network
 * probe itself is deliberately NOT exercised here (the CI step is an
 * observation-period gate; its anti-flake posture lives in classifyStatus and
 * isExcludedHost, locked below).
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  SCOPE_PATTERNS,
  classifyStatus,
  externalLinksInSource,
  identityDocPaths,
  isExcludedHost,
  isProbeTargetUrl,
  planProbes,
  verdictOf,
} from './verify-zdsh-external-links.ts'

const repoRoot = resolve(import.meta.dirname, '..')

describe('verify-zdsh-external-links scope contract', () => {
  it('pins the scope patterns to the zDSH identity documents only', () => {
    // Discriminating lock: widening the scope (for example to docs/**) would
    // pull the official documentation's huge external-link surface into a
    // zDSH gate — that surface is the official CI's responsibility (rulings §5).
    expect([...SCOPE_PATTERNS]).toEqual(['README.md', 'README.zh.md', 'packages/zdsh/**/*.md'])
  })

  it('resolves identity documents in the real repo and keeps official docs out', () => {
    const docs = identityDocPaths(repoRoot)
    expect(docs).toContain('README.md')
    expect(docs).toContain('README.zh.md')
    expect(docs).toContain('packages/zdsh/README.md')
    expect(docs).toContain('packages/zdsh/dsh-compat/README.zh.md')
    expect(docs).not.toContain('docs/architecture.md')
    expect(docs).not.toContain('AGENTS.md')
    expect(docs).not.toContain('packages/llm/model-slots/README.md')
    for (const doc of docs) {
      expect(doc === 'README.md' || doc === 'README.zh.md' || doc.startsWith('packages/zdsh/')).toBe(true)
    }
  })
})

describe('verify-zdsh-external-links URL classification', () => {
  it('probes http/https targets only', () => {
    expect(isProbeTargetUrl('https://github.com/org/repo')).toBe(true)
    expect(isProbeTargetUrl('http://example-host.org/x')).toBe(true)
    expect(isProbeTargetUrl('HTTPS://upper.case/x')).toBe(true)
    expect(isProbeTargetUrl('mailto:someone@host.org')).toBe(false)
    expect(isProbeTargetUrl('./docs/relative.md')).toBe(false)
    expect(isProbeTargetUrl('/root-absolute.md')).toBe(false)
    expect(isProbeTargetUrl('//protocol-relative.host/x')).toBe(false)
    expect(isProbeTargetUrl('#in-page-anchor')).toBe(false)
    expect(isProbeTargetUrl('ftp://files.host/x')).toBe(false)
  })

  it('excludes loopback, localhost, and RFC 2606/6761 placeholder hosts', () => {
    expect(isExcludedHost('localhost')).toBe(true)
    expect(isExcludedHost('127.0.0.1')).toBe(true)
    expect(isExcludedHost('127.9.9.9')).toBe(true)
    expect(isExcludedHost('[::1]')).toBe(true)
    expect(isExcludedHost('0.0.0.0')).toBe(true)
    expect(isExcludedHost('example.com')).toBe(true)
    expect(isExcludedHost('sub.example.org')).toBe(true)
    expect(isExcludedHost('EXAMPLE.NET')).toBe(true)
    expect(isExcludedHost('host.example')).toBe(true)
  })

  it('keeps real hosts probeable', () => {
    expect(isExcludedHost('github.com')).toBe(false)
    expect(isExcludedHost('deepseek.com')).toBe(false)
    expect(isExcludedHost('notexample.com')).toBe(false)
    expect(isExcludedHost('img.shields.io')).toBe(false)
  })
})

describe('verify-zdsh-external-links verdicts (false-red prevention)', () => {
  it('classifies 404/410 as the only blocking statuses', () => {
    expect(classifyStatus(404)).toBe('red')
    expect(classifyStatus(410)).toBe('red')
  })

  it('never blocks on rate limits, bot guards, server faults, or other 4xx', () => {
    expect(classifyStatus(403)).toBe('warn')
    expect(classifyStatus(429)).toBe('warn')
    expect(classifyStatus(500)).toBe('warn')
    expect(classifyStatus(503)).toBe('warn')
    expect(classifyStatus(401)).toBe('warn')
    expect(classifyStatus(451)).toBe('warn')
  })

  it('passes 2xx/3xx and folds every non-status outcome into warn', () => {
    expect(classifyStatus(200)).toBe('ok')
    expect(classifyStatus(301)).toBe('ok')
    expect(verdictOf({ kind: 'status', status: 404 })).toBe('red')
    expect(verdictOf({ kind: 'error', reason: 'network error (ECONNRESET)' })).toBe('warn')
    expect(verdictOf({ kind: 'error', reason: 'timeout after 10000ms' })).toBe('warn')
  })
})

describe('verify-zdsh-external-links extraction and planning', () => {
  const fixture = [
    '# Fixture title',
    '[doc link](https://github.com/org/repo)',
    '![badge](https://img.shields.io/badge/license-MIT-yellow.svg)',
    'Fenced code is not a link node:',
    '```',
    'https://inside-fence.invalid/x',
    '```',
    'Inline `https://inline-code.invalid/y` is not a link node either.',
    '[relative](./docs/x.md), [root](/abs.md), [mail](mailto:a@b.org) stay out.',
    '[defined-target]: https://defined-host.invalid/z',
  ].join('\n')

  it('extracts link, image, and definition nodes with line numbers, skipping code and non-http targets', () => {
    const found = externalLinksInSource(fixture, 'FIXTURE.md')
    expect(found).toEqual([
      { file: 'FIXTURE.md', line: 2, url: 'https://github.com/org/repo' },
      { file: 'FIXTURE.md', line: 3, url: 'https://img.shields.io/badge/license-MIT-yellow.svg' },
      { file: 'FIXTURE.md', line: 10, url: 'https://defined-host.invalid/z' },
    ])
  })

  it('plans one probe per unique URL, first-seen order, occurrences grouped', () => {
    const plan = planProbes([
      { file: 'README.md', line: 5, url: 'https://u1.invalid/a' },
      { file: 'README.zh.md', line: 5, url: 'https://u1.invalid/a' },
      { file: 'README.md', line: 9, url: 'https://u2.invalid/b' },
      { file: 'README.zh.md', line: 10, url: 'https://u1.invalid/a' },
    ])
    expect(plan.urls).toEqual(['https://u1.invalid/a', 'https://u2.invalid/b'])
    expect(plan.occurrences.get('https://u1.invalid/a')).toHaveLength(3)
    expect(plan.occurrences.get('https://u2.invalid/b')).toHaveLength(1)
  })

  it('extracts the real root README external surface end to end (P7 incident face)', () => {
    // The P7 incident was four dead issue links in exactly this document; the
    // extraction must see its live external surface (offline: no probing).
    const found = externalLinksInSource(readFileSync(resolve(repoRoot, 'README.md'), 'utf8'), 'README.md')
    expect(found.length).toBeGreaterThan(0)
    for (const occurrence of found) {
      expect(isProbeTargetUrl(occurrence.url)).toBe(true)
      expect(occurrence.line).toBeGreaterThan(0)
    }
  })
})
