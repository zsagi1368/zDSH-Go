/**
 * WebStack Bridge 扩展侧可测纯逻辑。
 *
 * 背景：MV3 service worker 里的 WebSocket/标签页编排无法直接进 vitest，故把
 * 全部「可判定的决策」抽为本文件的纯函数——帧构造、入站帧解析防线、ACK id
 * 回显、指数退避、重连裁决、加载超时换算、UTF-8 截断与注入抽取规则字符串。
 * background.js 只做 chrome.* 胶水；tests/extension-logic.test.ts 对本文件
 * 做 ≥10 例覆盖（含与宿主 src/protocol.ts 的常量一致性快照）。
 *
 * W-A-18 反制（executeScript func 序列化限制）：chrome.scripting 注入的
 * `func` 会被 toString 后在目标页重建，**任何闭包引用都会断裂**。因此页面
 * 抽取逻辑不做成模块函数闭包，而是做成可序列化字符串规则 EXTRACT_RULE_SOURCE，
 * 由注入侧经 executeScript args 传入、目标页里 new Function 执行——规则本身
 * 自包含，只依赖参数与页内全局（document / TextEncoder）。
 */

// 本文件自身也要用这些常量（如 shouldReconnect 的致命码闭集），
// 故 import 绑定本地名，再原样 re-export 供 background/popup/测试取用。
import {
  CLOSE_AUTH_FAILED,
  CLOSE_PAIR_REJECTED,
  CLOSE_PROTOCOL_VIOLATION,
} from './shared-protocol.js';

export {
  BRIDGE_PROTOCOL,
  CLOSE_AUTH_FAILED,
  CLOSE_PAIR_REJECTED,
  CLOSE_PROTOCOL_VIOLATION,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_PONG_TIMEOUT_MS,
  DEFAULT_TICKET_TTL_MS,
} from './shared-protocol.js';

/** 渲染产物字节上限：outerHTML 截断至 2MB。 */
export const MAX_CONTENT_BYTES = 2 * 1024 * 1024;
/** 标签页加载兜底占宿主 timeoutMs 的比例（剩余留给抽取与回传）。 */
export const LOAD_TIMEOUT_FRACTION = 0.8;
/** 断线重连退避基值（毫秒）：1s / 2s / 4s / … */
export const BACKOFF_BASE_MS = 1000;
/** 断线重连退避上限（毫秒）。 */
export const BACKOFF_MAX_MS = 60_000;

// ---------------------------------------------------------------------------
// 重连策略
// ---------------------------------------------------------------------------

/**
 * 指数退避：attempt 0 起，base * 2^attempt，封顶 maxMs。
 * 序列固定为 1s, 2s, 4s, 8s, …, 60s（默认参数下）。
 */
export function computeBackoffMs(attempt, baseMs = BACKOFF_BASE_MS, maxMs = BACKOFF_MAX_MS) {
  const step = Math.max(0, Math.floor(attempt));
  return Math.min(maxMs, baseMs * 2 ** step);
}

/**
 * 关闭后是否允许自动重连：
 * - 未配对（无长期 key）绝不自动重连——没有凭据，连上也只是撞握手闸；
 * - 4001/4002/4003 是配置或凭据问题（见 shared-protocol.js），须人工介入。
 */
export function shouldReconnect(closeCode, hasKey) {
  const fatalCodes = new Set([CLOSE_PAIR_REJECTED, CLOSE_PROTOCOL_VIOLATION, CLOSE_AUTH_FAILED]);
  return hasKey && !fatalCodes.has(closeCode);
}

// ---------------------------------------------------------------------------
// 出站帧构造（客户端 → 宿主）
// ---------------------------------------------------------------------------

/** 单调出站请求 id 分配器（两方向 id 空间独立；本分配器只服务客户端→宿主）。 */
export function createRequestIdAllocator(start = 1) {
  let next = Math.floor(start);
  return () => next++;
}

/** 配对请求：一次性 ticket 换长期 key。 */
export function createPairRequest(id, ticket) {
  return { type: 'pair', id: Math.floor(id), ticket: String(ticket) };
}

/** 重连认证请求：key 明文仅出现在本帧一次。 */
export function createAuthRequest(id, key) {
  return { type: 'auth', id: Math.floor(id), key: String(key) };
}

/** render-res 成功帧：id 必须原样回显对应 render-req；statusCode 缺省 200。 */
export function createRenderSuccess(id, content, statusCode = 200) {
  return { type: 'render-res', id, ok: true, content: String(content), statusCode };
}

/**
 * render-res 失败帧。`error` 是 protocol.ts 之外的**增量字段**（协议约定
 * 「字段只增不改」，宿主按 ok=false 结算并忽略未知字段）。
 */
export function createRenderFailure(id, error) {
  return { type: 'render-res', id, ok: false, error: String(error) };
}

// ---------------------------------------------------------------------------
// 入站帧解析防线（宿主 → 客户端）
// ---------------------------------------------------------------------------

/**
 * 严格解析一帧：非 JSON / 非普通对象（含数组）/ 缺整数 id 一律拒绝；
 * ok=true 时 frame 保证是带整数码 id 的普通对象帧。
 * reason 词表与宿主 server.ts 的关闭理由对齐（non-json-frame 等），
 * 便于两侧日志互查。
 */
export function parseFrame(raw) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'non-json-frame' };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, reason: 'non-object-frame' };
  }
  if (!Number.isInteger(value.id)) {
    return { ok: false, reason: 'missing-ack-id' };
  }
  return { ok: true, frame: value };
}

/** render-req 形状守卫：type/id/url/timeoutMs 齐备且合法才受理。 */
export function isRenderRequest(frame) {
  return (
    typeof frame === 'object' &&
    frame !== null &&
    !Array.isArray(frame) &&
    frame.type === 'render-req' &&
    Number.isInteger(frame.id) &&
    typeof frame.url === 'string' &&
    frame.url.length > 0 &&
    Number.isInteger(frame.timeoutMs) &&
    frame.timeoutMs > 0
  );
}

// ---------------------------------------------------------------------------
// 渲染管线数值
// ---------------------------------------------------------------------------

/**
 * 标签页加载预算 = timeoutMs * fraction（默认 0.8），至少 1ms。
 * 到点未 complete 也照常注入——半页 DOM 好过空手而归（宿主侧还有总超时兜底）。
 */
export function clampLoadTimeout(timeoutMs, fraction = LOAD_TIMEOUT_FRACTION) {
  const budget = Math.floor(Number(timeoutMs) * fraction);
  return Number.isFinite(budget) && budget > 0 ? budget : 1;
}

// ---------------------------------------------------------------------------
// UTF-8 截断
// ---------------------------------------------------------------------------

/** 文本的 UTF-8 字节长度（TextEncoder 在 SW / 页面 / Node 均可用）。 */
export function utf8ByteLength(text) {
  return new TextEncoder().encode(text).length;
}

/**
 * 按 UTF-8 字节数截断到 ≤ maxBytes 的最长完整前缀（二分字符数，绝不产生
 * 半个码元）。短文本原样返回。
 *
 * ⚠️ 审查点：EXTRACT_RULE_SOURCE 内嵌了一份同算法副本（注入侧无法引用本
 * 模块）；两者的一致性由测试 truncate/rule parity 锁死——改这里必须同步
 * 改规则串，反之亦然。
 */
export function truncateContent(text, maxBytes = MAX_CONTENT_BYTES) {
  if (utf8ByteLength(text) <= maxBytes) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (utf8ByteLength(text.slice(0, mid)) <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  // 边界落在代理对中间时退一格：不把一个码点劈成两半（lone surrogate 会
  // 在下游被替换成 U+FFFD，白丢内容还污染文本）。
  const tail = lo > 0 ? text.charCodeAt(lo - 1) : 0;
  if (tail >= 0xd800 && tail <= 0xdbff) lo -= 1;
  return text.slice(0, lo);
}

// ---------------------------------------------------------------------------
// W-A-18 反制：可序列化抽取规则
// ---------------------------------------------------------------------------

/**
 * 页面抽取规则源码。执行方式（注入侧与测试一致）：
 *   new Function('document', 'maxBytes', EXTRACT_RULE_SOURCE)(document, cap)
 * 规则自包含：不用 import/闭包外变量，只依赖形参与页内全局。
 * 返回 { title, html }，html 已按 maxBytes 截断。
 *
 * ⚠️ 审查点：truncateToBytes 与本文件 truncateContent 为同一算法的两份拷贝
 * （见上），由测试锁平。
 */
export const EXTRACT_RULE_SOURCE = `"use strict";
const encoder = new TextEncoder();
const byteLength = (text) => encoder.encode(text).length;
function truncateToBytes(text, budget) {
  if (byteLength(text) <= budget) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (byteLength(text.slice(0, mid)) <= budget) lo = mid;
    else hi = mid - 1;
  }
  const tail = lo > 0 ? text.charCodeAt(lo - 1) : 0;
  if (tail >= 0xd800 && tail <= 0xdbff) lo -= 1;
  return text.slice(0, lo);
}
let title = '';
try { title = String(document.title || ''); } catch {}
let html = '';
try { html = String(document.documentElement.outerHTML); } catch {}
return { title, html: truncateToBytes(html, Math.max(0, Number(maxBytes) || 0)) };`;

/** 在当前 JS 环境（Node 测试 / SW 兜底）执行一条抽取规则。 */
export function runExtractRule(
  ruleSource = EXTRACT_RULE_SOURCE,
  documentLike = undefined,
  maxBytes = MAX_CONTENT_BYTES,
) {
  const factory = new Function('document', 'maxBytes', ruleSource);
  return factory(documentLike, maxBytes);
}
