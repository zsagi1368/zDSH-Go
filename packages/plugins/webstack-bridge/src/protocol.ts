/**
 * 桥接协议词汇（W-B-58）：宿主 ↔ MV3 扩展之间的 WS 帧形状、超时常量与
 * 关闭码闭集。全部为冻结契约词汇——扩展侧实现按本文件语义对齐，字段只增不改。
 *
 * 方向约定：
 * - 客户端 → 宿主的「请求」（pair/auth）必须携带单调 `id`，宿主响应回显该 id；
 * - 宿主 → 客户端的「请求」（render-req）由宿主分配全局单调 `id`，
 *   客户端 render-res 必须原样回显。
 * - 两个方向的 id 空间相互独立；每个响应恰好对应一个请求 id。
 *
 * @module webstack-bridge/protocol
 */

/** 协议名（诊断用，不参与握手子协议协商）。 */
export const BRIDGE_PROTOCOL = 'webstack-bridge/1'

/** 一次性配对 ticket 有效期（毫秒）。 */
export const DEFAULT_TICKET_TTL_MS = 60_000
/** 心跳 ping 间隔（毫秒）。 */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 20_000
/** 连续无 pong 判死窗口（毫秒）；实际断开最迟滞后一个心跳周期。 */
export const DEFAULT_PONG_TIMEOUT_MS = 60_000

/**
 * 关闭码闭集（扩展侧据此决定是否重连提示）：
 * - 4001 配对被拒（ticket 缺失/过期/重复消费/格式非法）——不可重连；
 * - 4002 协议违规（非 JSON / id 缺失 / 握手前杂讯 / 未知类型）——不可重连；
 * - 4003 认证失败（key 与已配对哈希不符，或尚无已配对键）——不可重连。
 * 三者均为「配置或凭据问题」，自动重连只会反复撞墙，故统一要求人工介入。
 */
export const CLOSE_PAIR_REJECTED = 4001
export const CLOSE_PROTOCOL_VIOLATION = 4002
export const CLOSE_AUTH_FAILED = 4003

// ---------------------------------------------------------------------------
// 帧（客户端 → 宿主）
// ---------------------------------------------------------------------------

export interface PairRequestFrame {
  readonly type: 'pair'
  /** 单调请求序号；响应（paired）必须回显。 */
  readonly id: number
  /** 一次性短时效 ticket（明文仅出现在本帧与装配层日志）。 */
  readonly ticket: string
}

export interface AuthRequestFrame {
  readonly type: 'auth'
  readonly id: number
  /** 长期 key 明文（仅本次握手出现一次；宿主只存 sha256）。 */
  readonly key: string
}

export interface RenderResponseFrame {
  readonly type: 'render-res'
  /** 必须回显对应 render-req 的 id。 */
  readonly id: number
  readonly ok: boolean
  /** ok=true 时必填：渲染产物文本（DOM 快照/正文提取由扩展侧负责）。 */
  readonly content?: string
  /** ok=true 时可选：目标站真实 HTTP 状态码；经桥取得时缺失按 0 处理。 */
  readonly statusCode?: number
}

// ---------------------------------------------------------------------------
// 帧（宿主 → 客户端）
// ---------------------------------------------------------------------------

export interface PairedResponseFrame {
  readonly type: 'paired'
  /** 回显 PairRequestFrame.id。 */
  readonly id: number
  /** 长期 key 明文——**只此一次下发**，宿主从此只存其 sha256。 */
  readonly key: string
}

export interface AuthOkResponseFrame {
  readonly type: 'auth-ok'
  readonly id: number
}

export interface RenderRequestFrame {
  readonly type: 'render-req'
  /** 宿主侧全局单调自增。 */
  readonly id: number
  readonly url: string
  readonly timeoutMs: number
}
