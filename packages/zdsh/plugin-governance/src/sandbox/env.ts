/**
 * Shared sandbox environment derivation.
 *
 * The child environment is derived from a small allow list of runtime-required
 * variables (PATH/SYSTEMROOT/TEMP/NODE_* and friends) instead of inheriting
 * the full host `process.env`, so a sandboxed plugin can never read the host's
 * API keys, tokens, or credentials out of one whitelisted command.
 * @module @deepseek-ai/dsh-plugin-governance/sandbox/env
 */

import type { PluginSandboxConfig } from '../spec/index.js'

/** Names copied through from the host env because child runtimes need them. */
const REQUIRED_ENV_NAMES = [
  'PATH',
  'PATHEXT',
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'COMSPEC',
  'WINDIR',
  'TEMP',
  'TMP',
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LANG',
  'LC_ALL',
  'TZ',
  // Data-root discovery: governed plugins resolve the same install-scoped
  // storage the host uses (settings/credentials/<DSH_HOME>/zdsh branch data),
  // so community plugins keep their state inside the install directory too.
  'DSH_HOME',
] as const

/** Sensitive name shapes never handed to a sandboxed child. */
const SENSITIVE_PATTERNS = [
  '.*PASSWORD.*',
  '.*SECRET.*',
  '.*TOKEN.*',
  '.*API_KEY.*',
  '.*PRIVATE.*',
  '.*CREDENTIAL.*',
  '.*AUTH.*',
  '.*ACCESS_KEY.*',
  '.*SESSION.*',
  'AWS.*',
  'AZURE.*',
  'GCP.*',
] as const

/** Whether one variable name matches any sensitive shape. */
function isSensitiveName(key: string): boolean {
  return SENSITIVE_PATTERNS.some(pattern => new RegExp(pattern, 'i').test(key))
}

/**
 * Derive the sandbox child environment from the host process env.
 *
 * Layers, in order:
 * 1. start from {@link REQUIRED_ENV_NAMES} (`NODE_*` passthrough included);
 * 2. an explicit config whitelist pulls additional named variables from the host;
 * 3. `environment.clear` drops everything except the injected markers;
 * 4. the blacklist and sensitive-name shapes always win;
 * 5. `NODE_ENV`/`DSH_SANDBOX` markers are set last so callers cannot spoof them.
 *
 * Per-call `options.env` overrides are merged by the caller AFTER this
 * derivation, on top of — not instead of — the sanitized base.
 * @param config - the sandbox config whose `environment` section drives the derivation.
 * @param hostEnv - the host process environment to copy from; defaults to
 * `process.env`, overridable for tests.
 * @returns the sanitized child environment for the sandboxed plugin.
 */
export function deriveSandboxEnvironment(
  config: PluginSandboxConfig,
  hostEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const required = [...REQUIRED_ENV_NAMES.map(name => `^${name}$`), '^NODE_']
  const picked: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(hostEnv)) {
    if (value === undefined) continue
    if (!required.some(pattern => new RegExp(pattern).test(key))) continue
    picked[key] = value
  }
  // 显式白名单可以从宿主环境点名提取额外变量（仍受敏感形状过滤约束）。
  for (const name of config.environment.whitelist) {
    const value = hostEnv[name]
    if (value !== undefined && !isSensitiveName(name)) picked[name] = value
  }
  let filtered: NodeJS.ProcessEnv = picked
  if (config.environment.clear) {
    filtered = {}
  } else {
    // 黑名单与敏感形状始终生效，包括对必需变量本身（如 PATH 被显式拉黑）。
    filtered = Object.fromEntries(
      Object.entries(filtered).filter(([key]) =>
        !config.environment.blacklist.includes(key) && !isSensitiveName(key),
      ),
    )
  }

  const env: NodeJS.ProcessEnv = { ...filtered }
  env['NODE_ENV'] = 'production'
  env['DSH_SANDBOX'] = 'true'
  return env
}
