/**
 * Bind one process to the distribution it belongs to.
 *
 * Three distributions ship from these same sources — the official harness,
 * zDSH and zDSH-Go — and each must keep its own plugins, skills, MCP servers,
 * credentials and sessions. `DSH_HOME` decides all of them, and its default is
 * the OFFICIAL `~/.dsh`, so a distribution launched without the `env` file its
 * installer generated would silently read and write another distribution's
 * state: install a plugin into the official home, share `~/.agents` skills,
 * resume the official home's sessions.
 *
 * A zDSH or zDSH-Go checkout carries `zdsh-factory/seed.json` at its root, and
 * the official harness does not. Starting from inside one with no home
 * selected therefore binds to that root's `data/` instead of the OS default.
 * The official harness is untouched: no seed file, no rebinding.
 *
 * @module
 */

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Environment names a distribution binds when it owns the process. */
const DISTRIBUTION_HOME_ENV = ['DSH_HOME', 'DSH_BRANCH_HOME', 'DSH_AGENTS_HOME'] as const

/**
 * Find the distribution root above one module directory.
 * @param start - absolute directory to search upward from.
 * @returns the root holding `zdsh-factory/seed.json`, or undefined outside a distribution.
 */
export function findDistributionRoot(start: string): string | undefined {
  for (let dir = start; ; dir = dirname(dir)) {
    // The seed file alone is not proof: an official install unpacked inside a
    // checkout would sit under one. A distribution root also carries the CLI
    // assembly, so require both.
    if (existsSync(join(dir, 'zdsh-factory', 'seed.json')) && existsSync(join(dir, 'apps', 'cli'))) {
      return dir
    }
    if (dirname(dir) === dir) return undefined
  }
}

/**
 * Bind the distribution's own home directories when the caller selected none.
 *
 * An explicit `DSH_HOME` always wins: the generated `env.ps1`, a test harness,
 * and a user override all keep their choice. Only the silent fallback to the
 * official home is replaced.
 *
 * @param env - environment mapping to bind into (defaults to `process.env`).
 * @param moduleUrl - this process's module URL, whose directory anchors the search.
 * @returns the bound root, or undefined when no distribution root was found or a home was already chosen.
 */
export function bindDistributionHome(
  env: NodeJS.ProcessEnv = process.env,
  moduleUrl: string = import.meta.url,
): string | undefined {
  if (env.DSH_HOME !== undefined && env.DSH_HOME.trim().length > 0) return undefined
  const root = findDistributionRoot(dirname(fileURLToPath(moduleUrl)))
  if (root === undefined) return undefined
  env.DSH_HOME = join(root, 'data')
  // Set only what the caller left unset: an install that deliberately shares
  // one agents root with another distribution keeps that choice explicit.
  for (const name of DISTRIBUTION_HOME_ENV.slice(1)) {
    if (env[name] === undefined || env[name].trim().length === 0) {
      env[name] = join(root, 'data', name === 'DSH_AGENTS_HOME' ? 'agents' : 'zdsh')
    }
  }
  return root
}
