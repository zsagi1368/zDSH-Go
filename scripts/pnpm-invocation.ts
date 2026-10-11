/** Resolve shell-free child-process invocations for the pnpm process that launched a package script. */
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'

/** Real pnpm resolved through the health-recipe `detect-pnpm --json` contract. */
export interface DetectedPnpm {
  /** `entrypoint` = JavaScript file to run through Node; `command` = directly spawnable executable. */
  kind: 'entrypoint' | 'command'
  /** Absolute (entrypoint) or bare command (PATH) location of the detected pnpm. */
  path: string
}

interface PnpmDetectionPayload {
  ok: boolean
  pnpm?: { adopted?: { kind?: 'entrypoint' | 'command'; path?: string } | null }
  guidance?: string[]
}

const repositoryRoot = resolve(import.meta.dirname, '..')
const healthRecipeScript = join(import.meta.dirname, 'run-healthy-spec.mjs')

/** Basenames that are genuinely pnpm (`pnpm`, `pnpm.exe`, `pnpm.{js,cjs,mjs}`): lifecycle fast path. */
const PNPM_BASENAME_PATTERN = /^pnpm(?:\.[cm]?js|\.exe)?$/iu

/** Path-independent basename: lifecycle paths use either separator across platforms. */
function entrypointBasename(entrypoint: string): string {
  const segments = entrypoint.split(/[\\/]/u)
  const last = segments[segments.length - 1]
  return last === undefined || last === '' ? entrypoint : last
}

/**
 * Resolve the real pnpm through the repository health-recipe script
 * (`scripts/run-healthy-spec.mjs detect-pnpm --json`) — the same single
 * source of truth the pdf-license-bundle spec consumes (TC-B4-S2b/S2c), so
 * the probe order (packageManager pin materialization, npm-global derivation,
 * PATH pnpm) cannot drift between call sites.
 * @returns The detected pnpm in spawnable form.
 * @throws When detection fails, with the recipe's remediation guidance.
 */
function detectPnpmViaHealthRecipe(): DetectedPnpm {
  const probe = spawnSync(process.execPath, [healthRecipeScript, 'detect-pnpm', '--json'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 120_000,
    windowsHide: true,
  })
  // TC-B4-S2d (REVIEW-S2c suggestion 1): a corrupted recipe payload must
  // surface as structured guidance, not a bare SyntaxError from JSON.parse.
  let payload: PnpmDetectionPayload | undefined
  if (probe.stdout !== '') {
    try {
      payload = JSON.parse(probe.stdout) as PnpmDetectionPayload
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(`pnpm invocation: ${healthRecipeScript} detect-pnpm returned invalid JSON (${detail}): verify the recipe script is intact — stdout in --json mode must be exactly the detect-pnpm contract payload`)
    }
  }
  const adopted = payload?.pnpm?.adopted ?? undefined
  if (probe.status !== 0 || payload === undefined || !payload.ok || adopted === undefined) {
    const guidance = payload?.guidance?.join(' ') ?? (probe.stderr === '' ? `exit ${String(probe.status)}` : probe.stderr)
    throw new Error(`pnpm invocation: no usable pnpm detected via ${healthRecipeScript}: ${guidance}`)
  }
  const { kind, path } = adopted
  if (kind !== 'entrypoint' && kind !== 'command') {
    throw new Error(`pnpm invocation: detection returned an unknown candidate kind: ${JSON.stringify(adopted)}`)
  }
  if (path === undefined || path === '') {
    throw new Error(`pnpm invocation: detection returned an empty path: ${JSON.stringify(adopted)}`)
  }
  return { kind, path }
}

/**
 * Resolve pnpm's executable and arguments.
 *
 * Trust model (TC-B4-S2c face 2): `npm_execpath` is honored only when its
 * basename is genuinely pnpm — i.e. a real pnpm lifecycle launched the
 * script. When the variable is absent or points at another package manager
 * (bare `npx vitest` sets it to npm-cli.js, whose `pack --json`/`exec` shapes
 * differ), the real pnpm is resolved explicitly through the health-recipe
 * detect-pnpm contract instead of misusing the npm cli.
 * @param args - Arguments to pass to pnpm.
 * @param environment - Lifecycle environment containing `npm_execpath`.
 * @param detectPnpm - Explicit resolver for non-pnpm contexts, injectable for tests.
 * @returns A command and argument array suitable for `spawn` or `spawnSync` without a shell.
 */
export function pnpmInvocation(
  args: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
  detectPnpm: () => DetectedPnpm = detectPnpmViaHealthRecipe,
): { command: string; args: string[] } {
  const entrypoint = environment.npm_execpath
  if (entrypoint !== undefined && entrypoint !== '' && PNPM_BASENAME_PATTERN.test(entrypointBasename(entrypoint))) {
    return /\.[cm]?js$/iu.test(entrypoint)
      ? { command: process.execPath, args: [entrypoint, ...args] }
      : { command: entrypoint, args: [...args] }
  }
  const pnpm = detectPnpm()
  return pnpm.kind === 'entrypoint'
    ? { command: process.execPath, args: [pnpm.path, ...args] }
    : { command: pnpm.path, args: [...args] }
}
