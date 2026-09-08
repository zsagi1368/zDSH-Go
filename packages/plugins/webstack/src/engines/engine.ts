/**
 * 引擎适配器公共面：所有引擎（免费池/keyed/自托管/MCP/原生委托）统一从
 * 本文件取得契约引用与 BaseEngine 统一包装（W-B-40 错误分类学、F-010/011
 * attempts 审计轨迹、W-B-16 provenance 盖章）。
 *
 * 跨模块共享签名说明：`../fetch/narrowing`（parseJsonLoose/narrow*）与
 * `../safety/outbound`（outboundFetch）由并行工程师实现中。为不阻塞本波次，
 * 这里以**本地结构类型**声明冻结签名，运行期经 `await import()` 动态探测：
 * 模块或导出尚缺时统一抛 `transport / safety pipeline not wired yet`。
 * 集成工程师接线后无需改动本文件（动态导入按真实路径解析，类型形状由
 * tests/engines-engine.test.ts 与契约注释双重锁定）。
 *
 * @module webstack/engines/engine
 */

import { type EngineError, engineError, normalizeThrown } from '../kernel/errors.ts'
import type {
  AttemptRecord,
  EngineDescriptor,
  EngineSearchRequest,
  EngineSearchResponse,
  NormalizedHit,
} from '../kernel/types.ts'
import { retryAfterMsFromHeaders } from './pool.ts'

/** 免费池引擎 id 固定顺序（探针准入后的公示顺序与此一致）。 */
export const FREE_POOL_ENGINE_IDS = ['ddg', 'bing-lite', 'searxng'] as const

/** 描述符深冻结工具：外层与嵌套 caps/cost 一并只读，防运行期篡改名片。 */
export function freezeDescriptor<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      freezeDescriptor((value as Record<string, unknown>)[key])
    }
    Object.freeze(value)
  }
  return value
}

/**
 * 单遍解码五个白名单 HTML 实体（&amp;&lt;&gt;&quot;&#x27;）。单遍替换避免
 * `&amp;lt;` 类双重解码把用户内容误当转义序列（解码输出不再二次扫描）。
 */
export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|#x27);/g, (_, name: string) => {
    switch (name) {
      case 'amp':
        return '&'
      case 'lt':
        return '<'
      case 'gt':
        return '>'
      case 'quot':
        return '"'
      default:
        return "'"
    }
  })
}

/** 去 HTML 标签 + 白名单实体解码，得到纯文本（两端空白裁剪）。 */
export function stripHtmlToText(fragment: string): string {
  return decodeHtmlEntities(fragment.replace(/<[^>]*>/g, '')).trim()
}

/** 剥掉 RSS 节点常见的 CDATA 包裹；无包裹则原样返回。 */
export function unwrapCdata(raw: string): string {
  const m = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(raw)
  return m === null ? raw : (m[1] ?? '')
}

/**
 * 引擎适配器最小接口（内部契约，区别于宿主 Seam 面）：
 * 所有具体引擎都必须实现 `search(req): Promise<EngineSearchResponse>`。
 */
export interface EngineLike {
  readonly descriptor: EngineDescriptor
  search(req: EngineSearchRequest): Promise<EngineSearchResponse>
}

// ---------------------------------------------------------------------------
// 跨模块共享签名的本地结构类型（冻结，勿改形状）
// ---------------------------------------------------------------------------

/** `../fetch/narrowing` parseJsonLoose 的成功分支。 */
export interface JsonLooseOk {
  readonly ok: true
  readonly value: unknown
}

/** `../fetch/narrowing` parseJsonLoose 的失败分支。 */
export interface JsonLooseErr {
  readonly ok: false
  readonly reason: string
}

/** 宽松 JSON 解析结果（不信任响应文本，解析失败转结构化数据而非抛错）。 */
export type JsonLooseResult = JsonLooseOk | JsonLooseErr

/** 宽松 JSON 解析函数签名。 */
export type ParseJsonLooseFn = (text: string) => JsonLooseResult

/** 安全收窄 unknown → string（undefined 表示缺失）。 */
export type NarrowStringFn = (v: unknown) => string | undefined

/** 安全收窄 unknown → 只读数组。 */
export type NarrowArrayFn = (v: unknown) => readonly unknown[]

/** 安全收窄 unknown → 只读记录。 */
export type NarrowRecordFn = (v: unknown) => Readonly<Record<string, unknown>> | undefined

/**
 * 统一出站请求（经 SSRF 四道闸的唯一下网络通道；直连 fetch 在 lint 层禁用）。
 * `method` 当前仅开放 GET；`maxBytes` 是 G4 有界响应体的硬上限。
 */
export interface OutboundRequest {
  url: string
  method?: 'GET'
  headers?: Record<string, string>
  signal?: AbortSignal
  timeoutMs?: number
  maxBytes: number
}

/** 统一出站响应：最终 URL 已过 G3 重定向复验，文本读取受 maxBytes 约束。 */
export interface OutboundResponse {
  status: number
  finalUrl: string
  headers: Readonly<Record<string, string>>
  text(): Promise<string>
  bytes: number
}

/** 出站客户端函数签名（失败抛 EngineError：transport/rate-limited 等）。 */
export type OutboundFetchFn = (req: OutboundRequest) => Promise<OutboundResponse>

/**
 * 安全管道快照：引擎适配器发请求与收窄载荷所需的全部跨模块能力。
 * 任一成员缺失即视为「未接线」。
 */
export interface SafetyPipeline {
  readonly outboundFetch: OutboundFetchFn
  readonly parseJsonLoose: ParseJsonLooseFn
  readonly narrowString: NarrowStringFn
  readonly narrowArray: NarrowArrayFn
  readonly narrowRecord: NarrowRecordFn
}

/** 管道未接线时的统一错误文案（集成工程师接好线后此错误自然消失）。 */
const PIPELINE_NOT_WIRED = 'safety pipeline not wired yet'

/** 动态导入返回值的宽松视图：逐键探测导出是否存在且为函数。 */
type ModuleBag = Record<string, unknown>

let pipelinePromise: Promise<SafetyPipeline> | undefined

/** 从动态模块包里取函数导出；不存在或非函数一律 undefined。 */
function fnExport(bag: ModuleBag | undefined, key: string): unknown {
  const value = bag?.[key]
  return typeof value === 'function' ? value : undefined
}

/** 把动态命名空间对象放宽成可索引视图（隔离并行开发期的静态形状漂移）。 */
function toBag(mod: unknown): ModuleBag {
  return mod as ModuleBag
}

/**
 * 加载安全管道：同时探测 narrowing 与 outbound 两个真实路径（字面量动态导入，
 * 保持可被打包器静态分析）。任一模块加载失败或缺导出 → transport「未接线」。
 * 失败的加载不缓存，便于进程内晚接线。
 */
async function loadPipeline(): Promise<SafetyPipeline> {
  let narrowing: ModuleBag
  let outbound: ModuleBag
  try {
    [narrowing, outbound] = await Promise.all([
      import('../fetch/narrowing.ts').then(toBag),
      import('../safety/outbound.ts').then(toBag),
    ])
  } catch (cause) {
    throw engineError('transport', PIPELINE_NOT_WIRED, { cause })
  }
  const outboundFetch = fnExport(outbound, 'outboundFetch') as OutboundFetchFn | undefined
  const parseJsonLoose = fnExport(narrowing, 'parseJsonLoose') as ParseJsonLooseFn | undefined
  const narrowString = fnExport(narrowing, 'narrowString') as NarrowStringFn | undefined
  const narrowArray = fnExport(narrowing, 'narrowArray') as NarrowArrayFn | undefined
  const narrowRecord = fnExport(narrowing, 'narrowRecord') as NarrowRecordFn | undefined
  if (
    outboundFetch === undefined ||
    parseJsonLoose === undefined ||
    narrowString === undefined ||
    narrowArray === undefined ||
    narrowRecord === undefined
  ) {
    throw engineError('transport', PIPELINE_NOT_WIRED)
  }
  return {
    outboundFetch,
    parseJsonLoose,
    narrowString,
    narrowArray,
    narrowRecord,
  }
}

/** 取安全管道（懒加载 + 成功后缓存；失败可重试以支持晚接线）。 */
function getPipeline(): Promise<SafetyPipeline> {
  if (pipelinePromise === undefined) {
    pipelinePromise = loadPipeline().catch((cause: unknown) => {
      pipelinePromise = undefined
      throw cause
    })
  }
  return pipelinePromise
}

/**
 * 引擎适配器基类：统一承担三件事——
 * 1. attempts 审计（起点记 AttemptRecord，成功 outcome=ok，失败 outcome=错误码）；
 * 2. 抛出错经 normalizeThrown 归一为 EngineError 后原样 rethrow；
 * 3. 成功命中把 provenance.engine 盖章为本 descriptor.id（W-B-16 可解释性）。
 */
export abstract class BaseEngine {
  readonly descriptor: EngineDescriptor

  /** 最近一次尝试的审计记录（失败路径 response 无法承载，故挂在实例上供聚合器回读）。 */
  private lastAttemptRecord: AttemptRecord | undefined

  constructor(descriptor: EngineDescriptor) {
    this.descriptor = descriptor
  }

  /** 最近一次尝试记录；从未执行过则为缺席。 */
  get lastAttempt(): AttemptRecord | undefined {
    return this.lastAttemptRecord
  }

  /** 子类获取安全管道；未接线时抛统一的 transport 错误。 */
  protected pipeline(): Promise<SafetyPipeline> {
    return getPipeline()
  }

  /**
   * 搜索统一包装：计时、归一化错误、provenance 盖章一次完成。
   * @param _req 引擎层请求（参数位冻结：包装器本身不消费，signal 等由子类
   * 在 fn 闭包内自行下推；下划线前缀标记「有意保留的契约参数位」）
   * @param fn 真正取数与解析的逻辑；抛出的任意值都会被归一化为 EngineError
   */
  protected async runSearch(
    _req: EngineSearchRequest,
    fn: () => Promise<NormalizedHit[]>,
  ): Promise<EngineSearchResponse> {
    const startedAt = Date.now()
    let hits: NormalizedHit[]
    try {
      hits = await fn()
    } catch (thrown) {
      const err = normalizeThrown(thrown, this.descriptor.id)
      this.lastAttemptRecord = {
        engineId: this.descriptor.id,
        startedAt,
        durationMs: Math.max(0, Date.now() - startedAt),
        outcome: err.code,
      }
      throw err
    }
    // W-B-16：每条命中的出处引擎盖章为本描述符 id；其余 provenance 字段保留。
    const stamped = hits.map(hit =>
      hit.provenance.engine === this.descriptor.id
        ? hit
        : {
          ...hit,
          provenance: { ...hit.provenance, engine: this.descriptor.id },
        },
    )
    this.lastAttemptRecord = {
      engineId: this.descriptor.id,
      startedAt,
      durationMs: Math.max(0, Date.now() - startedAt),
      outcome: 'ok',
    }
    return { hits: stamped, attempts: [this.lastAttemptRecord] }
  }
}

// ---------------------------------------------------------------------------
// keyed 引擎共享辅助（追加面：只新增导出，不触碰上文任何既有行为）
// ---------------------------------------------------------------------------

/** keyed 引擎 id 固定顺序（与设置面 `engines.<id>` 配置键一一对应）。 */
export const KEYED_ENGINE_IDS = [
  'tavily',
  'brave',
  'exa',
  'jina',
  'firecrawl',
  'anysearch',
] as const

/**
 * 从请求级凭据通道取本引擎密钥（W-B-55 的引擎侧唯一入口）：缺席或空串一律抛
 * auth——keyed 引擎没有「匿名降级」，缺键即结构化失败，交聚合器换候选引擎。
 * 密钥只进请求头，绝不拼入 URL、绝不落日志（调用方契约由 types.ts 锁定）。
 */
export function requireCredential(
  req: EngineSearchRequest,
  engineId: string,
  credSlot: string,
): string {
  const secret = req.credentials?.[credSlot]
  if (secret === undefined || secret === '') {
    throw engineError('auth', `${engineId} requires credential "${credSlot}"`, { engineId })
  }
  return secret
}

/**
 * keyed 上游 HTTP 状态 → 统一错误（W-B-40 映射表）：429 → rate-limited
 * （Retry-After 头换算 retryAfterMs，HTTP-date 形态不做时钟猜测）、
 * 401/403 → auth（键之过，交键池冷却）、其余 ≥400 → http-upstream。
 * 状态 <400 时不应调用本函数（非 2xx 的 3xx 已被出站层复验消化）。
 */
export function keyedHttpStatusError(
  engineId: string,
  status: number,
  headers: Readonly<Record<string, string>> = {},
): EngineError {
  if (status === 429) {
    const retryAfterMs = retryAfterMsFromHeaders(headers)
    return engineError('rate-limited', `${engineId} upstream status ${status}`, {
      engineId,
      httpStatus: status,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    })
  }
  if (status === 401 || status === 403) {
    return engineError('auth', `${engineId} rejected credential (http ${status})`, {
      engineId,
      httpStatus: status,
    })
  }
  return engineError('http-upstream', `${engineId} upstream status ${status}`, {
    engineId,
    httpStatus: status,
  })
}

/**
 * 在统一出站请求上挂 POST JSON 体（与 pool.HTTP_POST_BRIDGED 同款桥接思路：
 * OutboundRequest 契约的 body 位尚未开放，先以运行期扩展位承载序列化载荷；
 * 集成侧放宽契约后此处收编为正式字段，六个 keyed 适配器零 diff 切换）。
 */
export function attachPostBody(req: OutboundRequest, payload: unknown): OutboundRequest {
  (req as { body?: string }).body = JSON.stringify(payload)
  return req
}
