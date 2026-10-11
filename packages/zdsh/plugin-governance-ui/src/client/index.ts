/** Governance roster/lifecycle/health/presets tab registered into Web Settings. */

import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { GovernanceResult } from '@deepseek-ai/dsh-plugin-governance-host/types'
import type { GovernedPluginRef } from './PluginManagerSettingsTab.tsx'
import { PluginManagerSettingsTab, type PluginManagerSettingsTabInjected } from './PluginManagerSettingsTab.tsx'
import { en, zh, type PluginManagerLocaleKey } from './locales.ts'

export type { PluginManagerSettingsTabInjected, PluginManagerSettingsTabProps } from './PluginManagerSettingsTab.tsx'
export type { PluginManagerLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Plugin governance manager copy. */
    'settings.pluginManager': PluginManagerLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.pluginManager'

/** Services required by the Settings registration and generated Remote face. */
export const inject = ['slots', 'locale', 'remote', 'remote.pluginGovernance']

/**
 * Unwrap the generated transport envelope (`RemoteResult`) and the service's
 * own business envelope (`GovernanceResult`), turning any failure into a loud
 * error carrying the stable code.
 */
async function call<T>(promise: Promise<RemoteResult<GovernanceResult<T>>>): Promise<T> {
  const transport = await promise
  if (!transport.ok) {
    throw new Error(`pluginGovernance transport failed: ${transport.error.code}: ${transport.error.message}`)
  }
  const business = transport.value
  if (!business.ok) {
    throw new Error(`pluginGovernance failed: ${business.error.code}: ${business.error.message}`)
  }
  return business.value
}

/** Unwrap methods that return the transport envelope only (list, health). */
async function callRaw<T>(promise: Promise<RemoteResult<T>>): Promise<T> {
  const transport = await promise
  if (!transport.ok) {
    throw new Error(`pluginGovernance transport failed: ${transport.error.code}: ${transport.error.message}`)
  }
  return transport.value
}

/** Contribute the governance management tab to the Plugins settings section. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'plugin-governance-ui: dictionaries')

  const t = ctx.locale.bind(NS)
  const governance = ctx.remote.pluginGovernance
  const injected = (): PluginManagerSettingsTabInjected => ({
    list: async () => callRaw(governance.list()),
    health: async () => callRaw(governance.health()),
    enable: async (pluginId: GovernedPluginRef) => {
      await call(governance.enable({ pluginId }))
    },
    disable: async (pluginId: GovernedPluginRef) => {
      await call(governance.disable({ pluginId, reason: null }))
    },
    approve: async (pluginId: GovernedPluginRef) => {
      await call(governance.approve({ pluginId }))
    },
    presetSave: async (name: string) => {
      await call(governance.presetSave({ name }))
    },
    presetLoad: async (name: string) => call(governance.presetLoad({ name })),
    presetDelete: async (name: string) => {
      await call(governance.presetDelete({ name }))
    },
  })

  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab',
    id: 'governance',
    order: 20,
    label: () => t('tab'),
    locale: NS,
    inject: injected,
  }, PluginManagerSettingsTab))
}
