# AGENTS.md — zdsh-plugin-center 开发守则

你是本仓（`zdsh-plugin-center`，zDSH 插件中心）的开发/测试/文档代理。本仓是**全新独立插件**：所有代码、文案与结构均为原创。

## 硬性红线

1. **原创性**：禁止复制任何第三方代码、API 形状、文案或资源进入本仓，来源包括但不限于：
   - `G:\000Github\DSH\PluginR&D\sources\` 下的参考克隆（只读，仅用于理解平台机制）
   - `G:\000Github\DSH\Fork\`（zDSH 分支，只读研究平台契约）
   - 任何 npm / GitHub 第三方实现。
   理解平台契约与安全设计思想允许；逐行翻译或形状抄袭不允许。公开文档（README/CHANGELOG/Release）不得出现"参考/整合自某项目"类表述——本产品定位为全新插件。
2. **Fork 树绝对只读**：对 `G:\000Github\DSH\Fork\` 只允许读命令与 git log/show/diff/status。
3. 源码文件一律用 Write/Edit 工具创建修改；不要用 bash 重定向/heredoc 写 .ts/.tsx/.js/.mjs。
4. 临时文件放 `G:\000Github\DSH\TMP\`，不落仓库根。

## 技术约定

- 单 npm 包 `zdsh-plugin-center`；ESM；TypeScript strict；Node >=22.13。
- 目录模块化：`src/shared`（类型/错误码/结果信封）、`src/host`（Cordis 插件 + HTTP 路由 + 事务引擎 + 守护助手）、`src/client`（React 设置页 UI）；对应测试 `tests/{shared,host,client}`。
- 构建产物 `lib/` **入库提交**（git 直装可用），发布前 `pnpm build` 必须刷新。
- 测试命令：`pnpm test`（vitest run）；类型门：`pnpm lint`（tsc --noEmit）；构建：`pnpm build`。三者全绿才算里程碑完成。
- client 测试文件头部加 `// @vitest-environment jsdom` 注释（需要 jsdom 时）——若缺依赖先在 devDependencies 补 `jsdom` 再用。
- Windows 是一等公民目标平台：路径拼接用 path 模块；spawn 必须 `shell:true`（.cmd shim）；symlink 一律 junction 语义；跨盘 relative() 会退化绝对路径，包含关系校验必须同时检查 `!path.isAbsolute(rel)`。
- 出站网络抓取必须经 `src/shared/ssrc-guard`：仅 http/https；发请求前校验 host，拒绝 localhost、环回（127.0.0.0/8、::1）、私有（10/172.16–12/192.168、169.254、CGNAT 100.64/10）、保留与组播地址；IPv4-mapped IPv6（::ffff:x.y.z.w）先解包再判；重定向逐跳复检。
- 所有对外 id 规范形 `namespace/name`；所有宿主交互返回封闭结果联合（`{ok:true,data}` | `{ok:false,error:{code,message}}`），错误码稳定枚举。
- 审计与账本永不记录 secret/token/env 值（统一脱敏出口）。

## 提交纪律

- Conventional Commits（feat/fix/test/docs/chore/refactor(scope): ...）。
- 每个里程碑验证门全绿后一次提交，目录级 add（`git add src tests catalog docs`），避免逐文件清单。
- 不 push（推送由 ORCH 统一执行）。

## 平台契约速查（研究结论，详见 PluginR&D/docs/R01–R04,R10）

- 安装通道：官方 CLI `dsh plugin --profile <p> add 'git+https://github.com/<owner>/<repo>.git#<40位commit>'`；绝不浮动分支、绝不绕过 CLI 手改 profile 三文件（package.json / pnpm-workspace.yaml / cordis.patch.yml）。
- 生效语义：装卸依赖需重启宿主生效；启停/配置类可即时。
- 设置页注入：client 半包在运行时向 settings slots 注册分区 `{id:'zdsh-plugin-center', order:30}`（order 10=inventory、20=governance 已被占用）。
- client 半包加载契约：以 `window.__ModuleLoader__.load({id, ...})` CJS 形态被宿主加载（实施前先读 sources/dsh-hub-plugin/lib/client.js 头部确认确切签名，再写自己的注册代码）。
