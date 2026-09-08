/**
 * 扩展侧纯逻辑测试（extension/logic.js，经 logic.d.ts 类型面直连）：
 * 退避序列、重连裁决、帧构造与 ACK id 回显、入站帧解析防线、加载预算换算、
 * UTF-8 截断（含注入规则串 parity）、以及**扩展镜像常量 ↔ 宿主 protocol.ts**
 * 的一致性快照——W-A-18「两侧同步」的数据化缓解本体。全离线，无 chrome.*。
 */
import { describe, expect, it } from 'vitest'
import * as ext from '../extension/logic.js'
import {
  CLOSE_AUTH_FAILED as HOST_CLOSE_AUTH_FAILED,
  CLOSE_PAIR_REJECTED as HOST_CLOSE_PAIR_REJECTED,
  CLOSE_PROTOCOL_VIOLATION as HOST_CLOSE_PROTOCOL_VIOLATION,
  DEFAULT_HEARTBEAT_INTERVAL_MS as HOST_HEARTBEAT_MS,
  DEFAULT_PONG_TIMEOUT_MS as HOST_PONG_MS,
  BRIDGE_PROTOCOL as HOST_PROTOCOL,
  DEFAULT_TICKET_TTL_MS as HOST_TICKET_TTL_MS,
} from '../src/protocol.ts'

const {
  BRIDGE_PROTOCOL,
  CLOSE_AUTH_FAILED,
  CLOSE_PAIR_REJECTED,
  CLOSE_PROTOCOL_VIOLATION,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_PONG_TIMEOUT_MS,
  DEFAULT_TICKET_TTL_MS,
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
  runExtractRule,
  shouldReconnect,
  truncateContent,
  utf8ByteLength,
} = ext

// ---------------------------------------------------------------------------
// 退避与重连裁决
// ---------------------------------------------------------------------------

describe('断线退避与重连裁决', () => {
  it('指数退避序列固定为 1s/2s/4s/…/32s（attempt 0..5）', () => {
    expect([0, 1, 2, 3, 4, 5].map(attempt => computeBackoffMs(attempt))).toEqual([
      1000, 2000, 4000, 8000, 16000, 32000,
    ])
  })

  it('退避封顶 60s；支持自定义 base/max', () => {
    expect(computeBackoffMs(6)).toBe(60_000)
    expect(computeBackoffMs(7)).toBe(60_000)
    expect(computeBackoffMs(40)).toBe(60_000)
    expect(computeBackoffMs(3, 250, 1500)).toBe(1500)
    expect(computeBackoffMs(1, 250, 1500)).toBe(500)
  })

  it('重连裁决：致命关闭码不重连；未配对绝不自动重连；其余关闭码且有 key 才重连', () => {
    for (const fatal of [CLOSE_PAIR_REJECTED, CLOSE_PROTOCOL_VIOLATION, CLOSE_AUTH_FAILED]) {
      expect(shouldReconnect(fatal, true)).toBe(false) // 配置/凭据问题须人工介入
      expect(shouldReconnect(fatal, false)).toBe(false)
    }
    expect(shouldReconnect(1006, false)).toBe(false) // 未配对：撞握手闸没有意义
    expect(shouldReconnect(1006, true)).toBe(true)
    expect(shouldReconnect(1000, true)).toBe(true)
    expect(shouldReconnect(3000, true)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 出站帧构造与 ACK id 回显
// ---------------------------------------------------------------------------

describe('出站帧构造与 ACK id 回显', () => {
  it('pair/auth 请求帧全形状精确（类型、单调整数 id、凭据字段名）', () => {
    expect(createPairRequest(1, 'ticket-abc')).toEqual({
      type: 'pair',
      id: 1,
      ticket: 'ticket-abc',
    })
    expect(createAuthRequest(2, 'key-xyz')).toEqual({ type: 'auth', id: 2, key: 'key-xyz' })
  })

  it('render-res 成功帧严格回显宿主分配的 id（含非零大起点），statusCode 缺省 200', () => {
    expect(createRenderSuccess(987_654, '正文')).toEqual({
      type: 'render-res',
      id: 987_654,
      ok: true,
      content: '正文',
      statusCode: 200,
    })
    expect(createRenderSuccess(7, 'c', 203).statusCode).toBe(203)
  })

  it('render-res 失败帧：ok=false + error 增量字段，不带 content/statusCode 键', () => {
    const frame = createRenderFailure(42, '标签页在加载完成前被关闭')
    expect(frame).toEqual({
      type: 'render-res',
      id: 42,
      ok: false,
      error: '标签页在加载完成前被关闭',
    })
    expect('content' in frame).toBe(false)
    expect('statusCode' in frame).toBe(false)
  })

  it('客户端→宿主请求 id 分配器单调递增且从 1 起', () => {
    const allocate = createRequestIdAllocator()
    const ids = [allocate(), allocate(), allocate()]
    expect(ids).toEqual([1, 2, 3])
    expect(createRequestIdAllocator(10)()).toBe(10)
  })

  it('消息形状快照：四类出站帧的线格式冻结（字段集与取值词汇漂移即红）', () => {
    expect([
      createPairRequest(1, 'one-time-ticket'),
      createAuthRequest(2, 'long-term-key'),
      createRenderSuccess(3, 'extracted content', 200),
      createRenderFailure(4, 'boom'),
    ]).toMatchSnapshot()
  })
})

// ---------------------------------------------------------------------------
// 入站帧解析防线
// ---------------------------------------------------------------------------

describe('入站帧解析防线（parseFrame/isRenderRequest）', () => {
  it('合法 render-req 解析往返：ok=true 且 id/url/timeoutMs 无损', () => {
    const raw = JSON.stringify({
      type: 'render-req',
      id: 12,
      url: 'https://x.example/',
      timeoutMs: 8000,
    })
    const parsed = parseFrame(raw)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.frame.type).toBe('render-req')
    expect(parsed.frame.id).toBe(12)
    expect(parsed.frame.url).toBe('https://x.example/')
    expect(parsed.frame.timeoutMs).toBe(8000)
  })

  it('非 JSON / 标量 / 数组一律拒绝，reason 与宿主关闭理由词表对齐', () => {
    expect(parseFrame('{not json')).toEqual({ ok: false, reason: 'non-json-frame' })
    expect(parseFrame('42')).toEqual({ ok: false, reason: 'non-object-frame' })
    expect(parseFrame('"hello"')).toEqual({ ok: false, reason: 'non-object-frame' })
    expect(parseFrame('[{"id":1}]')).toEqual({ ok: false, reason: 'non-object-frame' })
  })

  it('缺失或非整数 id 拒绝（missing-ack-id）：ACK 纪律的客户端侧镜像', () => {
    expect(parseFrame('{"type":"auth-ok"}')).toEqual({ ok: false, reason: 'missing-ack-id' })
    expect(parseFrame('{"type":"auth-ok","id":1.5}')).toEqual({
      ok: false,
      reason: 'missing-ack-id',
    })
    expect(parseFrame('{"type":"auth-ok","id":"7"}')).toEqual({
      ok: false,
      reason: 'missing-ack-id',
    })
  })

  it('isRenderRequest 接受矩阵：形状齐备才受理', () => {
    expect(
      isRenderRequest({ type: 'render-req', id: 1, url: 'https://a.example/', timeoutMs: 500 }),
    ).toBe(true)
  })

  it('isRenderRequest 拒绝矩阵：错类型/缺 url/空 url/非法 timeout 一律 false', () => {
    const good = { type: 'render-req', id: 1, url: 'https://a.example/', timeoutMs: 500 }
    expect(isRenderRequest({ ...good, type: 'ping' })).toBe(false)
    expect(isRenderRequest({ ...good, url: undefined })).toBe(false)
    expect(isRenderRequest({ ...good, url: '' })).toBe(false)
    expect(isRenderRequest({ ...good, timeoutMs: 0 })).toBe(false)
    expect(isRenderRequest({ ...good, timeoutMs: -1 })).toBe(false)
    expect(isRenderRequest({ ...good, timeoutMs: 1.5 })).toBe(false)
    expect(isRenderRequest(null)).toBe(false)
    expect(isRenderRequest([good])).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 加载预算与 UTF-8 截断
// ---------------------------------------------------------------------------

describe('加载预算换算与 UTF-8 截断', () => {
  it('clampLoadTimeout：timeoutMs×0.8 向下取整，支持覆写比例，退化输入保底 1ms', () => {
    expect(clampLoadTimeout(5000)).toBe(4000)
    expect(clampLoadTimeout(999)).toBe(799)
    expect(clampLoadTimeout(5000, 0.5)).toBe(2500)
    expect(clampLoadTimeout(0)).toBe(1)
    expect(clampLoadTimeout(-8000)).toBe(1)
  })

  it('truncateContent：预算内原样返回；默认上限为 2MB', () => {
    const short = '短文本 short text 🦊'
    expect(truncateContent(short)).toBe(short)
    expect(MAX_CONTENT_BYTES).toBe(2 * 1024 * 1024)
  })

  it('超限截断产出 ≤ 上限的完整前缀（不劈开代理对，绝不超预算）', () => {
    const text = `${'ab'.repeat(50)}汉字${'🦊'.repeat(5)}tail`
    const cap = 100
    const cut = truncateContent(text, cap)
    expect(utf8ByteLength(cut)).toBeLessThanOrEqual(cap)
    expect(cut.length).toBeLessThan(text.length)
    expect(text.startsWith(cut)).toBe(true)
    const tailCode = cut.charCodeAt(cut.length - 1)
    expect(tailCode < 0xd800 || tailCode > 0xdbff).toBe(true) // 边界不落在高代理上
  })

  it('注入规则串 parity：EXTRACT_RULE_SOURCE 内嵌截断与 truncateContent 输出一致（审查点锁死）', () => {
    const mixedHtml = `<html><body>${'中文内容 '.repeat(30)}${'🦊'.repeat(10)}</body></html>`
    const doc = {
      title: 'parity',
      documentElement: { outerHTML: mixedHtml },
    }
    const extracted = runExtractRule(EXTRACT_RULE_SOURCE, doc, 120)
    expect(extracted.html).toBe(truncateContent(mixedHtml, 120))
    expect(utf8ByteLength(extracted.html)).toBeLessThanOrEqual(120)
  })

  it('抽取规则执行：产出 title/html；documentElement 抛错时降级空串而非炸管道', () => {
    const doc = {
      title: '示例标题',
      documentElement: { outerHTML: '<html><body>x</body></html>' },
    }
    expect(runExtractRule(EXTRACT_RULE_SOURCE, doc, MAX_CONTENT_BYTES)).toEqual({
      title: '示例标题',
      html: '<html><body>x</body></html>',
    })
    const exploding = {
      title: 't',
      get documentElement(): never {
        throw new Error('cross-origin skeleton')
      },
    }
    expect(runExtractRule(EXTRACT_RULE_SOURCE, exploding, 1024)).toEqual({ title: 't', html: '' })
  })
})

// ---------------------------------------------------------------------------
// 与宿主 protocol.ts 的常量一致性（W-A-18 数据化缓解）
// ---------------------------------------------------------------------------

describe('shared-protocol.js 镜像 ↔ 宿主 protocol.ts 一致性', () => {
  it('协议名与全部时间常量逐字相等（改协议须两侧同步，漂移即红）', () => {
    expect(BRIDGE_PROTOCOL).toBe(HOST_PROTOCOL)
    expect(BRIDGE_PROTOCOL).toBe('webstack-bridge/1')
    expect(DEFAULT_TICKET_TTL_MS).toBe(HOST_TICKET_TTL_MS)
    expect(DEFAULT_TICKET_TTL_MS).toBe(60_000)
    expect(DEFAULT_HEARTBEAT_INTERVAL_MS).toBe(HOST_HEARTBEAT_MS)
    expect(DEFAULT_HEARTBEAT_INTERVAL_MS).toBe(20_000)
    expect(DEFAULT_PONG_TIMEOUT_MS).toBe(HOST_PONG_MS)
    expect(DEFAULT_PONG_TIMEOUT_MS).toBe(60_000)
  })

  it('关闭码闭集逐字相等：4001/4002/4003', () => {
    expect(CLOSE_PAIR_REJECTED).toBe(HOST_CLOSE_PAIR_REJECTED)
    expect(CLOSE_PAIR_REJECTED).toBe(4001)
    expect(CLOSE_PROTOCOL_VIOLATION).toBe(HOST_CLOSE_PROTOCOL_VIOLATION)
    expect(CLOSE_PROTOCOL_VIOLATION).toBe(4002)
    expect(CLOSE_AUTH_FAILED).toBe(HOST_CLOSE_AUTH_FAILED)
    expect(CLOSE_AUTH_FAILED).toBe(4003)
  })

  it('协议常量面整体快照（新增常量未同步镜像时此快照先红）', () => {
    expect({
      BRIDGE_PROTOCOL,
      DEFAULT_TICKET_TTL_MS,
      DEFAULT_HEARTBEAT_INTERVAL_MS,
      DEFAULT_PONG_TIMEOUT_MS,
      CLOSE_PAIR_REJECTED,
      CLOSE_PROTOCOL_VIOLATION,
      CLOSE_AUTH_FAILED,
    }).toMatchSnapshot()
  })
})
