#!/usr/bin/env node
/**
 * S-4 health-recipe runner (TC-B4-S2b face 1).
 *
 * Solidifies the two machine-local facts the pdf-license-bundle spec recipe
 * depends on (REVIEW-EXEC17.md suggestion 1), so the recipe survives
 * environment migration:
 *
 *   1. The real pnpm is not necessarily the one `npm_execpath` points at
 *      (npx sets it to npm-cli.js), and it does not live at the npm global
 *      prefix root. On this machine it materializes at
 *      `<npm-global-prefix>/node_modules/pnpm/bin/pnpm.cjs`. This script
 *      auto-probes the bin/ location instead of hardcoding it.
 *   2. On Windows, git-bash GNU tar shadows `C:\Windows\System32\tar.exe`
 *      (bsdtar) and fails on drive-letter paths ("tar: Cannot connect to C:",
 *      spawnSync status 128). The child process gets System32 prepended to
 *      PATH so `tar` resolves to bsdtar.
 *
 * Usage:
 *   node scripts/run-healthy-spec.mjs [specPath] [--json]
 *       Full recipe: probe pnpm + bsdtar, run one spec in the healthy
 *       environment (default = the S-4 pdf-license spec), print a structured
 *       conclusion (probe details + spec result + exit code).
 *   node scripts/run-healthy-spec.mjs detect-pnpm [--json]
 *       Detection only. With --json, stdout is pure JSON — this is the stable
 *       CLI contract reused by
 *       packages/client/ui-sidebar-documentpreview/tests/pdf-license-bundle.client.spec.ts
 *       (single source of truth for the probe order; no static import so the
 *       spec stays typecheck-clean).
 *   node scripts/run-healthy-spec.mjs detect-tar [--json]
 *       Tar resolution only (TC-B4-S2c face 1): reuses the recipe's bsdtar
 *       probe (probeBsdtar, unchanged) and prints the adopted tar command as
 *       JSON with the same stdout contract as detect-pnpm. Adopted shape:
 *       `tar.adopted = { kind: 'absolute', path: <System32 bsdtar> }` on win32
 *       when bsdtar exists (git-bash GNU tar shadows it on PATH and misreads
 *       `C:\...` archive paths as remote hosts), otherwise
 *       `{ kind: 'command', path: 'tar' }` (PATH fallback; POSIX tar handles
 *       absolute paths). Independent of the pnpm probes: detect-tar never
 *       runs detectPnpm, so it also works on machines without pnpm.
 *
 * pnpm probe order (each probe is recorded in the structured output):
 *   1. packageManager pin materialized inside the repo
 *      (`<repoRoot>/node_modules/pnpm/bin/pnpm.cjs`).
 *   2. npm-global materialization `<prefix>/node_modules/pnpm/bin/pnpm.cjs`,
 *      prefixes derived in order: (a) `npm_config_prefix` env, (b) directory
 *      of the `pnpm` shim found via System32 `where.exe` (win32) or a PATH
 *      scan (POSIX), (c) the known machine-local prefix
 *      `I:\home\z\.npm-global` (EXEC17 fact, last-resort literal),
 *      (d) `npm prefix -g`.
 *   3. `pnpm` on PATH in directly-spawnable form (a real .exe on win32;
 *      any PATH entry on POSIX).
 *   4. Structured failure with remediation guidance.
 *
 * The pinned version from `packageManager` is recorded per candidate as
 * `pinMatch` — data, not a gate: the global pnpm bootstrap version can differ
 * from the pin (pnpm self-switches to the pinned version when invoked inside
 * the repo, so the probe measures the effective in-repo version with
 * cwd=repoRoot).
 *
 * Exit codes: 0 = healthy (spec green / detection ok); 1 = spec red;
 * 2 = usage, detection, or environment failure. All output uses synchronous
 * fd writes and the exit code is set via process.exitCode, because
 * process.exit() would drop pipe-buffered stdout on Windows (the consuming
 * spawnSync in the pdf-license spec would then see an empty payload).
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeSync } from 'node:fs'
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_SPEC = 'packages/client/ui-sidebar-documentpreview/tests/pdf-license-bundle.client.spec.ts'
const LITERAL_NPM_GLOBAL_PREFIX = 'I:\\home\\z\\.npm-global'
const PROBE_TIMEOUT_MS = 30_000
const SPEC_TIMEOUT_MS = 600_000

function writeTo(fd, text) {
  const buffer = Buffer.from(text, 'utf8')
  let position = 0
  while (position < buffer.length) {
    position += writeSync(fd, buffer, position, buffer.length - position)
  }
}

function out(text) {
  writeTo(1, text)
}

function err(text) {
  writeTo(2, text)
}

function log(jsonMode, line) {
  // Keep stdout pure JSON in --json mode; human log lines go to stderr there.
  const write = jsonMode ? err : out
  write(`${line}\n`)
}

function stripAnsi(text) {
  return text.replace(/\x1B\[[0-9;]*[A-Za-z]/gu, '')
}

function readPin() {
  try {
    const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
    const raw = typeof manifest.packageManager === 'string' ? manifest.packageManager : null
    if (raw === null) return { raw: null, name: null, version: null }
    const match = /^([^@]+)@([^+\s]+)/u.exec(raw)
    return { raw, name: match?.[1] ?? null, version: match?.[2] ?? null }
  } catch (error) {
    return { raw: null, name: null, version: null, error: String(error?.message ?? error) }
  }
}

function probeVersion(command, args) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: PROBE_TIMEOUT_MS,
    windowsHide: true,
  })
  if (result.error !== undefined || result.status !== 0) return null
  const first = (result.stdout ?? '').trim().split(/\r?\n/u)[0]
  return first === undefined || first === '' ? null : first.trim()
}

function envValueIgnoreCase(name) {
  const key = Object.keys(process.env).find(candidate => candidate.toUpperCase() === name.toUpperCase())
  return key === undefined ? undefined : process.env[key]
}

function systemRoot() {
  return envValueIgnoreCase('SystemRoot') ?? 'C:\\Windows'
}

function wherePnpmWin32() {
  const whereExe = join(systemRoot(), 'System32', 'where.exe')
  if (!existsSync(whereExe)) return []
  const result = spawnSync(whereExe, ['pnpm'], { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS, windowsHide: true })
  if (result.status !== 0) return []
  return (result.stdout ?? '').split(/\r?\n/u).map(line => line.trim()).filter(line => line !== '')
}

function pathScanPnpmPosix() {
  const raw = envValueIgnoreCase('PATH') ?? ''
  const found = []
  for (const dir of raw.split(delimiter)) {
    if (dir === '') continue
    const candidate = join(dir, 'pnpm')
    if (existsSync(candidate)) found.push(candidate)
  }
  return found
}

function npmPrefixGlobal() {
  const isWin = process.platform === 'win32'
  // npm is npm.cmd on Windows and cannot be spawned shell-free; pass the whole
  // command as one fixed string to avoid DEP0190 (args + shell:true).
  const result = isWin
    ? spawnSync('npm prefix -g', {
        cwd: repoRoot,
        encoding: 'utf8',
        timeout: PROBE_TIMEOUT_MS,
        windowsHide: true,
        shell: true,
      })
    : spawnSync('npm', ['prefix', '-g'], {
        cwd: repoRoot,
        encoding: 'utf8',
        timeout: PROBE_TIMEOUT_MS,
      })
  if (result.error !== undefined || result.status !== 0) return null
  const first = (result.stdout ?? '').trim().split(/\r?\n/u)[0]
  return first === undefined || first === '' ? null : first.trim()
}

/**
 * Probe for a usable pnpm following the documented order.
 * @param pin - packageManager pin descriptor from the repo root package.json.
 * @param jsonMode - when true, human log lines are demoted to stderr.
 * @returns {{ adopted: object|null, probes: object[], guidance: string[] }}
 */
function detectPnpm(pin, jsonMode) {
  const probes = []
  const record = (probe) => {
    probes.push(probe)
    const version = probe.version === undefined || probe.version === null ? '?' : probe.version
    const match = probe.pinMatch === undefined || probe.pinMatch === null ? '' : ` pinMatch=${String(probe.pinMatch)}`
    const detail = probe.exists === true
      ? (probe.version === undefined || probe.version === null
          ? `${probe.candidate} (${probe.note ?? 'queued'})`
          : `found ${probe.candidate} (version ${version})${match}`)
      : (probe.note ?? `absent (${probe.candidate ?? 'n/a'})`)
    log(jsonMode, `[probe ${probe.step}] ${probe.source}: ${detail}${probe.adopted === true ? ' -> ADOPTED' : ''}`)
    return probe
  }
  const adoptCjs = (step, source, cjsPath, version) => {
    const pinMatch = pin.version === null || version === null ? null : version === pin.version
    record({ step, source, candidate: cjsPath, exists: true, version, pinMatch, adopted: true })
    return { source, path: cjsPath, kind: 'entrypoint', version, pinMatch }
  }

  // Probe 1: packageManager pin materialized inside the repo.
  const inRepo = join(repoRoot, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')
  if (existsSync(inRepo)) {
    const version = probeVersion(process.execPath, [inRepo, '--version'])
    if (version !== null) return { adopted: adoptCjs(1, 'packageManager pin (repo node_modules)', inRepo, version), probes }
    record({ step: 1, source: 'packageManager pin (repo node_modules)', candidate: inRepo, exists: true, version: null, note: 'present but --version failed' })
  } else {
    record({ step: 1, source: 'packageManager pin (repo node_modules)', candidate: inRepo, exists: false })
  }

  // Probe 2: npm-global materialization; derive prefixes, probe bin/ under each.
  const prefixes = []
  const pushPrefix = (source, value) => {
    if (value === null || value === undefined || value === '') {
      record({ step: 2, source, exists: false, note: 'unavailable' })
      return
    }
    if (prefixes.some(entry => entry.value === value)) {
      record({ step: 2, source, candidate: value, exists: true, note: 'duplicate of an earlier prefix candidate' })
      return
    }
    prefixes.push({ source, value })
    record({ step: 2, source, candidate: value, exists: true, note: 'prefix candidate queued' })
  }
  pushPrefix('npm_config_prefix', envValueIgnoreCase('npm_config_prefix'))
  const shims = process.platform === 'win32' ? wherePnpmWin32() : pathScanPnpmPosix()
  if (shims.length === 0) {
    record({ step: 2, source: 'pnpm shim location', exists: false, note: 'no pnpm shim found via where.exe/PATH scan' })
  }
  for (const shim of shims) pushPrefix(`pnpm shim dir (${shim})`, dirname(shim))
  pushPrefix('machine-local literal (EXEC17 fact)', LITERAL_NPM_GLOBAL_PREFIX)
  pushPrefix('npm prefix -g', npmPrefixGlobal())

  for (const { source, value } of prefixes) {
    const cjs = join(value, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')
    if (!existsSync(cjs)) {
      record({ step: 2, source: `npm-global ${source}`, candidate: cjs, exists: false })
      continue
    }
    const version = probeVersion(process.execPath, [cjs, '--version'])
    if (version === null) {
      record({ step: 2, source: `npm-global ${source}`, candidate: cjs, exists: true, version: null, note: '--version failed' })
      continue
    }
    return { adopted: adoptCjs(2, `npm-global ${source}`, cjs, version), probes }
  }

  // Probe 3: pnpm on PATH in directly-spawnable form.
  const spawnable = process.platform === 'win32'
    ? shims.filter(shim => /\.exe$/iu.test(shim))
    : shims
  for (const candidate of spawnable) {
    const version = probeVersion(candidate, ['--version'])
    if (version !== null) {
      const pinMatch = pin.version === null ? null : version === pin.version
      record({ step: 3, source: 'pnpm on PATH', candidate, exists: true, version, pinMatch, adopted: true })
      return { adopted: { source: 'pnpm on PATH', path: candidate, kind: 'command', version, pinMatch }, probes }
    }
    record({ step: 3, source: 'pnpm on PATH', candidate, exists: true, version: null, note: '--version failed' })
  }
  if (process.platform === 'win32' && shims.length > 0 && spawnable.length === 0) {
    record({ step: 3, source: 'pnpm on PATH', exists: false, note: 'only non-spawnable shims (.cmd/.ps1/sh) on PATH; no real pnpm.exe' })
  }

  // Probe 4: structured failure with guidance.
  const guidance = [
    `No usable pnpm found. The repo pins ${pin.raw ?? 'pnpm (no packageManager pin)'}.`,
    'Install a matching pnpm globally: npm i -g pnpm@<pinned-version> (detection then derives <npm-global-prefix>/node_modules/pnpm/bin/pnpm.cjs).',
    'Or enable corepack: corepack enable && corepack prepare pnpm@<pinned-version> --activate.',
    'Or set npm_config_prefix to the npm global prefix that contains node_modules/pnpm.',
    'Or run the suite through a real pnpm lifecycle (pnpm run test) so npm_execpath already points at pnpm.',
  ]
  record({ step: 4, source: 'failure', exists: false, note: 'no usable pnpm candidate' })
  return { adopted: null, probes, guidance }
}

function probeBsdtar(jsonMode) {
  if (process.platform !== 'win32') {
    log(jsonMode, '[bsdtar] not applicable (non-Windows: POSIX tar handles absolute paths)')
    return { applicable: false, note: 'non-Windows; no PATH prepend needed' }
  }
  const tarExe = join(systemRoot(), 'System32', 'tar.exe')
  if (!existsSync(tarExe)) {
    log(jsonMode, `[bsdtar] ABSENT (${tarExe}) — child PATH will not be prepended; GNU tar signatures may appear`)
    return { applicable: true, path: tarExe, exists: false, version: null, pathPrepended: false }
  }
  const version = probeVersion(tarExe, ['--version'])
  log(jsonMode, `[bsdtar] ${tarExe} present (${version ?? 'version unknown'}) — System32 prepended to child PATH`)
  return { applicable: true, path: tarExe, exists: true, version, pathPrepended: true }
}

/**
 * Adopt the tar command from the (unchanged) bsdtar probe — detect-tar mode.
 * win32 + System32 bsdtar present → its absolute path (GNU tar on PATH would
 * misread `C:\...` archive paths as remote hosts); otherwise PATH `tar`
 * (POSIX tar handles absolute paths; on win32 without bsdtar the probe
 * already logged the GNU-tar-signature warning).
 * @param probe - probeBsdtar result.
 * @returns {{ kind: 'absolute' | 'command', path: string, source: string, version: string | null }}
 */
function adoptTarCommand(probe) {
  if (probe.applicable === true && probe.exists === true) {
    return { kind: 'absolute', path: probe.path, source: 'System32 bsdtar', version: probe.version ?? null }
  }
  const source = probe.applicable === true
    ? 'PATH fallback (System32 bsdtar absent; GNU tar signatures may appear on drive-letter paths)'
    : 'PATH tar (non-Windows: POSIX tar handles absolute paths)'
  return { kind: 'command', path: 'tar', source, version: null }
}

function resolveSpecPath(arg) {
  if (isAbsolute(arg) && existsSync(arg)) return arg
  const fromRoot = resolve(repoRoot, arg)
  if (existsSync(fromRoot)) return fromRoot
  const fromCwd = resolve(process.cwd(), arg)
  if (existsSync(fromCwd)) return fromCwd
  return null
}

function summarize(vitestStdout) {
  const plain = stripAnsi(vitestStdout)
  const grab = (label) => {
    const match = plain.match(new RegExp(`${label}\\s+(.+)`, 'u'))
    return match?.[1]?.trim() ?? null
  }
  return { testFiles: grab('Test Files'), tests: grab('Tests') }
}

function parseArgv(argv) {
  let mode = 'recipe'
  let spec = DEFAULT_SPEC
  let jsonMode = false
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === 'detect-pnpm') mode = 'detect-pnpm'
    else if (arg === 'detect-tar') mode = 'detect-tar'
    else if (arg === '--json') jsonMode = true
    else if (arg === '--spec') {
      index += 1
      const value = argv[index]
      if (value === undefined) throw new Error('--spec requires a path argument')
      spec = value
    } else if (arg !== undefined && !arg.startsWith('-')) spec = arg
    else throw new Error(`unknown argument: ${String(arg)}`)
  }
  return { mode, spec, jsonMode }
}

function main() {
  let parsed
  try {
    parsed = parseArgv(process.argv.slice(2))
  } catch (error) {
    out(`${String(error?.message ?? error)}\n`)
    return 2
  }
  const { mode, jsonMode } = parsed
  if (mode === 'detect-tar') {
    // Tar resolution is pnpm-independent: skip the pin/pnpm probes entirely
    // (existing modes keep their original probe order below, untouched).
    const probe = probeBsdtar(jsonMode)
    const adopted = adoptTarCommand(probe)
    log(jsonMode, `[detect-tar] adopted ${adopted.kind} ${adopted.path} (${adopted.source})`)
    out(`${JSON.stringify({ ok: true, mode, tar: { adopted, probe }, exitCode: 0 }, null, 2)}\n`)
    return 0
  }
  const pin = readPin()
  log(jsonMode, `[pin] packageManager = ${pin.raw ?? '(none)'}`)
  const detection = detectPnpm(pin, jsonMode)

  if (mode === 'detect-pnpm') {
    const payload = {
      ok: detection.adopted !== null,
      mode,
      pin,
      pnpm: { adopted: detection.adopted, probes: detection.probes },
      ...(detection.adopted === null ? { guidance: detection.guidance } : {}),
      exitCode: detection.adopted !== null ? 0 : 2,
    }
    out(`${JSON.stringify(payload, null, 2)}\n`)
    return payload.exitCode
  }

  if (detection.adopted === null) {
    const payload = {
      ok: false,
      mode,
      pin,
      pnpm: { adopted: null, probes: detection.probes },
      guidance: detection.guidance,
      exitCode: 2,
    }
    out(`${JSON.stringify(payload, null, 2)}\n`)
    return 2
  }

  const specPath = resolveSpecPath(parsed.spec)
  if (specPath === null) {
    log(jsonMode, `[spec] NOT FOUND: ${parsed.spec} (tried repoRoot- and cwd-relative)`)
    out(`${JSON.stringify({ ok: false, mode, spec: { requested: parsed.spec, found: false }, exitCode: 2 }, null, 2)}\n`)
    return 2
  }

  const bsdtar = probeBsdtar(jsonMode)
  const vitestEntry = join(repoRoot, 'node_modules', 'vitest', 'vitest.mjs')
  if (!existsSync(vitestEntry)) {
    log(jsonMode, `[vitest] NOT FOUND: ${vitestEntry} — run pnpm install first`)
    out(`${JSON.stringify({ ok: false, mode, vitest: { path: vitestEntry, found: false }, exitCode: 2 }, null, 2)}\n`)
    return 2
  }

  const env = { ...process.env }
  const pathKey = Object.keys(env).find(key => key.toUpperCase() === 'PATH') ?? 'PATH'
  if (bsdtar.pathPrepended === true) {
    env[pathKey] = `${join(systemRoot(), 'System32')}${delimiter}${env[pathKey] ?? ''}`
  }
  if (detection.adopted.kind === 'entrypoint') env.npm_execpath = detection.adopted.path
  else delete env.npm_execpath

  const specRelative = specPath.startsWith(repoRoot) ? specPath.slice(repoRoot.length + 1) : specPath
  const execpathNote = env.npm_execpath === undefined ? '(deleted)' : env.npm_execpath
  log(jsonMode, `[spec] node node_modules/vitest/vitest.mjs run ${specRelative} (npm_execpath=${execpathNote}; System32 PATH prepend=${String(bsdtar.pathPrepended === true)})`)
  const result = spawnSync(process.execPath, [vitestEntry, 'run', specPath], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: SPEC_TIMEOUT_MS,
    windowsHide: true,
  })
  if (result.stdout !== null && result.stdout !== undefined && result.stdout !== '') (jsonMode ? err : out)(result.stdout)
  if (result.stderr !== null && result.stderr !== undefined && result.stderr !== '') err(result.stderr)
  const exitCode = result.status ?? (result.signal !== null && result.signal !== undefined ? 1 : 2)
  const summary = summarize(result.stdout ?? '')
  const ok = exitCode === 0
  log(jsonMode, `[done] spec exit=${String(exitCode)} summary: Test Files ${summary.testFiles ?? '?'}; Tests ${summary.tests ?? '?'}`)
  const payload = {
    ok,
    mode,
    pin,
    pnpm: { adopted: detection.adopted, probes: detection.probes },
    bsdtar,
    spec: {
      path: specRelative,
      absolute: specPath,
      command: `node ${join('node_modules', 'vitest', 'vitest.mjs')} run ${specRelative}`,
      npmExecpath: env.npm_execpath ?? null,
      exitCode,
      summary,
      ...(result.error !== undefined ? { error: String(result.error) } : {}),
      ...(result.signal !== null && result.signal !== undefined ? { signal: result.signal } : {}),
    },
    exitCode,
  }
  log(jsonMode, '=== STRUCTURED (JSON) ===')
  out(`${JSON.stringify(payload, null, 2)}\n`)
  return ok ? 0 : 1
}

// Natural completion (no process.exit) so every synchronous fd write above is
// guaranteed to reach pipe consumers such as the pdf-license spec's spawnSync.
process.exitCode = main()
