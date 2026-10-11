/**
 * Project root discovery for the project plugin layer (S-43 M1).
 *
 * Minimal reimplementation of skill-filesystem's `findProjectRoot`
 * (packages/skill/skill-filesystem/src/index.ts:937-947), copied on purpose:
 * this layer must not depend on the skill filesystem abstraction (its fs
 * facade differs). Semantics stay identical: walk up from `cwd` looking for a
 * `.git` directory (node `access` direct check, same as :972-980); when no
 * `.git` exists all the way to the filesystem root, `cwd` itself is the root
 * (C-04 pins this boundary so future changes cannot silently move the scope).
 * @module @deepseek-ai/dsh-plugin-project-root
 */

import { accessSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/** Whether `path` exists on disk (node direct existence probe). */
function pathExists(path: string): boolean {
  try {
    accessSync(path)
    return true
  } catch {
    return false
  }
}

/**
 * Find the project root that owns `cwd`: the nearest ancestor carrying a
 * `.git` directory, or `cwd` itself when no ancestor does.
 * @param cwd - the starting directory, resolved before walking.
 * @returns the absolute project root path.
 */
export function findProjectRoot(cwd: string): string {
  let current = resolve(cwd)
  while (true) {
    if (pathExists(join(current, '.git'))) return current
    const parent = dirname(current)
    if (parent === current) return resolve(cwd)
    current = parent
  }
}
