# dsh-guard

[English](README.md) | 中文

**DeepSeek Harness 统一守护件** —— 一个自包含文件，挂在 DSH profile 的 pnpm 生命周期上，在每次插件 `install` / `upgrade` / `remove` 之后自动检测并修复插件生态的已知破坏模式。零侵入官方核心、先备份后修改、可随时回滚。

> 目标用户：受够了「装个插件就启动崩 / 升个级就 prepare 崩溃」的 DSH 用户。

---

## 它解决什么问题

DSH（DeepSeek Harness）的插件机制有两个结构性的坑，会让**每一次装/升/卸插件**都可能再次踩雷：

### 1. 核心包重复副本 → Symbol 隔离崩溃（最常见）

如果把 `@deepseek-ai/dsh-tools` 等核心包在 **profile 层**（`profiles/web/node_modules/@deepseek-ai/`）变成了**真实目录副本**（而不是 junction 指向官方内核），会和内核层的 rc.x 形成两份物理副本。模块级 `Symbol`（如 `TOOL_RUNTIME_SCHEDULER`）按物理实例隔离，导致工具调用报：

```
Cannot read properties of undefined (reading 'prepare')
```

**触发时机**：每次 `dsh plugin add/upgrade/remove` 时 pnpm 重排 node_modules，就可能把 profile 层该是 junction 的核心包替换成真实副本。这也是它反复复发的原因。

### 2. 组合树 double-mount → duplicate route（启动崩）

聚合插件（如 `@linxin666/dsh-web-ui-all`）自带的 `cordis.patch.yml` 会把已单独安装的插件（如 `dsh-better-sidebar`）再 insert 一次，导致同一插件被加载两遍，启动报：

```
webserver: duplicate prefix route "/sidebar/api"
```

### 3. 附加检查

- session 日志（`session.jsonl.zstd`）首帧完整性（仅报告，不擅自改数据）
- 插件是否声明 dsh 元数据（仅报告）

---

## 为什么"自动"能成立

DSH 的 CLI（`dsh plugin add/upgrade/remove`）内部都是调用 `pnpm`（源码 `spawnSync("pnpm", args, { cwd: profileDir })`，**不带 `--ignore-scripts`**）。而 `profiles/<name>/` 本身是一个标准 pnpm workspace root（有 `package.json` + `pnpm-workspace.yaml`）。

因此：**每次插件安装/升级/卸载，pnpm install 完成后必会执行该 workspace root 的 `prepare` 脚本。** 只要把 dsh-guard 注册成 `prepare` 钩子，就能保证「任何插件变更的瞬间，守护自动运行」——装、升、卸全覆盖，不需要 cron、不需要记着手动跑。

---

## 安装

### 方式一：从 GitHub 直接装（推荐）

```powershell
# Download the single file anywhere (for example D:\tools\dsh-guard\)
git clone https://github.com/<your-username>/dsh-guard.git

# Register it into a profile (default web)
cd dsh-guard
node dsh-guard.mjs install --profile web
```

### 方式二：手动（只有两个动作）

```powershell
# 1. 找到 dsh-guard.mjs（放在哪都行）
# 2. 在 profile 的 package.json 里加上 prepare 钩子
#    C:\Users\<你>\.dsh\profiles\web\package.json
```

```json
{
  "scripts": {
    "prepare": "node I:\\path\\to\\dsh-guard.mjs"
  }
}
```

安装后立即跑一次体检+修复（`install` 命令会自己跑一遍）：

```powershell
node dsh-guard.mjs check --profile web    # 只读体检
node dsh-guard.mjs fix --profile web      # 备份后修复
```

---

## 用法

| 命令 | 说明 |
|---|---|
| `node dsh-guard.mjs install [--profile <name>]` | 注册 `prepare` 钩子 + 立即体检修复 |
| `node dsh-guard.mjs uninstall [--profile <name>]` | 移除钩子（保留备份和修复逻辑） |
| `node dsh-guard.mjs check [--profile <name>]` | 只读体检：报告偏差，**不改动** |
| `node dsh-guard.mjs fix [--profile <name>]` | 备份后修复所有偏差（幂等） |
| `node dsh-guard.mjs status [--profile <name>]` | 查看钩子/守护状态 |

`--profile` 支持名字（`web`）或绝对路径；默认 `web`。

### 环境变量

| 变量 | 作用 |
|---|---|
| `DSH_GUARD_BACKUP_DIR` | 自定义备份根目录（默认 `<profile>/.dsh-guard-backup/<ts>`） |
| `DSH_GUARD_HOOK_CMD` | 显式指定写进钩子的命令（默认自动生成 Windows 盘符路径） |
| `DSH_GUARD_SKIP_BACKUP=1` | 跳过备份（仅测试，不建议） |
| `DSH_GUARD_FORCE_JUNCTION=1` | 即使版本相同也强制 junction |
| `DSH_GUARD_CHECK_SESSIONS=1` | check 时额外扫描 session 日志首帧 |
| `DSH_GUARD_DEBUG=1` | 打印完整异常栈 |

---

## 卸载

```powershell
node dsh-guard.mjs uninstall --profile web
```

会移除 `prepare` 钩子；所有此前修复产生的备份仍在 `profiles/web/.dsh-guard-backup/` 下，可手动清理。

---

## 安全性设计（零风险）

- **只动 DSH profile 层**，绝不触碰官方核心（`profiles/node_modules` 的 junction 链）
- **全部修改前先备份**：核心包真实副本 → 改名移出（不删除），再建 junction；patch 文件 → 复制原件
- **fail-closed**：任何一步出错则不产生部分修改，只报错退出
- **幂等**：没有偏差就不动；反复运行无副作用
- **可回滚**：每次修复都有时间戳备份目录，文件都在原路径改名保留
- **跨平台**：junction 用 Node 原生 `symlink(..., 'junction')`（Windows = junction，POSIX = symlink）
- **WSL / Windows 双环境**：自动识别 DSH 数据目录（含 `%USERPROFILE%\.dsh`、`/mnt/c/Users/*/.dsh`）

---

## 故障排查速查表

| 症状 | 可能原因 | 处理 |
|---|---|---|
| `Cannot read properties of undefined (reading 'prepare')` | 核心包重复副本（Symbol 隔离） | `node dsh-guard.mjs fix --profile web` |
| `duplicate prefix route "/sidebar/api"` 启动崩 | 合并插件 double-mount | `node dsh-guard.mjs fix --profile web`（自动补 disabled） |
| `unknown to this harness and not marked ignorable` | 插件事件缺 ignorable 标记 | 需更新该插件/补丁（dsh-guard 报告不擅改） |
| `corrupt Zstandard session log` 启动崩 | 手动改过 session.jsonl.zstd 破坏帧结构 | 用原始备份恢复（dsh-guard 不擅改数据） |
| 插件列表显示"未声明 dsh 元数据" | 插件包缺 dsh 字段（preset 误装为插件） | 这是形态问题，dsh-guard 仅提示 |

## 开发

```bash
# 项目位置不限；改动后
node --check dsh-guard.mjs
node dsh-guard.mjs --help

# 自动化测试（在 /tmp 临时 fixture 上跑，不碰真实 profile）
node test/run.mjs
```

测试覆盖：clean 通过 / 核心副本检出+修复 / double-mount 检出+修复 / patch 不存在时新建 / install-uninstall 往返 / 幂等。当前 20/20 通过。

## License

MIT

## 模型体验

None, as 本包是修复插件生态磁盘破坏模式的 pnpm prepare 钩子；不注册任何模型可见内容（prompt、工具或会话事件）。

#### KV Cache 影响

无直接影响；守护件从不触碰模型请求或会话状态。

## 已知限制与延期工作

- DSH 内核升级（如 rc.7 → rc.8）若改变 junction 设计或钩子机制，可能需要一次人工适配——任何方案都躲不开官方行为变化。
- 新增插件的全新冲突类型需要增补守护规则表（`KNOWN_DOUBLE_MOUNTS` 是幂等增补式）。
- pnpm 若未来带 `--ignore-scripts`，钩子会被绕过；此时可手动运行 `node dsh-guard.mjs fix` 补跑。
