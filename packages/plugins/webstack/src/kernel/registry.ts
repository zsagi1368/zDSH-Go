/**
 * 引擎注册表与 fallback 执行器（W-B-10/11/40）：probe/run/失败冷却/诊断导出。
 * 同一个注册表同时服务执行路径（选引擎、跑降级链）与模型可见状态查询
 * （web_backend_status / doctor / prompt 状态节）。
 *
 * 错误三分类决策（W-B-40，ERROR_CLASSIFICATION 是唯一依据）：
 * - terminal（aborted/ssrf-blocked）→ 立即整场终止 rethrow，不做任何 fallback；
 * - non-retryable → 放弃当前候选，换下一个；
 * - retryable → 同候选最多重试 1 次（退避 250ms），仍失败再换下一个；
 * - rate-limited / quota → 触发该引擎冷却（retryAfterMs ?? 默认 60s/300s），
 *   冷却期内从候选中剔除。
 *
 * @module webstack/kernel/registry
 */

import type { EngineLike } from '../engines/engine.ts'
import { engineError, errorClass, normalizeThrown } from './errors.ts'
import type {
  AttemptRecord,
  EngineDescriptor,
  EngineErrorCode,
  EngineSearchRequest,
  EngineSearchResponse,
  EngineTier,
  NormalizedHit,
  SearchLayer,
} from './types.ts'

/** rate-limited 冷却默认时长（毫秒）：无服务端指示时的保守退避。 */
export const RATE_LIMIT_COOLDOWN_MS = 60_000

/** quota 冷却默认时长（毫秒）：账户级配额按更长时间窗冷却。 */
export const QUOTA_COOLDOWN_MS = 300_000

/** retryable 同候选重试退避（毫秒）。 */
export const RETRY_BACKOFF_MS = 250

/** 同候选 retryable 最大重试次数（首试之外再试 1 次）。 */
const MAX_SAME_ENGINE_RETRIES = 1

/** 每引擎审计轨迹环形缓冲上限（doctor 回显裁剪用）。 */
const ATTEMPT_HISTORY_CAP = 20

/** 路由层 → 引擎计费档位映射（api 层消费 keyed 档；本期池为空）。 */
const LAYER_TIERS: Readonly<Record<SearchLayer, readonly EngineTier[]>> = Object.freeze({
  native: ['native'],
  free: ['free'],
  api: ['keyed'],
  selfhosted: ['selfhosted'],
  mcp: ['mcp'],
})

/** 单引擎运行时状态：冷却截止时刻与最近一次失败码（成功即清除失败码）。 */
interface EngineRuntimeState {
  cooldownUntil?: number
  lastCode?: EngineErrorCode
}

/** statusSnapshot 单条目形状（W-B-113/114 的数据源）。 */
export interface EngineStatusEntry {
  readonly state: 'ok' | 'cooldown' | 'unwired'
  /** 冷却截止 epoch 毫秒；仅 cooldown 态携带。 */
  readonly cooldownUntil?: number
  /** 最近一次失败的错误码；仅失败过且未恢复时携带。 */
  readonly lastCode?: string
}

/** 已知引擎 id 但未注册进注册表的占位条目构造器（doctor 合并配置面用）。 */
export function unwiredEntry(): EngineStatusEntry {
  return { state: 'unwired' }
}

/** 中止感知的退避睡眠：caller signal 在等待期间中止 → aborted（terminal）。 */
async function backoff(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) {
    throw engineError('aborted', 'caller aborted during fallback backoff', {})
  }
  if (ms <= 0) return
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
  })
  if (signal?.aborted) {
    throw engineError('aborted', 'caller aborted during fallback backoff', {})
  }
}

/** 仅当映射出闭集 i18n 键时才追加 warning（缺映射静默，防自由文本注入 W-B-53）。 */
function pushWarning(warnings: string[], key: string | undefined): void {
  if (key !== undefined) warnings.push(key)
}

/**
 * 有序引擎注册表。注册顺序即 fallback 候选顺序（W-B-11）；重复注册按契约
 * 拒绝（镜像宿主 WEB_DUPLICATE_PROVIDER 语义）。
 */
export class EngineRegistry {
  readonly #engines = new Map<string, EngineLike>()
  readonly #states = new Map<string, EngineRuntimeState>()
  readonly #history = new Map<string, AttemptRecord[]>()

  /** 注册引擎实例；返回随 fiber 释放的 disposer。id 冲突按契约拒绝。 */
  register(engine: EngineLike): () => void {
    const id = engine.descriptor.id
    if (this.#engines.has(id)) {
      throw engineError('transport', `engine "${id}" is already registered`, {
        engineId: id,
      })
    }
    this.#engines.set(id, engine)
    this.#states.set(id, {})
    this.#history.set(id, [])
    return () => {
      this.#engines.delete(id)
      this.#states.delete(id)
      this.#history.delete(id)
    }
  }

  /** 全部已注册引擎 id（注册序）。 */
  listIds(): string[] {
    return [...this.#engines.keys()]
  }

  /** 引擎静态名片；未注册为 undefined。 */
  describe(id: string): EngineDescriptor | undefined {
    return this.#engines.get(id)?.descriptor
  }

  /** 按层过滤候选引擎（native→native 档；free→免费池；selfhosted→自托管…注册序）。 */
  candidates(layer: SearchLayer): EngineLike[] {
    const tiers = LAYER_TIERS[layer] ?? []
    return [...this.#engines.values()].filter(engine => tiers.includes(engine.descriptor.tier))
  }

  /**
   * 带 fallback 的顺序执行：`ids` 显式给定候选顺序（未知 id 安全跳过），
   * 缺省回落 candidates(req.layer)。冷却中的候选剔除并记 warning。
   * 终态语义：候选清单为空 → transport/no-candidates；全部候选冷却中 →
   * cooldown/all-cooling；尝试过但无一成功 → 抛最后一个错误；
   * terminal 错误（aborted/ssrf-blocked）随时立即整场终止。
   */
  async runWithFallback(
    req: EngineSearchRequest,
    ids?: readonly string[],
  ): Promise<EngineSearchResponse> {
    const ordered = this.resolveOrder(req.layer, ids)
    const attempts: AttemptRecord[] = []
    const warnings: string[] = []
    const hits: NormalizedHit[] = []
    let lastError: EngineErrorShapeLike | undefined
    let anySuccess = false

    for (const engine of ordered) {
      const id = engine.descriptor.id
      if (this.inCooldown(id)) {
        pushWarning(warnings, this.warningKeyFor(id))
        continue
      }
      const outcome = await this.runSingle(engine, req, attempts, warnings)
      if (outcome.kind === 'ok') {
        // 零结果的成功也是成功（合法空页 ≠ 全军覆没）。
        anySuccess = true
        hits.push(...outcome.hits)
        continue
      }
      lastError = outcome.error
      if (errorClass(outcome.error.code) === 'terminal') {
        // terminal（aborted/ssrf-blocked）：立即整场终止，rethrow 不绕行（W-B-42/50）。
        throw outcome.error
      }
    }

    if (attempts.length === 0) {
      // 一次都没真正尝试：候选清单为空，或全部候选处于冷却期被剔除（W-B-40 闭集码）。
      if (ordered.length === 0) {
        throw engineError('transport', 'no search engine candidates available', {
          detail: 'no-candidates',
        })
      }
      throw engineError('cooldown', 'every candidate engine is cooling down', {
        detail: 'all-cooling',
      })
    }
    if (!anySuccess) {
      throw (
        lastError ??
        engineError('transport', 'all candidate engines failed', {
          detail: 'all-failed',
        })
      )
    }
    return warnings.length === 0 ? { hits, attempts } : { hits, attempts, warnings }
  }

  /** 最近一次尝试轨迹导出（doctor 与设置卡「测试」按钮的审计回显来源，最新在前）。 */
  recentAttempts(engineId: string): readonly AttemptRecord[] {
    return [...(this.#history.get(engineId) ?? [])].reverse()
  }

  /**
   * 运行状态快照（web_backend_status / doctor / prompt 状态节的数据源）。
   * 只读本地计时与错误码，绝不发探针（W-B-97 纪律对诊断面同样适用）。
   */
  statusSnapshot(): Record<string, EngineStatusEntry> {
    const out: Record<string, EngineStatusEntry> = {}
    for (const id of this.#engines.keys()) {
      const state = this.#states.get(id) ?? {}
      const now = Date.now()
      if (state.cooldownUntil !== undefined && now < state.cooldownUntil) {
        out[id] = {
          state: 'cooldown',
          cooldownUntil: state.cooldownUntil,
          ...(state.lastCode === undefined ? {} : { lastCode: state.lastCode }),
        }
      } else {
        out[id] =
          state.lastCode === undefined
            ? { state: 'ok' }
            : { state: 'ok', lastCode: state.lastCode }
      }
    }
    return out
  }

  /** 引擎是否处于冷却期。 */
  inCooldown(id: string): boolean {
    const until = this.#states.get(id)?.cooldownUntil
    return until !== undefined && Date.now() < until
  }

  // -------------------------------------------------------------------------
  // 内部执行机制
  // -------------------------------------------------------------------------

  private resolveOrder(layer: SearchLayer, ids?: readonly string[]): EngineLike[] {
    if (ids === undefined) return this.candidates(layer)
    const out: EngineLike[] = []
    for (const id of ids) {
      const engine = this.#engines.get(id)
      if (engine !== undefined) out.push(engine)
    }
    return out
  }

  /** 单候选执行：retryable 同候选最多重试 1 次；rate-limited/quota 入冷却。 */
  private async runSingle(
    engine: EngineLike,
    req: EngineSearchRequest,
    attempts: AttemptRecord[],
    warnings: string[],
  ): Promise<
    { kind: 'ok'; hits: readonly NormalizedHit[] } | { kind: 'failed'; error: EngineErrorShapeLike }
  > {
    const id = engine.descriptor.id
    for (let attemptNo = 0; ; attemptNo++) {
      const startedAt = Date.now()
      try {
        const res = await engine.search(req)
        this.record(attempts, {
          engineId: id,
          startedAt,
          durationMs: Math.max(0, Date.now() - startedAt),
          outcome: 'ok',
        })
        this.clearFailure(id)
        return { kind: 'ok', hits: res.hits }
      } catch (thrown) {
        const err = normalizeThrown(thrown, id)
        this.record(attempts, {
          engineId: id,
          startedAt,
          durationMs: Math.max(0, Date.now() - startedAt),
          outcome: err.code,
        })
        this.markFailure(id, err.code)

        // 配额/限频：provider 级冷却（尊重服务端 retryAfterMs），冷却期内剔除。
        if (err.code === 'rate-limited') {
          this.enterCooldown(id, err.retryAfterMs ?? RATE_LIMIT_COOLDOWN_MS)
          pushWarning(warnings, this.warningKeyFor(id))
          return { kind: 'failed', error: err }
        }
        if (err.code === 'quota') {
          this.enterCooldown(id, err.retryAfterMs ?? QUOTA_COOLDOWN_MS)
          pushWarning(warnings, this.warningKeyFor(id))
          return { kind: 'failed', error: err }
        }
        // retryable：同候选最多再试 1 次（退避后）；其余分类换下一候选。
        if (errorClass(err.code) === 'retryable' && attemptNo < MAX_SAME_ENGINE_RETRIES) {
          await backoff(RETRY_BACKOFF_MS, req.signal)
          continue
        }
        if (errorClass(err.code) !== 'terminal') {
          pushWarning(warnings, this.warningKeyFor(id))
        }
        return { kind: 'failed', error: err }
      }
    }
  }

  private enterCooldown(id: string, ms: number): void {
    const state = this.#states.get(id) ?? {}
    state.cooldownUntil = Date.now() + Math.max(0, ms)
    this.#states.set(id, state)
  }

  private markFailure(id: string, code: EngineErrorCode): void {
    const state = this.#states.get(id) ?? {}
    state.lastCode = code
    this.#states.set(id, state)
  }

  private clearFailure(id: string): void {
    const state = this.#states.get(id) ?? {}
    delete state.lastCode
  }

  /** 审计轨迹入环形缓冲（超限丢最旧）。 */
  private record(attempts: AttemptRecord[], entry: AttemptRecord): void {
    attempts.push(entry)
    const ring = this.#history.get(entry.engineId)
    if (ring === undefined) return
    ring.push(entry)
    while (ring.length > ATTEMPT_HISTORY_CAP) ring.shift()
  }

  /** 失败回显的 i18n warning 键（闭集词表内映射，缺映射则不产生键——W-B-53）。 */
  private warningKeyFor(id: string): string | undefined {
    switch (id) {
      case 'ddg':
        return 'webstack.engine.ddg.degraded'
      case 'bing-lite':
        return 'webstack.engine.bing-lite.degraded'
      case 'searxng':
        return 'webstack.engine.searxng.offline'
      case 'native':
        return 'webstack.engine.native.unavailable'
      default:
        return undefined
    }
  }
}

/** runWithFallback 内部流转的错误最小视图（EngineError 结构兼容）。 */
interface EngineErrorShapeLike {
  readonly code: EngineErrorCode
}
