/**
 * path-guard realpath hardening — symlink/junction escape coverage.
 *
 * R-S43 A4/A6: checkPathAllowed must follow symlinks/junctions to their real
 * target and reject any path whose real location falls outside the allow list.
 * These tests construct temporary junctions to verify the gate.
 * @module @deepseek-ai/dsh-plugin-governance/sandbox/path-guard
 */

import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { checkPathAllowed } from '../src/sandbox/path-guard.ts'
import type { PluginSandboxConfig } from '../src/spec/index.ts'

const root = mkdtempSync(join(tmpdir(), 'dsh-pathguard-'))
const allowed = join(root, 'allowed')
const outside = join(root, 'outside')
mkdirSync(allowed, { recursive: true })
mkdirSync(outside, { recursive: true })
writeFileSync(join(outside, 'secret.txt'), 'top-secret')

function fsConfig(allowedPaths: string[]): PluginSandboxConfig['filesystem'] {
  return { access: 'readwrite', allowedPaths, deniedPatterns: [] }
}

describe('checkPathAllowed realpath hardening (R-S43 A4/A6)', () => {
  it('allows a real file inside the boundary', () => {
    writeFileSync(join(allowed, 'real.txt'), 'ok')
    expect(checkPathAllowed(fsConfig([allowed]), join(allowed, 'real.txt'))).toBe(true)
  })

  it('allows a not-yet-existing file whose real ancestor is inside the boundary', () => {
    const target = join(allowed, 'new-dir', 'file.txt')
    expect(checkPathAllowed(fsConfig([allowed]), target)).toBe(true)
  })

  it('rejects a path whose junction leaf escapes the allow list', () => {
    const link = join(allowed, 'link')
    try {
      symlinkSync(outside, link, 'junction')
    } catch {
      return // Platform does not support junction creation; skip.
    }
    try {
      // The junction leaf resolves to 'outside', which is not in the allow list.
      expect(checkPathAllowed(fsConfig([allowed]), link)).toBe(false)
      // A file inside the junction target is also outside the boundary.
      expect(checkPathAllowed(fsConfig([allowed]), join(link, 'secret.txt'))).toBe(false)
    } finally {
      rmSync(link, { recursive: true, force: true })
    }
  })

  it('rejects a not-yet-existing file through a junction to outside', () => {
    const link = join(allowed, 'link2')
    try {
      symlinkSync(outside, link, 'junction')
    } catch {
      return
    }
    try {
      // File does not exist yet; the deepest existing ancestor is the junction
      // itself, which resolves to 'outside' -> real location is out of bounds.
      expect(checkPathAllowed(fsConfig([allowed]), join(link, 'brand-new.txt'))).toBe(false)
    } finally {
      rmSync(link, { recursive: true, force: true })
    }
  })

  it('fails closed when a dangling junction leaf cannot be resolved', () => {
    const dang = join(allowed, 'dangling')
    try {
      symlinkSync(join(outside, 'does-not-exist'), dang, 'junction')
    } catch {
      return // Platform does not support dangling junction creation.
    }
    try {
      // The leaf exists (lstat) but realpath fails (dangling target) -> fail
      // closed because a write through it would create the target outside.
      expect(checkPathAllowed(fsConfig([allowed]), dang)).toBe(false)
    } finally {
      rmSync(dang, { recursive: true, force: true })
    }
  })

  it('fails closed when a dangling junction is mid-path', () => {
    const dang = join(allowed, 'dangling-mid')
    try {
      symlinkSync(join(outside, 'ghost-dir'), dang, 'junction')
    } catch {
      return
    }
    try {
      // The path component 'dangling-mid' is a dangling junction (exists but
      // unresolvable); the file below it does not exist on disk either.
      expect(checkPathAllowed(fsConfig([allowed]), join(dang, 'sub', 'file.txt'))).toBe(false)
    } finally {
      rmSync(dang, { recursive: true, force: true })
    }
  })
})

describe('checkPathAllowed raw-path traversal defense (POSIX fork escape)', () => {
  it('rejects a raw path containing a `..` component before resolve', () => {
    // `allowed/escape/../secret.txt` collapses lexically in resolve() to
    // `allowed/secret.txt`, but on POSIX the kernel resolves `..` against the
    // junction/symlink target of `escape` — the gate must reject the raw input.
    // The path is passed as a raw string because path.join() would already
    // normalize the `..` segment away before the gate sees it.
    expect(
      checkPathAllowed(fsConfig([allowed]), `${allowed}/escape/../secret.txt`),
    ).toBe(false)
    expect(
      checkPathAllowed(fsConfig([allowed]), `${allowed}/../outside/secret.txt`),
    ).toBe(false)
    // Windows-style separators are split and rejected too.
    expect(
      checkPathAllowed(fsConfig([allowed]), `${allowed}\\escape\\..\\secret.txt`),
    ).toBe(false)
  })

  it('rejects a raw path containing a `.` component', () => {
    expect(checkPathAllowed(fsConfig([allowed]), `${allowed}/./file.txt`)).toBe(false)
  })

  it('still allows names that merely contain dots', () => {
    writeFileSync(join(allowed, 'file.name.txt'), 'ok')
    expect(checkPathAllowed(fsConfig([allowed]), join(allowed, 'file.name.txt'))).toBe(true)
  })

  it('allows an 8.3 short-name shaped path whose tilde sits MID-path (RUNNER~1)', () => {
    // Windows 8.3 short names carry a `~` mid-component (GitHub Windows
    // runners: `C:\Users\RUNNER~1\...`). A substring tilde check fail-closed
    // every temp path on those hosts; the check must be component-scoped.
    // The directory below reproduces the trigger shape without needing real
    // 8.3 name generation on the host volume.
    const shortNamed = join(root, 'runner~1-ws')
    mkdirSync(shortNamed, { recursive: true })
    writeFileSync(join(shortNamed, 'file.txt'), 'ok')
    expect(checkPathAllowed(fsConfig([shortNamed]), join(shortNamed, 'file.txt'))).toBe(true)
  })

  it('still rejects a leading tilde component (POSIX home-expansion escape)', () => {
    expect(checkPathAllowed(fsConfig([allowed]), '~/secrets')).toBe(false)
    expect(checkPathAllowed(fsConfig([allowed]), '~\\secrets')).toBe(false)
  })
})

describe('checkPathAllowed deny-pattern realpath (batch3 backlog)', () => {
  it('denies a symlink alias whose real target matches a deny pattern', () => {
    // The deny pattern targets a REAL location inside the allow list, so the
    // allow check alone would pass. Only the realpath deny comparison can
    // reject the alias that resolves into the denied subdirectory.
    const blockedDir = join(allowed, 'blocked')
    // The alias name must NOT share the deny pattern as a string prefix:
    // `allowed\blocked-link\...` already contains `allowed\blocked`, which the
    // logical-path containment check would catch before realpath is ever
    // consulted. An unrelated alias name (`alias`) keeps this test on the
    // realpath branch it exists to cover.
    const link = join(allowed, 'alias')
    try {
      mkdirSync(blockedDir, { recursive: true })
      writeFileSync(join(blockedDir, 'secret.txt'), 's')
      symlinkSync(blockedDir, link, 'junction')
    } catch {
      return // Platform does not support symlink/junction creation; skip.
    }
    try {
      const config: PluginSandboxConfig['filesystem'] = {
        access: 'readwrite',
        allowedPaths: [allowed],
        deniedPatterns: [join(allowed, 'blocked')],
      }
      // The direct path is denied by the logical-path check.
      expect(checkPathAllowed(config, join(blockedDir, 'secret.txt'))).toBe(false)
      // The alias's logical path is NOT inside the denied subdirectory; only
      // the realpath comparison catches it.
      expect(checkPathAllowed(config, join(link, 'secret.txt'))).toBe(false)
    } finally {
      rmSync(link, { recursive: true, force: true })
      rmSync(blockedDir, { recursive: true, force: true })
    }
  })
})

describe('checkPathAllowed component-prefix regression (S-43 B-05)', () => {
  it('does not let /work admit /workshop (whole-segment matching)', () => {
    const base = join(root, 'work')
    mkdirSync(base, { recursive: true })
    mkdirSync(join(root, 'workshop'), { recursive: true })
    expect(checkPathAllowed(fsConfig([base]), join(base, 'file.txt'))).toBe(true)
    // A sibling whose name merely shares the prefix must stay denied.
    expect(checkPathAllowed(fsConfig([base]), join(root, 'workshop', 'file.txt'))).toBe(false)
  })

  it('matches Windows-style backslash prefixes too', () => {
    const base = join(root, 'win-dir')
    mkdirSync(base, { recursive: true })
    const config = fsConfig([base])
    const winStyle = `${base}\\sub\\file.txt`.replace(/\//g, '\\')
    expect(checkPathAllowed(config, winStyle)).toBe(true)
  })

  it('denies everything on an empty allow list (fail closed)', () => {
    const base = join(root, 'denied')
    mkdirSync(base, { recursive: true })
    expect(checkPathAllowed(fsConfig([]), base)).toBe(false)
    expect(checkPathAllowed(fsConfig([]), join(base, 'file.txt'))).toBe(false)
  })
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})
