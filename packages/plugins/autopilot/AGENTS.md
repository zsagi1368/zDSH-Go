# AGENTS.md — zdsh-autopilot 开发纪律（人与代理共用）

> 本仓库是 **zDSH AutoPilot** 独立插件：DeepSeek Harness 的统一自动化引擎（断线续跑 / 沙箱优先权限守卫 / 二模型审批复核）。规划全文见 `../plan/00-overview.md`（研究根目录），本文件只放"动手前必须知道"的纪律。

## 净室红线（不可协商）

1. **零第三方插件代码**：本插件为全新原创实现，严禁依赖、引用或复制任何第三方 DSH 插件包的代码。以下标识符禁止出现在 `src/ tests/ eval/ corpus/ scripts/ bin/` 的任何文件中（`scripts/check-boundaries.mjs` 会扫描并在 CI 拦截）：
   - `dsh-client-auto-continue`、`dsh-auto-review`、`dsh-auto-mode`、`@nanmicoder`
2. 本插件不依赖任何第三方 DSH 插件包；对宿主 API 的调用方式属于宿主接口本身，与任何第三方插件无关。
3. 对宿主接缝的每一个行为假设，必须在 `src/kernel/probes.ts` 的 ASSUMPTIONS 清单登记（注释：假设内容 + 证据来源 + 对应回归测试名），并配能力探测降级路径。

## 架构边界（CI 强制）

- `kernel/` 是唯一共享层；`continue/ guard/ review/` 只准 import `../kernel/*` 与自身目录；模块之间横向 import 一律禁止；`console/` 只准 import `../kernel/*` 与自身。组合只在 `src/index.ts` 发生。
- 客户端半身（`src/client/**`）不得值导入宿主 Node 包；跨面类型走纯类型出口。

## 本机环境怪癖（Windows 开发机）

1. shell 里含 `&` 的路径必须加引号（工作区在 `PluginR&D` 下）。
2. grep 是 ugrep 有静默漏匹配怪癖：**优先 `git grep -n`**。
3. Mimosa 钩子会拦截 bash 中出现源文件路径作为写入目标的命令——**一律用 Write/Edit 工具创建与修改文件**，不要用 heredoc/cp/sed。
4. 跨目录复制用绝对路径；shell cwd 可能被重置，别依赖相对路径。
5. SSH push 会挂起：push 走 https origin + gh 凭据助手（GH_TOKEN 来自仓库外的 .agent-env，**绝不入库**）。

## 门禁（每个里程碑出口全绿才算完成）

```bash
pnpm lint        # 边界检查 + oxlint
pnpm typecheck   # host / client / tests 三个 tsconfig 全过
pnpm test        # vitest
pnpm build       # tsc(host→lib) + tsdown(client→dist 经典脚本壳)
pnpm eval        # 行为契约评测（离线替身，无需真实 API key）
```

测试分层约定：纯函数单测 → 真实 Cordis Loader 组合测试 → 无头产物契约（假 ctx 直接 import 打包物）→ 平台业务流（如实标注覆盖度）。测试放 `tests/*.spec.ts`；评测用例放 `eval/cases/*.yaml`。

## 提交纪律

- 实施代理**不自行 commit**——完工后报告门禁证据，由主控统一提交（保持提交叙事干净）。
- 主控提交用 conventional commits（feat/fix/test/docs/chore），body 可中文，需写明里程碑号。
- 版本钉子：宿主包 devDeps 钉 `0.1.1-rc.2`（与 zDSH 分支基线一致）；peer 用 `>=0.1.0-rc.2 <0.2.0` optional。npm dist-tag `latest` 滞后是已知现象，勿据此改钉子。

## i18n

zh 词典是键集事实来源；en 用 satisfies 全键校验。机器可读文本（审计 marker 等）不走词典，保持可解析性。
