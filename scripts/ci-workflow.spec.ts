import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

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
 * ships exactly ONE workflow: `.github/workflows/ci.yml` (a standalone Windows
 * quality gate). The tests below pin that factual inventory instead of the
 * upstream file set, and keep the upstream checks that still anchor real files
 * in this tree (wine gate script, GitLab CI, lefthook, vitest config).
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

function ciWorkflow(): Record<string, unknown> {
  return loadWorkflow(`${WORKFLOW_DIR}/ci.yml`)
}

describe('CI workflow (zDSH-Go standalone quality gate)', () => {
  it('is the ONLY GitHub Actions workflow in the repository', () => {
    const entries = readdirSync(resolve(root, WORKFLOW_DIR)).sort()
    expect(entries).toEqual(['ci.yml'])
  })

  it('runs the quality gate on main pushes, PRs, and manual dispatch on a Windows runner', () => {
    const workflow = ciWorkflow()
    if (!isRecord(workflow.on)) throw new TypeError('ci.yml must define on')
    expect(Object.keys(workflow.on).sort()).toEqual(['pull_request', 'push', 'workflow_dispatch'])
    const push = workflowEvent(workflow, 'push')
    expect(push).toMatchObject({ branches: ['main'] })

    const quality = workflowJob(workflow, 'quality-gate')
    expect(quality['runs-on']).toBe('windows-latest')
    if (!Array.isArray(quality.steps)) throw new TypeError('quality-gate job must define steps')
    const steps = quality.steps.filter(isRecord)

    // The checkout action stays pinned so a dependabot bump is a reviewed change.
    const checkout = steps.find(step => typeof step.uses === 'string' && step.uses.startsWith('actions/checkout@'))
    expect(checkout).toBeDefined()

    const runCommands = steps.flatMap(step => typeof step.run === 'string' ? [step.run] : [])
    // The gate builds both shipped libraries before running the suites.
    expect(runCommands).toContain('pnpm run build:lib:host')
    expect(runCommands).toContain('pnpm run build:lib:client')
    expect(runCommands).toContain('pnpm run test')
    expect(runCommands).toContain('pnpm run lint:contracts-ready')
    expect(runCommands).toContain('pnpm run test:docs')
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
