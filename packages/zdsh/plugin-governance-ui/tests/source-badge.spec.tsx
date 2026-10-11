// @vitest-environment jsdom
/**
 * Roster source-badge rendering (S-43 M3): a source='project' row shows the
 * project source badge plus the server-served project root path; the client
 * renders the value, never infers it.
 */

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PluginManagerSettingsTab } from '../src/client/PluginManagerSettingsTab.tsx'
import type { PluginManagerSettingsTabProps } from '../src/client/PluginManagerSettingsTab.tsx'
import type {
  GovernanceRosterSnapshot,
  GovernedPluginSummary,
} from '@deepseek-ai/dsh-plugin-governance-host/types'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const t = (key: keyof typeof en) => en[key]

/** One roster row for a project plugin, exactly as the server projects it. */
function projectRow(overrides: Partial<GovernedPluginSummary> = {}): GovernedPluginSummary {
  return {
    pluginId: 'fixtures/project-demo' as GovernedPluginSummary['pluginId'],
    displayName: 'Project Demo',
    version: '1.0.0',
    status: 'active',
    source: 'project',
    projectRoot: 'C:\\Users\\test\\project',
    approvalRequired: true,
    approved: false,
    warnings: [],
    ...overrides,
  }
}

function renderTab(roster: readonly GovernedPluginSummary[]) {
  const props = {
    t,
    list: vi.fn(async (): Promise<GovernanceRosterSnapshot> => ({ plugins: roster })),
    health: vi.fn(async () => ({
      total: roster.length,
      active: roster.length,
      warnings: 0,
      errors: 0,
      disabled: 0,
      plugins: [],
    })),
    enable: vi.fn(async () => {}),
    disable: vi.fn(async () => {}),
    approve: vi.fn(async () => {}),
    presetSave: vi.fn(async () => {}),
    presetLoad: vi.fn(async () => ({ applied: [], unknown: [] })),
    presetDelete: vi.fn(async () => {}),
  } as unknown as PluginManagerSettingsTabProps
  render(<PluginManagerSettingsTab {...props} />)
}

describe('PluginManagerSettingsTab source badge', () => {
  it('renders source=project with the server-served project root path', async () => {
    renderTab([projectRow()])
    // The roster loads asynchronously; wait for the project row to appear.
    await waitFor(() => {
      expect(screen.getByText('Project Demo')).toBeDefined()
    })
    expect(screen.getByText(en.sourceProject)).toBeDefined()
    // The project root path is displayed verbatim from the server projection.
    const badge = document.querySelector('[data-project-root]')
    expect(badge?.textContent).toBe('C:\\Users\\test\\project')
    // The source badge itself carries the server source value.
    const sourceBadge = document.querySelector('[data-source="project"]')
    expect(sourceBadge?.textContent).toContain(en.sourceProject)
  })

  it('renders no project root for loader-mirror rows', async () => {
    const { projectRoot: _, ...row } = projectRow({ source: 'loader-mirror', approvalRequired: false })
    renderTab([row])
    await waitFor(() => {
      expect(screen.getByText('Project Demo')).toBeDefined()
    })
    expect(screen.getByText(en.sourceMirror)).toBeDefined()
    expect(document.querySelector('[data-project-root]')).toBeNull()
  })
})
