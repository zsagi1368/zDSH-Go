/**
 * Browser console fiber — official slots only, zero DOM scraping.
 *
 * Registers: locale dictionary, a keyed settings card (per-plugin item slot),
 * and a session-header actions panel fed by the status bridge. The panel is
 * deliberately small: state lights, today counters, pause/resume and
 * approve-latest buttons.
 */
import { NS, en, zh } from '../shared-client/locales.js'
import type { LocaleKey } from '../shared-client/locales.js'

export const name = '@deepseek-ai/dsh-autopilot'

export const inject = ['slots', 'locale', 'settingsScope']

interface BridgeResponse {
  ok?: boolean
}

export interface ConsoleClientAdapters {
  /** Fetch wrapper bound to the host connection (injected at build time). */
  fetchText(url: string, init?: { method?: string; body?: string }): Promise<string>
  /** Token issued by the host on first bridge frame (action authorization). */
  actionToken(): string | undefined
}

export function createConsoleFiber(adapters: ConsoleClientAdapters) {
  let locale: ((key: LocaleKey, params?: Record<string, string>) => string) | undefined

  function lookup(dict: Record<string, string | undefined>, key: LocaleKey): string | undefined {
    return dict[key]
  }

  function t(key: LocaleKey, params?: Record<string, string>): string {
    const template = lookup(zh, key) ?? lookup(en, key) ?? key
    if (!params) return template
    return template.replace(/\{(\w+)\}/g, (_, k: string) => params[k] ?? `{${k}}`)
  }

  async function refreshStatus(): Promise<unknown> {
    const raw = await adapters.fetchText('/api/autopilot-bridge')
    return safeParse(raw)
  }

  async function performAction(action: Record<string, unknown>): Promise<BridgeResponse> {
    const token = adapters.actionToken()
    const body = JSON.stringify({ ...action, token })
    const raw = await adapters.fetchText('/api/autopilot-action', { method: 'POST', body })
    try {
      return JSON.parse(raw) as BridgeResponse
    } catch {
      return { ok: false }
    }
  }

  return {
    disposable: true as const,
    name,
    /** Host client fiber entry: register dictionaries + slots. */
    apply(ctx: {
      locale?: {
        register(ns: string, dict: { zh: typeof zh; en: typeof en }): void
        bind(ns: string): (key: string, params?: Record<string, string>) => string
      }
      slots?: { inject(slot: string, register: () => unknown): void }
      settingsScope?: unknown
      effect?(fn: () => void | (() => void), name: string): void
    }): void {
      ctx.locale?.register(NS, { zh, en })
      locale = ctx.locale?.bind(NS)

      // Settings card into the keyed per-plugin slot (host renders the form).
      ctx.slots?.inject('settings.plugin.item', () => ({
        name: NS,
        key: NS,
        title: t('tab.label'),
        description: t('tab.description'),
      }))

      // Session-header actions panel.
      ctx.slots?.inject('conversation.session.header.actions', () => ({
        id: NS,
        order: 40,
        render: () => ({
          title: t('panel.title'),
          buttons: [
            { label: t('panel.pause1h'), action: () => void performAction({ action: 'pause1h' }) },
            { label: t('panel.approve'), action: () => void performAction({ action: 'approve-latest' }) },
          ],
        }),
      }))

      ctx.effect?.(() => {
        void refreshStatus()
      }, 'autopilot-initial-status')
    },
    t,
    refreshStatus,
    performAction,
    setLocaleResolver(fn: NonNullable<typeof locale>): void {
      locale = fn
    },
    getLocaleText(): string {
      return locale?.('panel.title') ?? t('panel.title')
    },
  }
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
