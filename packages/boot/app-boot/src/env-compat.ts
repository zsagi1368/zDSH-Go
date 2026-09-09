/**
 * Behavior probe for the installed `@deepseek-ai/dsh-app-boot` env blacklist.
 *
 * The official package keeps `BOOTSTRAP_NAMES` private, so compatibility with
 * the zDSH env-blacklist enhancement (D-006) is detected by behavior instead
 * of by symbol: a temporary project layer declaring `SYSTEMROOT` is fed
 * through the official `loadLayeredEnv`; a throw means the installed build
 * already filters bootstrap-only names (patched), a silent accept means it
 * does not (unpatched). `loadLayeredEnv` mutates `process.env` and reads the
 * DSH-home layer, so both are isolated for the duration of the probe and
 * restored afterwards; the temporary fixture is removed when the probe ends.
 * @module env-compat
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadLayeredEnv } from './index.ts'

/** Verdict of one behavior probe of the installed env blacklist. */
export interface EnvBlacklistProbe {
  /** Whether the installed build rejects bootstrap-only `.env` names. */
  patched: boolean
  /** Machine verdict: `env-blacklist:patched`, `env-blacklist:unpatched`, or `env-blacklist:unprobeable`. */
  reason: string
}

/** Guard computed from a completed probe. */
export interface EnvBlacklistGuard {
  /** Whether the compat guard is satisfied by the installed build. */
  enabled: boolean
  /** Whether the installed build rejects bootstrap-only `.env` names. */
  patched: boolean
  /** Machine verdict, forwarded from the probe. */
  reason: string
}

/** Diagnostic prefix used when driving the probed `loadLayeredEnv`. */
const PROBE_BIN_NAME = 'dsh-env-compat'

/** A bootstrap-only name the enhancement rejects; probes whether the installed build rejects it too. */
const PROBE_VAR = 'SYSTEMROOT'

/**
 * Probe whether the installed `@deepseek-ai/dsh-app-boot` rejects the
 * `SYSTEMROOT` bootstrap name in a project-layer `.env` file.
 * @param logger - optional sink for the one-line probe diagnostics; defaults to a no-op.
 * @returns the probe verdict; the probe never throws.
 */
export function probeEnvBlacklist(logger?: (line: string) => void): EnvBlacklistProbe {
  const warn = logger ?? (() => undefined)
  const envSnapshot = { ...process.env }
  let fixtureDir = ''
  let homeDir = ''
  try {
    fixtureDir = mkdtempSync(join(tmpdir(), 'dsh-env-blacklist-fixture-'))
    homeDir = mkdtempSync(join(tmpdir(), 'dsh-env-blacklist-home-'))
    // `resolveDshHome` honors DSH_HOME, so pointing it at an empty directory
    // keeps the user layer from influencing the verdict.
    process.env.DSH_HOME = homeDir
    writeFileSync(join(fixtureDir, '.env'), `${PROBE_VAR}=C:\\evil\n`, 'utf8')
    try {
      loadLayeredEnv(PROBE_BIN_NAME, fixtureDir, warn)
    } catch {
      // Thrown while loading the fixture: the installed build rejected the name.
      return { patched: true, reason: 'env-blacklist:patched' }
    }
    return { patched: false, reason: 'env-blacklist:unpatched' }
  } catch (error) {
    warn(`env-compat: probe failed: ${String(error)}`)
    return { patched: false, reason: 'env-blacklist:unprobeable' }
  } finally {
    for (const key of Object.keys(process.env)) {
      if (envSnapshot[key] === undefined) {
        // oxlint-disable-next-line typescript/no-dynamic-delete -- dropping a process.env key needs delete.
        delete process.env[key]
      }
    }
    Object.assign(process.env, envSnapshot)
    if (fixtureDir !== '') rmSync(fixtureDir, { recursive: true, force: true })
    if (homeDir !== '') rmSync(homeDir, { recursive: true, force: true })
  }
}

/**
 * Decide whether the compat guard for the env blacklist enhancement is
 * satisfied by the installed `@deepseek-ai/dsh-app-boot`.
 * @param logger - optional sink for the one-line probe diagnostics; defaults to a no-op.
 * @returns the guard verdict; enabled only when the probe found the installed build patched.
 */
export function guardEnvBlacklist(logger?: (line: string) => void): EnvBlacklistGuard {
  const probe = probeEnvBlacklist(logger)
  return probe.patched
    ? { enabled: true, patched: true, reason: probe.reason }
    : { enabled: false, patched: false, reason: probe.reason }
}
