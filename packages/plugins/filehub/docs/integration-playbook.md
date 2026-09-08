# FileHub 集成 playbook（形态一：内核核心插件适配指南）

> 冻结区说明：本文件登记**必须等待宿主集成期才能闭环**的 seam。
> M6 加固轮已把"可在 standalone 形态内闭环"的条目全部修掉（见文末收敛记录）；
> 剩余每一条都依赖宿主暴露尚未存在的服务面，在分支集成（M7 通电）时按下表逐行执行。

## 一、Seam 总表

| # | Seam 位置 | 等待条件 | 集成动作 | 验收方式 |
|---|---|---|---|---|
| 1 | `src/index.ts`（`VisionDomainConfig.nativeRoute` 注释）+ `src/server/vision.ts`（`createImageCapableGate`） | 宿主向插件暴露"当前会话实际路由的 provider/model"查询面（apiproxy 内部选路目前对插件不可见） | 删除 config 传入的 `nativeRoute`，改为在 `createFileHubDomain` 内从宿主会话上下文解析 `{provider, model}` 并注入 `createImageCapableGate({ llm, nativeRoute: <live route> })` | FR-D5 用例：注册 image 模态路由后上传图片，断言零外呼、响应无 `imageCaption`、日志无 waterfall warn |
| 2 | `src/index.ts`（`createFileHubDomain` 尾注 TODO(integration)） | Loader 明确插件可注册 effect/disposer 的契约（`ctx.effect(...)` 语义冻结） | 把 `webServer.register` 返回的 disposer 与 `lifecycle.start` 的定时器包进 `ctx.effect(...)`；保留返回 handle 兼容 standalone 调用方 | dispose/rebuild 循环测试（现有 `keeps serving uploads end-to-end after a dispose/rebuild cycle`）改走宿主 effect 后依旧绿；进程退出无泄漏句柄告警 |
| 3 | `src/server/meta.ts` 头注（KV backend 选择策略） | 宿主组合定型：确认 dsh-storage 多后端环境下哪个 backend 名承载 KvFacet | 若宿主给出权威 backend 名，把 `pickKvFacet` 的"首个带 .kv 的后端"改为按名精确选取；否则维持现状并删除本 TODO | KV 元数据跨进程重启存活（控制台列表、配额计数不回退）；内存回退路径警告仅在真无 facet 时出现 |
| 4 | `src/server/workspace.ts` 头注（无 cwd 会话 403） | 宿主确认是否保证每个 session.header.cwd 非空（或提供默认 cwd 服务） | 若保证：`toWorkspace` 对空 cwd 回退到宿主默认 cwd，而不是返回 undefined → HTTP 403 | 无 cwd 会话上传不再 403 且落盘于默认工作区；沙箱断言（isStrictlyInside）对新根依旧生效 |
| 5 | `src/client/mention/picker.tsx` 头注（MOUNT SEAM） | 宿主提供 caret 级触发观察或 overlay 挂载钩子（ui-input-trigger ArbitrateKey 现无 ArrowRight 位） | 在宿主 overlay 钩子或设置面板预览位挂载完整 picker 组件；composer 键盘面继续走宿主原生菜单 | FR-B7 全套键盘导航（ArrowRight 进目录等）在真机 composer 生效；与原生菜单共存不双弹 |
| 6 | 四个白名单接线点：`tsconfig.host.json` +1 行、`tsconfig.client.json` +1 行、web-app `cordis.patch.yml` insert 行、`pnpm-lock.yaml` workspace importer | 分支集成窗口开启（用户明确指令，且与其他扩展的接线点改动串行合并） | 执行四文件改动；bundle 行 id 固定 `filehub` | 分支部署全新 profile：上传/@ 提及/AI 读文档/控制台四链路免配置可用；diff-baseline 门绿 |

## 二、集成期红线

1. **权威源唯一**：集成以本仓库为事实来源，禁止在分发分支里手改后反向拷贝（避免双仓静默发散）。
2. **接线点 ≤4**：除上表第 5 行四个白名单文件外，任何 upstream 文件零改动；CI diff-baseline 门持续把关。
3. **Typert 两铁律**：远程服务手写 `ctx.typert.register` manifest；客户端用 `ctx.reflect.get('remote.<ns>')` 解析。M7 演练时若启用 Typert 面，按此执行。
4. **来源隔离红线**：任何非本仓库的代码永不进入构建树；依赖黑名单守卫持续运行。

## 三、M6 收敛记录（2026-08-24 加固轮）

本轮清点 `TODO(integration)/TODO(M*)/校正点` 共 7 条：

- **standalone 内闭环 1 条**：
  - `src/server/mention.ts` 的 `TODO(M5 consolidation)` —— `SearchResultSchema`
    已迁入 `src/contract.ts`（wire 契约单一来源），mention.ts 保留 re-export 兼容。
- **转集成 playbook 6 条**：上表第 1–6 行（vision nativeRoute 在 index.ts 与
  vision.ts 两处注释属同一 seam 的两个锚点，合并登记为一行；picker MOUNT SEAM
  经复核属宿主 overlay 钩子依赖，如实归入集成期）。
- 此后源码中不再存在未登记的 `TODO(integration)` / `校正点` 标记。
