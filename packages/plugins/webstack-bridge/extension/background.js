/**
 * WebStack Bridge MV3 service worker：回环 WS 客户端 + 渲染管线胶水。
 *
 * 协议语义全部来自 shared-protocol.js（宿主 src/protocol.ts 的镜像）与
 * logic.js（可测纯函数）；本文件只做 chrome.* 胶水，不做可判定决策——
 * 凡「算得出」的（退避间隔、帧形状、截断、解析防线）一律下沉 logic.js。
 *
 * 安全要点（与宿主 server.ts 模型对齐）：
 * - 只连 ws://127.0.0.1:<port>，端口由装配层（dsh-webstack-bridge 宿主）
 *   随机分配并经 popup 写入 chrome.storage.local；
 * - key 明文只存于浏览器本地 chrome.storage.local 与内存，宿主侧只有其
 *   sha256；ticket 一次性、60s 过期；
 * - cookie / localStorage 永不离开浏览器进程：渲染发生在真实会话里，
 *   宿主只收到抽取后的文本（title + 截断后的 outerHTML）。
 *
 * 心跳说明：宿主的 ping 是 RFC 6455 协议层 ping，Chrome 网络栈自动回 pong，
 * 无需 JS 参与（DEFAULT_HEARTBEAT_INTERVAL_MS/DEFAULT_PONG_TIMEOUT_MS 由
 * 宿主执行）；这里额外兼容**应用层** {type:'ping'} 帧 → {type:'pong', id}
 * 原样回显 id，为未来协议演进预留，两侧词汇已镜像。
 */

import {
  CLOSE_AUTH_FAILED,
  CLOSE_PAIR_REJECTED,
  CLOSE_PROTOCOL_VIOLATION,
} from './shared-protocol.js';
import {
  EXTRACT_RULE_SOURCE,
  MAX_CONTENT_BYTES,
  clampLoadTimeout,
  computeBackoffMs,
  createAuthRequest,
  createPairRequest,
  createRenderFailure,
  createRenderSuccess,
  createRequestIdAllocator,
  isRenderRequest,
  parseFrame,
  shouldReconnect,
  truncateContent,
} from './logic.js';

/** chrome.storage.local 键位（popup 同样读写）。 */
const STORAGE_KEYS = Object.freeze({ port: 'port', key: 'key' });
/** 配对握手等待 paired/auth-ok 的兜底时限（毫秒）。 */
const HANDSHAKE_TIMEOUT_MS = 10_000;

const state = {
  /** @type {WebSocket | null} */
  ws: null,
  ready: false,
  /** 已配对长期 key 明文（仅内存 + chrome.storage.local）。 */
  key: null,
  port: null,
  /** @type {string | null} popup 发起配对时暂存的 ticket（下一次 onopen 消费）。 */
  pendingTicket: null,
  /** @type {((value: {ok: boolean, error?: string}) => void) | null} */
  pendingPairSettle: null,
  reconnectAttempt: 0,
  /** @type {ReturnType<typeof setTimeout> | null} */
  reconnectTimer: null,
  allocateRequestId: createRequestIdAllocator(1),
};

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

bootstrap();

async function bootstrap() {
  const stored = await chrome.storage.local.get([STORAGE_KEYS.port, STORAGE_KEYS.key]);
  state.port = typeof stored[STORAGE_KEYS.port] === 'number' ? stored[STORAGE_KEYS.port] : null;
  state.key = typeof stored[STORAGE_KEYS.key] === 'string' && stored[STORAGE_KEYS.key] !== ''
    ? stored[STORAGE_KEYS.key]
    : null;
  if (state.key !== null && state.port !== null) connect();
  notifyPopup();
}

// ---------------------------------------------------------------------------
// 连接生命周期
// ---------------------------------------------------------------------------

/** 连接代际：代际过期的事件一律忽略，防止被替换的旧 socket 触发重连/结算。 */
let generation = 0;

function connect() {
  clearReconnectTimer();
  // 未配对且无待配对 ticket 不建连：没有凭据，连上也过不了握手闸。
  if (state.ws !== null || state.port === null) return;
  if (state.key === null && state.pendingTicket === null) return;

  generation += 1;
  const currentGen = generation;
  const isCurrent = () => currentGen === generation;

  let ws;
  try {
    ws = new WebSocket(`ws://127.0.0.1:${state.port}`);
  } catch {
    scheduleReconnect();
    return;
  }
  state.ws = ws;
  broadcastState('connecting');

  ws.onopen = () => {
    if (!isCurrent()) return;
    // 握手二选一：popup 排队的 ticket 优先（配对），否则用长期 key 认证。
    if (state.pendingTicket !== null) {
      sendJson(ws, createPairRequest(state.allocateRequestId(), state.pendingTicket));
    } else if (state.key !== null) {
      sendJson(ws, createAuthRequest(state.allocateRequestId(), state.key));
    } else {
      ws.close(CLOSE_AUTH_FAILED, 'no-credentials');
    }
  };

  ws.onmessage = (event) => {
    if (!isCurrent()) return; // 旧连接的迟到包
    handleInbound(ws, String(event.data));
  };

  ws.onclose = (event) => {
    if (!isCurrent()) return;
    state.ws = null;
    state.ready = false;
    settlePendingPair(
      event.code === CLOSE_PAIR_REJECTED
        ? { ok: false, error: '配对被拒：ticket 缺失、过期或已被消费' }
        : event.code === CLOSE_PROTOCOL_VIOLATION
        ? { ok: false, error: '协议违规：宿主拒绝该客户端' }
        : event.code === CLOSE_AUTH_FAILED
        ? { ok: false, error: '认证失败：key 与宿主不匹配，请重新配对' }
        : { ok: false, error: `连接关闭（code=${event.code}）` },
    );
    broadcastState('disconnected');
    if (shouldReconnect(event.code, state.key !== null)) scheduleReconnect();
  };

  ws.onerror = () => {
    // close 事件随后必然到达，重连决策集中在 onclose。
  };
}

/**
 * 关闭当前连接并推进代际：旧 socket 的全部事件就此作废（不结算、不重连），
 * 用于解除配对与「重新配对前复位到握手态」。
 */
function resetConnection(closeCode, reason) {
  generation += 1;
  clearReconnectTimer();
  const ws = state.ws;
  state.ws = null;
  state.ready = false;
  if (ws !== null) {
    try {
      ws.close(closeCode, reason);
    } catch {
      // already closed
    }
  }
}

function scheduleReconnect() {
  clearReconnectTimer();
  const delayMs = computeBackoffMs(state.reconnectAttempt);
  state.reconnectAttempt += 1;
  state.reconnectTimer = setTimeout(connect, delayMs);
}

function clearReconnectTimer() {
  if (state.reconnectTimer !== null) {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }
}

// ---------------------------------------------------------------------------
// 入站帧分发
// ---------------------------------------------------------------------------

function handleInbound(ws, raw) {
  if (ws !== state.ws) return; // 旧连接的迟到包
  const parsed = parseFrame(raw);
  if (!parsed.ok) {
    // 宿主违反协议：记录并忽略该帧；持续违规由宿主侧心跳/闸门兜底。
    console.warn('[webstack-bridge] drop malformed inbound frame:', parsed.reason);
    return;
  }
  const frame = parsed.frame;

  switch (frame.type) {
    case 'paired': {
      // key 明文只此一次下发：落 chrome.storage.local，此后重连走 auth。
      state.key = typeof frame.key === 'string' ? frame.key : null;
      state.ready = true;
      state.reconnectAttempt = 0;
      state.pendingTicket = null;
      if (state.key !== null) {
        void chrome.storage.local.set({ [STORAGE_KEYS.key]: state.key });
      }
      settlePendingPair({ ok: true });
      broadcastState('ready');
      break;
    }
    case 'auth-ok': {
      state.ready = true;
      state.reconnectAttempt = 0;
      broadcastState('ready');
      break;
    }
    case 'render-req':
      void handleRenderRequest(frame);
      break;
    case 'ping':
      // 应用层心跳：id 回显（协议层 ping 由浏览器自动 pong，见模块头）。
      sendJson(ws, { type: 'pong', id: frame.id });
      break;
    default:
      // 未知类型：静默忽略（不回包不关连接；严格闸在宿主侧）。
      break;
  }
}

// ---------------------------------------------------------------------------
// 配对面（popup 驱动）
// ---------------------------------------------------------------------------

/**
 * 发起配对：暂存 ticket →（必要时）建连 → onopen 发 pair → 等 paired。
 * 返回值供 popup 直接展示。
 */
async function startPairing(ticketRaw) {
  const ticket = String(ticketRaw ?? '').trim();
  if (ticket.length === 0) return { ok: false, error: '请先粘贴宿主日志中的一次性 ticket' };
  if (state.port === null) return { ok: false, error: '请先填写宿主端口' };
  if (state.pendingTicket !== null) return { ok: false, error: '配对已在进行中' };

  state.pendingTicket = ticket;
  const settled = new Promise((resolve) => {
    state.pendingPairSettle = resolve;
  });
  const timeout = setTimeout(() => {
    settlePendingPair({
      ok: false,
      error: `配对超时（${HANDSHAKE_TIMEOUT_MS / 1000}s 内未完成握手）`,
    });
  }, HANDSHAKE_TIMEOUT_MS);

  try {
    // 配对必须发生在握手态：就绪态里发 pair 会被宿主按协议违规断开，
    // 故先复位既有连接（旧 socket 事件因代际推进而全部作废），再建连。
    resetConnection(1000, 're-pair');
    connect();

    const outcome = await settled;
    if (outcome.ok) broadcastState('ready');
    return outcome;
  } finally {
    clearTimeout(timeout);
    state.pendingTicket = null;
    state.pendingPairSettle = null;
  }
}

/** 解除配对：清 key、复位连接（代际作废，不触发重连）。 */
async function unpair() {
  state.key = null;
  state.reconnectAttempt = 0;
  await chrome.storage.local.remove(STORAGE_KEYS.key);
  resetConnection(1000, 'unpaired'); // 正常关闭码 + 无 key → 不会自动重连
  broadcastState('disconnected');
}

function settlePendingPair(outcome) {
  if (state.pendingPairSettle === null) return;
  const settle = state.pendingPairSettle;
  state.pendingPairSettle = null;
  settle(outcome);
}

// ---------------------------------------------------------------------------
// 渲染管线：render-req → 开后台标签页 → 等 complete（带兜底）→ 注入抽取 → 回包
// ---------------------------------------------------------------------------

async function handleRenderRequest(frame) {
  const ws = state.ws;
  if (!isRenderRequest(frame)) {
    replyRender(ws, createRenderFailure(Number(frame?.id ?? -1), 'malformed render-req'));
    return;
  }
  const reqId = frame.id;
  try {
    const extracted = await renderViaTab(frame.url, clampLoadTimeout(frame.timeoutMs));
    const content = truncateContent(`${extracted.title}\n\n${extracted.html}`, MAX_CONTENT_BYTES);
    replyRender(ws, createRenderSuccess(reqId, content, 200));
  } catch (error) {
    replyRender(
      ws,
      createRenderFailure(reqId, error instanceof Error ? error.message : String(error)),
    );
  }
}

/**
 * 单次渲染。加载预算 = clampLoadTimeout(timeoutMs)（timeoutMs*0.8，剩余留给
 * 抽取与回传）；到点未 complete 也继续注入——半页 DOM 好过空手而归，
 * 总时长最终由宿主侧 timeoutMs 兜底结算。
 */
async function renderViaTab(url, loadBudgetMs) {
  const tab = await chrome.tabs.create({ active: false, url });
  const tabId = tab.id;
  try {
    if (typeof tabId !== 'number') throw new Error('tabs.create 未返回 tabId');
    await waitForTabComplete(tabId, loadBudgetMs);

    const injection = await chrome.scripting.executeScript({
      target: { tabId },
      // W-A-18 反制：func 必须自包含（executeScript 会序列化 toString 后在页内
      // 重建，闭包引用模块常量会断裂）。抽取规则经 args 传入、页内 new Function
      // 执行；规则本体是 logic.js 的 EXTRACT_RULE_SOURCE 字符串。
      func: injectedExtractor,
      args: [EXTRACT_RULE_SOURCE, MAX_CONTENT_BYTES],
    });
    const result = injection[0]?.result;
    if (
      result === undefined ||
      result === null ||
      typeof result.title !== 'string' ||
      typeof result.html !== 'string'
    ) {
      throw new Error('页面抽取结果缺失或形状非法');
    }
    return result;
  } finally {
    if (typeof tabId === 'number') {
      try {
        await chrome.tabs.remove(tabId);
      } catch {
        // 用户手动关掉等场景：标签页已不存在，无需补救。
      }
    }
  }
}

/** 等待标签页 complete；tab 被关闭则失败；到点未 complete 兜底放行注入。 */
function waitForTabComplete(tabId, budgetMs) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (settleError) => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      clearTimeout(timer);
      if (settleError === undefined) resolve();
      else reject(settleError);
    };
    const onUpdated = (changedTabId, changeInfo) => {
      if (changedTabId === tabId && changeInfo.status === 'complete') finish(undefined);
    };
    const onRemoved = (removedTabId) => {
      if (removedTabId === tabId) finish(new Error('标签页在加载完成前被关闭'));
    };
    const timer = setTimeout(() => finish(undefined), Math.max(1, budgetMs)); // 兜底：照常注入

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    // 竞态补偿：create 到监听之间可能已 complete（缓存页等）。
    void chrome.tabs.get(tabId).then((fresh) => {
      if (fresh.status === 'complete') finish(undefined);
    }).catch(() => finish(new Error('标签页不可访问')));
  });
}

/**
 * 页面上下文内执行的抽取器（自包含，禁止引用外部作用域——见 renderViaTab 注释）。
 */
function injectedExtractor(ruleSource, maxBytes) {
  const extract = new Function('document', 'maxBytes', ruleSource);
  return extract(document, maxBytes);
}

// ---------------------------------------------------------------------------
// 出站与状态广播
// ---------------------------------------------------------------------------

function replyRender(ws, frame) {
  if (ws !== null && ws === state.ws && ws.readyState === WebSocket.OPEN) sendJson(ws, frame);
}

function sendJson(ws, payload) {
  try {
    ws.send(JSON.stringify(payload));
  } catch {
    // 死亡 socket 上 send 同步抛错；close 事件会接管后续。
  }
}

/** popup 打开期间推送状态变化；popup 已关闭时 sendMessage 会 reject，吞掉即可。 */
function broadcastState(phase) {
  notifyPopup(phase);
}

function notifyPopup(phase = '') {
  chrome.runtime.sendMessage(buildStatePayload(phase)).catch(() => {});
}

function buildStatePayload(phase) {
  return {
    type: 'bridge-state',
    phase,
    paired: state.key !== null,
    connected: state.ready,
    connecting: state.ws !== null && !state.ready,
    port: state.port,
  };
}

// ---------------------------------------------------------------------------
// popup 消息面
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  void (async () => {
    switch (message?.type) {
      case 'get-state':
        sendResponse(buildStatePayload(''));
        break;
      case 'pair':
        sendResponse(await startPairing(message.ticket));
        break;
      case 'unpair':
        await unpair();
        sendResponse({ ok: true });
        break;
      case 'set-port': {
        const port = Number(message.port);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          sendResponse({ ok: false, error: '端口必须是 1–65535 的整数' });
          break;
        }
        state.port = port;
        await chrome.storage.local.set({ [STORAGE_KEYS.port]: port });
        notifyPopup('');
        sendResponse({ ok: true });
        break;
      }
      default:
        sendResponse({ ok: false, error: '未知消息类型' });
        break;
    }
  })();
  return true; // 异步 sendResponse
});
