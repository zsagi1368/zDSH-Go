# dsh-guard

English | [中文](README.zh.md)

**The unified guard for DeepSeek Harness** — a self-contained single file hooked into the DSH profile's pnpm lifecycle. After every plugin `install` / `upgrade` / `remove` it automatically detects and repairs known breakage patterns in the plugin ecosystem. Zero intrusion into the official core, backup before every modification, rollback at any time.

> Target users: DSH users tired of "install a plugin and startup crashes / upgrade and prepare crashes".

---

## What problem it solves

The DSH (DeepSeek Harness) plugin mechanism has two structural traps that can recur on **every plugin install/upgrade/uninstall**:

### 1. Duplicate core-package copies → Symbol isolation crash (most common)

If a core package such as `@deepseek-ai/dsh-tools` becomes a **real directory copy** in the **profile layer** (`profiles/web/node_modules/@deepseek-ai/`) instead of a junction pointing at the official kernel, the module-level `Symbol`s (such as `TOOL_RUNTIME_SCHEDULER`) are isolated per physical instance, and tool calls fail with:

```
Cannot read properties of undefined (reading 'prepare')
```

**When it triggers**: every `dsh plugin add/upgrade/remove` re-arranges node_modules through pnpm, which can replace a junction in the profile layer with a real copy. That is why it keeps coming back.

### 2. Composition-tree double-mount → duplicate route (startup crash)

Aggregator plugins (such as `@linxin666/dsh-web-ui-all`) ship a `cordis.patch.yml` that inserts already-installed plugins (such as `dsh-better-sidebar`) a second time, so the plugin loads twice and startup fails with:

```
webserver: duplicate prefix route "/sidebar/api"
```

### 3. Additional checks

- Session log (`session.jsonl.zstd`) first-frame integrity (report only; data is never modified)
- Whether a plugin declares dsh metadata (report only)

---

## Why "automatic" works

The DSH CLI (`dsh plugin add/upgrade/remove`) shells out to `pnpm` internally (`spawnSync("pnpm", args, { cwd: profileDir })`, **without `--ignore-scripts`**), and `profiles/<name>/` is itself a standard pnpm workspace root (with `package.json` + `pnpm-workspace.yaml`).

Therefore: **after every plugin install/upgrade/uninstall, the pnpm install completion runs the workspace root's `prepare` script.** Registering dsh-guard as the `prepare` hook guarantees the guard runs the moment any plugin change happens — installs, upgrades and uninstalls all covered, no cron, no need to remember to run it manually.

---

## Install

### Option 1: install straight from GitHub (recommended)

```powershell
# Download the single file anywhere (for example D:\tools\dsh-guard\)
git clone https://github.com/<your-username>/dsh-guard.git

# Register it into a profile (default web)
cd dsh-guard
node dsh-guard.mjs install --profile web
```

### Option 2: manual (only two steps)

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

Right after installing, run one check-and-fix pass (the `install` command does this itself):

```powershell
node dsh-guard.mjs check --profile web    # 只读体检
node dsh-guard.mjs fix --profile web      # 备份后修复
```

---

## Usage

| Command | Purpose |
|---|---|
| `node dsh-guard.mjs install [--profile <name>]` | Register the `prepare` hook + run an immediate check-and-fix pass |
| `node dsh-guard.mjs uninstall [--profile <name>]` | Remove the hook (backups and repair logic stay) |
| `node dsh-guard.mjs check [--profile <name>]` | Read-only check: reports deviations, **changes nothing** |
| `node dsh-guard.mjs fix [--profile <name>]` | Repair all deviations after backing up (idempotent) |
| `node dsh-guard.mjs status [--profile <name>]` | Show hook/guard status |

`--profile` accepts a name (`web`) or an absolute path; the default is `web`.

### Environment variables

| Variable | Purpose |
|---|---|
| `DSH_GUARD_BACKUP_DIR` | Custom backup root directory (default `<profile>/.dsh-guard-backup/<ts>`) |
| `DSH_GUARD_HOOK_CMD` | Explicit command written into the hook (default auto-generates a Windows drive path) |
| `DSH_GUARD_SKIP_BACKUP=1` | Skip backup (testing only, not recommended) |
| `DSH_GUARD_FORCE_JUNCTION=1` | Force junction even when versions match |
| `DSH_GUARD_CHECK_SESSIONS=1` | Also scan session-log first frames during `check` |
| `DSH_GUARD_DEBUG=1` | Print full exception stacks |

---

## Uninstall

```powershell
node dsh-guard.mjs uninstall --profile web
```

This removes the `prepare` hook; all backups from earlier repairs remain under `profiles/web/.dsh-guard-backup/` and can be cleaned up manually.

---

## Safety design (zero risk)

- **Touches only the DSH profile layer**, never the official core (the junction chain under `profiles/node_modules`)
- **Backs up before every modification**: real core-package copies are renamed out (never deleted) before a junction replaces them; patch files are copied first
- **Fail-closed**: any failed step produces no partial modification — the guard reports the error and exits
- **Idempotent**: no deviation means no action; repeated runs have no side effects
- **Rollback-ready**: every repair keeps a timestamped backup directory with files preserved in place under a renamed path
- **Cross-platform**: junctions use Node's native `symlink(..., 'junction')` (junction on Windows, symlink on POSIX)
- **WSL / Windows dual environment**: auto-detects the DSH data directory (including `%USERPROFILE%\.dsh` and `/mnt/c/Users/*/.dsh`)

---

## Troubleshooting quick reference

| Symptom | Likely cause | Action |
|---|---|---|
| `Cannot read properties of undefined (reading 'prepare')` | Duplicate core-package copy (Symbol isolation) | `node dsh-guard.mjs fix --profile web` |
| `duplicate prefix route "/sidebar/api"` startup crash | Aggregator double-mount | `node dsh-guard.mjs fix --profile web` (auto-disables) |
| `unknown to this harness and not marked ignorable` | Plugin events missing the ignorable marker | Update the plugin/patch (dsh-guard only reports, never edits) |
| `corrupt Zstandard session log` startup crash | Manually edited session.jsonl.zstd broke the frame structure | Restore from the original backup (dsh-guard never edits data) |
| Plugin list shows "未声明 dsh 元数据" | Plugin package missing the dsh field (preset installed as a plugin) | A shape problem; dsh-guard only reports it |

## Development

```bash
# 项目位置不限；改动后
node --check dsh-guard.mjs
node dsh-guard.mjs --help

# 自动化测试（在 /tmp 临时 fixture 上跑，不碰真实 profile）
node test/run.mjs
```

Test coverage: clean pass / core-copy detection + repair / double-mount detection + repair / patch creation when absent / install-uninstall round trip / idempotency. Currently 20/20 passing.

## License

MIT

## Model Experience

None, as the package is a pnpm prepare hook that repairs plugin-ecosystem breakage on disk; it registers no prompt, tool, or session event.

#### KV Cache effect

No direct effect; the guard never touches model requests or conversation state.

## Known Limitations and Deferred Work

- A DSH kernel upgrade that changes junction design or hook mechanics may require a one-time manual adaptation.
- New conflict patterns require adding rules to the guard's rule table (`KNOWN_DOUBLE_MOUNTS` is append-only by design).
- If pnpm ever runs with `--ignore-scripts`, the hook is bypassed; run `node dsh-guard.mjs fix` manually in that case.
