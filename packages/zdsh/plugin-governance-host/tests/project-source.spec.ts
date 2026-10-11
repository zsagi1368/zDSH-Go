/**
 * Project source distinction suite (S-43 M2a, C-01): a project plugin mounted
 * through the project layer appears in the roster as source='project' with its
 * root, no OFFICIAL certification, and requiresAdmission=true — all three
 * distinguishable from the same plugin arriving via the host install channel
 * or as an ordinary Loader mirror.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, parse } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import PluginGovernanceGateway, { type PluginGovernanceId } from '../src/index.ts'
import { mountProjectPlugins } from '@deepseek-ai/dsh-plugin-project-root'
import {
  emptyProjectTrusts,
  saveProjectTrusts,
  trustProjectRoot,
  decideProjectPlugin,
} from '@deepseek-ai/dsh-plugin-project-root'

const contexts: Context[] = []
const tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gov-project-src-'))
  tempRoots.push(dir)
  return dir
}

function gid(value: string): PluginGovernanceId {
  return value as PluginGovernanceId
}

/** A Cordis service used as the mounted fixture AND the project entry module. */
class FixtureService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'project-source-fixture')
  }
}

/** A separate service for the project entry (avoids duplicate registration). */
class ProjectFixtureService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'project-source-fixture-proj')
  }
}

describe('project source distinction (C-01)', () => {
  it('keeps project, loader-mirror, and native-install channels distinguishable', async () => {
    const ctx = new Context()
    contexts.push(ctx)

    // --- Loader with a controllable module importer ---
    const { Loader } = await import('@deepseek-ai/cordis-plugin-loader')
    await ctx.plugin(Loader)
    const modules = new Map<string, unknown>([
      ['@fixtures/dsh-alpha', { default: FixtureService }],
    ])
    ctx.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        const mod = modules.get(specifier)
        if (mod === undefined) throw new Error(`unexpected Loader import: ${specifier}`)
        return mod
      },
    } as unknown as NonNullable<typeof ctx.loader.internal>

    // --- Ordinary loader mirror (host bundle) ---
    await ctx.loader.create({ name: '@fixtures/dsh-alpha' })
    await ctx.loader.await()

    // --- Project plugin: switch on + trusted ledger ---
    const projectRoot = tempDir()
    mkdirSync(join(projectRoot, '.git'))
    const dataDir = tempDir()
    const trusts = emptyProjectTrusts()
    trustProjectRoot(trusts, projectRoot)
    decideProjectPlugin(trusts, projectRoot, 'fixtures/project-demo', true)
    saveProjectTrusts(dataDir, trusts)
    const rows = new Map([['project-plugins', { id: 'project-plugins', name: 'project-plugins', config: { enabled: true } }]])
    const realProjectDir = join(projectRoot, '.dsh', 'plugins', 'demo')
    mkdirSync(realProjectDir, { recursive: true })
    // On win32 a bare '/' resolves to the CURRENT drive root, which may differ
    // from the drive holding the fixture root; declare the root's own drive root.
    const declaredRoot = parse(realProjectDir).root
    writeFileSync(join(realProjectDir, 'manifest.json'), JSON.stringify({
      id: 'fixtures/project-demo',
      version: '1.0.0',
      name: 'Project Demo',
      dsh: { compatible: '>=0.1.0-rc.8' },
      capabilities: [{ type: 'tool', tool: { name: 'project_tool', description: 't', schema: { type: 'object' } } }],
      sandbox: {
        type: 'inline',
        resources: { memoryLimitMb: 128, cpuLimit: 50, timeoutMs: 30000, maxOutputBytes: 10000 },
        filesystem: { access: 'readonly', allowedPaths: [declaredRoot], deniedPatterns: [] },
        network: { access: 'none', allowedHosts: [], deniedHosts: [], allowLocal: false },
        environment: { whitelist: [], blacklist: [], clear: false },
        process: { spawn: false, exec: false, allowedCommands: [] },
      },
    }, null, 2))
    writeFileSync(join(realProjectDir, 'index.js'), '')
    modules.set(pathToFileURL(join(realProjectDir, 'index.js')).href, { default: ProjectFixtureService })
    const result = await mountProjectPlugins(ctx, rows, { cwd: projectRoot, dataDir })
    expect(result.mounted).toHaveLength(1)

    // --- Gateway (its init syncs the loader, seeing the project entry) ---
    const storageRoot = tempDir()
    await ctx.plugin(PluginGovernanceGateway, { storageRoot })

    // --- Host install channel for a DIFFERENT plugin id ---
    const installSource = tempDir()
    writeFileSync(join(installSource, 'package.json'), JSON.stringify({
      name: '@fixtures/host-installed',
      version: '1.0.0',
      displayName: 'Host Installed',
      dsh: { permissionLevel: 'workspace', capabilities: [{ type: 'tool', tool: { name: 'host_tool', description: 'h', schema: { type: 'object' } } }] },
    }))
    const gateway = ctx.get('pluginGovernance') as PluginGovernanceGateway
    const installed = await gateway.install({ source: installSource })
    expect(installed.ok).toBe(true)

    // --- Roster: wait for the lazy sync to pick up the project entry ---
    await vi.waitFor(() => {
      const roster = gateway.list().plugins
      expect(roster.find(p => p.pluginId === gid('fixtures/project-demo'))).toBeDefined()
      expect(roster.find(p => p.pluginId === gid('fixtures/dsh-alpha'))).toBeDefined()
      expect(roster.find(p => p.pluginId === gid('fixtures/host-installed'))).toBeDefined()
    })

    const roster = gateway.list().plugins
    const projectRow = roster.find(p => p.pluginId === gid('fixtures/project-demo'))
    const mirrorRow = roster.find(p => p.pluginId === gid('fixtures/dsh-alpha'))
    const nativeRow = roster.find(p => p.pluginId === gid('fixtures/host-installed'))

    // --- C-01 assertions: the project row is fully distinguishable ---
    expect(projectRow).toMatchObject({
      source: 'project',
      projectRoot,
      approvalRequired: true,
      status: 'active',
      version: '1.0.0',
    })
    expect(mirrorRow?.source).toBe('loader-mirror')
    expect(mirrorRow?.approvalRequired).toBe(false)
    expect(mirrorRow?.projectRoot).toBeUndefined()
    expect(nativeRow?.source).toBe('native')
    // FB3 (TC-B4-H1 face 2) — card-mandated conflict update (PC2 precedent:
    // 既有锁更新=严格增强零削弱): the fixture's self-reported
    // `permissionLevel: 'workspace'` was pre-clamp elevation material — the
    // install channel no longer consumes self-reported trust fields, so the
    // native row projects approvalRequired=true (CONFIRM_REQUIRED 起步).
    // project/mirror 两腿断言零触碰（各自通道的信任语义与安装通道正交）。
    expect(nativeRow?.approvalRequired).toBe(true)
    expect(nativeRow?.projectRoot).toBeUndefined()

    // Detail projection: project plugins carry no OFFICIAL badge and expose
    // the clamped sandbox plus the M2a runtime tier.
    const projectDetail = gateway.get({ pluginId: gid('fixtures/project-demo') })
    expect(projectDetail.ok).toBe(true)
    if (projectDetail.ok) {
      expect(projectDetail.value.certification).toBeNull()
      expect(projectDetail.value.permissionLevel).toBe('confirm-required')
      expect(projectDetail.value.sandbox).toMatchObject({
        type: 'inline',
        networkAccess: 'none',
        filesystemAccess: 'readonly',
        maySpawnProcesses: false,
        runtimeTier: 'in-process',
      })
    }
    // The mirror (official-style) keeps its OFFICIAL badge for contrast.
    const mirrorDetail = gateway.get({ pluginId: gid('fixtures/dsh-alpha') })
    expect(mirrorDetail.ok).toBe(true)
    if (mirrorDetail.ok) {
      expect(mirrorDetail.value.certification).toBe('official')
    }
  })
})

describe('subprocess project plugin roster (M2b)', () => {
  it('registers subprocess-tier entries with no loader row as source=project', async () => {
    const ctx = new Context()
    contexts.push(ctx)

    // A fake project plugin layer exposing ONE subprocess-tier entry (no
    // loader row — its tools are host-side proxies). The host enumerates
    // subprocess entries through `subprocessEntryIds()`.
    const projectRoot = tempDir()
    const entryId = 'project-plugin-abcdef12-fixtures-subproc'
    const guardedManifest = {
      id: 'fixtures/subproc-demo',
      version: '1.0.0',
      name: 'Subprocess Demo',
      dsh: { compatible: '>=0.1.0-rc.8' },
      capabilities: [{ type: 'tool', tool: { name: 'subproc_tool', description: 't', schema: { type: 'object' } } }],
      sandbox: {
        type: 'process',
        resources: { memoryLimitMb: 128, cpuLimit: 50, timeoutMs: 30000, maxOutputBytes: 10000 },
        filesystem: { access: 'readonly', allowedPaths: [], deniedPatterns: [] },
        network: { access: 'none', allowedHosts: [], deniedHosts: [], allowLocal: false },
        environment: { whitelist: [], blacklist: [], clear: false },
        process: { spawn: false, exec: false, allowedCommands: [] },
      },
    } as const
    const fakeLayer = {
      originOf: (id: string) => id === entryId
        ? {
          manifestId: 'fixtures/subproc-demo',
          projectRoot,
          version: '1.0.0',
          runtimeTier: 'subprocess',
        }
        : undefined,
      guardedManifestOf: (id: string) => id === entryId ? guardedManifest : undefined,
      subprocessEntryIds: () => [entryId],
    }
    // Mirror the project layer's own provide mechanism (ctx.reflect.provide).
    ctx.reflect.provide('projectPluginLayer', fakeLayer)

    const storageRoot = tempDir()
    await ctx.plugin(PluginGovernanceGateway, { storageRoot })
    const gateway = ctx.get('pluginGovernance') as PluginGovernanceGateway

    await vi.waitFor(() => {
      const roster = gateway.list().plugins
      expect(roster.find(p => p.pluginId === gid('fixtures/subproc-demo'))).toBeDefined()
    })

    const row = gateway.list().plugins.find(p => p.pluginId === gid('fixtures/subproc-demo'))
    // C-01 projection applies to subprocess entries exactly like in-process
    // loader entries: source='project', projectRoot, approval required.
    expect(row).toMatchObject({
      source: 'project',
      projectRoot,
      approvalRequired: true,
      status: 'active',
      version: '1.0.0',
    })

    // Detail projection reports the M2b runtime tier (process/worker OS
    // boundary) so the UI never mistakes it for the in-process runtime.
    const detail = gateway.get({ pluginId: gid('fixtures/subproc-demo') })
    expect(detail.ok).toBe(true)
    if (detail.ok) {
      expect(detail.value.certification).toBeNull()
      expect(detail.value.sandbox).toMatchObject({
        type: 'process',
        networkAccess: 'none',
        maySpawnProcesses: false,
        runtimeTier: 'subprocess',
      })
    }
  })
})
