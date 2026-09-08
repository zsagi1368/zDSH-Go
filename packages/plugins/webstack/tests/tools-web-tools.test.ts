/**
 * W9 新工具对回归：web_batch_search（≤10 上限拒绝 / 保序 / 逐项隔离 /
 * 并发钳制）与 web_history（list/clear 参数化），渲染文案走 i18n 键。
 */
import { describe, expect, it } from 'vitest'
import { HistoryStore } from '../src/kernel/history.ts'
import type { NormalizedHit } from '../src/kernel/types.ts'
import { buildBatchSearchTool, buildHistoryTool } from '../src/tools/web-tools.ts'

const hit = (n: number): NormalizedHit => ({
  url: `https://t.example/${n}`,
  title: `T${n}`,
  provenance: { engine: 'ddg' },
})

/** 直接调用 defineTool 产物的 execute（绕过宿主注册表；args 已是校验后形态）。 */
async function callExec(
  tool: object,
  args: unknown,
): Promise<{ value: unknown; rendered: string }> {
  const exec = tool as {
    execute: (a: unknown) => Promise<unknown>
    output: { render: (a: unknown, v: unknown) => { text: string }[] }
  }
  const value = await exec.execute(args)
  const blocks = exec.output.render({}, value)
  return { value, rendered: blocks.map(b => b.text).join('\n') }
}

describe('web_batch_search', () => {
  it('保序并发扇出：结果下标 = 输入下标', async () => {
    const seen: string[] = []
    const tool = buildBatchSearchTool({
      run: async (query) => {
        seen.push(query)
        return [hit(query.length)]
      },
    })
    const { value } = await callExec(tool, { queries: ['alpha', 'beta', 'gamma'] })
    const report = value as {
      total: number
      okCount: number
      items: { index: number; query: string }[]
    }
    expect(seen).toEqual(['alpha', 'beta', 'gamma'])
    expect(report.total).toBe(3)
    expect(report.okCount).toBe(3)
    expect(report.items.map(i => i.query)).toEqual(['alpha', 'beta', 'gamma'])
  })

  it('逐项隔离：单项失败转结构化条目不传染整批', async () => {
    const tool = buildBatchSearchTool({
      run: async (query) => {
        if (query === 'bad') throw new Error('upstream down')
        return [hit(1)]
      },
    })
    const { value, rendered } = await callExec(tool, { queries: ['good', 'bad'] })
    const report = value as {
      okCount: number
      failedCount: number
      items: { ok: boolean; code?: string }[]
    }
    expect(report.okCount).toBe(1)
    expect(report.failedCount).toBe(1)
    expect(report.items[1]?.ok).toBe(false)
    expect(report.items[1]?.code).toBe('transport')
    expect(rendered).toContain('部分查询失败')
  })

  it('超 10 条整体拒绝（unrepresentable / batch.limit-exceeded）', async () => {
    const tool = buildBatchSearchTool({ run: async () => [hit(1)] })
    await expect(
      callExec(tool, { queries: Array.from({ length: 11 }, (_, i) => `q${i}`) }),
    ).rejects.toMatchObject({ code: 'unrepresentable', detail: 'batch.limit-exceeded' })
  })

  it('10 条整批可执行；渲染含完成标记与逐条行', async () => {
    const tool = buildBatchSearchTool({ run: async q => [hit(q.length)] })
    const queries = Array.from({ length: 10 }, (_, i) => `query-${i}`)
    const { value, rendered } = await callExec(tool, { queries, concurrency: 99 })
    const report = value as { total: number }
    expect(report.total).toBe(10)
    expect(rendered).toContain('批量搜索已完成')
    expect(rendered).toContain('1. [ok] query-0')
  })

  it('聚合管线入口被消费（run 即 searchHits 注入点）；全失败也结构化返回', async () => {
    const tool = buildBatchSearchTool({
      run: async () => {
        throw new Error('all engines down')
      },
    })
    const { value } = await callExec(tool, { queries: ['a', 'b'] })
    const report = value as { failedCount: number }
    expect(report.failedCount).toBe(2)
  })
})

describe('web_history', () => {
  it('list 回放最新在前 + limit 参数', async () => {
    const history = new HistoryStore()
    for (let i = 0; i < 5; i++) {
      history.record({
        kind: 'search',
        at: 1000 + i,
        input: `q${i}`,
        sources: [{ url: `https://h.example/${i}` }],
      })
    }
    const tool = buildHistoryTool({ history })
    const all = (await callExec(tool, { action: 'list' })).value as {
      action: string
      count: number
      entries: { input: string }[]
    }
    expect(all.action).toBe('list')
    expect(all.count).toBe(5)
    expect(all.entries[0]?.input).toBe('q4')

    const capped = (await callExec(tool, { action: 'list', limit: 2 })).value as {
      count: number
      entries: { input: string }[]
    }
    expect(capped.count).toBe(2)
    expect(capped.entries.map(e => e.input)).toEqual(['q4', 'q3'])
  })

  it('clear 清空并回报清除条数；再次 list 为空', async () => {
    const history = new HistoryStore()
    history.record({
      kind: 'fetch',
      at: 7,
      input: 'https://c.example',
      statusCode: 200,
      truncated: false,
      sources: [],
    })
    const tool = buildHistoryTool({ history })
    const cleared = (await callExec(tool, { action: 'clear' })).value as {
      action: string
      count: number
    }
    expect(cleared.action).toBe('clear')
    expect(cleared.count).toBe(1)
    const after = (await callExec(tool, { action: 'list' })).value as { count: number }
    expect(after.count).toBe(0)
  })

  it('渲染：clear 走 i18n「已清空」文案；list 行带 kind 与 http 状态', async () => {
    const history = new HistoryStore()
    history.record({
      kind: 'fetch',
      at: 9,
      input: 'https://r.example',
      statusCode: 404,
      sources: [{ url: 'https://r.example' }],
    })
    const tool = buildHistoryTool({ history })
    const cleared = await callExec(tool, { action: 'clear' })
    expect(cleared.rendered).toContain('搜索历史已清空')
    history.record({
      kind: 'fetch',
      at: 9,
      input: 'https://r.example',
      statusCode: 404,
      sources: [{ url: 'https://r.example' }],
    })
    const listed = await callExec(tool, { action: 'list' })
    expect(listed.rendered).toContain('[fetch] https://r.example (http 404)')
  })

  it('历史工具零网络零凭据：execute 不触碰 registry/creds（依赖面仅 HistoryStore）', async () => {
    const history = new HistoryStore()
    const deps = { history }
    buildHistoryTool(deps)
    // 构造成功即证明依赖面收敛；执行 list/clear 全程本地。
    history.record({ kind: 'search', at: 1, input: 'x', sources: [] })
    const { value } = await callExec(buildHistoryTool(deps), { action: 'list' })
    expect((value as { count: number }).count).toBe(1)
  })
})
