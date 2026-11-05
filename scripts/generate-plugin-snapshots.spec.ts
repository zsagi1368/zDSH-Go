/**
 * Automated coverage for scripts/generate-plugin-snapshots.mjs (REV-A-5).
 *
 * The script is the cache/ledger dual `declare module` same-shape gate plus the
 * two-direction snapshot drift/coverage report (D7). These specs pin the
 * fail-loud contract (REV-A-1): a same-shape check must never silently pass on
 * unparseable or renamed-away declare blocks — an empty vocabulary aborts with
 * exit 1 instead of comparing empty maps to empty maps. Each case runs the real
 * CLI against a synthetic authority/snapshot fixture (mkdtemp), so the exit-code
 * and report contract is exercised end to end without the sibling plugin
 * repository, and every spawned child gets an explicit timeout (A12).
 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

const SCRIPT = fileURLToPath(new URL('./generate-plugin-snapshots.mjs', import.meta.url))
const SPAWN_TIMEOUT_MS = 60_000

const DUAL_FILES = [
  'packages/core/agent-loop/src/agent.ts',
  'packages/llm/token-meter/src/cache-metrics.ts',
]

function declareBlock(moduleName: string, quote: "'" | '"', payload: string): string {
  return [
    '// fixture',
    `declare module ${quote}${moduleName}${quote} {`,
    '  interface SessionEventMap {',
    '    \'cache/ledger\': {',
    payload,
    '    }',
    '  }',
    '}',
    '',
  ].join('\n')
}

const CANONICAL_PAYLOAD = '      ledger: string\n      resetWriteCost: number'

interface Fixture {
  root: string
  authority: string
  plugins: string
}

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'gen-plugin-snapshots-'))
  const authority = join(root, 'authority')
  const plugins = join(root, 'plugins')
  mkdirSync(join(authority, dirname(DUAL_FILES[0]!)), { recursive: true })
  mkdirSync(join(authority, dirname(DUAL_FILES[1]!)), { recursive: true })
  mkdirSync(join(plugins, 'packages'), { recursive: true })
  return { root, authority, plugins }
}

function writeDual(fixture: Fixture, moduleName: string, quote: "'" | '"', payload: string): void {
  for (const rel of DUAL_FILES) {
    writeFileSync(join(fixture.authority, rel), declareBlock(moduleName, quote, payload))
  }
}

function runCheck(fixture: Fixture, extraArgs: string[] = []): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(
    process.execPath,
    [SCRIPT, '--check', '--plugins-root', fixture.plugins, '--authority-root', fixture.authority, ...extraArgs],
    { timeout: SPAWN_TIMEOUT_MS, encoding: 'utf8' },
  )
  return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

describe('generate-plugin-snapshots', () => {
  const fixtures: Fixture[] = []
  const make = (): Fixture => {
    const fixture = makeFixture()
    fixtures.push(fixture)
    return fixture
  }

  afterAll(() => {
    for (const fixture of fixtures) rmSync(fixture.root, { recursive: true, force: true })
  })

  it('reports SAME-SHAPE OK and exits 0 when both declare blocks carry the identical vocabulary', () => {
    const fixture = make()
    writeDual(fixture, '@deepseek-ai/dsh-session/types', "'", CANONICAL_PAYLOAD)
    const result = runCheck(fixture)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('SAME-SHAPE OK')
    expect(result.stdout).toContain("'cache/ledger': ledger, resetWriteCost")
  })

  it('reports SAME-SHAPE FAIL and exits 1 when one payload carries an extra key', () => {
    const fixture = make()
    writeDual(fixture, '@deepseek-ai/dsh-session/types', "'", CANONICAL_PAYLOAD)
    writeFileSync(
      join(fixture.authority, DUAL_FILES[1]!),
      declareBlock('@deepseek-ai/dsh-session/types', "'", `${CANONICAL_PAYLOAD}\n      bogusField: boolean`),
    )
    const result = runCheck(fixture)
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('SAME-SHAPE FAIL')
    expect(result.stdout).toContain('bogusField: boolean')
  })

  it('fails loud (exit 1, no SAME-SHAPE OK) when BOTH sides declare under a different module name', () => {
    const fixture = make()
    writeDual(fixture, 'some-other/module', "'", CANONICAL_PAYLOAD)
    const result = runCheck(fixture)
    expect(result.status).toBe(1)
    expect(result.stdout).not.toContain('SAME-SHAPE OK')
    expect(result.stderr).toContain('fail-loud')
    expect(result.stderr).toContain('no \'declare module @deepseek-ai/dsh-session/types\' block found')
  })

  it('fails loud when the expected interface is absent from a matched module block', () => {
    const fixture = make()
    const renamed = declareBlock('@deepseek-ai/dsh-session/types', "'", CANONICAL_PAYLOAD).replace(
      'interface SessionEventMap',
      'interface RenamedAway',
    )
    for (const rel of DUAL_FILES) writeFileSync(join(fixture.authority, rel), renamed)
    const result = runCheck(fixture)
    expect(result.status).toBe(1)
    expect(result.stdout).not.toContain('SAME-SHAPE OK')
    expect(result.stderr).toContain("'interface SessionEventMap' not found")
  })

  it('parses double-quoted module specifiers instead of silently skipping them', () => {
    const fixture = make()
    writeDual(fixture, '@deepseek-ai/dsh-session/types', '"', CANONICAL_PAYLOAD)
    const result = runCheck(fixture)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('SAME-SHAPE OK')
  })

  it('reports coverage in both directions: AUTHORITY-ONLY files and UNMAPPED-EXPECTED bundle glue', () => {
    const fixture = make()
    writeDual(fixture, '@deepseek-ai/dsh-session/types', "'", CANONICAL_PAYLOAD)
    // One mirrored file with an identical authority counterpart, plus one
    // authority-only sibling and the intentionally unmapped bundle glue.
    mkdirSync(join(fixture.authority, 'packages/demo/src'), { recursive: true })
    mkdirSync(join(fixture.plugins, 'packages/demo/src'), { recursive: true })
    mkdirSync(join(fixture.plugins, 'plugin/src'), { recursive: true })
    writeFileSync(join(fixture.authority, 'packages/demo/src/a.ts'), 'export const a = 1\n')
    writeFileSync(join(fixture.plugins, 'packages/demo/src/a.ts'), 'export const a = 1\n')
    writeFileSync(join(fixture.authority, 'packages/demo/src/b-only-authority.ts'), 'export const b = 2\n')
    writeFileSync(join(fixture.plugins, 'plugin/src/index.ts'), 'export {}\n')
    const result = runCheck(fixture)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('AUTHORITY-ONLY  packages/demo/src/b-only-authority.ts')
    expect(result.stdout).toContain('UNMAPPED-EXPECTED plugin/src/index.ts')
    expect(result.stdout).toContain('1 authority-only')
  })

  it('prints usage and exits 0 for --help even alongside --check', () => {
    const fixture = make()
    writeDual(fixture, '@deepseek-ai/dsh-session/types', "'", CANONICAL_PAYLOAD)
    const result = runCheck(fixture, ['--help'])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('Usage:')
    expect(result.stdout).toContain('REPOSITORY ROOT')
    expect(result.stdout).not.toContain('generate-plugin-snapshots --check')
  })

  it('resolves relative --plugins-root/--authority-root against the repository root, not the caller cwd', () => {
    const fixture = make()
    writeDual(fixture, '@deepseek-ai/dsh-session/types', "'", CANONICAL_PAYLOAD)
    // Relative paths that only resolve correctly from the repository root; the
    // child cwd is the fixture temp dir, so a cwd-based resolution would look in
    // the wrong place and fail (REV-A-7).
    const repoRoot = dirname(dirname(SCRIPT))
    const relPlugins = relative(repoRoot, fixture.plugins)
    const relAuthority = relative(repoRoot, fixture.authority)
    const result = spawnSync(
      process.execPath,
      [SCRIPT, '--check', '--plugins-root', relPlugins, '--authority-root', relAuthority],
      { timeout: SPAWN_TIMEOUT_MS, encoding: 'utf8', cwd: fixture.root },
    )
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('SAME-SHAPE OK')
  })
})
