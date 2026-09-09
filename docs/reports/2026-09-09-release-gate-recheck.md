# 发布前全量门禁复验（战役 B · tester 独立验证）

- 日期：2026-09-09
- 执行者：tester（独立复验，不采信各卡自证）
- 仓库：`G:\000Github\zDSH\zDSH-wt\zDSH-go`（分支 `zDSH-go`）
- 复验基线：`238e525c2b..HEAD`，HEAD = `181c5489b7e2c4502b9c5e288c68d0f92100ca33`
- 工作树：复验开始时 `git status --porcelain` 无输出（干净）

## 1. 冲刺新增 commit 全名单（238e525c2b..HEAD，共 11 个）

| commit | 说明 |
| --- | --- |
| `181c5489b7` | fix(catalog): tolerate project-references mirror of cache/ledger event |
| `b710d13ca0` | fix(docs): satisfy the doc-quick gates for the vendored plugin set |
| `52f05e571e` | fix(docs): extend README gate registries for the vendored plugin set |
| `f56a2e4625` | fix(docs): point source doc references at paths that exist |
| `38dcb50a60` | chore: gitignore vendored omnivision/dist build artifacts |
| `cbd713cd33` | fix(omnivision): carry attachment-local ingest limits into web-app patch layer |
| `3cc0debaa9` | fix(tests): de-flake two load-sensitive script specs under full-suite load |
| `14698bc96a` | fix(lint): clear 16 upstream oxlint errors with real typed fixes |
| `ab896bdd0f` | fix(tests): de-flake session-projection-cache fixtures.spec under full-suite load |
| `ae9db826a3` | fix(ui): repair slot-UI registration and plugin-manager design-contract CSS |
| `ec149dfc3c` | test(report): T6 final verification after P0/P1/P1b fixes (tester) |

## 2. 门禁清单

| # | 检查项 | 命令 | 结果 | 关键输出 |
| --- | --- | --- | --- | --- |
| 1 | 冲刺 commit 全名单 + 工作树干净 | `git log/status` | PASS | 11 commits；porcelain 无输出 |
| 2 | 依赖安装 | `pnpm install --frozen-lockfile` | PASS (exit 0) | `Already up to date`，288 workspace projects；仅 linux 平台包 unsupported 警告（win32 预期，非错误） |
| 3 | 三构建 | `pnpm build:lib:host` / `build:lib:client` / `build:lib:plugins` | PASS (exit 0 ×3) | host 10562ms；client 5190ms；plugins `dist/index.js 58.77 kB` |
| 4 | 全量测试 | `pnpm test`（vitest run） | PASS (exit 0) | **18199 passed \| 76 skipped（18275）**，1140 文件 passed \| 4 skipped，0 failed，Duration 183.94s。skipped 已记录（含 `cordis-catalog-contract.spec` 28 skipped 等），无失败 |
| 5 | Lint | `pnpm run lint`（oxlint 全仓） | PASS (exit 0) | `Found 0 warnings and 0 errors.` 3258 files / 90 rules（A1 承诺兑现） |
| 6 | 文档门 | `pnpm run test:docs`（doc-quick） | PASS (exit 0) | `15 passed, 0 failed, 0 skipped in 17.43s`（A2' 承诺兑现） |
| 7 | 持久化 catalog | `gen-persistence-catalog` + `verify-persistence-catalog` | PASS (exit 0 ×2) | gen 后其管理文件（`docs/persistence-catalog.md`、`known-event-types.ts`）零 diff（幂等）；verify 输出 `are up to date`（P1c 承诺兑现） |
| 8 | 其余 catalog | cordis / client / config / tool / cordis-inspect 各 gen+verify | PASS (exit 0 ×10) | 5 组 gen 均无 drift（幂等），verify --check 全过；收尾工作树干净 |
| 9 | 真实启动冒烟 | `node apps/cli/lib/bin.js web --no-open --port 4181` | PASS | 进程存活 >22s；`127.0.0.1:4181 LISTENING`；日志 `failed to apply` 计数 0；三探针全 200（见 §3）；进程已 kill（bash PID 51273 / 监听 PID 13100，均 taskkill 确认，端口释放） |
| 10 | attachment-local 限额 | `node apps/cli/lib/bin.js --profile web --dump-config` | PASS (exit 0) | `maxImageBytes: 20971520`（=20MiB）、`maxImagePixels: 100000000`（=100MP）、`maxImageDimension: 10000`（=10000px），与 A2' 项 1 承诺一致（dump 输出第 64-69 行） |
| 11 | 报告落盘 | 本文件 + 单独 commit | PASS | commit `test(report): release gate recheck after zero-backlog sprint (tester)` |

## 3. 冒烟探针明细（端口 4181）

| 探针 | 请求 | 结果 | 响应摘录 |
| --- | --- | --- | --- |
| workbench | `POST /workbench/api/ping` | 200 | `{"ok":true,"value":{"ok":true,"plugin":"@deepseek-ai/dsh-client-workbench","version":"0.1.3-alpha.1"}}` |
| filehub | `GET /api/filehub/usage` | 200 | `{"totalBytes":0,"files":0,"byKind":{...5 类...},"bySession":[]}` |
| plugin-center | `GET /api2/zdsh-plugin-center/market` | 200 | `{"items":[{"id":"sliverp/dsh-hub-plugin",...}]}` |

环境：`source env.sh`（`DSH_HOME=…/data`、`DSH_BRANCH_HOME=…/data/zdsh`），隔离于仓库 data 面，未触碰真实 `$HOME`。

## 4. 复验过程中的记录与定性

### ① 首次冒烟失败 → 定性为环境构建步骤缺失（非产品缺陷，未计入门禁失败）

首次启动即失败退出：日志 2 处 `failed to apply`，根因为 `MissingClientBundleError: client bundle not found; run 'pnpm run build' before launch`（`packages/plugins/webstack/lib/client.js` ENOENT）。三个 `build:lib:*` 不产出 web profile 所需 client bundle，需先跑根 `pnpm run build`（`tsx scripts/build.ts`，exit 0，231 client artifacts）。补跑后冒烟全绿。产品在缺 artifact 时 fail-fast 且日志给出明确可执行指引，属预期行为；记录为发布前置条件备查（ops 启动 web profile 前须先 `pnpm run build`）。

### ② autopilot dist 漂移（P3，非阻断）

`build:lib:plugins` 后 `packages/plugins/autopilot/dist/client.cjs` 出现 1 行插入的 diff（构建产物非确定性）。已按零风险协议备份至 `del/20260909-tester-dist-drift/`（含 RESTORE.md）后 `git checkout` 还原，工作树恢复干净。后续全量 `pnpm run build` 未再产生 drift。建议后续评估将 `packages/plugins/autopilot/dist` 与 omnivision/dist 同样 gitignore（backlog，本任务范围外）。

### ③ 测试进程清理

冒烟进程：bash PID 51273、Windows 监听 PID 13100，均已 kill 并经 netstat 确认端口释放（仅余 TIME_WAIT）。残留 node 进程与本冒烟无关（无 4179/4181 监听）。

## 5. 结论

**发布门：PASS。**

12 项复验全部通过（0 failed 测试 / 0 warnings-errors lint / 15 15 docs / catalog 幂等 / 冒烟 3×200 / dump-config 限额达标）。无 P0/P1/P2 阻断项；1 条 P3 记录进 backlog（见 §4-②）。可进入发布流程。
