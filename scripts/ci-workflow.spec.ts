import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import * as yaml from 'js-yaml'
import { afterEach, describe, expect, it } from 'vitest'
import { KNOWN_FAILURE_LANES, KNOWN_FAILURES_PATH, KnownFailuresRosterError, activeKnownFailurePaths, loadKnownFailures } from './ci-windows-known-failures.ts'

const root = resolve(import.meta.dirname, '..')

/**
 * zDSH-Go adaptation of the upstream CI-workflow contract suite.
 *
 * The upstream 0.1.5 tree spreads its CI across ci.yml / ci-master.yml /
 * e2e.yml / e2b-e2e.yml / python-release.yml / build-exe-for-python-sdk.yml /
 * issue-lifecycle.yml / issue-policy.yml / release.yml / release-publish.yml /
 * release-vendor.yml / release-vendor-publish.yml / docs-pages.yml /
 * node-addon-system(-release).yml / sandbox.yml / weighted-approval(-review-event).yml /
 * expected-filenames.yml / build-preview-cloudflare.yml / pi-ai-provider-e2e.yml.
 * The zDSH-Go line deliberately removed every inherited upstream workflow and
 * ships exactly TWO workflows: `.github/workflows/ci.yml` (a standalone Windows
 * quality gate) and `.github/workflows/zdsh-ci.yml` (the zDSH overlay contract
 * lane, adopted with the 0.2.1-alpha.2 base and retargeted from the zDSH line's
 * `zdsh-latest` push branch to this line's `main`). The tests below pin that
 * factual inventory instead of the upstream file set, and keep the upstream
 * checks that still anchor real files in this tree (wine gate script, GitLab CI,
 * lefthook, vitest config).
 *
 * Unlike the historical vendored-plugins layout, the 0.1.5 in-tree layout ships
 * two buildable libraries (host + client); there is no `build:lib:plugins`.
 */
const WORKFLOW_DIR = '.github/workflows'

function loadWorkflow(path: string): Record<string, unknown> {
  const workflow: unknown = yaml.load(readFileSync(resolve(root, path), 'utf8'))
  if (!isRecord(workflow)) throw new TypeError(`${path} must define a workflow`)
  return workflow
}

function workflowEvent(workflow: Record<string, unknown>, event: string): Record<string, unknown> {
  if (!isRecord(workflow.on) || !isRecord(workflow.on[event])) {
    throw new TypeError(`workflow must define the ${event} event`)
  }
  return workflow.on[event]
}

function workflowJob(workflow: Record<string, unknown>, job: string): Record<string, unknown> {
  if (!isRecord(workflow.jobs) || !isRecord(workflow.jobs[job])) {
    throw new TypeError(`workflow must define the ${job} job`)
  }
  return workflow.jobs[job]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function workflowSteps(job: Record<string, unknown>, workflowName: string): Record<string, unknown>[] {
  if (!Array.isArray(job.steps)) throw new TypeError(`${workflowName} job must define steps`)
  return job.steps.filter(isRecord)
}

function runCommandsOf(job: Record<string, unknown>, workflowName: string): string {
  return workflowSteps(job, workflowName)
    .flatMap(step => typeof step.run === 'string' ? [step.run] : [])
    .join('\n')
}

/** The version handed to pnpm/action-setup; both lanes must track packageManager. */
function pnpmSetupVersion(job: Record<string, unknown>, workflowName: string): unknown {
  const setup = workflowSteps(job, workflowName)
    .find(step => typeof step.uses === 'string' && step.uses.startsWith('pnpm/action-setup@'))
  if (!isRecord(setup) || !isRecord(setup.with)) throw new TypeError(`${workflowName} must configure pnpm/action-setup`)
  return setup.with.version
}

function packageManagerVersion(): string {
  const manifest: unknown = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
  if (!isRecord(manifest) || typeof manifest.packageManager !== 'string') {
    throw new TypeError('package.json must declare packageManager')
  }
  return manifest.packageManager
}

function packageScriptNames(): string[] {
  return Object.keys(packageScripts())
}

/** The declared package scripts by name (bodies only; non-string entries are dropped). */
function packageScripts(): Record<string, string> {
  const manifest: unknown = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
  if (!isRecord(manifest) || !isRecord(manifest.scripts)) throw new TypeError('package.json must define scripts')
  const scripts: Record<string, string> = {}
  for (const [name, body] of Object.entries(manifest.scripts)) {
    if (typeof body === 'string') scripts[name] = body
  }
  return scripts
}

function ciWorkflow(): Record<string, unknown> {
  return loadWorkflow(`${WORKFLOW_DIR}/ci.yml`)
}

function zdshCiWorkflow(): Record<string, unknown> {
  return loadWorkflow(`${WORKFLOW_DIR}/zdsh-ci.yml`)
}

describe('CI workflow (zDSH-Go standalone quality gate)', () => {
  it('is the only GitHub Actions workflow besides the zDSH overlay lane', () => {
    const entries = readdirSync(resolve(root, WORKFLOW_DIR)).sort()
    expect(entries).toEqual(['ci.yml', 'zdsh-ci.yml'])
  })

  it('runs the quality gate on main pushes, PRs, and manual dispatch on a Windows runner', () => {
    const workflow = ciWorkflow()
    if (!isRecord(workflow.on)) throw new TypeError('ci.yml must define on')
    expect(Object.keys(workflow.on).sort()).toEqual(['pull_request', 'push', 'workflow_dispatch'])
    const push = workflowEvent(workflow, 'push')
    expect(push).toMatchObject({ branches: ['main'] })

    const quality = workflowJob(workflow, 'quality-gate')
    expect(quality['runs-on']).toBe('windows-latest')
    const steps = workflowSteps(quality, 'ci.yml')

    // The checkout action stays pinned so a dependabot bump is a reviewed change.
    const checkout = steps.find(step => typeof step.uses === 'string' && step.uses.startsWith('actions/checkout@'))
    expect(checkout).toBeDefined()

    const runCommands = steps.flatMap(step => typeof step.run === 'string' ? [step.run] : [])
    // The gate builds both shipped libraries before running the suites.
    expect(runCommands).toContain('pnpm run build:lib:host')
    expect(runCommands).toContain('pnpm run build:lib:client')
    // The unit lane is the roster-filtered one: a spec file red on this runner
    // must be registered in the known-failure roster, never silently skipped.
    expect(runCommands).toContain('pnpm run test:ci')
    expect(runCommands).not.toContain('pnpm run test')
    expect(runCommands).toContain('pnpm run lint:contracts-ready')
    expect(runCommands).toContain('pnpm run test:docs')
  })

  it('pins the pnpm installer to the repository packageManager version', () => {
    const pinned = pnpmSetupVersion(workflowJob(ciWorkflow(), 'quality-gate'), 'ci.yml')

    expect(packageManagerVersion()).toBe(`pnpm@${String(pinned)}`)
  })

  it('cancels superseded runs per ref and bounds the job wall clock', () => {
    const workflow = ciWorkflow()
    expect(workflow.concurrency).toMatchObject({ 'cancel-in-progress': true })
    const group = (workflow.concurrency as Record<string, unknown>).group
    expect(group).toBe('ci-${{ github.ref }}')

    const quality = workflowJob(workflow, 'quality-gate')
    expect(quality['timeout-minutes']).toBe(60)
  })

  it('keeps supported LSP source under native Windows coverage', () => {
    const config = readFileSync(resolve(root, 'vitest.config.ts'), 'utf8')

    expect(config).not.toContain('packages/lsp/lsp-stdio/src/connection.ts')
    expect(config).not.toContain('packages/lsp/lsp-stdio/src/index.ts')
    expect(config).not.toContain('packages/lsp/lsp-stdio/src/instance.ts')
  })

  it('keeps every Vitest project process-isolated on native Windows', () => {
    const config = readFileSync(resolve(root, 'vitest.config.ts'), 'utf8')

    expect(config).not.toContain("pool: process.platform === 'win32' ? 'threads' : 'forks'")
    expect(config.match(/pool: 'forks'/g)).toHaveLength(2)
  })
})

/**
 * The Windows lane's known-failure roster: the registered register that lets an
 * admitted file stay red without failing the gate. These tests pin the two
 * halves of the anti-masking contract — every entry carries its admission
 * evidence, and the CI lane's excludes come from the roster (plus the
 * inherited repository config) and from nowhere else.
 */
describe('CI known-failure roster (Windows quality gate)', () => {
  it('registers only existing, exact spec files with a reason and evidence', () => {
    const entries = loadKnownFailures(root)

    expect(entries.length).toBeGreaterThan(0)
    for (const entry of entries) {
      // Exact paths only: a glob would widen one registration into a mask.
      expect(entry.path, entry.path).not.toMatch(/[*?[\]{}!]/)
      expect(entry.path, entry.path).toMatch(/\.spec\.tsx?$/)
      expect(existsSync(resolve(root, entry.path)), entry.path).toBe(true)
      expect(KNOWN_FAILURE_LANES).toContain(entry.lane)
      expect(entry.reason.trim().length, entry.path).toBeGreaterThan(0)
      expect(entry.evidence.length, entry.path).toBeGreaterThan(0)
      for (const reference of entry.evidence) expect(reference.trim().length, entry.path).toBeGreaterThan(0)
    }
  })

  it('feeds the roster-filtered lane through the inherited config and its own package script', () => {
    const scripts = packageScripts()
    expect(scripts['test:ci']).toContain('vitest run --config vitest.ci.config.ts')

    // The lane adds excludes; it must not re-implement the platform inventory
    // or fork any other part of the repository's Vitest definition.
    const config = readFileSync(resolve(root, 'vitest.ci.config.ts'), 'utf8')
    expect(config).toContain("from './vitest.config.ts'")
    expect(config).toContain('activeKnownFailurePaths')
    expect(config).toContain('scripts/ci-windows-known-failures.ts')
    expect(config).not.toContain('platformUnsupportedTests')
    expect(config).not.toContain('pool:')

    // The roster path the lane reads is the registered one.
    expect(existsSync(resolve(root, KNOWN_FAILURES_PATH))).toBe(true)
  })

  it('drops exactly the workstation-only entries on the hosted runner (D25①)', () => {
    const entries = loadKnownFailures(root)
    const local = activeKnownFailurePaths({})
    const hosted = activeKnownFailurePaths({ GITHUB_ACTIONS: 'true' })

    // Explicit pins: both numbers move only with a reviewed roster edit (the
    // campaign's reverse verification replayed the original failure set against
    // a cleared roster at this size: 12 registered / 4 hosted).
    expect(local).toHaveLength(12)
    expect(hosted).toHaveLength(4)

    // Lane semantics, stated independently of the counts: the local lane
    // excludes every registered entry in file order, while `GITHUB_ACTIONS=true`
    // drops exactly the workstation-only rows so the hosted runner keeps
    // covering those files (no coverage is traded away by the roster).
    expect([...local]).toEqual(entries.map(entry => entry.path))
    expect([...hosted]).toEqual(entries.filter(entry => entry.lane === 'github-windows-ci').map(entry => entry.path))
    const workstation = entries.filter(entry => entry.lane === 'workstation')
    expect(workstation.length).toBeGreaterThan(0)
    for (const entry of workstation) expect(hosted).not.toContain(entry.path)

    // A duplicate path would split one file's evidence across two rows and
    // change nothing on the wire; the loader refuses it outright.
    expect(new Set(entries.map(entry => entry.path)).size).toBe(entries.length)
  })
})

/**
 * The guards fail closed: a roster that could widen an entry into a mask (glob
 * path), state no reason, cite no evidence, tag an unknown lane, or name a file
 * that is gone must refuse to load — the lane then cannot run at all.
 */
describe('known-failure roster guards', () => {
  const fixtureRoots: string[] = []

  afterEach(() => {
    for (const fixture of fixtureRoots.splice(0)) rmSync(fixture, { recursive: true, force: true })
  })

  /** A throwaway repository root holding one real spec file and `entries`. */
  function fixtureRepository(entries: unknown): string {
    const fixture = mkdtempSync(join(tmpdir(), 'dsh-known-failures-'))
    fixtureRoots.push(fixture)
    mkdirSync(join(fixture, 'packages/probe/target/tests'), { recursive: true })
    writeFileSync(join(fixture, 'packages/probe/target/tests/probe.spec.ts'), '')
    mkdirSync(join(fixture, 'scripts'), { recursive: true })
    writeFileSync(join(fixture, KNOWN_FAILURES_PATH), JSON.stringify({ entries }))
    return fixture
  }

  const ACCEPTED = {
    path: 'packages/probe/target/tests/probe.spec.ts',
    lane: 'workstation',
    reason: 'registered for the guard test',
    evidence: ['scripts/ci-workflow.spec.ts'],
  }

  it('accepts an exact, evidenced entry', () => {
    expect(loadKnownFailures(fixtureRepository([ACCEPTED]))).toEqual([ACCEPTED])
  })

  it.each([
    ['a glob path', { ...ACCEPTED, path: 'packages/probe/target/tests/*.spec.ts' }],
    ['no evidence', { ...ACCEPTED, evidence: [] }],
    ['an empty reason', { ...ACCEPTED, reason: '   ' }],
    ['an unknown lane', { ...ACCEPTED, lane: 'somewhere-else' }],
    ['an unknown key', { ...ACCEPTED, note: 'unregistered' }],
    ['a missing file', { ...ACCEPTED, path: 'packages/probe/target/tests/gone.spec.ts' }],
  ])('refuses %s', (_label, entry) => {
    expect(() => loadKnownFailures(fixtureRepository([entry]))).toThrow(KnownFailuresRosterError)
  })

  it('refuses a `..` traversal segment before the existence check (D25⑤)', () => {
    // Both shapes are rejected by the traversal guard itself: the first escapes
    // the fixture root, the second resolves back inside — a segment is never
    // legitimate in a repo-relative roster path, and checking it before
    // `existsSync(resolve(root, path))` keeps the guard independent of whatever
    // happens to exist outside the tree.
    for (const path of [
      'packages/../../probe.spec.ts',
      'packages/../packages/probe/target/tests/probe.spec.ts',
    ]) {
      expect(() => loadKnownFailures(fixtureRepository([{ ...ACCEPTED, path }]))).toThrow(/must not carry a '\.\.' segment/)
    }
  })

  it('refuses a duplicated path (D25⑤)', () => {
    // The same file registered twice would split its evidence across two rows.
    expect(() => loadKnownFailures(fixtureRepository([ACCEPTED, { ...ACCEPTED }])))
      .toThrow(/lists packages\/probe\/target\/tests\/probe\.spec\.ts more than once/)
  })
})

describe('zDSH overlay lane (zdsh-ci.yml)', () => {
  const JOB = 'zdsh-contract-gates'

  it('runs the contract lane on main pushes, PRs, and manual dispatch on the hosted Linux runner', () => {
    const workflow = zdshCiWorkflow()
    if (!isRecord(workflow.on)) throw new TypeError('zdsh-ci.yml must define on')
    expect(Object.keys(workflow.on).sort()).toEqual(['pull_request', 'push', 'workflow_dispatch'])
    const push = workflowEvent(workflow, 'push')
    // The lane was authored against the zDSH line's `zdsh-latest` branch.
    expect(push).toMatchObject({ branches: ['main'] })

    const job = workflowJob(workflow, JOB)
    expect(job['runs-on']).toBe('ubuntu-latest')
    expect(job['timeout-minutes']).toBe(90)

    const checkout = workflowSteps(job, 'zdsh-ci.yml')
      .find(step => typeof step.uses === 'string' && step.uses.startsWith('actions/checkout@'))
    expect(checkout).toBeDefined()
  })

  it('pins the pnpm installer to the repository packageManager version', () => {
    const pinned = pnpmSetupVersion(workflowJob(zdshCiWorkflow(), JOB), 'zdsh-ci.yml')

    expect(packageManagerVersion()).toBe(`pnpm@${String(pinned)}`)
  })

  it('cancels superseded runs per workflow/ref and reads repository contents only', () => {
    const workflow = zdshCiWorkflow()
    expect(workflow.concurrency).toMatchObject({ 'cancel-in-progress': true })
    const group = (workflow.concurrency as Record<string, unknown>).group
    expect(group).toBe('${{ github.workflow }}-${{ github.ref }}')
    expect(workflow.permissions).toMatchObject({ contents: 'read' })
  })

  it('installs immutably before the static gates, then the host build, then the contract specs', () => {
    const commands = runCommandsOf(workflowJob(zdshCiWorkflow(), JOB), 'zdsh-ci.yml')

    expect(commands).toContain('pnpm install --frozen-lockfile')
    for (const script of [
      'constraints',
      'verify-tsconfig-paths',
      'verify-config-catalog',
      'verify-package-readme-summaries',
      'build:lib:host',
    ]) {
      expect(commands).toContain(`pnpm run ${script}`)
    }

    const installIndex = commands.indexOf('pnpm install --frozen-lockfile')
    const hostBuildIndex = commands.indexOf('pnpm run build:lib:host')
    const specsIndex = commands.indexOf('pnpm exec vitest run')
    expect(installIndex).toBeLessThan(hostBuildIndex)
    expect(hostBuildIndex).toBeLessThan(specsIndex)
  })

  it('invokes only package scripts and specs that exist in this tree', () => {
    const commands = runCommandsOf(workflowJob(zdshCiWorkflow(), JOB), 'zdsh-ci.yml')

    const invoked = [...commands.matchAll(/pnpm run ([A-Za-z0-9:_-]+)/g)].map(match => match[1]!)
    expect(invoked.length).toBeGreaterThan(0)
    const declared = packageScriptNames()
    for (const script of invoked) expect(declared).toContain(script)

    // The tsx/vitest entrypoints the lane names by path (the exec forms cannot
    // be covered by the package.json lookup above).
    for (const path of [
      'scripts/audit-compat-roster.ts',
      'scripts/verify-compatible-window.ts',
      'scripts/verify-zdsh-external-links.ts',
      'scripts/verify-zdsh-residence-map.ts',
      'scripts/verify-zdsh-residence-map.spec.ts',
      'scripts/lint-plugin-dependency-face.spec.ts',
      'scripts/gen-config-catalog.spec.ts',
    ]) {
      expect(existsSync(resolve(root, path)), path).toBe(true)
    }
  })
})

describe('GitLab CI (upstream contract retained by zDSH-Go)', () => {
  it('uses the shared macOS deployment-target check in GitLab', () => {
    const workflow = loadWorkflow('.gitlab-ci.yml')
    const runtimeWheel = workflow['.runtime-wheel']
    if (!isRecord(runtimeWheel) || !Array.isArray(runtimeWheel.script)) {
      throw new TypeError('GitLab CI must define the runtime wheel script')
    }
    const runtimeScript: unknown[] = runtimeWheel.script
    const macosCheck = runtimeScript.find(
      step => typeof step === 'string' && step.includes('${PLATFORM#macos-}'),
    )
    if (typeof macosCheck !== 'string') {
      throw new TypeError('GitLab CI must check the macOS deployment target')
    }

    expect(macosCheck).toContain('scripts/check-macos-deployment-target.py')
    expect(macosCheck).toContain('lipo "$payload" -verify_arch')
    expect(macosCheck).toContain('"$EXE" "$EXE-rg" "$EXE-spawn-helper"')
  })

  it('builds the macOS x64 wheel on the matching GitLab runner', () => {
    const workflow = loadWorkflow('.gitlab-ci.yml')
    const macosX64 = workflow['runtime-macos-x64']
    const publish = workflow['publish-python']
    if (!isRecord(macosX64) || !isRecord(publish) || !Array.isArray(publish.needs)) {
      throw new TypeError('GitLab CI must define the macOS x64 runtime and publication jobs')
    }

    expect(macosX64.tags).toEqual(['macos-x64'])
    expect(macosX64.variables).toMatchObject({ PKG_TARGET: 'node24-macos-x64', PLATFORM: 'macos-x64' })
    expect(publish.needs).toContainEqual({ job: 'runtime-macos-x64', artifacts: true })
    expect(JSON.stringify(publish.script)).toContain('macosx_14_0_x86_64.whl')
  })

  it('builds and black-box tests the Windows x64 wheel in GitLab', () => {
    const workflow = loadWorkflow('.gitlab-ci.yml')
    const windows = workflow['runtime-windows-x64']
    const publish = workflow['publish-python']
    if (!isRecord(windows) || !Array.isArray(windows.before_script) || !Array.isArray(windows.script)
      || !isRecord(publish) || !Array.isArray(publish.needs)) {
      throw new TypeError('GitLab CI must define the Windows runtime and aggregate publication jobs')
    }

    expect(windows.tags).toEqual(['windows-x64'])
    expect(windows.variables).toMatchObject({ PKG_TARGET: 'node24-win-x64', PLATFORM: 'win-x64' })
    expect(JSON.stringify(windows.before_script)).toContain('.ci-python\\\\Scripts')
    expect(JSON.stringify(windows.before_script)).toContain('[IO.Path]::PathSeparator')
    expect(JSON.stringify(windows.script)).toContain('win_amd64.whl')
    expect(JSON.stringify(windows.script)).toContain('--scenario all --installed-wheel')
    expect(publish.needs).toContainEqual({ job: 'runtime-windows-x64', artifacts: true })
  })
})

describe('Git hooks', () => {
  it('leaves frozen Agent Note sidecars to the archive verifier', () => {
    const lefthook = loadWorkflow('lefthook.yml')

    for (const hookName of ['pre-commit', 'pre-merge-commit']) {
      const hook = lefthook[hookName]
      if (!isRecord(hook) || !Array.isArray(hook.jobs)) {
        throw new TypeError(`lefthook must define ${hookName} jobs`)
      }
      const pairing: unknown = hook.jobs.find(
        (job: unknown) => isRecord(job) && job.name === 'translation pairing (staged records)',
      )

      expect(pairing).toMatchObject({ exclude: ['.agents/notes/archived/**'] })
    }
  })
})

describe('Wine gate script (upstream contract retained by zDSH-Go)', () => {
  it('gives the Host TypeScript compile the repository heap budget', () => {
    const wineGates = readFileSync(resolve(root, 'scripts/wine-windows-gates.sh'), 'utf8')

    expect(wineGates).toContain(
      'wine_node "$scratch/logs/host-tsc.log" --max-old-space-size=4096 "$tsc_js" -b tsconfig.host.json --pretty false',
    )
  })
})
