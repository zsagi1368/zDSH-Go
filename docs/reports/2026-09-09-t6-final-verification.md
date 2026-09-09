# T6-③④ 修复后终验报告（tester 独立终验）

- 日期：2026-09-09
- 执行者：tester（独立复验，不采信 coder 自证）
- 被验对象：P0 `448e7e722b`（omnivision 挂载崩溃）、P1 `0d00f6cb62`（workbench API/SPA 路由）、P1b `cf5b949894`（plugin-center 路由注册）、P2 `518ebbe30b`（guard 定位）修复后的 zDSH-go 分支
- 首轮报告：`docs/reports/2026-09-09-t5-t6-test-report.md`

## 1. 终验环境

| 项 | 值 |
| --- | --- |
| worktree | `G:\000Github\zDSH\zDSH-wt\zDSH-go`（分支 zDSH-go） |
| HEAD | `238e525c2b`（提交链完整：`407644f758`→`ad74de2247`→`35986cf89e`→`56b73fedf4`→`d87c48f87e`→`4d3a99d847`→`bac0e62967`→`448e7e722b`→`518ebbe30b`→`0d00f6cb62`→`cf5b949894`→`238e525c2b`，4 个修复 commit 全部在链上） |
| 工作树状态 | 干净（仅 `packages/plugins/omnivision/dist/` 未跟踪，为构建产物） |
| Node / pnpm | v24.19.0 / 11.7.0 |
| 隔离安装 | `data/env.sh` 实际位于仓库根 `env.sh`（install.ps1 写入根目录；`DSH_HOME=…/data`、`DSH_BRANCH_HOME=…/data/zdsh`、`DSH_AGENTS_HOME=…/data/agents`）。首轮已跑过 install.ps1，本次未重跑（避免重复改动，直接复用既有 env.sh） |
| 零风险备份 | web 启动前 `data/` + `env.sh` + `env.ps1` 已备份至 `del/20260909-125034-t6-final-verify-data-backup/`（61 个实体文件，含 RESTORE.md；node_modules 内 symlink 为仓库内部生成链接未备份，可自动重建） |
| 进程清理 | 测试 web 服务 PID 90056 已 taskkill，端口 4179 已确认释放 |

## 2. 门禁表（构建/安装）

| # | 项 | 结果 | Exit | 证据 |
| --- | --- | --- | --- | --- |
| 1 | `pnpm install --frozen-lockfile` | PASS | 0 | workspace 项目就绪（日志 /tmp/t6-install.log） |
| 2 | `pnpm build:lib:host` | PASS | 0 | tsc -b host + tsdown host face 全绿 |
| 3 | `pnpm build:lib:client` | PASS | 0 | ui-conversation/client 构建完成（4.96s） |
| 4 | `pnpm build:lib:plugins` | PASS | 0 | filehub/webstack/autopilot/omnivision 4 包构建完成 |

## 3. 真实启动 + 6 插件活体探针

启动方式：`source env.sh && node apps/cli/lib/bin.js web --no-open --port 4179`（真实启动，非 mock）。

### 3.1 启动与主面

| 项 | 结果 | 证据 |
| --- | --- | --- |
| 进程存活 30s+ | PASS | node.exe PID 90056（tasklist 确认），实际存活约 30 分钟直至手动清理 |
| 端口 LISTENING | PASS | `netstat -ano`：`TCP 127.0.0.1:4179 LISTENING 90056` |
| 日志无 `failed to apply` | PASS | `grep -ci "failed to apply"` = 0（全程日志仅 1 行启动横幅，无任何插件加载失败） |
| `GET /`（主 SPA 面） | PASS | token 换 cookie（303→200），带 cookie `GET /` = 200 |

### 3.2 6 插件探针表（全部带 cookie、`--noproxy '*'`）

| 插件 | 探针 | 结果 | 实测证据 |
| --- | --- | --- | --- |
| workbench | POST `/workbench/api/ping` | PASS 200 | `{"ok":true,"value":{"ok":true,"plugin":"@deepseek-ai/dsh-client-workbench","version":"0.1.3-alpha.1"}}`（envelope 形态正确） |
| workbench | GET `/workbench` | PASS 200 | HTML 26172 B，`text/html; charset=utf-8`，含 `<!doctype html` + `<title>DSH Local Build` |
| filehub | GET `/api/filehub/usage` | PASS 200 | `{"totalBytes":0,"files":0,"byKind":{...5 类},"bySession":[]}` |
| plugin-center | GET `/api2/zdsh-plugin-center/market` | PASS 200 | JSON 3754 B，`items` 数组 6 条（id 含 `sliverp/dsh-hub-plugin`、`AI-Scarlett/dsh-safe-plugin-manager` 等）。注记见 §6-① |
| plugin-center | GET `/api2/zdsh-plugin-center/runtime` | PASS 200 | `{"schemaVersion":1,"pluginName":"zdsh-plugin-center","bootId":"7cabf443-…","startedAt":"2026-09-09T04:53:46.564Z","restartMode":"self-guardian"}` |
| autopilot | dump-config insert 行 | PASS | `dsh --profile web --dump-config`（exit 0）第 537-538 行：`- id: autopilot / name: zdsh-autopilot`（含 modules: continue/guard/review enabled） |
| autopilot | lib 导入 + `apply` 导出 | PASS | `import('…/autopilot/lib/index.js')` OK，keys 含 `apply,inject,runtimeFor`，`typeof apply === 'function'`，exit 0 |
| webstack | dump-config insert 行 | PASS | 第 547-548 行：`- id: dsh-webstack / name: dsh-webstack` |
| webstack | lib 导入 + `WebstackAggregator` | PASS | keys 含 `WebstackAggregator,EngineRegistry,apply,…`，`typeof WebstackAggregator === 'function'`，exit 0 |
| omnivision | dump-config insert 行 | PASS | 第 549-550 行：`- id: dsh-omnivision / name: dsh-omnivision` |
| omnivision | lib 导入 + toolRegistry 工具存在 | PASS | `import('…/omnivision/dist/index.js')` OK，导出面含 `toolRegistry/listTools/apply/OmniVisionPlugin`；`listTools()` 返回 9 个工具：`vision_describe/ocr/detect/ground/bootstrap/crop/pixel_diff/trace/screenshot`（`toolRegistry.size=9`） |

P0/P1/P1b 结论：web 服务真实启动零 `failed to apply`，6 插件全部挂载（dump-config 6/6 insert 行）且 HTTP 面/导入面/工具面均活体可达。三项修复独立复验通过。

## 4. seed 闭环复验

- `packages/plugins/plugin-center/catalog/seed.json`：6 条 entries。
- 对照 `G:\000Github\zDSH\zDSH-plugins\PluginRegistry\catalog.json`：6 条 entries。
- 前 2 条比对：`MATCH_0_FULL=true`、`MATCH_1_FULL=true`（`sliverp/dsh-hub-plugin`、`AI-Scarlett/dsh-safe-plugin-manager` **整对象逐字节全等**，含 pinnedCommit）。

**PASS**：seed 闭环成立。

## 5. 安装隔离复验

| 项 | 结果 | 证据 |
| --- | --- | --- |
| `data/zdsh` 存在 | PASS | 含 `plugin-center/cache/catalog.json(+.sha256)`、`workbench/tasks.json` |
| env.sh 含 DSH_BRANCH_HOME=data/zdsh | PASS | `export DSH_BRANCH_HOME="G:/000Github/zDSH/zDSH-wt/zDSH-go/data/zdsh"` |
| 真实 $HOME 无泄漏 | PASS | `~/.dsh-zdsh-go` 不存在（`~/.dsh` 为用户既有主树，与本安装无关） |
| guard 定位（P2 修复复验） | PASS | 带 `DSH_HOME=…/data DSH_BRANCH_HOME=…/data/zdsh` 运行 `dsh-guard.mjs check --profile web`：日志显式打出 `DSH_HOME=G:\…\zDSH-go\data`、`profile=G:\…\data\profiles\web`，输出「体检通过：无偏差」，exit 0 —— 定位钉在本安装 data 面 |
| 哨兵双向对照 | 引用首轮 | T6 首轮已 PASS×2（哨兵目录双向），见 `docs/reports/2026-09-09-t5-t6-test-report.md` 第 41 行，本次按任务卡不重跑 |

## 6. 全量 vitest

| 项 | 值 |
| --- | --- |
| 命令 | `pnpm test`（全量 `vitest run`，默认配置） |
| 总量 | Test Files 4 failed / 1136 passed / 4 skipped（1144）；Tests **12 failed** / 18185 passed / 76 skipped（18273） |
| 基线对照 | `del/20260908-190506-core-patches/evidence/.t1-baseline.log` 的基线 11 条全部重现，无一减少、无一变形：ui-settings-models apply ×9 + ui-theme corner-shape ×1 + ui-theme elevation ×1 |
| 基线外失败 | `packages/session/session-projection-cache/tests/fixtures.spec.ts > archived version recovery > opens v5-lineageless-doc.json…` ×1，错误为 `Test timed out in 5000ms` |
| 定性（按纪律复跑一次） | 单独复跑该文件：**7/7 PASS，exit 0**。定性为超时抖动（全量高负载——import 累计 450s、tests 累计 1168s——下 5s testTimeout 偏紧），与首轮 `client-build-environment` 冷缓存超时抖动同模式。本轮未再出现 client-build-environment 失败 |
| 判定 | **PASS（附条件）**：失败集合 = 基线 11 + 1 条复跑即过的超时抖动，无确定性新回归。新抖动点按 P2 记 backlog（建议：该 fixture 提高 testTimeout 或收敛 mktmp IO） |

## 7. 缺陷与注记汇总

| 级别 | 内容 | 处置 |
| --- | --- | --- |
| 注记（非缺陷） | 任务卡写 market「含 entries」，实测契约字段为 `items`（`MarketPage extends Page<CatalogEntry>`，`packages/plugins/plugin-center/src/shared/catalog.ts:217` paginate 返回 `{items,page,pageSize,…}`）。属卡面笔误，产品行为与源码契约一致 | 无需改码；后续任务卡措辞以源码契约为准 |
| P2 | `fixtures.spec.ts` 全量负载下 5000ms 超时抖动（复跑即过） | backlog：调 testTimeout 或优化 fixture；不阻断 |
| 继承 | 基线 11 条（ui-settings-models ×9、ui-theme ×2）维持首轮定性，不在本次修复范围 | 维持既有 backlog |

## 8. 结论

**PASS** —— P0/P1/P1b/P2 四项修复全部通过独立终验：构建 4/4 exit 0；真实启动零插件失败；6 插件挂载、HTTP、导入、工具四类活体探针全绿；seed 闭环全等；安装隔离与 guard 定位无泄漏；全量 vitest 无基线外确定性回归（1 条复跑即过的超时抖动已记 P2）。发布门无阻断项。

## 9. 证据路径

- 安装日志：`/tmp/t6-install.log`；构建日志：`/tmp/t6-b1.log`、`/tmp/t6-b2.log`、`/tmp/t6-b3.log`
- web 启动日志：`/tmp/t6-web.log`；dump-config：`/tmp/t6-dump.yaml`（537-550 行）
- vitest 全量：`/tmp/t6-vitest.log`；fixtures 复跑：`/tmp/t6-fixture-retry.log`
- 基线：`del/20260908-190506-core-patches/evidence/.t1-baseline.log`
- 零风险备份：`del/20260909-125034-t6-final-verify-data-backup/`（含 RESTORE.md；删除权归用户）
- 首轮报告（哨兵对照引用）：`docs/reports/2026-09-09-t5-t6-test-report.md`
