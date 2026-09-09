<div align="center">

# zDSH FileHub

**DeepSeek Harness 的统一文件中心。**

随处上传、`@` 引用万物、让模型读懂文档、为图片生成讲解——并在一个控制台里管理所有会话的文件。

[![ci](https://github.com/zsagi1368/zdsh-filehub/actions/workflows/ci.yml/badge.svg)](https://github.com/zsagi1368/zdsh-filehub/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE) [![Node](https://img.shields.io/badge/node-%E2%89%A522-blue.svg)](./package.json)

[English](README.md) | 中文

</div>

---

## 为什么需要 FileHub

DeepSeek Harness 提供了出色的多模态对话体验，但图像之外的一切都停留在边缘：没有点击上传按钮、没有通用（非图像）文件上传通道、模型打不开 PDF 或表格、也没有地方查看会话产出的文件。

FileHub 用一个开箱即用的插件补齐这些缺口：

- **四个上传入口汇入同一条队列**——按钮、整页拖拽、粘贴、整个文件夹（保留层级）。
- **把 `@` 文件提及做对**——候选来自有界工作区索引与已上传文件的即时合并排序；每条提及在发送时做存在性校验，然后以结构化引用注入。模型精确知道你指的是哪个文件——除非它主动去读，否则内容从不过线。
- **给模型的文档阅读能力**——`read_document` 打开 text/PDF/DOCX/XLSX，支持分页、按格式的输出预算与显式截断标记，长文档按需翻页而不是灌爆上下文。
- **图片讲解瀑布**——当前路由是多模态时图片原样直通、零干预；否则默认走本地 Ollama 生成讲解。除非你明确允许，没有任何字节离开你的机器。
- **一个真正的文件中心**——所有会话的文件可搜索、可过滤，附存储统计与两步确认的清理。

## 功能

### 上传通道

| 入口 | 行为 |
|---|---|
| 输入框按钮 | 多选文件选择器 |
| 拖拽 | 整页遮罩、目录递归遍历、保留相对路径 |
| 粘贴 | 剪贴板内任意文件，不限于图片 |
| 队列条 | 逐项进度、重试、取消、移除（同步删除服务端文件） |

传输全程流式并双重强制大小上限，配并发闸与会话配额。内容寻址去重保证同一文件重复上传只落一份。文件落在隔离的会话工作区 `.filehub/<sessionId>/`——agent 可用常规文件工具直达，沙箱策略天然覆盖。

### @ 文件提及

在输入框键入 `@` 即可同时搜索工作区索引与本会话已上传文件。候选项带类型图标、消歧父路径与完整键盘导航。发送时每个提及 token 都经过文件系统校验（路径穿越直接拒绝），再展开为结构化 `<workspace-reference>` 消息——无效路径显式提示，绝不静默丢弃。输入框上方的 chip 引用条跟踪全部引用，可精确移除某一条。

### AI 文档阅读

| 工具 | 用途 |
|---|---|
| `read_document` | 分页读 text/PDF/DOCX/XLSX（`offset`/`limit`），可选 `sheet` 定位表；`probe` 模式只返回结构概览（页数、表清单、体量）而不倾倒正文 |
| `list_workspace_files` | 列出会话工作区（有界，带截断标志） |

按格式差异化字符预算让输出体量可预期；截断必带显式续读标记，教模型自行取下一段。解析结果按内容寻址缓存，同一文件重复读取零开销。

### 图片讲解

当活跃路由声明了 `image` 输入模态时，FileHub 完全让位——原生多模态行为不受任何影响。否则讲解走严格瀑布：显式端点（仅公网 HTTPS）→ 本地 Ollama 探测（仅环回，默认开启）→ 优雅关闭。结果按图片哈希缓存；同一张图并发上传只会触发一次讲解调用。

### 文件中心

对话视图新增**文件** tab，聚合所有会话：搜索与类型过滤、按会话分组、存储占用分解，以及由"试运行预览 + 二次确认"双保险的清理动作。助手消息菜单亦提供基于同一存储的快捷操作。

## 安装

```sh
dsh plugin --profile <your-profile> add https://github.com/zsagi1368/zdsh-filehub
```

完成——随包清单自动装配两端，无需手工配置，所有选项都有合理默认值。

## 配置

日常选项在 Web UI 的 **设置 → FileHub** 中调整（语言、粘贴行为、候选上限、隐私开关等）。服务端调优接受 profile 配置对象：

```ts
{
  storageDirName: '.filehub',            // session-workspace subdirectory
  upload: {
    maxBytes: 50 * 1024 * 1024,          // single-file cap (streaming-enforced)
    maxConcurrent: 4,                    // parallel transfer gate
    perSessionQuotaBytes: 512 * 1024 * 1024,
    // dangerousExtensions: [...],       // optional deny-list override
  },
  lifecycle: {
    ttlMs: 7 * 24 * 60 * 60 * 1000,      // retention window
    sweepIntervalMs: 60 * 60 * 1000,     // sweeper cadence (all sessions)
  },
  mention: {
    indexMaxFiles: 5000,                 // bounded index hard stop
    indexTtlMs: 30_000,                  // staleness fallback
    searchLimit: 50,
  },
  reading: {
    budgets: { /* per-format char budgets */ },
    cacheEntries: 64,
    cacheBytes: 256 * 1024 * 1024,
  },
  vision: {
    mode: 'off' | 'caption' | 'analyze',
    endpoint: undefined,                 // public http(s) captioning endpoint
    ollamaProbe: true,                   // loopback-only local fallback
    timeoutMs: 20_000,
  },
  console: { maxEntries: 2000 },
}
```

## 安全

FileHub 处理用户文件，因此这里的安全声明全部由具名测试背书（`tests/adversarial/`），而非文字承诺：

- **路径沙箱**——先 resolve 后包含断言，每次操作的路径两端都做 `realpath` 复检；对 symlink/junction 逃逸、兄弟前缀欺骗、ADS 载荷与 Windows 盘符相对路径陷阱免疫。
- **SSRF 栅栏**——本地探针锁定环回地址；远端端点必须是公网主机且 DNS 解析后复检；重定向一律拒绝而非跟随。
- **同源加固**——Origin 主机名比对加远端地址环回复核。
- **资源限额**——流式大小上限、并发闸、会话配额、可证明遍历*全部*会话的 TTL 清扫。

逐条证据映射见 [SECURITY.md](./SECURITY.md)。

## 开发

```sh
pnpm install   # host types resolve from registry-pinned devDependencies (=0.1.2-rc.1, zDSH baseline)
pnpm run check # typecheck + test + build
```

构建产物为 ESM 宿主半与单文件客户端 bundle（由 harness web server 直接服务）。`docs/integration-playbook.md` 记录了将 FileHub 作为分发分支第一方扩展嵌入时的接缝清单。

## 许可证

[MIT](./LICENSE)

## 模型体验

### 文档阅读工具

#### 模型看到什么

`read_document` 工具按 `offset`/`limit` 分页打开文本、PDF、DOCX 与 XLSX 文件，支持 `sheet` 选择与只返回结构的 `probe` 模式；`list_workspace_files` 列出会话工作区（结果有界并带截断标志）。

#### Token 影响

按格式的字符预算封顶每次响应，截断读取附带显式续读标记说明如何取下一片；解析结果按内容寻址缓存，重复读取零成本。

#### KV Cache 影响

`@` 提及注入的是结构化 `<workspace-reference>`，只指明文件——内容须模型主动请求；文件内容仅经显式 `read_document` 调用进入上下文。

### 图像打标

#### 模型看到什么

当前路由声明 `image` 输入时图像原样直通；否则附加以严格瀑布（显式端点 → 本地 Ollama 探测 → 关闭）产出的文本描述。

#### Token 影响

描述按图像哈希缓存，同图并发上传只触发一次打标调用，重复图像不会成倍消耗 token。

#### KV Cache 影响

无论图像原生直通还是转为描述，消息形状不变；打标路径自身不注册任何 prompt 或工具 schema。

## 已知限制与延期工作

- 没有 cwd 的会话会被拒绝，除非宿主保证工作区可用。
- 富提及选择器仅为展示层，等宿主提供对应扩展点后才完整生效。
- 分支集成限于集成手册记载的四个白名单接线点。
- 非图像上传依赖宿主界面；缺席时队列降级为仅本地操作。
