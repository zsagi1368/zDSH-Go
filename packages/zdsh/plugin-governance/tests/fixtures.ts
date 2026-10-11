/**
 * Shared fixtures for the plugin governance suites: a minimal mock
 * PluginContext and a valid PluginManifest factory.
 */

import type { PluginManifest, PluginContext, PluginStatus } from '../src/spec/index.ts'

/** Build an in-memory PluginContext that records nothing. */
export function mockContext(): PluginContext {
  return {
    services: new Map(),
    emit: () => {},
    on: () => () => {},
    once: () => () => {},
    off: () => {},
    config: {},
    setConfig: () => {},
    getConfig: <T>(_key: string, defaultValue?: T): T => defaultValue as T,
    effect: () => {},
    onDispose: () => {},
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    },
    status: 'active' as PluginStatus,
    setWarnings: () => {},
    markDeprecated: () => {},
    sandbox: {
      exec: async () => ({ exitCode: 0, stdout: '', stderr: '', duration: 0 }),
      read: async () => '',
      write: async () => {},
      list: async () => [],
    },
    registerCapability: () => {},
    unregisterCapability: () => {},
  }
}

/** A manifest that passes every governance validation. */
export function testManifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    id: 'test/plugin',
    version: '1.0.0',
    name: 'Test Plugin',
    dsh: {
      compatible: '>=0.1.0-rc.8',
    },
    capabilities: [
      {
        type: 'tool',
        tool: {
          name: 'test_tool',
          description: 'A test tool',
          schema: { type: 'object' },
        },
      },
    ],
    sandbox: {
      type: 'inline',
      resources: {
        memoryLimitMb: 128,
        cpuLimit: 50,
        timeoutMs: 30000,
        maxOutputBytes: 10000,
      },
      filesystem: { access: 'readonly', allowedPaths: [], deniedPatterns: [] },
      network: { access: 'none', allowedHosts: [], deniedHosts: [], allowLocal: false },
      environment: { whitelist: [], blacklist: [], clear: false },
      process: { spawn: false, exec: false, allowedCommands: [] },
    },
    ...overrides,
  }
}
