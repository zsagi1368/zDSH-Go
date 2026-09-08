// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  compatLabel,
  evidenceLabel,
  extractSha8,
  marketUrl,
  PluginCenterApp,
} from '../../src/client/index.js'

const samplePage = {
  items: [
    {
      id: 'owner/beta',
      source: 'github',
      title: { zh: '测试乙', en: 'Beta' },
      summary: { zh: '说明乙', en: 'Desc beta' },
      category: 'test',
      evidence: 'recommended',
      compat: 'exact',
      scriptsPolicy: 'none',
    },
    {
      id: 'owner/alpha',
      source: 'npm',
      title: { zh: '测试甲', en: 'Alpha' },
      summary: { zh: '说明甲', en: 'Desc alpha' },
      category: 'test',
      evidence: 'discovered',
      compat: 'unknown',
      scriptsPolicy: 'none',
    },
  ],
  page: 1,
  pageSize: 24,
  total: 2,
  mode: 'seed',
}

describe('pure client helpers', () => {
  it('extracts the confirmation code from a phrase', () => {
    expect(extractSha8('确认 安装 install owner/alpha @1a2b3c4d5e6f / confirm')).toBe('1a2b3c4d5e6f')
    expect(extractSha8('no code here')).toBe('')
    expect(extractSha8('短码 @1a2b3c4d / confirm')).toBe('')
  })

  it('builds bounded market queries', () => {
    const url = marketUrl({ page: 2, q: 'hub', category: '', onlyRecommended: true })
    expect(url).toContain('page=2')
    expect(url).toContain('pageSize=24')
    expect(url).toContain('q=hub')
    expect(url).toContain('onlyRecommended=1')
    expect(marketUrl({ page: -3, q: '', category: '', onlyRecommended: false })).toContain('page=1')
  })

  it('labels evidence and compatibility bilingually', () => {
    expect(evidenceLabel('recommended', 'zh')).toBe('推荐')
    expect(evidenceLabel('recommended', 'en')).toBe('Recommended')
    expect(compatLabel('range-supported', 'zh')).toBe('范围支持·待验证')
    expect(compatLabel('exact', 'en')).toBe('Compatible')
  })
})

describe('PluginCenterApp rendering', () => {
  let container: HTMLDivElement | null = null
  let root: Root | null = null

  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input)
        if (path.includes('/market')) {
          return new Response(JSON.stringify(samplePage), { status: 200 })
        }
        if (path.includes('/runtime')) {
          return new Response(JSON.stringify({ bootId: 'boot-1' }), { status: 200 })
        }
        if (path.includes('/audit')) {
          return new Response(JSON.stringify([]), { status: 200 })
        }
        return new Response('{}', { status: 404 })
      }),
    )
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    vi.useFakeTimers({ shouldAdvanceTime: true })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    if (root !== null) root.unmount()
    container?.remove()
    container = null
    root = null
  })

  it('renders catalog entries with badges after load', async () => {
    await act(async () => {
      root?.render(<PluginCenterApp locale="zh" />)
      await Promise.resolve()
    })
    const text = container?.textContent ?? ''
    expect(text).toContain('ZDSH 插件中心')
    expect(text).toContain('测试乙')
    expect(text).toContain('测试甲')
    expect(text).toContain('推荐')
    expect(text).toContain('仅发现') // discovered install button is disabled upstream
    const disabledButton = Array.from(container?.querySelectorAll('button') ?? []).find(
      b => b.disabled === true && b.textContent === '安装',
    )
    expect(disabledButton).toBeDefined()
  })
})
