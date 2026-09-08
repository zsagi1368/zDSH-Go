# WebStack Bridge（浏览器扩展侧）

MV3 扩展，借**真实浏览器会话**为 `dsh-webstack-bridge` 宿主做渲染兜底：
宿主经回环 WebSocket 下发 `render-req`，扩展开后台标签页加载目标页、注入
抽取脚本取 `document.title + outerHTML`（截断至 2MB），以 `render-res`
回传。**cookie / localStorage 永不离开浏览器进程**——宿主只收到提取后的
文本。

纯 JS、零构建：本目录不进 pnpm 工作区，直接以「加载解压的扩展程序」方式
安装。可测决策逻辑集中在 `logic.js`（纯函数），由
`packages/bridge/tests/extension-logic.test.ts` 覆盖。

## 安装

1. 打开 `chrome://extensions`（Chromium 系浏览器均可）；
2. 右上角开启「开发者模式」；
3. 点「加载解压的扩展程序」，选择本目录（`packages/bridge/extension/`）；
4. 固定工具栏图标，点开即是配对面板。

## 配对步骤

1. 启动宿主侧桥接服务（`dsh-webstack-bridge` 装配层）。它在 **127.0.0.1**
   随机端口监听，并在日志里打印一次性 ticket（60 秒有效、单次消费）与端口号；
2. 从日志复制端口号填入面板「宿主端口」；
3. 从日志复制 ticket 粘贴进输入框，点「配对」；
4. 成功后长期 key 只此一次下发并保存于 `chrome.storage.local`；此后扩展
   断线自动重连时走 `auth(key)` 握手，无需再配对。

重新配对 = 先「解除配对」再走一遍上述流程（宿主侧新 key 即轮换，旧 key
立即失效）。

## 行为要点

- **心跳**：宿主每 20s 发协议层 ping，Chrome 自动回 pong；扩展另兼容应用
  层 `{type:'ping'}` → `{type:'pong', id}` 帧（协议词汇镜像见
  `shared-protocol.js`）。
- **断线重连**：指数退避 1s / 2s / 4s / … 封顶 60s；收到 4001/4002/4003
  （ticket 无效 / 协议违规 / key 不符）或尚未配对时**不**自动重连——这些是
  配置或凭据问题，须人工介入。
- **渲染管线**：`chrome.tabs.create({active:false})` 后台加载 → 等
  `status==='complete'`（预算为 `timeoutMs × 0.8`，到点未完成也照常注入，
  半页 DOM 好过超时空手；总时长由宿主兜底结算）→ 注入抽取器 → 用完即关
  标签页 → 回包严格回显 `render-req` 的 id。
- **抽取注入**（W-A-18 反制）：`chrome.scripting.executeScript` 的 `func`
  会被序列化后在页面重建，闭包引用模块变量会静默断裂。故抽取规则做成可
  序列化字符串 `logic.js#EXTRACT_RULE_SOURCE`，经 `args` 传入、页内
  `new Function` 执行；其内置截断算法与 `truncateContent` 的同构性由测试锁死。

## 权限说明（最小必要面）

| 权限 | 为什么需要 |
| --- | --- |
| `tabs` | 创建后台标签页承载渲染、监听 `onUpdated/onRemoved`、用完即 `tabs.remove` |
| `scripting` | 向目标页注入一次性抽取函数（title + outerHTML） |
| `storage` | 本机保存宿主端口与长期 key（`chrome.storage.local`，不上云不同步） |
| `host_permissions: <all_urls>` | 渲染兜底的目标 URL 由宿主搜索需求决定、无法枚举白名单；无它则任意非白名单站点注入即失败 |

## 隐私声明

- 浏览器会话中的 cookie、localStorage、登录态**只存在于浏览器进程**，扩展
  不读取、不转发、不落盘到宿主；宿主仅获得抽取后的正文文本。
- 内容只在内存中转：抽取结果随 `render-res` 发往 `ws://127.0.0.1:<port>`
  （仅本机回环），扩展自身不做任何持久化、遥测或第三方请求。
- 长期 key 与端口存于本机 `chrome.storage.local`；「解除配对」即删除 key。
