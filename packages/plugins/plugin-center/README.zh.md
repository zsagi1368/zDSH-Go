<h1 align="center">zDSH 插件中心</h1>

<p align="center">
  <a href="https://github.com/zsagi1368/zdsh-plugin-center/actions/workflows/ci.yml"><img src="https://github.com/zsagi1368/zdsh-plugin-center/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/zsagi1368/zdsh-plugin-center/releases/latest"><img src="https://img.shields.io/github/v/release/zsagi1368/zdsh-plugin-center?style=flat-square" alt="Release"></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A522.13-339933?style=flat-square" alt="Node ≥22.13">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-2563eb?style=flat-square" alt="License: MIT"></a>
</p>

<p align="center">
  DeepSeek Harness（DSH）的内置插件中枢：在一个设置页里完成插件的发现、评估、
  安装、更新与审计——安全第一，Windows 一等公民。<br>
  English documentation: <a href="README.md">README.md</a>
</p>

---

## 两种使用方式

| | 获取方式 |
|---|---|
| **zDSH 分支** | 已经内置。[zDSH 分支](https://github.com/zsagi1368/deepseek-harness-zDSH) 将插件中心作为核心扩展随分支分发——打开 **设置 → 插件中心** 即可直接使用，无需任何安装。 |
| **原版 DeepSeek Harness** | 像普通插件一样按发布 commit 安装（见下文）。 |

## 为什么做它

现在安装一个 DSH 插件，意味着手敲一条 CLI 命令、然后无条件信任进入 profile
的东西。插件中心把这件事变成由 Web 界面驱动的「先审核、可回滚」流程——同时
它自己就是一个普通插件：除标准 bundle 声明外不修改宿主任何文件，也不需要
特权辅助进程。

## 核心能力

**市场发现**
- 有界目录浏览（每页 24 条）：搜索、分类过滤、只看推荐
- 每条目三枚徽章：信任证据 · 兼容性投影 · 固定来源（GitHub commit 或 npm 版本）
- 优雅离线：在线目录 → 验签本地缓存 → 随包快照三级降级，数据可能过期时界面明确提示

**信任模型**
- GitHub 安装目标固定到精确 40 位 commit，npm 固定精确 semver——浮动分支在计划创建前即被拒绝
- 四级证据体系（`discovered` → `recommended`）与三级兼容性投影，逐条目可见
- 远端目录必须携带匹配的 SHA-256 边车，未签名的快照一律拒收

**安全生命周期事务**
- 每次安装 / 更新 / 卸载都是一次性计划，需输入 staging 时仅返回一次的随机确认码
- 执行前：profile 三文件先哈希并备份；执行后：状态重比对 + 健康探测；任一步失败即逐字回滚并校验字节
- 目标声明的生命周期脚本默认全拒，显式放行清单之外一律 `script_blocked`
- 追加式审计日志记录每一步——落盘前统一经过秘密脱敏

**重启编排**
- 独立 Node 看门狗探测固定环回地址，宿主崩溃后自动拉起：5 分钟内最多 3 次，
  超限熔断放弃——不需要 launchd / schtasks / systemd

**运维与体验**
- 看门狗开关、备份恢复、卸载全部内嵌在市场页旁
- 界面中英双语（默认中文），基于主题别名变量，适配移动端布局

## 环境要求

| | |
|---|---|
| DeepSeek Harness | 启用 Web 客户端的 profile |
| Node.js | ≥ 22.13 |
| 平台 | Windows（一等公民）、macOS、Linux |

## 安装（独立形态）

请固定精确的发布 commit——当前值见
[Releases 页面](https://github.com/zsagi1368/zdsh-plugin-center/releases)：

```bash
dsh plugin --profile web add 'git+https://github.com/zsagi1368/zdsh-plugin-center.git#<release-commit>'
```

安装并重启 web profile 后，打开 **设置 → 插件中心**。

## 一次安装的完整流转

```
浏览 / 搜索            → 有界分页、徽章、详情元数据
创建计划（staging）    → 服务端校验 commit 固定、脚本策略与信任级别
输入确认码             → 消费该一次性计划
应用                   → 哈希 → 备份 → 固定参数安装 → 校验 → 健康探测
完成                   → 「待重启生效」横幅；看门狗随时可用
任一步失败             → 字节级校验回滚 + 审计记录
```

## 配置

所有配置均可选；默认即为「随包目录 + web profile + 可写」。常用开关：

| 键 | 作用 |
|---|---|
| `remoteCatalogUrl` | 指向签名远端目录（如 [zdsh-plugin-registry](https://github.com/zsagi1368/zdsh-plugin-registry)） |
| `mutationsEnabled: false` | 只读模式 |
| `webPort` | DSH Web 宿主环回端口（看门狗探测用） |

完整参考（示例与 `~/.zdsh-plugin-center` 数据布局）：
[docs/CONFIGURATION.md](docs/CONFIGURATION.md)

## 安全声明

威胁模型、八项保证（目标固定、一次性计划、字节级回滚、脚本门禁、SSRF 守卫、
同源 + 意图双闸、无秘密审计、有界重启）以及已接受的残余风险，详见
[SECURITY.md](SECURITY.md)。

## 项目文档

| 文档 | 内容 |
|---|---|
| [docs/CONFIGURATION.md](docs/CONFIGURATION.md) | 全部配置键、默认值、示例与数据布局 |
| [SECURITY.md](SECURITY.md) | 威胁模型与安全保证 |
| [docs/INTEGRATION-PLAYBOOK.md](docs/INTEGRATION-PLAYBOOK.md) | 宿主发行版打包说明 |
| [CHANGELOG.md](CHANGELOG.md) | 发布历史（双语） |

## 本地开发

```bash
pnpm install
pnpm lint        # tsc --noEmit，strict
pnpm build       # tsdown：host ESM + client 加载器包 + 看门狗入口
pnpm test        # vitest：单元 + 契约 + 闭环集成套件
```

集成套件会启动真实 HTTP 服务、以真实子进程驱动 CLI 替身、作用于真实临时
profile 文件。CI 在 ubuntu-latest 与 windows-latest 双跑道跑完整门禁。

面向开发代理的仓库守则见 [AGENTS.md](AGENTS.md)。

## 已知限制（v0.x）

- `restart/request` 路由目前返回 `not_implemented`；请通过看门狗开关路由管理守护进程，宿主重启暂需手动。
- 无法获取目标实时清单时，脚本门禁退回使用目录中声明的策略。
- 出站请求仅判定字面主机名，解析后地址钉扎属于后续工作。

## 许可证

[MIT](./LICENSE)
