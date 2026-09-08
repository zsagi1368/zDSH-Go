/**
 * 自托管 SearXNG 引擎适配器（selfhosted 档，用户显式配置 baseUrl + 可选 SSRF 豁免）。
 *
 * 走实例的 JSON 输出通道 `${baseUrl}/search?...&format=json`。载荷收窄遵循
 * W-B-52「不信任任何响应形状」：url/title 收窄失败或为空即跳过该条，绝不抛裸
 * TypeError、不编造占位值。解析器拆为纯函数 `parseSearxngJson` 以便离线回放。
 *
 * 注：收窄读取器在本文件内自包含（与并行开发中的 ../fetch/narrowing 语义一致），
 * 待该模块接线后引擎主流程改走共享 narrow*；纯解析器的行为契约不变。
 *
 * @module webstack/engines/searxng
 */

import { engineError } from '../kernel/errors.ts'
import type {
  EngineDescriptor,
  EngineSearchRequest,
  EngineSearchResponse,
  NormalizedHit,
} from '../kernel/types.ts'
import { BaseEngine, freezeDescriptor } from './engine.ts'

export const SEARXNG_ENGINE_ID = 'searxng'

/** G4 有界响应体上限：JSON 结果集适中，1MB 封顶。 */
export const SEARXNG_MAX_BYTES = 1_000_000

/** 静态名片：自托管实例延迟预算更宽（冻结，防运行期篡改）。 */
export const SEARXNG_DESCRIPTOR: EngineDescriptor = freezeDescriptor({
  id: SEARXNG_ENGINE_ID,
  kind: 'search',
  tier: 'selfhosted',
  caps: { locale: true, freshness: true },
  cost: { keysRequired: 0, quotaHint: 'unknown' },
  latencyBudgetMs: 6000,
})

/**
 * 组装 SearXNG JSON 查询串：locale→language 参数、freshness→time_range
 * （day/week/month/year 直映）；baseUrl 去尾部斜杠防出现双斜杠。
 */
export function buildSearxngUrl(
  baseUrl: string,
  query: string,
  opts: { language?: string; timeRange?: string } = {},
): string {
  const root = baseUrl.replace(/\/+$/, '')
  let url = `${root}/search?q=${encodeURIComponent(query)}&format=json`
  if (opts.language !== undefined && opts.language !== 'auto')
    url += `&language=${encodeURIComponent(opts.language)}`
  if (opts.timeRange !== undefined) url += `&time_range=${encodeURIComponent(opts.timeRange)}`
  return url
}

/** 安全收窄 unknown → 只读记录（原型链对象与数组一律拒绝）。 */
function asRecord(v: unknown): Readonly<Record<string, unknown>> | undefined {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined
  return v as Readonly<Record<string, unknown>>
}

/** 安全收窄 unknown → string。 */
function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

/**
 * SearXNG JSON 载荷解析器（纯函数，离线可测）：
 * - 根与每条 result 均按记录收窄；results 缺席/非数组视为零结果（非错误）；
 * - url 与 title 必须 narrowString 后**非空**，任一缺失 → 整条跳过；
 * - content → snippet（空串保持缺席）；publishedDate 仅接受 ISO-8601 形态，
 *   否则缺席（不猜测、不改写）；
 * - 截断至 count 条。
 */
export function parseSearxngJson(value: unknown, count: number): NormalizedHit[] {
  const root = asRecord(value)
  if (root === undefined) return []
  const results = Array.isArray(root.results) ? root.results : []
  const hits: NormalizedHit[] = []
  for (const entry of results) {
    if (hits.length >= count) break
    const record = asRecord(entry)
    if (record === undefined) continue
    const url = asString(record.url)
    const title = asString(record.title)
    if (url === undefined || url === '' || title === undefined || title === '') continue
    const content = asString(record.content)
    const publishedDate = asIsoShape(asString(record.publishedDate))
    hits.push({
      url,
      title,
      ...(publishedDate === undefined ? {} : { publishedAt: publishedDate }),
      ...(content === undefined || content === '' ? {} : { snippet: content }),
      provenance: { engine: SEARXNG_ENGINE_ID },
    })
  }
  return hits.slice(0, Math.max(0, count))
}

/** ISO-8601 形态校验（日历日期起头即可直接采用）；其余形态缺席处理。 */
function asIsoShape(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  return /^\d{4}-\d{2}-\d{2}([Tt ]\d{2}:\d{2}(:\d{2})?(\.\d+)?([Zz]|[+-]\d{2}:?\d{2})?)?$/.test(raw)
    ? raw
    : undefined
}

/**
 * 自托管 SearXNG 引擎适配器。
 * @param descriptor 引擎名片（默认 SEARXNG_DESCRIPTOR）
 * @param baseUrl    用户显式配置的实例根地址（如 https://searx.example.org）
 */
export class SearxngEngine extends BaseEngine {
  constructor(
    descriptor: EngineDescriptor = SEARXNG_DESCRIPTOR,
    readonly baseUrl: string,
  ) {
    super(descriptor)
  }

  /** 搜索：出站必经安全管道；JSON 解析失败转 narrow-failed，条目级坏行跳过。 */
  async search(req: EngineSearchRequest): Promise<EngineSearchResponse> {
    return await this.runSearch(req, async () => {
      const { outboundFetch, parseJsonLoose } = await this.pipeline()
      const response = await outboundFetch({
        url: buildSearxngUrl(this.baseUrl, req.query, {
          ...(req.hints.locale !== undefined ? { language: req.hints.locale } : {}),
          ...(req.hints.freshness !== undefined ? { timeRange: req.hints.freshness } : {}),
        }),
        method: 'GET',
        ...(req.signal !== undefined ? { signal: req.signal } : {}),
        timeoutMs: this.descriptor.latencyBudgetMs,
        maxBytes: SEARXNG_MAX_BYTES,
      })
      if (response.status >= 400) {
        throw engineError(
          response.status === 429 ? 'rate-limited' : 'http-upstream',
          `searxng upstream status ${response.status}`,
          { engineId: this.descriptor.id, httpStatus: response.status },
        )
      }
      const parsed = parseJsonLoose(await response.text())
      if (!parsed.ok) {
        throw engineError('narrow-failed', parsed.reason, {
          engineId: this.descriptor.id,
        })
      }
      return parseSearxngJson(parsed.value, req.count)
    })
  }
}
