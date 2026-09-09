# Fresh-Clone E2E Verification of Published zDSH-Go (Campaign E, Final Acceptance)

English | [中文](2026-09-09-fresh-clone-e2e.zh.md)

- Date: 2026-09-09
- Executor: tester (independent acceptance; no code fixes performed)
- Subject: the published repository `https://github.com/zsagi1368/zDSH-Go.git`, verified end-to-end in a fresh clone strictly following the repo README Quick Start
- Verdict: **PASS — release gate cleared. 0 blocking defects (P0/P1: none; P2: none; P3: 2 recorded observations, backlog).**

## 1. Environment

| Item | Value |
| --- | --- |
| Clone target | `%TEMP%\zshgo-e2e\clone\zDSH-Go` (task-dedicated temp dir, self-created and self-cleaned) |
| Node / pnpm / git / curl | v24.19.0 / 11.7.0 (install output) and 11.25.0 (shell) / 2.54.0.windows.1 / 8.19.0 |
| Real `$HOME` | untouched (baseline snapshotted before uninstall; see section 6) |
| Isolation | installer-generated `data/` home (`DSH_HOME=<repo>/data`), server bound to `127.0.0.1:4182`; all probes sent with `--noproxy` (local loopback) |

## 2. Clone and README fact-check

| # | Check | Result | Evidence |
| --- | --- | --- | --- |
| 1 | `git clone https://github.com/zsagi1368/zDSH-Go.git` | PASS (exit 0, 9756 files) | HEAD `02b2f21b11fd0810c791aa3d4e788b29a4c06180` = expected `02b2f21b11` |
| 2 | README.md / README.zh.md content = worktree final | PASS | byte-identical to worktree (`md5` `271b0d53…` / `f3642a4e…`); 3 sampled sections verified by eye: Quick Start (L53–107), Security (L144–149), FAQ/License/Acknowledgements (L151–174) |
| 3 | Root `install.cmd` exists | PASS | 92-byte wrapper → `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install.ps1`, identical to worktree |

## 3. Install (README Quick Start, `install.cmd`)

Run as `cmd //c install.cmd` (the README Windows instruction `.\install.cmd`; `powershell -File install.cmd` is invalid because `-File` requires `.ps1` — see P3-b).

Exit code: **0**. Step outputs:

| Step | Output excerpt |
| --- | --- |
| Prereq check | `[OK] Node.js v24.19.0` / `[OK] pnpm 11.7.0` |
| [1/4] `pnpm install --frozen-lockfile` | `Done in 50.8s using pnpm v11.7.0`; WARNs: two linux-only `landlock-run` optional packages skipped on win32, cyclic workspace deps listing, 4× `Failed to create bin …bin.js.EXE` (P3-a) |
| [2/4] `pnpm run build` | completed, exit 0; build-tool WARNs only (`external` deprecated, one INEFFECTIVE_DYNAMIC_IMPORT) |
| [2b/4] `dsh-guard check --profile web` | `[dsh-guard …] ERROR profile 不存在: …\data\profiles\web` → `[WARN] … continuing (non-blocking)` — exactly the fresh-install behavior README documents |
| [3/4] data directory | `<repo>/data` created |
| [4/4] env files | `env.ps1` (UTF-8 BOM) / `env.sh` (BOM-free) written; `dsh` = `node <repo>/apps/cli/lib/bin.js` |
| Final | `zDSH-go installed successfully (self-contained).` `DSH_HOME=<repo>\data`, `DSH_BRANCH_HOME=<repo>\data\zdsh`, `DSH_AGENTS_HOME=<repo>\data\agents` |

## 4. Run (README Run section)

- `source ./env.sh && dsh web --no-open --port 4182`
- Startup log (single line, clean): `dsh web: http://127.0.0.1:4182/?token=…`
- Process: node.exe PID 90232; `netstat` → `TCP 127.0.0.1:4182 … LISTENING`; alive verified at +12 s and +24 s (and stayed up ~13 min until intentional stop)
- Log scan: 0 occurrences of `failed-to-apply` / `failed to apply` / `error`
- Auth model verified live: unauthenticated `GET /` → **401** (by design); `GET /?token=<launch token>` → **303 + set-cookie** (`dsh-auth-<authority>`, HttpOnly, SameSite=Strict, 30-day max-age); cookie then authenticates all subsequent probes

## 5. Nine-item integrated live probe (all PASS)

All probes via loopback with the token-minted cookie, `--noproxy` set. Baseline root check: `curl /` → **200** (with cookie).

| # | Probe | Endpoint / method | Result | Evidence excerpt |
| --- | --- | --- | --- | --- |
| 1 | workbench ping + HTML | `GET /workbench/api/ping` + `GET /workbench` | PASS | ping → 200 `{"ok":true,"value":{"ok":true,"plugin":"@deepseek-ai/dsh-client-workbench","version":"0.1.3-alpha.1"}}`; HTML → 200, 26172 bytes (SPA module-loader shell) |
| 2 | filehub usage | `GET /api/filehub/usage` | PASS | 200 `{"totalBytes":0,"files":0,"byKind":{image,document,text,binary,media…},"bySession":[]}` |
| 3 | plugin-center market | `GET /api2/zdsh-plugin-center/market` | PASS | 200, `total=6`; 6 items, ids + pinnedCommits match catalog (see #9) |
| 4 | autopilot dump-config insert | `dsh --profile web --dump-config` | PASS | exit 0, 556 lines; autopilot entry present (L543–551): `id: autopilot / name: zdsh-autopilot / modules: continue|guard|review enabled: true`; provenance chain traced to the bundle patch `packages/plugins/autopilot/cordis.patch.yml` `insert:` row. Note: the rendered dump materializes insert rows (no literal `insert` keyword in dump output) — semantics verified end-to-end |
| 5 | webstack dump-config + Aggregator importable | dump + ESM import of built lib | PASS | dump contains `- id: dsh-webstack / name: dsh-webstack`; `import('…/packages/plugins/webstack/lib/index.js')` OK, `typeof WebstackAggregator === 'function'`, plugin `name === 'webstack'` |
| 6 | omnivision toolRegistry = 9 tools | ESM import of `packages/plugins/omnivision/dist/index.js` | PASS | 13 exports incl. `toolRegistry`/`listTools`; `listTools()` returns exactly 9: `vision_describe`, `vision_ocr`, `vision_detect`, `vision_ground`, `vision_bootstrap`, `vision_crop`, `vision_pixel_diff`, `vision_trace`, `vision_screenshot` |
| 7 | attachment-local dump-config limits | dump lines 64–69 | PASS | `maxImageBytes: 20971520` (20 MiB), `maxImagePixels: 100000000` (100 MP), `maxImageDimension: 10000` (px) — matches expectation; repo-level defaults (64 MP / 8192 px) are overridden by the web profile patch layer to 100 MP / 10000 px, as designed |
| 8 | dsh-guard install log line | install output + follow-up | PASS | install output contains the `[2b/4] dsh-guard check` block incl. the `[dsh-guard <ts>]` log line (expected profile-absent warning on fresh install); post-boot `dsh-guard check --profile web` → `体检通过：无偏差` exit 0; `dsh-guard install --profile web` → prepare hook registered, `install: 执行首次体检+修复…`, `unclean 检查通过：无需修复`, exit 0 |
| 9 | PluginCenter seed 6 = PluginRegistry catalog | seed.json vs remote catalog.json vs live market | PASS | `packages/plugins/plugin-center/catalog/seed.json`: 6 entries; remote `https://raw.githubusercontent.com/zsagi1368/zdsh-plugin-registry/main/catalog.json`: 6 entries; identical ids + pinnedCommits in the same order (`sliverp/dsh-hub-plugin@2b21934…`, `AI-Scarlett/dsh-safe-plugin-manager@47ad35b…`, `zsagi1368/zdsh-autopilot@d705e49…`, `omdsh-dev/DSH-better-sidebar@36a4119…`, `taxueseek/dsh-files@b17e36f…`, `HongMing-Huang/dsh-file-upload@ce4ca94…`); live market API serves the same 6 |

## 6. Uninstall (default mode) and `$HOME` protection

- `cmd //c uninstall.cmd` → exit **0**
- `[1/2] Cleaning gitignored artifacts inside the repository` — node_modules, build output, data, env files removed
- `[2/2] Zero-residue checklist`: node_modules / lib / data / env.ps1 / env.sh → all `[clean]`; `~/.dsh-zdsh-go` → `[clean]`; `~/.zdsh-workbench` → `[REMAINS] (use -CleanLegacy to remove)`; final `Result: some items remain` — solely due to the pre-existing legacy dir below
- **REMAINS semantics verified correct**: `~/.zdsh-workbench/tasks.json` predates this session (mtime 2026-09-01 20:04, created by an earlier non-DSH_HOME run of the workbench bundle; the ledger falls back to `~/.zdsh-workbench` when no `DSH_BRANCH_HOME`/`DSH_HOME` is set). The uninstaller reports it and keeps it — conservative, by design; it never deletes without `-CleanLegacy`
- `$HOME` protection: baseline before uninstall → `.dsh` EXISTS (5 files), `.dsh-zdsh` ABSENT, `.dsh-zdsh-go` ABSENT; after uninstall → identical. The official `~/.dsh` is only reachable through `-CleanLegacy` plus an interactive `yes` confirmation (default mode never touches it)
- Repository integrity: `git status --porcelain` empty, HEAD still `02b2f21b11`

## 7. Cleanup and residue check

- Test server stopped (taskkill; the first graceful `taskkill /PID` was refused — normal Windows behavior for a node process without a console-signal handler — then `/F`). Port 4182 released (netstat empty)
- No node process with `zshgo-e2e` in its command line remained
- Clone directory deleted entirely (task-dedicated temp dir, self-created; test logs retained in the temp workspace until session end)

## 8. Defects / backlog

**P0: none. P1: none. P2: none.** Release gate not blocked.

| Severity | ID | Observation | Suggested owner |
| --- | --- | --- | --- |
| P3 | E-P3-a | Fresh `pnpm install --frozen-lockfile` emits 4× `[WARN] Failed to create bin …bin.js.EXE (ENOENT)` — pnpm links workspace bins before `pnpm run build` produces `apps/cli/lib/bin.js`. Non-blocking (env.ps1/env.sh define `dsh` against the path directly; a post-install run links fine). Cosmetic noise on every fresh install | backlog (coder) |
| P3 | E-P3-b | Task-card wording `powershell -File .\install.cmd` cannot work (`-File` requires `.ps1`); the README instruction `.\install.cmd` is correct. Documentation nuance only — no repo change required | recorded, no action |

Non-defect confirmations: unauthenticated `/` → 401 is the designed auth model; `dump-config` materializing `insert` rows is the documented renderer behavior.

## 9. Conclusion

The published zDSH-Go repository passes full fresh-clone acceptance: clone → install (exit 0) → run (healthy listener, clean logs, working token→cookie auth) → 9/9 live probes PASS → uninstall (exit 0, correct REMAINS semantics, `$HOME` untouched) → clean teardown. The README Quick Start is accurate and reproducible as written. **Recommendation to ops: release gate cleared.**
