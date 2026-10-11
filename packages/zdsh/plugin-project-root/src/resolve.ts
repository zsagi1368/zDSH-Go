/**
 * Project plugin switch resolution (S-43 M1, A-03/A7.3).
 *
 * The switch is the composed config row `project-plugins.config.enabled`,
 * declared by the base bundle (deployment) and overridable only through the
 * user layers (`$DSH_HOME/cordis.patch.yml`, `--patch` overlays) — every
 * source that composes `rows`. NO environment key exists for this switch
 * (zero env attack surface), and this function performs no filesystem access:
 * it only reads the already-composed row map, so a project `.env` or any
 * project-local config file can never place it.
 * @module @deepseek-ai/dsh-plugin-project-root
 */

import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'

/** Config row id of the project plugin switch. */
export const PROJECT_PLUGINS_ROW_ID = 'project-plugins'

/**
 * Whether the composed profile enables project plugins. Default false; only
 * an explicit `config.enabled === true` on the composed row turns it on.
 * @param rows - the composed entry index (bundle + user + overlay layers only).
 * @returns the effective switch state.
 */
export function resolveProjectPluginEnabled(rows: ReadonlyMap<string, EntryOptions>): boolean {
  const row = rows.get(PROJECT_PLUGINS_ROW_ID)
  if (row === undefined) return false
  const config: unknown = row.config
  if (typeof config !== 'object' || config === null) return false
  return (config as Record<string, unknown>).enabled === true
}
