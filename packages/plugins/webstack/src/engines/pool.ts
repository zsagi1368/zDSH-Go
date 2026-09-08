/**
 * keyed 引擎共享支撑件（W-B-41 换键池职责）：KeyPool 明文密钥轮换池，以及
 * 五个 keyed 适配器共用的小型工具（POST 方法桥接、Retry-After 解析、ISO
 * 时间戳宽松校验）。
 *
 * 安全不变量：
 * - 明文密钥只存在于进程内私有 Map，绝不落盘、绝不进日志/缓存/模型上下文；
 * - `auth-failed` 是唯一把键打入冷却的结果——网络层失败与限频都不是键之过，
 *   键保持健康，仅在飞计数清零；
 * - 全部键冷却（或池为空）时 acquire 抛统一 auth 错误，由聚合器按
 *   non-retryable 处置并换下一候选引擎。
 *
 * @module webstack/engines/pool
 */

import { engineError } from '../kernel/errors.ts'

/** 单次取用结果：`ok` = 正常归还；`auth-failed` = 上游拒绝该键（401/403）。 */
export type KeyOutcome = 'ok' | 'auth-failed'

/** 池快照：total = 装入键数；healthy = 未冷却键数；inflight = 在飞总数。 */
export interface KeyPoolStats {
  readonly total: number
  readonly healthy: number
  readonly inflight: number
}

/** 单键运行时状态（明文密钥作 Map 键存在，值内不含明文副本）。 */
interface KeyEntry {
  /** 当前在飞请求数。 */
  inflight: number
  /** 冷却标记：auth 失败后本轮池生命周期内禁用（不可逆，直到池重建）。 */
  cooledDown: boolean
}

/**
 * keyed 引擎的明文密钥轮换池。
 *
 * 选择策略 least-in-flight：每次 acquire 在健康键中取在飞计数最小者；
 * 同数按轮换序（cursor 从上次选择的下一位继续扫描），保证均匀摊销。
 * 明文只存于构造期建立的私有 Map（插入序即轮换基准序）；重复密钥合并为
 * 同一槽位（同键同配额，语义等价）。
 */
export class KeyPool {
  private readonly entries = new Map<string, KeyEntry>()
  private readonly order: string[] = []
  private cursor = 0

  /**
   * @param engineId 归属引擎 id（仅用于错误标注 extras.engineId，不参与选键）
   * @param secrets  明文密钥列表；空串项忽略，全部为空 = 空池（acquire 必抛）
   */
  constructor(
    private readonly engineId: string,
    secrets: readonly string[],
  ) {
    for (const secret of secrets) {
      if (secret === '') continue
      if (!this.entries.has(secret)) this.order.push(secret)
      this.entries.set(secret, { inflight: 0, cooledDown: false })
    }
  }

  /**
   * 取用一个健康键：健康键中在飞计数最小者，同数取轮换序。
   * @throws EngineError('auth', 'all keys unhealthy') 当无健康键可用（含空池）
   */
  acquire(): string {
    let chosen: string | undefined
    let chosenInflight = Number.POSITIVE_INFINITY
    const n = this.order.length
    for (let offset = 0; offset < n; offset++) {
      const secret = this.order[(this.cursor + offset) % n]
      if (secret === undefined) continue
      const entry = this.entries.get(secret)
      if (entry === undefined || entry.cooledDown) continue
      // 严格小于：从 cursor 起首个最小者胜出 → 同数自然落在轮换序前端。
      if (entry.inflight < chosenInflight) {
        chosen = secret
        chosenInflight = entry.inflight
        if (chosenInflight === 0) break // 0 已是下界，提前收敛
      }
    }
    if (chosen === undefined) {
      throw engineError('auth', 'all keys unhealthy', { engineId: this.engineId })
    }
    const entry = this.entries.get(chosen)
    if (entry !== undefined) entry.inflight++
    this.cursor = (this.order.indexOf(chosen) + 1) % n
    return chosen
  }

  /**
   * 归还键：`ok` 仅在飞减一（下限 0，重复归还安全）；`auth-failed` 打冷却
   * 标记且在飞清零（W-B-41）。未知键静默忽略（调用方只会传 acquire 的产物，
   * 容错以避免外部误用放大成崩溃）。
   */
  release(key: string, outcome: KeyOutcome): void {
    const entry = this.entries.get(key)
    if (entry === undefined) return
    if (outcome === 'auth-failed') {
      entry.cooledDown = true
      entry.inflight = 0
      return
    }
    entry.inflight = Math.max(0, entry.inflight - 1)
  }

  /** 池快照（纯读取；inflight 含冷却键的历史清零后残值恒为 0）。 */
  stats(): KeyPoolStats {
    let healthy = 0
    let inflight = 0
    for (const entry of this.entries.values()) {
      if (!entry.cooledDown) healthy++
      inflight += entry.inflight
    }
    return { total: this.entries.size, healthy, inflight }
  }
}

// ---------------------------------------------------------------------------
// keyed 适配器共享小工具（五家端点协议差异之外的公共机械）
// ---------------------------------------------------------------------------

/**
 * outbound 契约的请求方法类型面当前仅声明 GET（冻结形状，见 engine.ts 本地
 * 结构类型），而运行期 outboundFetch 将 method 原样透传给底层 fetch。keyed
 * JSON 端点的 POST 语义经本常量单一收口点桥接；契约未来放宽为 method union
 * 时删除即可（届时此处唯一改动点，五个适配器零 diff）。
 */
export const HTTP_POST_BRIDGED = 'POST' as unknown as 'GET'

/**
 * 从响应头解析 Retry-After 为毫秒数：仅接受秒数形态（RFC 7231 允许的
 * HTTP-date 形态不做时钟猜测，返回 undefined）。大小写不敏感扫描。
 */
export function retryAfterMsFromHeaders(
  headers: Readonly<Record<string, string>>,
): number | undefined {
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== 'retry-after') continue
    const seconds = Number(value.trim())
    if (value.trim() !== '' && Number.isFinite(seconds) && seconds >= 0) {
      return Math.round(seconds * 1000)
    }
    return undefined
  }
  return undefined
}

/**
 * ISO-8601 形态宽松校验（日历日期起头即可直接采用）；其余形态一律缺席
 * （不猜测、不改写）。unknown 进、合法 ISO 出——供各家 published 字段收窄。
 */
export function isoTimestampOrUndefined(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.length === 0) return undefined
  return /^\d{4}-\d{2}-\d{2}([Tt ]\d{2}:\d{2}(:\d{2})?(\.\d+)?([Zz]|[+-]\d{2}:?\d{2})?)?$/.test(raw)
    ? raw
    : undefined
}
