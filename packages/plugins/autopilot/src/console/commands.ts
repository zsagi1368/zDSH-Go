/**
 * `/ap` command surface: parsing and execution against a console-state port.
 * Pure logic — the host command registry adapter lives in the composition root.
 */
import type { ModuleId } from '../kernel/types.js'

export interface ConsoleStatePort {
  status(): {
    paused: boolean
    circuitOpen: boolean
    modules: Record<ModuleId, boolean>
    today: Record<string, number>
  }
  setModuleEnabled(moduleId: ModuleId, enabled: boolean): void
  setPaused(paused: boolean): void
  approveLatestDenial(): { ok: true; toolName: string } | { ok: false }
  applyPreset(name: PresetName): void
  resetStats(): void
}

export type PresetName = 'conservative' | 'standard' | 'fullspeed'

const PRESETS: readonly PresetName[] = ['conservative', 'standard', 'fullspeed']

export interface CommandResult {
  /** Lines to print back to the user. */
  lines: string[]
}

export function executeCommand(
  input: string,
  state: ConsoleStatePort,
  t: (key: string, params?: Record<string, string>) => string,
): CommandResult {
  const parts = input.trim().split(/\s+/).filter(Boolean)
  const sub = parts[0] ?? 'status'
  const arg = parts.slice(1).join(' ')

  switch (sub) {
    case '':
    case 'status': {
      const s = state.status()
      const modules = (Object.keys(s.modules) as ModuleId[])
        .map(m => `${m}=${s.modules[m] ? t('cmd.status.enabled') : t('cmd.status.disabled')}`)
        .join(' ')
      const counters = Object.entries(s.today)
        .map(([k, v]) => `${k}:${v}`)
        .join(' ')
      return {
        lines: [
          `AutoPilot ${s.paused ? '[paused]' : ''}${s.circuitOpen ? ` [${t('cmd.status.circuitOpen')}]` : ''}`,
          modules,
          `${t('stats.today')} ${counters}`,
        ],
      }
    }
    case 'on':
    case 'off': {
      const enabled = sub === 'on'
      if (arg === 'continue' || arg === 'guard' || arg === 'review') {
        state.setModuleEnabled(arg, enabled)
        return { lines: [`${arg} → ${enabled ? 'on' : 'off'}`] }
      }
      for (const m of ['continue', 'guard', 'review'] as ModuleId[]) {
        state.setModuleEnabled(m, enabled)
      }
      return { lines: [`all → ${enabled ? 'on' : 'off'}`] }
    }
    case 'pause': {
      state.setPaused(true)
      return { lines: [t('cmd.pause.done', { duration: arg || '∞' })] }
    }
    case 'resume': {
      state.setPaused(false)
      return { lines: [t('cmd.resume.done')] }
    }
    case 'approve': {
      const outcome = state.approveLatestDenial()
      if (!outcome.ok) return { lines: [t('cmd.approve.none')] }
      return { lines: [t('cmd.approve.done', { tool: outcome.toolName })] }
    }
    case 'preset': {
      const name = arg as PresetName
      if (!PRESETS.includes(name)) {
        return { lines: [`presets: ${PRESETS.join(' | ')}`] }
      }
      state.applyPreset(name)
      return { lines: [t('cmd.preset.done', { preset: name })] }
    }
    case 'reset-stats': {
      state.resetStats()
      return { lines: ['stats cleared'] }
    }
    case 'help':
    default:
      return {
        lines: [
          '/ap status | on|off [continue|guard|review] | pause|resume',
          '/ap approve | preset <conservative|standard|fullspeed> | reset-stats',
        ],
      }
  }
}
