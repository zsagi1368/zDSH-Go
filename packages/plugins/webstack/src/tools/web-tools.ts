/**
 * W9 新工具对（tools seam，形状照 web_backend_status）：`web_batch_search`
 * 与 `web_history`。设计要点：
 *
 * - **web_batch_search**（F-113/W-B-20）：≤10 条查询走聚合管线（凭据/缓存/
 *   融合/fallback 全一致）；保序逐项结构化、部分失败不传染；超上限显式
 *   拒绝（unrepresentable / detail=batch.limit-exceeded），绝不静默截断。
 * - **web_history**（F-205/pro B-13）：list/clear 参数化——list 回放最近
 *   limit 条（默认全部），clear 清空并回报清除条数。
 * - 渲染文案只引用 i18n 键（kernel-p1 分册），不拼自由文本（W-B-53）；
 *   canonical 值不含任何凭据与错误正文（W-B-55）。
 *
 * @module webstack/tools/web-tools
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Locale } from '../i18n/index.ts'
import { kernelP1Text } from '../i18n/kernel-p1.ts'
import { BATCH_MAX_QUERIES, batchSearch } from '../kernel/batch.ts'
import { engineError } from '../kernel/errors.ts'
import type { HistoryStore } from '../kernel/history.ts'
import type { NormalizedHit } from '../kernel/types.ts'

/** 批量搜索并发宽度默认值（batchSearch 自带 ≤5 钳制）。 */
const BATCH_DEFAULT_CONCURRENCY = 5

/**
 * 批量搜索的执行依赖：`run` 即聚合管线入口（aggregator.searchHits），
 * 单条失败经 batchSearch 转结构化条目，绝不传染整批。
 */
export interface BatchSearchToolDeps {
  readonly run: (query: string) => Promise<readonly NormalizedHit[]>
}

/** 单条批量结果条目（canonical 值形状；type 别名保留 JSON 兼容隐式索引签名）。 */
type BatchItemValue = {
  index: number
  query: string
  ok: boolean
  hits: { url: string; title: string }[]
  code?: string
  message?: string
}

/**
 * 构造 `web_batch_search` 工具定义。零副作用读工具（isConcurrencySafe=true）：
 * 只消费聚合管线，不改任何共享状态。
 */
export function buildBatchSearchTool(deps: BatchSearchToolDeps, locale: Locale = 'zh') {
  return defineTool({
    name: 'web_batch_search',
    description:
      'Run up to 10 WebStack searches in one call. Results keep input order; each query succeeds or fails independently. Same pipeline (credentials/cache/fusion) as single search.',
    parameters: {
      queries: {
        type: 'array',
        items: { type: 'string' },
        description: '1-10 search queries executed in order.',
        required: true,
      },
      concurrency: {
        type: 'integer',
        description: 'Parallel width (clamped to 1-5). Default 5.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          total: { type: 'integer', required: true },
          okCount: { type: 'integer', required: true },
          failedCount: { type: 'integer', required: true },
          items: { type: 'array', required: true, items: { type: 'json' } },
        },
      },
      render: (_args, value) => {
        const report = value as unknown as {
          readonly total: number
          readonly okCount: number
          readonly failedCount: number
          readonly items: readonly BatchItemValue[]
        }
        const lines: string[] = []
        lines.push(
          report.failedCount > 0
            ? kernelP1Text('webstack.kernel-p1.batch.partial-failure', locale)
            : kernelP1Text('webstack.kernel-p1.batch.completed', locale),
        )
        for (const item of report.items) {
          if (item.ok) {
            const first = item.hits[0]
            lines.push(
              `${item.index + 1}. [ok] ${item.query}${
                first === undefined ? '' : ` → ${first.title} (${first.url})`
              }`,
            )
          } else {
            lines.push(`${item.index + 1}. [${item.code ?? 'error'}] ${item.message ?? ''}`)
          }
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    timeoutMs: 60_000,
    isConcurrencySafe: () => true,
    async execute(args) {
      if (args.queries.length > BATCH_MAX_QUERIES) {
        throw engineError(
          'unrepresentable',
          `batch of ${args.queries.length} queries exceeds the limit of ${BATCH_MAX_QUERIES}`,
          { detail: 'batch.limit-exceeded' },
        )
      }
      const items = await batchSearch(
        deps,
        args.queries,
        args.concurrency ?? BATCH_DEFAULT_CONCURRENCY,
      )
      const canonical: BatchItemValue[] = items.map(item =>
        item.ok
          ? {
            index: item.index,
            query: item.query,
            ok: true,
            hits: item.hits.map(hit => ({ url: hit.url, title: hit.title })),
          }
          : {
            index: item.index,
            query: item.query,
            ok: false,
            hits: [],
            code: item.code,
            message: item.message,
          },
      )
      return {
        total: canonical.length,
        okCount: canonical.filter(item => item.ok).length,
        failedCount: canonical.filter(item => !item.ok).length,
        items: canonical,
      }
    },
  })
}

/** 历史工具的执行依赖（HistoryStore 全公开方法均不抛错）。 */
export interface HistoryToolDeps {
  readonly history: HistoryStore
}

/**
 * 构造 `web_history` 工具定义。`clear` 是唯一写路径（不做并发安全申报，
 * 缺省即独占执行）；`list` 只读本地环形账本，零网络零凭据。
 */
export function buildHistoryTool(deps: HistoryToolDeps, locale: Locale = 'zh') {
  return defineTool({
    name: 'web_history',
    description:
      'Inspect or clear the WebStack recent search/fetch ledger. action=list replays latest entries (newest first, optional limit); action=clear wipes the ledger.',
    parameters: {
      action: {
        type: 'string',
        enum: ['list', 'clear'],
        description: 'list = replay recent entries; clear = wipe the ledger.',
        required: true,
      },
      limit: {
        type: 'integer',
        description: 'Max entries returned for action=list (default all).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', enum: ['list', 'clear'], required: true },
          count: { type: 'integer', required: true },
          entries: { type: 'array', required: true, items: { type: 'json' } },
        },
      },
      render: (_args, value) => {
        const report = value as unknown as {
          readonly action: 'list' | 'clear'
          readonly count: number
          readonly entries: readonly {
            readonly kind: string
            readonly input: string
            readonly statusCode?: number
          }[]
        }
        if (report.action === 'clear') {
          return [
            { type: 'text', text: kernelP1Text('webstack.kernel-p1.history.cleared', locale) },
          ]
        }
        const lines = [`history: ${report.count} entr${report.count === 1 ? 'y' : 'ies'}`]
        for (const entry of report.entries) {
          lines.push(
            `- [${entry.kind}] ${entry.input}${
              entry.statusCode === undefined ? '' : ` (http ${entry.statusCode})`
            }`,
          )
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    timeoutMs: 10_000,
    async execute(args) {
      if (args.action === 'clear') {
        const count = deps.history.size()
        deps.history.clear()
        return { action: 'clear' as const, count, entries: [] }
      }
      const listed = deps.history.list(args.limit)
      return {
        action: 'list' as const,
        count: listed.length,
        entries: listed.map(entry => ({
          kind: entry.kind,
          at: entry.at,
          input: entry.input,
          ...(entry.statusCode === undefined ? {} : { statusCode: entry.statusCode }),
          ...(entry.truncated === undefined ? {} : { truncated: entry.truncated }),
          sources: entry.sources.map(source => ({
            url: source.url,
            ...(source.title === undefined ? {} : { title: source.title }),
          })),
        })),
      }
    },
  })
}
