/**
 * draft-state 五态状态机的表驱动穷举测试：迁移全图（clean/dirty/invalid/
 * saving/failed × 6 事件）+ 校验边界（maxResults 1–50、ssrfExempts
 * host:port 格式、fusion 三参、maxContentChars）+ 宿主 section 双向映射。
 */
import { describe, expect, it } from 'vitest'
import {
  canSave,
  cleanDraft,
  type DraftEvent,
  type DraftPhase,
  type DraftState,
  diffToWrites,
  draftIssues,
  isValidSsrfLine,
  parseSsrfExempts,
  reduceDraft,
  shapeFromSection,
  type WebstackSettingsShape,
} from '../src/client/draft-state.ts'

/** 合法基线形状（与 DEFAULT_SETTINGS 对齐的代表性取值）。 */
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

const edit = (
  field: keyof WebstackSettingsShape,
  value: string | number | boolean,
): DraftEvent => ({
  type: 'edit',
  field,
  value,
})

/** 五个相的构造链：clean → dirty → invalid / saving → failed。 */
function phaseOf(phase: DraftPhase): DraftState {
  const clean = cleanDraft(baseShape())
  const dirty = reduceDraft(clean, edit('maxResults', 9))
  const invalid = reduceDraft(clean, edit('maxResults', 0))
  const saving = reduceDraft(dirty, { type: 'save' })
  const failed = reduceDraft(saving, { type: 'saveFailure' })
  switch (phase) {
    case 'clean':
      return clean
    case 'dirty':
      return dirty
    case 'invalid':
      return invalid
    case 'saving':
      return saving
    case 'failed':
      return failed
  }
}

describe('draft-state：五态迁移全图（表驱动）', () => {
  const ALL_PHASES: readonly DraftPhase[] = ['clean', 'dirty', 'invalid', 'saving', 'failed']

  const TABLE: ReadonlyArray<{
    name: string
    from: DraftPhase
    event: DraftEvent
    to: DraftPhase
  }> = [
    // ---- edit ----
    {
      name: 'clean +edit 合法值 → dirty',
      from: 'clean',
      event: edit('maxResults', 9),
      to: 'dirty',
    },
    {
      name: 'dirty +edit 另一合法值 → dirty',
      from: 'dirty',
      event: edit('authorityBoost', 2),
      to: 'dirty',
    },
    {
      name: 'dirty +edit 非法值 → invalid',
      from: 'dirty',
      event: edit('maxResults', 0),
      to: 'invalid',
    },
    {
      name: 'invalid +edit 修正为另一合法值 → dirty',
      from: 'invalid',
      event: edit('maxResults', 9),
      to: 'dirty',
    },
    {
      name: 'invalid +edit 修正回基线值 → clean',
      from: 'invalid',
      event: edit('maxResults', 8),
      to: 'clean',
    },
    {
      name: 'dirty +edit 改回基线 → clean',
      from: 'dirty',
      event: edit('maxResults', 8),
      to: 'clean',
    },
    {
      name: 'failed +edit 重改 → dirty（恢复路径）',
      from: 'failed',
      event: edit('maxResults', 12),
      to: 'dirty',
    },
    {
      name: 'saving +edit 被闸门拒绝 → 保持 saving',
      from: 'saving',
      event: edit('maxResults', 30),
      to: 'saving',
    },
    // ---- discard ----
    { name: 'clean +discard → clean', from: 'clean', event: { type: 'discard' }, to: 'clean' },
    { name: 'dirty +discard → clean', from: 'dirty', event: { type: 'discard' }, to: 'clean' },
    { name: 'invalid +discard → clean', from: 'invalid', event: { type: 'discard' }, to: 'clean' },
    { name: 'failed +discard → clean', from: 'failed', event: { type: 'discard' }, to: 'clean' },
    {
      name: 'saving +discard 被闸门拒绝 → 保持 saving',
      from: 'saving',
      event: { type: 'discard' },
      to: 'saving',
    },
    // ---- save ----
    { name: 'clean +save 无操作 → clean', from: 'clean', event: { type: 'save' }, to: 'clean' },
    {
      name: 'invalid +save 校验拦截 → invalid',
      from: 'invalid',
      event: { type: 'save' },
      to: 'invalid',
    },
    { name: 'dirty +save → saving', from: 'dirty', event: { type: 'save' }, to: 'saving' },
    {
      name: 'failed +save 重试（草稿合法）→ saving',
      from: 'failed',
      event: { type: 'save' },
      to: 'saving',
    },
    { name: 'saving +save 幂等 → saving', from: 'saving', event: { type: 'save' }, to: 'saving' },
    // ---- settle ----
    {
      name: 'saving +saveSuccess → clean 且基线升格为草稿',
      from: 'saving',
      event: { type: 'saveSuccess' },
      to: 'clean',
    },
    {
      name: 'saving +saveFailure → failed',
      from: 'saving',
      event: { type: 'saveFailure' },
      to: 'failed',
    },
    {
      name: 'clean +saveSuccess 拒绝越相迁移 → clean',
      from: 'clean',
      event: { type: 'saveSuccess' },
      to: 'clean',
    },
    // ---- load ----
    {
      name: 'clean +load 新基线 → clean',
      from: 'clean',
      event: { type: 'load', value: { ...baseShape(), enabled: false } },
      to: 'clean',
    },
    {
      name: 'saving +load 在途屏蔽 → 保持 saving',
      from: 'saving',
      event: { type: 'load', value: { ...baseShape() } },
      to: 'saving',
    },
    {
      name: 'dirty +load 宿主推送覆盖本地暂存 → clean',
      from: 'dirty',
      event: { type: 'load', value: { ...baseShape(), layer: 'api' } },
      to: 'clean',
    },
  ]

  for (const row of TABLE) {
    it(row.name, () => {
      const next = reduceDraft(phaseOf(row.from), row.event)
      expect(next.phase).toBe(row.to)
    })
  }

  it('saveSuccess 把草稿升格为已提交基线', () => {
    const saving = phaseOf('saving')
    const settled = reduceDraft(saving, { type: 'saveSuccess' })
    expect(settled.committed.maxResults).toBe(9)
    expect(settled.draft).toEqual(settled.committed)
  })

  it('五相 × 六事件矩阵无未预期抛错且相值合法', () => {
    for (const from of ALL_PHASES) {
      for (const event of ['load', 'discard', 'save', 'saveSuccess', 'saveFailure'] as const) {
        const next = reduceDraft(
          phaseOf(from),
          event === 'load' ? { type: 'load', value: baseShape() } : { type: event },
        )
        expect(ALL_PHASES).toContain(next.phase)
      }
    }
  })

  it('canSave：dirty/failed 且合法才可保存；invalid 永不可保存', () => {
    expect(canSave(phaseOf('clean'))).toBe(false)
    expect(canSave(phaseOf('dirty'))).toBe(true)
    expect(canSave(phaseOf('invalid'))).toBe(false)
    expect(canSave(phaseOf('saving'))).toBe(false)
    expect(canSave(phaseOf('failed'))).toBe(true)
    const failedInvalid = reduceDraft(phaseOf('failed'), edit('maxResults', 0))
    expect(failedInvalid.phase).toBe('invalid')
    expect(canSave(failedInvalid)).toBe(false)
  })

  it('非数值文本编辑数值字段 → invalid（NaN 分支）', () => {
    const next = reduceDraft(phaseOf('clean'), edit('maxResults', 'abc'))
    expect(next.phase).toBe('invalid')
    expect(next.draft.maxResults).toBe(8)
  })
})

describe('draft-state：校验边界', () => {
  /** 单字段编辑后的问题清单。 */
  function issuesFor(field: keyof WebstackSettingsShape, value: string | number | boolean) {
    const state = reduceDraft(cleanDraft(baseShape()), edit(field, value))
    return { state, issues: draftIssues(state) }
  }

  it.each([
    [1, true],
    [8, true],
    [50, true],
    [0, false],
    [51, false],
    [7.5, false],
  ] as const)('maxResults 边界 %i → 合法=%s', (value, ok) => {
    const { state, issues } = issuesFor('maxResults', value)
    expect(issues.some(issue => issue.message === 'errMaxResults')).toBe(!ok)
    expect(state.phase === 'invalid').toBe(!ok)
  })

  it.each([
    ['example.com:8443', true],
    ['localhost:3000', true],
    ['10.0.0.1:80', true],
    ['a-b.example.co:1', true],
    ['example.com', false],
    ['example.com:', false],
    [':8443', false],
    ['example.com:0', false],
    ['example.com:70000', false],
    ['http://example.com:8443', false],
    ['example.com:8443/path', false],
    ['ex ample.com:8443', false],
  ] as const)('ssrfExempts 行 %j → 合法=%s', (line, ok) => {
    expect(isValidSsrfLine(line)).toBe(ok)
  })

  it('豁免行文本含任一非法行 → invalid + errSsrfLine', () => {
    const { state, issues } = issuesFor('ssrfExemptsText', 'example.com:8443\nbad-host\n')
    expect(state.phase).toBe('invalid')
    expect(issues.some(issue => issue.message === 'errSsrfLine')).toBe(true)
  })

  it('fusion 三参与 maxContentChars 的边界', () => {
    expect(issuesFor('timeDecayHalfLifeH', 1).state.phase).toBe('dirty')
    expect(issuesFor('timeDecayHalfLifeH', 8760).state.phase).toBe('dirty')
    expect(
      draftIssues(reduceDraft(cleanDraft(baseShape()), edit('timeDecayHalfLifeH', 0))),
    ).toEqual([{ field: 'timeDecayHalfLifeH', message: 'errHalfLife' }])
    expect(issuesFor('authorityBoost', 0).state.phase).toBe('dirty')
    expect(issuesFor('authorityBoost', 10).state.phase).toBe('dirty')
    expect(issuesFor('authorityBoost', -0.5).issues[0]?.message).toBe('errAuthority')
    expect(issuesFor('diversityDiscount', 0).state.phase).toBe('dirty')
    expect(issuesFor('diversityDiscount', 1).state.phase).toBe('dirty')
    expect(issuesFor('diversityDiscount', 1.01).issues[0]?.message).toBe('errDiversity')
    expect(issuesFor('maxContentChars', 200).state.phase).toBe('dirty')
    expect(issuesFor('maxContentChars', 8_000_000).state.phase).toBe('dirty')
    expect(issuesFor('maxContentChars', 199).issues[0]?.message).toBe('errMaxContentChars')
    expect(issuesFor('maxContentChars', 8_000_001).issues[0]?.message).toBe('errMaxContentChars')
  })

  it('parseSsrfExempts 去空白行并按首次出现去重', () => {
    expect(parseSsrfExempts('  a.test:443 \n\nb.test:80\na.test:443\n')).toEqual([
      'a.test:443',
      'b.test:80',
    ])
  })
})

describe('draft-state：宿主 section 映射与写入差分', () => {
  it('shapeFromSection 读嵌套 section，缺字段回落基线', () => {
    const fallback = baseShape()
    const shape = shapeFromSection(
      {
        enabled: false,
        search: { layer: 'api', maxResults: 20, fusion: { authorityBoost: 2.5 } },
        fetch: { maxContentChars: 4000 },
        safety: { ssrfExempts: ['x.test:443'] },
      },
      fallback,
    )
    expect(shape).toEqual({
      enabled: false,
      layer: 'api',
      autoFallback: fallback.autoFallback,
      maxResults: 20,
      fusionEnabled: fallback.fusionEnabled,
      timeDecayHalfLifeH: fallback.timeDecayHalfLifeH,
      authorityBoost: 2.5,
      diversityDiscount: fallback.diversityDiscount,
      maxContentChars: 4000,
      ssrfExemptsText: 'x.test:443\n',
    })
  })

  it('shapeFromSection 对非对象与非法枚举回落', () => {
    const fallback = baseShape()
    expect(shapeFromSection(null, fallback)).toEqual({ ...fallback, ssrfExemptsText: '' })
    expect(shapeFromSection({ search: { layer: 'nope' } }, fallback).layer).toBe('free')
  })

  it('diffToWrites 产出点路径写入清单，ssrfExempts 为解析数组', () => {
    const committed = baseShape()
    const draft: WebstackSettingsShape = {
      ...committed,
      maxResults: 33,
      fusionEnabled: false,
      ssrfExemptsText: 'p.test:8443\nq.test:80\n',
    }
    expect(diffToWrites(draft, committed)).toEqual([
      { field: 'search.maxResults', value: 33 },
      { field: 'search.fusion.enabled', value: false },
      { field: 'safety.ssrfExempts', value: ['p.test:8443', 'q.test:80'] },
    ])
  })

  it('diffToWrites 对相同形状产出空清单', () => {
    const same = baseShape()
    expect(diffToWrites(same, same)).toEqual([])
  })
})
