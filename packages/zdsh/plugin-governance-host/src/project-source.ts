/**
 * Project-plugin mount seam for the host governance service.
 *
 * The project-plugin layer (clamp + LoadGuard.preLoad + capability rejections)
 * is implemented in `@deepseek-ai/dsh-plugin-project-root`, but until this seam
 * existed nothing in the host plane ever invoked it: a project-root plugin was
 * therefore never gated, and the `dsh.compatible` enforcement chain had no
 * runtime reader. This module is that caller — it composes the loader entry
 * rows carrying the project-plugin enable marker, hands them to
 * `mountProjectPlugins`, and publishes the surviving layer on the reflection
 * plane under `projectPluginLayer` (the key `PluginGovernanceGateway` reads to
 * classify roster rows as `source: 'project'`).
 * @module @deepseek-ai/dsh-plugin-governance-host
 */

import { Context } from '@deepseek-ai/cordis'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { mountProjectPlugins } from '@deepseek-ai/dsh-plugin-project-root'

/** The loader entry id carrying the project-plugin enable marker. */
export const PROJECT_PLUGINS_ENTRY_ID = 'project-plugins'

/**
 * Compose the loader entry rows `mountProjectPlugins` gates over.
 *
 * The project-plugin path is opt-in: a disabled posture yields an empty row
 * set, so a default deployment mounts no project plugins and the gate stays
 * inert. When enabled, the single marker row mirrors the shape the
 * project-plugin suite drives, and `mountProjectPlugins` discovers the actual
 * candidates from the session cwd.
 * @param enabled - whether the `projectPlugins` config posture is on.
 * @returns the composed entry index (empty when disabled).
 */
export function resolveEntryRows(enabled: boolean): ReadonlyMap<string, EntryOptions> {
  if (!enabled) return new Map()
  return new Map<string, EntryOptions>([
    [PROJECT_PLUGINS_ENTRY_ID, {
      id: PROJECT_PLUGINS_ENTRY_ID,
      name: PROJECT_PLUGINS_ENTRY_ID,
      config: { enabled: true },
    }],
  ])
}

/**
 * Mount the project-plugin layer and publish it on the reflection plane.
 *
 * A disabled posture is a no-op (the empty row set short-circuits inside
 * `mountProjectPlugins`); an enabled one gates every discovered candidate
 * through the host clamp and LoadGuard.preLoad, then provides the surviving
 * layer as `projectPluginLayer` for the roster's source classification.
 * @param ctx - the host service context.
 * @param enabled - whether the `projectPlugins` config posture is on.
 */
export async function mountProjectPluginsOnHost(ctx: Context, enabled: boolean): Promise<void> {
  const { layer } = await mountProjectPlugins(ctx, resolveEntryRows(enabled))
  if (layer !== undefined) ctx.reflect.provide('projectPluginLayer', layer)
}
