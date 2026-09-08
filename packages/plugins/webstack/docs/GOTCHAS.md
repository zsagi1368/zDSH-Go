# GOTCHAS — 实战坑清单

联调/构建过程中真实踩过并已解决的坑。新波次开工前先通读；解决方式若依赖
配置文件，以仓库当前内容为准。

## G1. cordis 未装载服务的属性访问会抛错，不是 undefined

cordis 的 Context 对「未 inject / 未装载」的服务属性，访问时**直接抛错**
（内部代理的 fail-fast 语义），而不是像普通对象那样返回 `undefined`。

- 后果：`typeof ctx.settings?.installSection === 'function'` 这类惯用探测会
  直接把 activate 炸掉。
- 解法：所有探测必须逐项 try/catch 兜底。归口在
  `src/kernel/capability.ts` 的 `peek()` 与 `src/index.ts` 的 `peekService()`——
  永不裸访问 ctx 上的可选服务。

## G2. 测试要 await 两层 fiber：先宿主 Runtime 再自身插件

用真实 cordis Context 写生命周期测试时：

```ts
const ctx = new Context();
await ctx.plugin(WebRuntime, {});          // ① 宿主 seam 运行时先装载
const fiber = ctx.plugin({ name, inject, Config, apply }, {});
await fiber;                               // ② 自身插件 fiber 也要 await
```

漏掉 ② 时 `apply` 内的异步注册（settings 节安装等）尚未完成，断言会随机
失败或读到空注册表。参见 tests/index-plugin.test.ts 的写法。

## G3. dsh-invariants 没有 stable 版可匹配 peer 区间

`@deepseek-ai/dsh-invariants` 只在 next tag 发布 rc 版本（如
`0.1.2-rc.1`），不存在能命中 `>=0.1.0-rc.2 <0.2.0` 区间的 stable 版。
因此它**只能放 devDependencies 并精确钉死版本号**（不带 `^`/`>=`），
不能进 peerDependencies——否则安装器永远解析失败。
其余平台包 devDeps 同理钉精确快照，保证类型断言对象确定。

## G4. tsdown 的 INEFFECTIVE_DYNAMIC_IMPORT 是无害警告

构建时 tsdown 会报
`INEFFECTIVE_DYNAMIC_IMPORT (warning)`，指向
`src/fetch/pipeline.ts` / `src/engines/engine.ts` 里对
`../safety/outbound.ts`、`../fetch/narrowing.ts` 的字面量 `await import()`。

- 原因：这些动态导入是并行开发期的「运行期探测接线」设计（模块缺失时抛
  统一 transport 错误而非构建失败）；tsdown 能静态分析字面量导入并把模块
  打进 bundle，于是提示「既然静态可见不如改 static import」。
- 处置：**保留动态导入不改**。运行期探测语义是刻意的（晚接线自愈 +
  缺导出统一错误码），警告不影响产物正确性，构建退出码为 0。

## G5. biome.json 是严格 JSON：注释会炸掉整个配置

曾有人在 biome.json 里写 `// 说明` 注释（JSONC 习惯）。本仓库锁定的
biome 2.5.x 把 biome.json 按**严格 JSON**解析：一条注释即触发 parse 错误，
且后果是**整个配置文件被丢弃回退默认值**——表现为全库按双引号默认风格
飘红、overrides 全部失效，极易误判成「代码坏了」。

解法（现行 biome.json）：

1. 保持 biome.json 零注释；要留说明就写在 README/GOTCHAS；
2. 单引号风格对齐既有代码：`javascript.formatter.quoteStyle: "single"`；
3. 测试的非空断言豁免走 `overrides`（`includes: ["**/tests/**"]` 关
   `style/noNonNullAssertion`）——fixture 形状静态已知，改写只会加噪音；
4. `linter.rules.recommended: true` 已废弃，等价写法是
   `"preset": "recommended"`，避免 deprecation 告警。

## G6. Windows 下经 .cmd shim 调 tsdown 会踩坑

`node_modules/.bin/*` 在 Windows 是 `.cmd` shim，`execFileSync` 直呼有
参数转义/查找坑。仓库用 `build.mjs` 直接解析 tsdown 包入口并以 node
spawn 本体 JS 绕开（见 build.mjs 头注释）。新增构建脚本沿用此模式。
