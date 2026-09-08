/** 会话联网模式状态机：三态封闭 + 三态×轮次表驱动（W-B-94 / F-107）。 */
import { describe, expect, it } from 'vitest'
import { SESSION_ONLINE_MODES, SessionOnlineState } from '../src/mode/online.ts'

describe('SESSION_ONLINE_MODES', () => {
  it('off / on / ask 三态封闭', () => {
    expect([...SESSION_ONLINE_MODES]).toEqual(['off', 'on', 'ask'])
  })
})

describe('SessionOnlineState · 三态 × 轮次表驱动', () => {
  const matrix: readonly {
    readonly mode: (typeof SESSION_ONLINE_MODES)[number]
    readonly searched: boolean
    readonly expected: boolean
    readonly note: string
  }[] = [
    {
      mode: 'off',
      searched: false,
      expected: false,
      note: '关闭且未搜过 → 不强制',
    },
    {
      mode: 'off',
      searched: true,
      expected: true,
      note: '宽松满足语义：搜过即算满足',
    },
    {
      mode: 'ask',
      searched: false,
      expected: false,
      note: '询问态未搜过 → 不强制（由上层征询）',
    },
    {
      mode: 'ask',
      searched: true,
      expected: true,
      note: '询问态搜过 → 宽松满足',
    },
    {
      mode: 'on',
      searched: false,
      expected: true,
      note: '会话级强制，无需轮次标志',
    },
    {
      mode: 'on',
      searched: true,
      expected: true,
      note: '强制态与标志无关恒真',
    },
  ]

  for (const c of matrix) {
    it(`${c.mode} × ${c.searched ? '已搜' : '未搜'} → ${c.expected}（${c.note}）`, () => {
      const state = new SessionOnlineState()
      state.setMode(c.mode)
      state.beginTurn('turn-1')
      if (c.searched) state.markSearched('turn-1')
      expect(state.shouldForceOnline('turn-1')).toBe(c.expected)
    })
  }
})

describe('SessionOnlineState · 轮次生命周期', () => {
  it('endTurn 清 flag：off 模式下搜过 → 结束轮次后不再满足', () => {
    const state = new SessionOnlineState()
    state.setMode('off')
    state.beginTurn('t')
    state.markSearched('t')
    expect(state.shouldForceOnline('t')).toBe(true)
    state.endTurn('t')
    expect(state.shouldForceOnline('t')).toBe(false)
  })

  it('beginTurn 覆盖同 id 残留标志，防跨轮泄漏', () => {
    const state = new SessionOnlineState()
    state.setMode('off')
    state.beginTurn('t')
    state.markSearched('t')
    state.endTurn('t')
    // 复用同一 turnId 开新一轮：旧标志不得残留。
    state.beginTurn('t')
    expect(state.shouldForceOnline('t')).toBe(false)
  })

  it('未 beginTurn 的 markSearched 容错接受（瘦写端乱序到达）', () => {
    const state = new SessionOnlineState()
    state.setMode('off')
    state.markSearched('orphan')
    expect(state.shouldForceOnline('orphan')).toBe(true)
    state.endTurn('orphan')
    expect(state.shouldForceOnline('orphan')).toBe(false)
  })

  it('模式切换即时生效；getMode 回显当前态；默认 off', () => {
    const state = new SessionOnlineState()
    expect(state.getMode()).toBe('off')
    state.setMode('ask')
    expect(state.getMode()).toBe('ask')
    state.beginTurn('t')
    expect(state.shouldForceOnline('t')).toBe(false)
    state.setMode('on')
    expect(state.shouldForceOnline('t')).toBe(true)
  })

  it('多轮并存：各 turnId 标志互不干扰', () => {
    const state = new SessionOnlineState()
    state.setMode('off')
    state.beginTurn('a')
    state.beginTurn('b')
    state.markSearched('a')
    expect(state.shouldForceOnline('a')).toBe(true)
    expect(state.shouldForceOnline('b')).toBe(false)
  })
})
