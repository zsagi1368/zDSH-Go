/**
 * R6 dual-instance guard: no compiled artifacts may sit directly inside a
 * package's `src/` directory. A `src/**\/*.js` ghost shadows the TypeScript
 * source for ESM `.js` import specifiers, splitting the module graph into two
 * instances of the same package (symptom: real-composition route registries
 * come up empty — `expected [] to deeply equal ['deepseek']` — and tool
 * projections crash with `Cannot read properties of undefined (reading
 * 'kind')`). The 2026-11-11 sweep removed 285 such ghosts that earlier
 * pathspec sweeps missed because `.gitignore` hides them from git status.
 *
 * Emitted files belong under `lib/` (outDir) — never beside the sources.
 * @module scripts/src-ghost-guard
 */

import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(import.meta.dirname, '..')

function memberDirs(): string[] {
  const out: string[] = []
  for (const base of ['vendor', 'packages']) {
    let groups: string[] = []
    try {
      groups = readdirSync(join(ROOT, base))
    } catch {
      continue
    }
    for (const group of groups) {
      let pkgs: string[] = []
      try {
        pkgs = readdirSync(join(ROOT, base, group))
      } catch {
        continue
      }
      for (const pkg of pkgs) out.push(`${base}/${group}/${pkg}`)
    }
  }
  out.push('apps/cli', 'apps/web', 'apps/desktop')
  return out
}

describe('src ghost guard (R6 dual-instance)', () => {
  it('keeps compiled artifacts out of package src/ directories', () => {
    const offenders: string[] = []
    for (const member of memberDirs()) {
      const src = join(ROOT, member, 'src')
      let entries: string[]
      try {
        entries = readdirSync(src)
      } catch {
        continue
      }
      for (const entry of entries) {
        // Only `.js`/`.js.map` shadows poison runtime resolution (dual
        // instances). Generated `*.d.ts` (css-modules, vite-env) are declared
        // type-only artifacts that authored sources legitimately carry.
        if (/\.(js|js\.map)$/.test(entry)) offenders.push(`${member}/src/${entry}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
