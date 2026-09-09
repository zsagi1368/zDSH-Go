# dsh-webstack-bridge

[English](README.md) | 中文

WebStack Bridge (网栈·桥) — 面向 [dsh-webstack](../webstack) 插件族的浏览器桥接卫星包（**宿主侧**）。

MV3 浏览器扩展借出真实浏览器会话充当渲染兜底（T3 层）：当页面需要 JS 渲染内容时，宿主经回环 WebSocket 下发 `render-req`，扩展现真实标签页完成渲染并回传抽取文本。**cookie 永不离开浏览器**——宿主进程只收到已提取的内容文本。

## 为什么 `ws` 是本包唯一的运行时依赖

Node（>=22）标准库自带 WebSocket **客户端**但没有 WebSocket **服务端**。桥接宿主必须接受扩展连接，服务端实现不可避免；`ws` 是零原生绑定的纯 JS 事实标准（monorepo 禁用原生模块）。因此它是本卫星包唯一运行时依赖——其余（`@deepseek-ai/cordis`、`dsh-webstack`）全部是由宿主提供的可选 peer。

## 配对流程（W-B-58）

```
host log            extension popup              storage
─────────           ───────────────              ───────
issueTicket()
  │ logger.info ──► user pastes ticket
  ▲                 {type:'pair',id,ticket} ──►
  │                 ◄── {type:'paired',id,key}
  │                        long-term key ──────► chrome.storage (extension side)
  └─ only sha256(key) retained on the host
```

1. 启动时插件在日志打印一次性 ticket：**60 秒**有效、单次消费。过期则重载插件/重启宿主换取新 ticket。
2. 扩展连到 `ws://127.0.0.1:<port>` 发送 `{type:'pair', id, ticket}`。服务端回 `{type:'paired', id, key}`。明文 key **只此一次**下发；宿主仅保留 `sha256(key)`（ticket 同样以哈希存储）。
3. 此后扩展每次重连以 `{type:'auth', id, key}` → `{type:'auth-ok', id}` 认证。长期 key 只存在于扩展存储。
4. 重新配对即轮换 key 哈希：旧 key 立即失效。

### 关闭码（无自动重连提示）

| code | 含义 | 处理 |
|------|---------|--------|
| 4001 | 配对被拒（ticket 缺失/过期/重放） | 换新 ticket |
| 4002 | 协议违规（坏 JSON、缺 ack id、未知帧） | 修复客户端 |
| 4003 | 认证失败（key 不符或尚未配对） | 重新配对 |

三者均为配置/凭据问题——客户端必须把错误呈现给用户，而不是循环重试。

### Origin 门

升级握手只接受 `chrome-extension://*` 来源**或缺失 Origin 头**：MV3 service worker 可能合法省略该头，而恶意网页总被浏览器强制携带自身来源并落入拒绝分支。不要求 `Sec-Fetch-*` 头。真正的访问控制是上面的配对协议，不是头检查。

## 心跳

服务端每 20s 发 ping，60s 内未收到 pong 即终止连接（执行粒度最多滞后一个 ping 周期）。半开 socket 因此不会悬挂在途渲染请求——挂起的渲染结算为 `undefined` 并触发 `onDisconnect`，内核可降级到 `site:` 搜索。

## 渲染契约（`SeamBridgeRuntime` 形状）

```ts
render(url: string, timeoutMs: number): Promise<{ content: string; statusCode: number } | undefined>
```

- `undefined` = 本次桥接不可用：无已配对连接、超时、对端回 `ok:false`、中途断连，或 **SSRF 门拒绝目标**。调用方降级；绝不抛错。
- 请求**串行**排队（浏览器标签页是稀缺资源）。
- 严格 ACK 纪律：每个请求携带单调递增整数 `id`，响应原样回显；迟到/错配的渲染响应直接忽略。
- SSRF：每个 URL 必须通过 dsh-webstack 的 `checkTarget`（门 G1+G2）。为避免深层路径 import，检查器在装配期注入（`deps.checkTarget` / `setTargetChecker`）；注入前渲染器 fail-closed，绝不派发请求。

## Cordis 装配

```ts
import * as bridge from 'dsh-webstack-bridge';
ctx.plugin(bridge, { enabled: true });
// ctx.bridge.render(url, timeoutMs) — named service `bridge`
```

`apply()` 启动回环服务器（`getPort()` 随机端口），提供命名服务，打印首个配对 ticket，并注册 disposal 使端口与全部 socket 随 fiber 释放。

## 模型体验

间接生效：桥接返回的页面抽取文本并入 dsh-webstack 搜索结果；由消费方 web 工具决定一切模型可见效果。

#### KV Cache 影响

无直接影响；桥接输出经宿主工具渲染后就是普通搜索结果内容。

## 已知限制与延期工作

- 渲染依赖已配对的 MV3 扩展；缺席时内核降级为 `site:` 搜索。
- 浏览器标签页是稀缺资源：渲染请求串行排队。
- 上游门只接受 `chrome-extension://*` 来源或缺省 Origin 头；其他扩展生态不在范围内。
