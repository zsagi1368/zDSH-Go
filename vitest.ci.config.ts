/**
 * The CI (Windows quality gate) Vitest lane.
 *
 * This config EXTENDS the repository's single Vitest definition
 * (`vitest.config.ts`) and appends exactly one thing: the excludes registered
 * in `scripts/ci-windows-known-failures.json`. Every other option — projects,
 * pools, timeouts, setup files, coverage policy, path mapping — is inherited
 * unchanged, so the lane cannot drift from the definition the rest of the
 * repository runs.
 *
 * A failure outside the roster still fails the lane; the roster is a
 * registered-deviation register, never a red-to-green switch (admission rules
 * and guards live in `scripts/ci-windows-known-failures.ts`).
 *
 * @module vitest.ci.config
 */

import { defineConfig, type TestProjectConfiguration, type UserConfig } from 'vitest/config'
import baseConfig from './vitest.config.ts'
import { activeKnownFailurePaths } from './scripts/ci-windows-known-failures.ts'

/**
 * Append the known-failure excludes to a copy of `config`: the root test
 * options plus EVERY inline project, because the projects carry their own
 * `exclude` arrays (the include/exclude pair is per project in this repository).
 * @param config - the inherited repository config.
 * @param patterns - registered known-failure spec paths to exclude.
 * @returns the config with the patterns appended, nothing else changed.
 */
function withKnownFailureExcludes(config: UserConfig, patterns: readonly string[]): UserConfig {
  const test = config.test ?? {}
  const projects: readonly TestProjectConfiguration[] = Array.isArray(test.projects) ? test.projects : []
  return {
    ...config,
    test: {
      ...test,
      exclude: [...stringsOf(test.exclude), ...patterns],
      projects: projects.map(project => appendToProject(project, patterns)),
    },
  }
}

/** Append the patterns to one inline project's own exclude list, preserving its other options. */
function appendToProject(project: TestProjectConfiguration, patterns: readonly string[]): TestProjectConfiguration {
  if (typeof project !== 'object' || project === null || !('test' in project)) return project
  const options = project.test
  if (typeof options !== 'object' || options === null) return project
  return { ...project, test: { ...options, exclude: [...stringsOf(options.exclude), ...patterns] } }
}

/** The string entries of an exclude-like option value. */
function stringsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
}

export default defineConfig(withKnownFailureExcludes(baseConfig, activeKnownFailurePaths()))
