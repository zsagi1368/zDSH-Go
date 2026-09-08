/**
 * WebStack Bridge 协议镜像（扩展侧纯 JS）。
 *
 * ⚠️ 单一事实源：`packages/bridge/src/protocol.ts`。**改协议须两侧同步**——
 * 本文件是宿主 protocol.ts 的逐字镜像（W-A-18 的数据化缓解：把「两侧一致」
 * 从口头约定变成 tests/extension-logic.test.ts 里的常量相等断言 + 帧形状
 * 快照，漂移即测试红）。
 *
 * 方向与 id 纪律（同 protocol.ts）：
 * - pair/auth（客户端→宿主请求）必须带单调整数 id，宿主响应回显；
 * - render-req（宿主→客户端请求）由宿主分配 id，render-res 必须原样回显；
 * - 两方向 id 空间独立；每个响应恰好对应一个请求 id。
 *
 * 本文件刻意只含常量，不含任何逻辑；逻辑进 logic.js（可被 vitest 直测）。
 */

/** 协议名（诊断用，不参与握手子协议协商）。 */
export const BRIDGE_PROTOCOL = 'webstack-bridge/1';

/** 一次性配对 ticket 有效期（毫秒）。 */
export const DEFAULT_TICKET_TTL_MS = 60_000;
/** 心跳 ping 间隔（毫秒）。 */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 20_000;
/** 连续无 pong 判死窗口（毫秒）。 */
export const DEFAULT_PONG_TIMEOUT_MS = 60_000;

/**
 * 关闭码闭集（收到其一 = 配置/凭据问题，自动重连只会撞墙 → 必须人工介入，
 * 扩展侧据此停止退避重连并在 popup 提示）：
 * - 4001 配对被拒（ticket 缺失/过期/重复消费/格式非法）；
 * - 4002 协议违规（非 JSON / id 缺失 / 握手前杂讯 / 未知类型）；
 * - 4003 认证失败（key 与已配对哈希不符，或尚无已配对键）。
 */
export const CLOSE_PAIR_REJECTED = 4001;
export const CLOSE_PROTOCOL_VIOLATION = 4002;
export const CLOSE_AUTH_FAILED = 4003;
