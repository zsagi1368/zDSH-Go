/**
 * 会话联网模式状态机（W-B-94 / F-107）：Host-owned 单一状态机，输入区按钮
 * 与 `/search` 都是瘦读写端。裁决规则：
 *
 * - 三态词汇 `off | on | ask`（与 kernel 契约的 SessionOnlineMode 一致）；
 * - 「本轮调用过搜索即算满足」的**宽松满足语义**：只要本轮标记过
 *   markSearched（无论成败），shouldForceOnline 即为真；
 * - 轮次标志随 beginTurn 建立、endTurn 回收，不跨轮泄漏。
 *
 * @module webstack/mode/online
 */

import type { SessionOnlineMode } from '../kernel/types.ts'

export type { SessionOnlineMode }

/** 会话联网三态（配置 `mode.sessionOnline` 的合法值）。 */
export const SESSION_ONLINE_MODES = ['off', 'on', 'ask'] as const

/** 每轮标志：状态机据其判定本轮是否已满足联网要求。 */
export interface TurnOnlineFlags {
  /** 本轮已发起过搜索调用（无论成败——宽松满足语义）。 */
  searched: boolean
}

/**
 * Host-owned 会话联网状态机实例（每会话一个）。模式是会话级持久态，
 * 轮次标志是轮级瞬态；两者读写全部收敛在此，禁止旁路缓存。
 */
export class SessionOnlineState {
  private mode: SessionOnlineMode = 'off'
  private readonly turnFlags = new Map<string, TurnOnlineFlags>()

  /** 切换会话联网模式；任意时刻可切，立即影响后续判定。 */
  setMode(mode: SessionOnlineMode): void {
    this.mode = mode
  }

  /** 读当前模式（瘦读端：输入区按钮回显用）。 */
  getMode(): SessionOnlineMode {
    return this.mode
  }

  /**
   * 开启一轮：为 turnId 建立全新空白标志（覆盖同 id 残留，防串轮）。
   * `ask` 模式的「先征求用户」交互发生在更上层，这里只管状态记账。
   */
  beginTurn(turnId: string): void {
    this.turnFlags.set(turnId, { searched: false })
  }

  /**
   * 标记本轮已发起过搜索调用。无论该次调用成败都置位——宽松满足语义
   * （F-107）：模型已经尝试联网，就不必在本轮再强制一次。
   */
  markSearched(turnId: string): void {
    const flags = this.turnFlags.get(turnId)
    if (flags !== undefined) {
      flags.searched = true
      return
    }
    // 容错：未 beginTurn 的轮次也接受标记（瘦写端可能乱序到达）。
    this.turnFlags.set(turnId, { searched: true })
  }

  /**
   * 是否应强制走在线路径：`mode === 'on'`（会话级强制）或本轮已搜过
   * （宽松满足）。`off` 且未搜过 → false；`ask` 由上层征询后落点同上。
   */
  shouldForceOnline(turnId: string): boolean {
    return this.mode === 'on' || (this.turnFlags.get(turnId)?.searched ?? false)
  }

  /** 结束一轮：回收轮级标志，防长会话内存累积与跨轮误判。 */
  endTurn(turnId: string): void {
    this.turnFlags.delete(turnId)
  }
}
