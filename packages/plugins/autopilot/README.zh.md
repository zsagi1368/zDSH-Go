# zdsh-autopilot

[![ci](https://github.com/zsagi1368/zdsh-autopilot/actions/workflows/ci.yml/badge.svg)](https://github.com/zsagi1368/zdsh-autopilot/actions/workflows/ci.yml) [![release](https://img.shields.io/github/v/tag/zsagi1368/zdsh-autopilot?label=release&sort=semver)](https://github.com/zsagi1368/zdsh-autopilot/releases) [![license](https://img.shields.io/github/license/zsagi1368/zdsh-autopilot)](LICENSE)

**zDSH AutoPilot（自动领航）** —— [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的统一自动化引擎。三个协同能力，共享一个内核与一个控制台：

| | 模块 | 功能 |
|---|---|---|
| ⏵ | **续跑 Continue** | 识别非人为打断（网络错误、截断回合）并自动恢复会话——自适应退避、按上一工具终态附加幂等护栏、区分空转与进展的循环守卫。 |
| 🛡 | **守卫 Guard** | 沙箱优先的权限策略：例行工作在 OS 沙箱内零打扰直行；语义风险经脱敏后的 LLM 分类器严格裁决；越界操作发放五元组一次性授权并在官方审批点代答一次——永远只弹一次窗。 |
| 🔎 | **复核 Review** | 只读第二模型复核子代理在完整认领条件下应答审批请求，默认 fail-closed，带双预算、推导式默认熔断器，并把拒绝理由回喂给错误结果。 |

[English](README.md) | 中文

---

## 为什么是一个引擎

互相看不见彼此的自动化模块会制造最糟的故障：自动续跑撞进刚发生的拒绝风暴、三张设置卡三套审计格式、"暂停"只暂停了其中一环。AutoPilot 从一开始就设计为 **一个内核 + 四条跨模块不变量**：

1. 存在待批审批的会话会 **挂起自动续跑**——延迟重排而非丢弃。
2. 复核熔断开启时 **抑制自动续跑**（`skipped: circuit-open`）——无人值守时不再出现拒绝风暴。
3. 一处 **全局暂停约束全部模块**。
4. 同一审批 callId **只被处置一次**——先认领者赢，双弹窗从构造上不存在。

全部模块共享一套记账模型（副作用发生前先记账；取消永不消耗失败预算）、一套审计词汇（`ap/*` 会话日志事件 + 可重放折叠 + 机械可查的标记校验）、一套失败语言（`timeout | cancelled | unavailable | schema | budget | circuit-open`，穷举映射到安全侧结局）。

## 环境要求

| | |
|---|---|
| DeepSeek Harness | `>= 0.1.0-rc.2`，`< 0.2.0` |
| Node（宿主） | `>= 22` |
| 平台 | Windows / macOS / Linux（路径判定以 Windows 为一等公民硬化） |

所有宿主能力均特性检测并优雅降级；缺失的服务只会关闭对应接线，绝不阻断启动。

## 安装

**zDSH 分支——无需任何操作。** AutoPilot 作为 [deepseek-harness-zDSH](https://github.com/zsagi1368/deepseek-harness-zDSH) 分支的内置扩展随分支分发：装好分支即已启用，可在 设置 → 插件 中管理。

**上游 DSH 或其他 profile：**

```bash
# 从 GitHub 安装
dsh plugin --profile web add github:zsagi1368/zdsh-autopilot

# 或从本地检出安装
dsh plugin --profile web add link:/path/to/zdsh-autopilot
```

然后打开 **设置 → 插件 → AutoPilot**，选择一个预设即可使用。

## 使用

所有操作都收敛在一个命令面：

```text
/ap                          status of all modules + today counters
/ap on|off [continue|guard|review]
/ap pause [duration]         /ap resume
/ap approve                  authorize the latest denial (one-shot context)
/ap preset conservative|standard|fullspeed
/ap reset-stats              /ap help
```

预设是应用在用户配置之上的命名配置集：

| 预设 | 续跑 | 守卫 | 复核 |
|---|---|---|---|
| **conservative 保守** | 关 | 严格阶梯、偏人工兜底 | delegate 兜底 |
| **standard 标准**（默认） | 开 | 均衡 | rejected 兜底 |
| **fullspeed 全速** | 快速退避 | 宽松阶梯 | 更宽预算 |

配置位于 DSH 设置文件的 `autopilot:` 命名空间（热重载）；部署级默认值随 bundle 补丁分发。每个旋钮都有内联文档，且全部派生自代码中的单一事实来源。

## 架构

```text
src/
├── kernel/      shared facade: coordinator · ledger · audit(ap/*) · redact · probes · defaults
├── continue/    detector · scheduler · loopguard · resume texts
├── guard/       path hardening · shell lexer (bash/pwsh) · artifacts · classifier · grants
├── review/      answerer · reviewer prompt/verdict · circuit · feedback
├── console/     command parser · status/action bridge (token-or-same-origin auth)
└── client/      browser fiber — official slots only, zero DOM scraping
eval/            offline behavior contracts: YAML cases drive real module factories
corpus/          extensible error-classification corpus
```

模块边界由 CI 强制（`scripts/check-boundaries.mjs`）：能力模块只准依赖内核门面与自身。因此任一模块目录未来都可零重构地抽出为独立插件。

同一份源码同时供给两种发行形态——zDSH 单仓 vendor 构建与本独立包——确保行为完全一致。

## 开发

```bash
pnpm install
pnpm verify     # lint(boundaries) + typecheck(3 configs) + vitest + build + eval
pnpm eval       # offline behavior-contract suite only (no API key needed)
```

仓库内置的质量门禁：

- **134 项单元/行为测试**覆盖内核与全部模块，含平台感知的路径/shell 样本集；
- **10 条 YAML 行为契约**无头驱动真实模块工厂，以进程退出码作 CI 门禁；
- lint 内置**边界与依赖守卫**；
- 双面构建验证（宿主 ESM `lib/` 与 Web 客户端经典脚本 bundle）;
- 对宿主接缝的每一条假设都在 `kernel/probes` 登记探测与降级路径。

## 安全说明

- 授权来源仅限人类直接消息与预执行事实；仓库内容、工具输出、模型文本一律视为数据而非指令。
- 一切跨越模型边界的内容先经结构化脱敏（secret 键位、大段正文、token 形态、PEM 块、连接串）。
- 动作端点要求令牌或同源鉴权，并对载荷设上限。
- 越权授权绑定 会话/工具/调用/级别/理由 五要素，仅可消费一次。

完整架构记录见 [docs/DESIGN.md](docs/DESIGN.md)，版本历史见 [CHANGELOG.md](CHANGELOG.md)。

## 许可证

[MIT](LICENSE) © 2026 zsagi1368

## 模型体验

### 自动化内核

#### 模型看到什么

Continue 通过提交普通恢复消息续跑被中断的会话；Guard 经官方审批缝以五要素一次性升级授权作答；Review 贡献只读的审稿 subagent 裁决（严格输出协议），拒绝理由回灌错误结果。

#### Token 影响

LLM 分类器与审稿调用是主对话之外的辅助请求；审计事件（`ap/*`）是会话日志记录而非提示内容，跨模型边界前一律经结构化脱敏（密钥名键、批量内容、token 形状）。

#### KV Cache 影响

模块决策从不改写消息历史——待审批推迟自动恢复、熔断状态抑制恢复，前缀缓存赖以建立的可见转写始终与用户和工具所写一致。

## 已知限制与延期工作

- 审稿质量取决于所配置的第二模型；表现不佳时默认 fail-closed 拒绝。
- 路径判断以 Windows 优先加固；其他平台为尽力等价实现。
- 升级授权按 callId 恰好消费一次，不可批量。
