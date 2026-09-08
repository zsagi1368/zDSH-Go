/**
 * Jina 搜索 keyed 引擎适配器（tier=keyed，Bearer 鉴权）。
 *
 * 端点协议（GET https://s.jina.ai/<encoded-query>）：
 * - 鉴权经 `Authorization: Bearer` 请求头下发，`Accept: application/json` 索取
 *   JSON 通道（密钥绝不进 URL，W-B-55）；
 * - 响应两形态兼容（历史演进所致）：`{data:[...]}` 包裹形与裸数组 `[...]` 直出
 *   形，解析器 parseJinaJson 双形态等价处理；
 * - 条目字段 url/title/description/publishedAt。
 *
 * 载荷收窄遵循 W-B-52「不信任任何响应形状」：url/title 收窄失败或为空即跳该
 * 条；publishedAt 仅接受 ISO-8601 形态。出站必经安全管道 outboundFetch。
 *
 * @module webstack/engines/jina
 */

import { narrowRecord, narrowString } from '../fetch/narrowing.ts'
import { engineError } from '../kernel/errors.ts'
import type {
  EngineDescriptor,
  EngineSearchRequest,
  EngineSearchResponse,
  NormalizedHit,
} from '../kernel/types.ts'
import { BaseEngine, freezeDescriptor, keyedHttpStatusError, requireCredential } from './engine.ts'
import { isoTimestampOrUndefined } from './pool.ts'

export const JINA_ENGINE_ID = 'jina'

/** 凭据槽位名：请求级 credentials 通道与本引擎约定的字段键。 */
export const JINA_CRED_SLOT = 'jinaKey'

/** 端点基址（GET 路径段即编码后的查询串）。 */
const JINA_ENDPOINT = 'https://s.jina.ai'

/** G4 有界响应体上限：JSON 结果集适中，1MB 封顶。 */
export const JINA_MAX_BYTES = 1_000_000

/** 静态名片：keyed 档单密钥（冻结，防运行期篡改）。 */
export const JINA_DESCRIPTOR: EngineDescriptor = freezeDescriptor({
  id: JINA_ENGINE_ID,
  kind: 'search',
  tier: 'keyed',
  caps: {},
  cost: { keysRequired: 1, quotaHint: 'paid' },
  latencyBudgetMs: 4000,
})

/**
 * 组装查询 URL：整条 query 作为单个路径段整体编码（含空格/斜杠/问号均安全）。
 */
export function buildJinaUrl(query: string): string {
  return `${JINA_ENDPOINT}/${encodeURIComponent(query)}`
}

/** 收敛两形态响应为统一条目数组：裸数组直出形或 {data:[...]} 包裹形；其余零结果。 */
function collectJinaEntries(value: unknown): readonly unknown[] {
  if (Array.isArray(value)) return value
  const root = narrowRecord(value)
  if (root === undefined) return []
  const data = root.data
  return Array.isArray(data) ? data : []
}

/**
 * Jina JSON 载荷解析器（纯函数，离线可测，双形态兼容）：
 * - 根为数组直出形或记录包裹形（data 数组）；其余形状视为零结果（非错误）；
 * - title 与 url 必须 narrowString 后非空，任一缺失 → 整条跳过；
 * - description → snippet；publishedAt 仅接受 ISO-8601 形态；
 * - 截断至 count 条。
 */
export function parseJinaJson(value: unknown, count: number): NormalizedHit[] {
  const hits: NormalizedHit[] = []
  for (const entry of collectJinaEntries(value)) {
    if (hits.length >= count) break
    const record = narrowRecord(entry)
    if (record === undefined) continue
    const url = narrowString(record.url)
    const title = narrowString(record.title)
    if (url === undefined || title === undefined) continue
    const snippet = narrowString(record.description)
    const publishedAt = isoTimestampOrUndefined(record.publishedAt)
    hits.push({
      url,
      title,
      ...(publishedAt === undefined ? {} : { publishedAt }),
      ...(snippet === undefined ? {} : { snippet }),
      provenance: { engine: JINA_ENGINE_ID },
    })
  }
  return hits.slice(0, Math.max(0, count))
}

/** Jina 搜索 keyed 引擎适配器。 */
export class JinaEngine extends BaseEngine {
  constructor(descriptor: EngineDescriptor = JINA_DESCRIPTOR) {
    super(descriptor)
  }

  /** 搜索：缺密钥即 auth（不打网）；出站必经安全管道；JSON 解析失败转 narrow-failed。 */
  async search(req: EngineSearchRequest): Promise<EngineSearchResponse> {
    return await this.runSearch(req, async () => {
      const apiKey = requireCredential(req, this.descriptor.id, JINA_CRED_SLOT)
      const { outboundFetch, parseJsonLoose } = await this.pipeline()
      const response = await outboundFetch({
        url: buildJinaUrl(req.query),
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
        ...(req.signal !== undefined ? { signal: req.signal } : {}),
        timeoutMs: this.descriptor.latencyBudgetMs,
        maxBytes: JINA_MAX_BYTES,
      })
      if (response.status >= 400) {
        throw keyedHttpStatusError(this.descriptor.id, response.status, response.headers)
      }
      const parsed = parseJsonLoose(await response.text())
      if (!parsed.ok) {
        throw engineError('narrow-failed', parsed.reason, { engineId: this.descriptor.id })
      }
      return parseJinaJson(parsed.value, req.count)
    })
  }
}
