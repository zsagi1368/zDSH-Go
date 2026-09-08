/**
 * 抓取管线：T1 静态 HTTP + 正文抽取回退链；T2 可读性增强参数；T3 桥接渲染兜底（可选卫星）。
 * 目标站 4xx/5xx = 数据上呈；管道故障 = 异常（W-B-46）。
 *
 * 跨模块共享签名说明：`../safety/outbound`（outboundFetch）由并行工程师实现
 * 中（与 src/engines/engine.ts 同款先例）。这里以**本地结构类型**声明冻结
 * 签名，运行期经 `await import()` 动态探测：模块或导出尚缺时统一抛
 * `transport / safety pipeline not wired yet`（detail: todo-w2-safety）。
 * 安全侧接线后无需改动本文件。
 *
 * @module webstack/fetch/pipeline
 */

import { fetchSafetyText, formatStatusPrefix } from '../i18n/fetch-safety.ts'
import { engineError } from '../kernel/errors.ts'
import type {
  ContentBudgets,
  FetchMode,
  FetchRequest,
  FetchResult,
  SelectorRule,
} from '../kernel/types.ts'
import { renderExtract } from './extract.ts'
import { parseJsonLoose } from './narrowing.ts'
import { applySelectorRules, matchRule } from './selectors.ts'

/** 管线档位闭集（配置 `fetch.pipeline` 的合法值）。 */
export const PIPELINE_TIERS = ['t1', 't1+t2', 't1+t2+t3'] as const

export type PipelineTier = (typeof PIPELINE_TIERS)[number]

/** 有界响应体硬上限：8 MiB（G4 出站纪律，与安全侧一致）。 */
const MAX_BYTES_CAP = 8 * 1024 * 1024

/** 管道未接线时的统一错误文案（与引擎侧先例逐字一致）。 */
const PIPELINE_NOT_WIRED = 'safety pipeline not wired yet'

// ---------------------------------------------------------------------------
// 跨模块共享签名的本地结构类型（冻结，勿改形状）
// ---------------------------------------------------------------------------

/** 统一出站请求（经 SSRF 四道闸的唯一下网络通道）。 */
export interface PipelineOutboundRequest {
  readonly url: string
  readonly headers?: Record<string, string>
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
  readonly maxBytes: number
}

/** 统一出站响应：finalUrl 已过重定向复验，text() 受 maxBytes 约束。 */
export interface PipelineOutboundResponse {
  readonly status: number
  readonly finalUrl: string
  readonly headers: Readonly<Record<string, string>>
  text(): Promise<string>
  readonly bytes: number
}

/** 出站客户端函数签名（失败抛 EngineError，管线原样透传不二次包装）。 */
export type OutboundFetchLike = (
  req: PipelineOutboundRequest,
  opts?: { exemptions?: readonly string[] },
) => Promise<PipelineOutboundResponse>

/** 动态导入返回值的宽松视图：逐键探测导出是否存在且为函数。 */
type ModuleBag = Record<string, unknown>

/**
 * 加载出站客户端：字面量动态导入真实路径（保持可被打包器静态分析），结构
 * 探测 `outboundFetch` 是否为函数。加载失败或缺导出 → transport「未接线」，
 * 不缓存失败结果，便于进程内晚接线（安全侧补齐后立即恢复）。
 */
async function loadOutboundFetch(): Promise<OutboundFetchLike> {
  let bag: ModuleBag
  try {
    bag = (await import('../safety/outbound.ts')) as ModuleBag
  } catch (cause) {
    throw engineError('transport', PIPELINE_NOT_WIRED, {
      cause,
      detail: 'todo-w2-safety',
    })
  }
  const outboundFetch: unknown = bag.outboundFetch
  if (typeof outboundFetch !== 'function') {
    throw engineError('transport', PIPELINE_NOT_WIRED, {
      detail: 'todo-w2-safety',
    })
  }
  return outboundFetch as OutboundFetchLike
}

/** 从响应头里做大小写无关的 Content-Type 查找（头字段大小写不可信任）。 */
function contentTypeOf(headers: Readonly<Record<string, string>>): string {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === 'content-type') return value
  }
  return ''
}

/** 预算二次裁剪：超出 renderedChars 即截断并置标记（canonical 层已由 maxBytes 把守）。 */
function truncateBudget(
  text: string,
  budgets: ContentBudgets,
): { text: string; truncated: boolean } {
  if (text.length <= budgets.renderedChars) return { text, truncated: false }
  return {
    text: text.slice(0, Math.max(0, budgets.renderedChars)),
    truncated: true,
  }
}

/**
 * 规则抽取优先段（F-203/pro B-11）：装配层注入 rulesGetter 时，抓取入口在
 * 窄化前按 finalUrl 的 host 查站选规则；命中即优先走选择器抽取。getter 抛
 * 错、host 不可解析、规则未命中、选择器抽空——任一情况都返回 undefined
 * 落回原链路，绝不致命。命中产出以 `fit` 模式上呈（mode = 实际达成形态）。
 */
function ruleExtract(
  html: string,
  finalUrl: string,
  budgets: ContentBudgets,
  rulesGetter: (() => readonly SelectorRule[]) | undefined,
): { text: string; mode: FetchMode; truncated: boolean } | undefined {
  if (rulesGetter === undefined) return undefined
  let rules: readonly SelectorRule[]
  try {
    rules = rulesGetter()
  } catch {
    return undefined
  }
  if (rules.length === 0) return undefined
  let host = ''
  try {
    host = new URL(finalUrl).hostname
  } catch {
    return undefined
  }
  const rule = matchRule(rules, host)
  if (rule === undefined) return undefined
  let applied: { title?: string; content: string; truncated: boolean }
  try {
    applied = applySelectorRules(html, rule, budgets)
  } catch {
    return undefined
  }
  if (applied.content === '') return undefined
  const text =
    applied.title === undefined ? applied.content : `${applied.title}\n${applied.content}`
  return { text, mode: 'fit', truncated: applied.truncated }
}

/**
 * 抓取管线主入口：
 * 0. 注入了 rulesGetter 且 finalUrl host 命中站选规则 → 优先按选择器抽取
 *    （mode 记 fit）；未命中或抽空一律落回默认回退链；
 * 1. 动态探测出站客户端（未接线 → transport，detail todo-w2-safety）；
 * 2. maxBytes = min(budgets.canonicalChars × 4, 8 MiB) 发起有界抓取；
 * 3. Content-Type 含 json 且解析成功 → pretty-print（mode 记 raw）；解析失败
 *    或非 JSON → renderExtract 回退链（raw→fit 有内容者胜，实际 mode 写回）；
 * 4. status ≥ 400 是「数据」不是错误：statusCode 如实上呈，正文首行注入
 *    i18n 状态说明；全空时注入 empty-fallback 解释文案（绝不静默空白）；
 * 5. renderedChars 二次裁剪，truncated 取任一环节截断的析取。
 *
 * 管道自身故障（transport/aborted/ssrf-blocked）原样透传 throw，不吞不改。
 *
 * @param req 引擎层抓取请求（url/mode/budgets/signal）。
 * @param opts 转发给出站客户端的可选项（如 SSRF 豁免清单，语义归安全侧）；
 *   `rulesGetter` 为站选规则的构造参数注入口（F-203），缺席 = 行为与旧版一致。
 */
export async function fetchPipeline(
  req: FetchRequest,
  opts?: {
    exemptions?: readonly string[]
    rulesGetter?: () => readonly SelectorRule[]
  },
): Promise<FetchResult> {
  const outboundFetch = await loadOutboundFetch()
  const maxBytes = Math.min(req.budgets.canonicalChars * 4, MAX_BYTES_CAP)
  const outboundReq: PipelineOutboundRequest = {
    url: req.url,
    maxBytes,
    ...(req.signal !== undefined ? { signal: req.signal } : {}),
  }
  // 管道自身故障原样透传：此处刻意不 try/catch（W-B-46 错误分类学前置）。
  const res = await outboundFetch(outboundReq, opts)
  const rawText = await res.text()

  // 视图组装：站选规则命中 → 选择器抽取优先；否则显式声明 JSON 且可解析 →
  // 格式化文本（mode 记 raw）；再否则走 renderExtract 回退链（首选模式抽空
  // 时 raw→fit 有内容者胜）。
  const ruled = ruleExtract(rawText, res.finalUrl, req.budgets, opts?.rulesGetter)
  let view: { text: string; mode: FetchMode; truncated: boolean }
  if (ruled !== undefined) {
    view = ruled
  } else if (contentTypeOf(res.headers).toLowerCase().includes('json')) {
    const parsed = parseJsonLoose(rawText)
    view = parsed.ok
      ? {
        text: JSON.stringify(parsed.value, null, 2),
        mode: 'raw',
        truncated: false,
      }
      : renderExtract(rawText, req.mode, res.finalUrl, req.budgets.renderedChars)
  } else {
    view = renderExtract(rawText, req.mode, res.finalUrl, req.budgets.renderedChars)
  }

  // 「带解释上呈」：非 2xx 注入状态前缀；2xx 全空注入 empty-fallback 说明。
  let composed = view.text
  if (res.status >= 400) {
    composed =
      composed.length > 0
        ? `${formatStatusPrefix(res.status)}\n${composed}`
        : formatStatusPrefix(res.status)
  } else if (composed.length === 0) {
    composed = fetchSafetyText('webstack.fetch.empty-fallback')
  }

  const budgeted = truncateBudget(composed, req.budgets)
  return {
    url: res.finalUrl,
    statusCode: res.status,
    content: budgeted.text,
    mode: view.mode,
    truncated: view.truncated || budgeted.truncated,
    budgets: req.budgets,
  }
}
