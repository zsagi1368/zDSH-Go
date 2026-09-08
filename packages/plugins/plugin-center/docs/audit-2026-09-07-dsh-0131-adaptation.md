# 审计：zdsh-plugin-center 对 dsh 0.1.3 的适配结论（Tier 0）

- 日期：2026-09-07
- 任务卡：zDSH-docs/Plan/campaigns/2026-09-07-plugins-0131-adaptation/tasks/R2-plugin-center.md
- 仓库/分支：zDSH-plugins/PluginCenter @ main（基线提交 19ff7b0）
- 结论：**本仓零 dsh 版本钉，0.1.3 适配 N/A**（仅 cordis peer `>=4`，兼容 4.0.2）。未改任何代码或版本号。

## 1. 审计证据（grep）

编译期依赖检查（src/ 与 tests/ 全量）：

```
$ grep -rn "@deepseek-ai" src/    → 无匹配（exit 1）
$ grep -rn "@deepseek-ai" tests/  → 无匹配（exit 1）
```

全仓 `@deepseek-ai/dsh-*` 引用面（排除 node_modules/lib/del/pnpm-lock）仅 1 处：

```
package.json:35  "@deepseek-ai/dsh-client-ui-settings"
```

该处位于 `dsh.client.inject` 数组——是构建期由 dsh 打包器消费的**运行时注入声明**，
无版本号、非 npm dependencies/peerDependencies，不构成编译期依赖或版本钉。
（2026-09-03 已移除停发的 dsh-client-runtime inject，见 del/20260903-165139-alpha4-adapt。）

pnpm-lock.yaml 中 `@deepseek-ai/*` 仅 cordis 4.0.1 及其依赖 cosmokit（dev 解析产物），
无任何 `@deepseek-ai/dsh-*` 包。

版本钉检查：peerDependencies 为 `@deepseek-ai/cordis: ">=4"`（optional）与 `react: ">=18"`（optional）。
`>=4` 为开区间，接受 cordis 4.0.2，无需 bump。

## 2. 回归结果（全绿）

环境：node v24.19.0 / pnpm 11.25.0 / Git Bash。

| 命令 | 结果 |
| --- | --- |
| `pnpm run lint`（tsc --noEmit） | exit 0，零错误 |
| `pnpm run build`（tsdown） | exit 0，Build complete；仅既有 WARN（ESM 建议、INEFFECTIVE_DYNAMIC_IMPORT），非错误 |
| `pnpm run test`（vitest run） | exit 0，**Test Files 11 passed (11) / Tests 101 passed (101)**，Duration 1.46s |

build 重写 lib/ 后 `git status --porcelain` 为空——产物与 HEAD 逐字节一致，零 diff。

## 3. 范围声明

- 本审计仅覆盖 0.1.3 适配问题；build 输出中的两条既有 WARN 与 `dsh.client.inject`
  中 ui-settings 声明的后续去留，均属本任务范围之外，如需处理应另开任务卡。
- 改动面：仅本文件（新增）；备份区 del/20260907-120741-0131-adapt/RESTORE.md。
