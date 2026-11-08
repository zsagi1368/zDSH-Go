import { defineConfig } from 'tsdown'
import { typertPlugin } from './packages/typert/generator/lib/types/tsdown-plugin.js'

function isBuildFaceClient(value: unknown): boolean {
  if (value === undefined || value === 'host') return false
  if (value === 'client') return true
  throw new Error(`tsdown: --env.DSH_BUILD_FACE must be host or client, received ${String(value)}`)
}

/**
 * Local checkout residue: directories matching the workspace globs that hold
 * only install/build leftovers (`lib/`, `node_modules/`, `dist/`) of packages
 * that no longer exist on this branch. They carry no package.json, so they are
 * not workspace members, and their stale bundles cannot resolve against
 * current sources (e.g. `packages/settings/settings-file` imports
 * `SettingsProvider`, which `@deepseek-ai/dsh-settings` no longer exports).
 * Fresh checkouts never contain these directories because git tracks no
 * content for them, so these exclusions are inert there. Listed per directory
 * so no future member of these groups is shadowed. (ctx-rel W1,
 * mainline-authorized 2026-11-08.)
 */
const LOCAL_RESIDUE_EXCLUSIONS = [
  '!packages/client/workbench',
  '!packages/code-runtime/code-runtime',
  '!packages/code-runtime/code-runtime-worker-thread',
  '!packages/compat/dsh-compat',
  '!packages/e2b/e2b',
  '!packages/e2b/fs-e2b',
  '!packages/e2b/subprocess-e2b',
  '!packages/experimental/agent-team-web-profile',
  '!packages/experimental/code-runtime-python',
  '!packages/hooks/hook-protocol',
  '!packages/hooks/hooks-claude-code',
  '!packages/hooks/hooks-codex',
  '!packages/host/plugin-governance-host',
  '!packages/preset/agent-presets',
  '!packages/session/session-title-all-prompts-llm',
  '!packages/session-query/tool-session-query',
  '!packages/settings/settings-file',
  '!packages/skill/skill-badge',
  '!packages/subagent/subagent-in-process-driver',
  '!packages/terminal/tool-terminal',
  '!packages/webhook/webhook',
  '!packages/webhook/webhook-github',
  '!packages/workflow/tool-ralph',
  '!packages/workflow/workflow-worker-thread',
]

/**
 * The ordinary workspace build consumes JavaScript emitted by the Host
 * TypeScript project and runs Typert. The Client pass selects packages that
 * declare a browser bundle and lets their package-local configs emit both
 * their Node loader entry and browser artifact. `apps/desktop` bundles after
 * this pass (root package.json `build:lib:host`): its main bundle inlines
 * workspace devDependencies from their lib/ output, and tsdown builds
 * workspace members concurrently without ordering them.
 */
export default defineConfig(({ env }) => {
  const client = isBuildFaceClient(env?.DSH_BUILD_FACE)
  return {
    workspace: client
      ? ['vendor/*', 'packages/*/*', 'apps/cli', '!packages/plugins/*', ...LOCAL_RESIDUE_EXCLUSIONS]
      : ['vendor/*', 'packages/*/*', 'apps/cli', 'apps/desktop-host', '!packages/plugins/*', ...LOCAL_RESIDUE_EXCLUSIONS],
    entry: client ? '' : ['lib/types/{index,startup}.js'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    plugins: client ? [] : [typertPlugin({ mode: 'workspace', faces: ['host'] })],
  }
})
