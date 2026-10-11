/**
 * Shared fixtures for the plugin-project-root test suites.
 */

import { mkdirSync, mkdtempSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PluginManifest, PluginSandboxConfig } from '@deepseek-ai/dsh-plugin-governance'

/** A valid PluginSandboxConfig for the project plugin clamp. */
export function testSandbox(overrides: Partial<PluginSandboxConfig> = {}): PluginSandboxConfig {
  return {
    type: 'inline',
    resources: { memoryLimitMb: 128, cpuLimit: 50, timeoutMs: 30000, maxOutputBytes: 10000 },
    filesystem: { access: 'readonly', allowedPaths: [], deniedPatterns: [] },
    network: { access: 'none', allowedHosts: [], deniedHosts: [], allowLocal: false },
    environment: { whitelist: [], blacklist: [], clear: false },
    process: { spawn: false, exec: false, allowedCommands: [] },
    ...overrides,
  }
}

/** A valid PluginManifest that passes the LoadGuard five checks. */
export function testManifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    id: 'fixtures/demo',
    version: '1.0.0',
    name: 'Demo Plugin',
    dsh: { compatible: '>=0.1.0-rc.8' },
    capabilities: [{ type: 'tool', tool: { name: 'demo_tool', description: 'A demo tool', schema: { type: 'object' } } }],
    sandbox: testSandbox(),
    ...overrides,
  }
}

/** A manifest JSON blob for quick fixture writing. */
export function manifestBlob(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'fixtures/demo',
    version: '1.0.0',
    name: 'Demo Plugin',
    dsh: { compatible: '>=0.1.0-rc.8' },
    capabilities: [{ type: 'tool', tool: { name: 'demo_tool', description: 'A demo tool', schema: { type: 'object' } } }],
    sandbox: {
      type: 'inline',
      resources: { memoryLimitMb: 128, cpuLimit: 50, timeoutMs: 30000, maxOutputBytes: 10000 },
      filesystem: { access: 'readonly', allowedPaths: [], deniedPatterns: [] },
      network: { access: 'none', allowedHosts: [], deniedHosts: [], allowLocal: false },
      environment: { whitelist: [], blacklist: [], clear: false },
      process: { spawn: false, exec: false, allowedCommands: [] },
    },
    ...overrides,
  }
}

/** A throwaway temp directory, removed on cleanup. */
export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-ppr-'))
}

/** Write a plugin package under `root/.dsh/plugins/<name>/` and return the absolute pluginDir. */
export function writePluginPackage(
  root: string,
  name: string,
  manifest: Record<string, unknown>,
  entryJs = 'export default class {}',
): string {
  const pluginDir = join(root, '.dsh', 'plugins', name)
  mkdirSync(pluginDir, { recursive: true })
  writeFileSync(join(pluginDir, 'manifest.json'), JSON.stringify(manifest, null, 2))
  writeFileSync(join(pluginDir, 'index.js'), entryJs)
  return pluginDir
}

/** Create a junction/symlink entry under `.dsh/plugins/<name>` pointing to a real directory. */
export function createPluginJunction(root: string, name: string, target: string): string {
  const linkPath = join(root, '.dsh', 'plugins', name)
  mkdirSync(join(root, '.dsh', 'plugins'), { recursive: true })
  try {
    symlinkSync(target, linkPath, 'junction')
  } catch {
    symlinkSync(target, linkPath)
  }
  return linkPath
}

/** A minimal Cordis service class usable as a project entry module default export. */
export class ProjectFixtureService {
  static serviceName = 'project-fixture'
  static inject: string[] = []
  start() {}
  stop() {}
}
