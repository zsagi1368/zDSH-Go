/**
 * 客户端 React 面冒烟测试：react-dom/server renderToString 渲染设置卡与
 * 联网按钮（无 DOM、无宿主），断言降级形态、可编辑形态、校验错误呈现、
 * 密钥零回显与双语字典键奇偶一致。
 */

import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { createElement, useSyncExternalStore } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { cleanDraft, reduceDraft, type WebstackSettingsShape } from '../src/client/draft-state.ts'
import { nextOnlineMode, OnlineModeToggle } from '../src/client/input-toggle.tsx'
import {
  CARD_KEYS,
  CARD_NS,
  cardEn,
  cardZh,
  TOGGLE_KEYS,
  TOGGLE_NS,
  toggleEn,
  toggleZh,
} from '../src/client/locale.ts'
import {
  type CardViewState,
  WebstackSettingsCard,
  type WebstackSettingsCardProps,
} from '../src/client/settings-card.tsx'

function baseShape(): WebstackSettingsShape {
  return {
    enabled: true,
    layer: 'free',
    autoFallback: true,
    maxResults: 8,
    fusionEnabled: true,
    timeDecayHalfLifeH: 24,
    authorityBoost: 1,
    diversityDiscount: 0.85,
    maxContentChars: 12_000,
    ssrfExemptsText: '',
  }
}

/** 以 SnapshotStore 为源的合成 useWebstackCard（与框架绑定的钩子同构）。 */
function makeProps(store: SnapshotStore<CardViewState>): WebstackSettingsCardProps {
  return {
    useWebstackCard: <R,>(selector: (snapshot: CardViewState) => R): R =>
      useSyncExternalStore(
        store.subscribe,
        () => selector(store.getSnapshot()),
        () => selector(store.getSnapshot()),
      ),
    editField: () => {},
    save: () => {},
    discard: () => {},
    t: ((key: string) =>
      (cardZh as Record<string, string>)[key] ?? key) as WebstackSettingsCardProps['t'],
  }
}

function view(overrides: Partial<CardViewState>): CardViewState {
  return {
    machine: cleanDraft(baseShape()),
    readOnly: false,
    scopeStatus: 'ready',
    ...overrides,
  }
}

describe('settings-card：renderToString 冒烟', () => {
  it('只读降级卡：渲染生效值与降级说明，不出现编辑控件', () => {
    const store = createTestStore(
      view({
        readOnly: true,
        scopeStatus: 'unbound',
        machine: cleanDraft({ ...baseShape(), ssrfExemptsText: 'a.test:443\n' }),
      }),
    )
    const html = renderToString(createElement(WebstackSettingsCard, makeProps(store)))
    expect(html).toContain('data-webstack-card')
    expect(html).toContain('data-readonly="true"')
    expect(html).toContain('data-webstack-degraded')
    expect(html).toContain('网栈')
    expect(html).toContain('a.test:443')
    expect(html).not.toContain('data-webstack-save')
    expect(html).not.toContain('<textarea')
  })

  it('可编辑卡：渲染全部字段控件与保存/放弃按钮，clean 相双按钮禁用', () => {
    const store = createTestStore(view({}))
    const html = renderToString(createElement(WebstackSettingsCard, makeProps(store)))
    expect(html).toContain('data-webstack-save')
    expect(html).toContain('data-webstack-discard')
    expect(html).toMatch(/<button[^>]*data-webstack-save="?"?[^>]*disabled/)
    expect(html).toContain('<textarea')
    expect(html).toContain('value="8"')
    expect(html).toContain('value="0.85"')
    expect(html).toContain('已同步')
  })

  it('invalid 相：呈现校验问题清单并禁用保存', () => {
    const machine = reduceDraft(cleanDraft(baseShape()), {
      type: 'edit',
      field: 'maxResults',
      value: 0,
    })
    expect(machine.phase).toBe('invalid')
    const store = createTestStore(view({ machine }))
    const html = renderToString(createElement(WebstackSettingsCard, makeProps(store)))
    expect(html).toContain('data-phase="invalid"')
    expect(html).toContain('data-webstack-issues')
    expect(html).toContain('结果条数须为 1–50 的整数')
  })

  it('密钥永不回显：任何形态下 HTML 都不含密钥字段材料', () => {
    for (const readOnly of [true, false]) {
      const store = createTestStore(view({ readOnly }))
      const html = renderToString(createElement(WebstackSettingsCard, makeProps(store)))
      expect(html).not.toContain('apiKey')
      expect(html).not.toContain('credentialRef')
      expect(html).not.toContain('sk-')
    }
  })
})

describe('input-toggle：三态循环与冒烟', () => {
  it('nextOnlineMode 循环 off → on → ask → off', () => {
    expect(nextOnlineMode('off')).toBe('on')
    expect(nextOnlineMode('on')).toBe('ask')
    expect(nextOnlineMode('ask')).toBe('off')
  })

  it('renderToString：本地态降级渲染初始态与本地提示', () => {
    const html = renderToString(
      createElement(OnlineModeToggle, {
        t: ((key: string) => (toggleZh as Record<string, string>)[key] ?? key) as never,
      }),
    )
    expect(html).toContain('data-mode="off"')
    expect(html).toContain('联网:关')
    expect(html).toContain('宿主写入通道不可用')
  })

  it('renderToString：宿主通道接通时渲染注入的初始态', () => {
    const html = renderToString(
      createElement(OnlineModeToggle, {
        initial: 'ask',
        requestChange: () => true,
        t: ((key: string) => (toggleEn as Record<string, string>)[key] ?? key) as never,
      }),
    )
    expect(html).toContain('data-mode="ask"')
    expect(html).toContain('aria-pressed="true"')
    expect(html).toContain('Web:ask')
  })
})

describe('locale：字典完整性', () => {
  it('card/toggle 两命名空间 zh 与 en 键集合一致且非空', () => {
    for (const keys of [CARD_KEYS, TOGGLE_KEYS]) {
      expect(keys.length).toBeGreaterThan(0)
    }
    expect(Object.keys(cardZh).sort()).toEqual([...CARD_KEYS].sort())
    expect(Object.keys(cardEn).sort()).toEqual([...CARD_KEYS].sort())
    expect(Object.keys(toggleZh).sort()).toEqual([...TOGGLE_KEYS].sort())
    expect(Object.keys(toggleEn).sort()).toEqual([...TOGGLE_KEYS].sort())
    expect(CARD_KEYS.length + TOGGLE_KEYS.length).toBeGreaterThanOrEqual(12)
  })

  it('命名空间常量与声明合并键一致', () => {
    expect(CARD_NS).toBe('webstack.card')
    expect(TOGGLE_NS).toBe('webstack.toggle')
  })
})

/** 测试用最小快照存储（同步 flush，与 createSnapshotStore 同构）。 */
function createTestStore(init: CardViewState): SnapshotStore<CardViewState> {
  let state = init
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => state,
    subscribe(fn: () => void) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    update(mutator) {
      const draft = structuredClone(state)
      mutator(draft)
      state = draft
      for (const fn of listeners) fn()
    },
    set(next) {
      state = next
      for (const fn of listeners) fn()
    },
  }
}
