#!/usr/bin/env node
/**
 * dsh-guard — DeepSeek Harness 统一守护件 (self-guarding middleware)
 *
 * 一个自包含文件，挂在 DSH profile 的 pnpm `prepare` 生命周期钩子上，
 * 每次任何插件 install / upgrade / remove 之后自动运行，检测并修复
 * DSH 插件生态的已知破坏模式（核心包重复副本、组合树 double-mount 等）。
 *
 * 设计原则：
 *  - 全部修改之前先备份（改名而非删除），可随时回滚
 *  - fail-closed：任何一步失败，不产生部分修改，只报错退出
 *  - 幂等：反复运行无副作用（没有偏差就不动）
 *  - 只动 DSH profile 层，绝不触碰官方核心（profiles/node_modules 的 junction 链）
 *  - 跨平台：junction 用 Node 原生 symlink(..., 'junction')（Windows=junction, POSIX=symlink）
 *
 * 用法：
 *   node dsh-guard.mjs install   [--profile <name>]  安装：注册 prepare 钩子
 *   node dsh-guard.mjs uninstall [--profile <name>]  卸载：移除钩子（保留备份与修复逻辑）
 *   node dsh-guard.mjs check     [--profile <name>]  只读体检：报告偏差，不修改
 *   node dsh-guard.mjs fix       [--profile <name>]  修复：发现偏差则备份后修复
 *   node dsh-guard.mjs status    [--profile <name>]  查看钩子与规则状态
 *   node dsh-guard.mjs --help
 *
 * 环境变量：
 *   DSH_GUARD_BACKUP_DIR  备份目录（默认 <profile>/.dsh-guard-backup/<ts>）
 *   DSH_GUARD_SKIP_BACKUP  任意非空值 = 跳过备份（不推荐，仅测试）
 */
"use strict";

import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync,
         statSync, lstatSync, symlinkSync, renameSync } from "node:fs";
import { zstdDecompressSync } from "node:zlib";
import { join, dirname, basename, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const SELF = fileURLToPath(import.meta.url);
const VERSION = "0.1.0";

/* ------------------------------------------------------------------ *
 * 常量与已知知识
 * ------------------------------------------------------------------ */

/** 必须由官方内核层提供、绝不允许在 profile 层出现真实副本的核心包。
 *  这些包在 profiles/node_modules 是 junction → npm-cache；若在
 *  profiles/<name>/node_modules/@deepseek-ai 下出现真实目录副本，
 *  会产生模块级 Symbol 隔离，触发 run_code 的 scheduler.prepare 崩溃。 */
const CORE_BUNDLES = [
  "dsh-tools",
  "dsh-credentials",
  "dsh-settings",
  "dsh-llm-deepseek",
  "dsh-anonymous-user-id",
  "cosmokit",
  "schemastery",
];

/** 已知 double-mount 冲突规则表（可幂等增补）。
 *  entryId: 聚合 patch 引入的重复条目 id；
 *  name: 该条目指向的插件名（用于验证仍指向同一插件才禁用）。 */
const KNOWN_DOUBLE_MOUNTS = [
  { entryId: "web-ui-better-sidebar", name: "dsh-better-sidebar",
    why: "@linxin666/dsh-web-ui-all 聚合 patch 重复挂载已单独安装的 dsh-better-sidebar" },
];

const SESSION_LOG = "session.jsonl.zstd";
const GUARD_MARK = "# dsh-guard (auto-managed)";

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

function log(level, msg) {
  const t = new Date().toISOString();
  process.stdout.write(`[dsh-guard ${t}] ${level.toUpperCase()} ${msg}\n`);
}
function warn(msg) { log("warn", msg); }
function info(msg) { log("info", msg); }
function error(msg) { log("error", msg); }

/** 找 DSH_HOME（.dsh 根目录）。WSL/Windows 双环境皆可。
 * 优先级：显式 DSH_HOME > WSL Windows 侧 ~/.dsh > USERPROFILE > 原生 ~/.dsh */
function findDshHome() {
  if (process.env.DSH_HOME && existsSync(process.env.DSH_HOME)) return resolve(process.env.DSH_HOME);
  const candidates = [];
  if (process.env.USERPROFILE) candidates.push(join(process.env.USERPROFILE, ".dsh")); // WSL 取 Windows 用户
  // WSL 下的 Windows 侧常见位置
  if (process.env.WSL_DISTRO_NAME && existsSync("/mnt/c/Users")) {
    for (const u of readdirSync("/mnt/c/Users")) {
      const p = join("/mnt/c/Users", u, ".dsh");
      if (existsSync(join(p, "profiles"))) candidates.unshift(p); // 有 profiles 的优先
    }
  }
  candidates.push(join(homedir(), ".dsh")); // 原生(WSL: /home/z)
  for (const cand of candidates) {
    if (cand && existsSync(cand)) return resolve(cand);
  }
  throw new Error("找不到 DSH 数据目录（DSH_HOME 或 ~/.dsh / %USERPROFILE%\\.dsh）。");
}

/** 定位 profile 目录；支持名字（web）或绝对路径。 */
function resolveProfile(dir, dshHome) {
  if (!dir) dir = "web";                       // 默认 profile
  const p = isAbsolute(dir) ? dir : join(dshHome, "profiles", dir);
  if (!existsSync(join(p, "package.json"))) throw new Error(`profile 不存在: ${p}`);
  return p;
}

/** 判断 path 是否是符号链接/junction（lstat 语义，不跟随）。 */
function isSymlink(p) {
  try { return lstatSync(p).isSymbolicLink(); } catch { return false; }
}

/** 复制文件。WSL 下 node:fs 的 copyFileSync 在 9p 挂载上可能 EPERM
 * （copy_file_range 不被 drvfs 支持），改用 read+write 稳妥复制。 */
function copyFileSafe(src, dest) {
  writeFileSync(dest, readFileSync(src));
}

/* ------------------------------------------------------------------ *
 * 守卫阶段 1：核心包重复副本 ↔ junction 一致性
 * ------------------------------------------------------------------ */

/**
 * 检查 profile 层的 @deepseek-ai 核心包：
 * 返回需要修复的列表 [{ pkg, realDir, officialDir }] —— 即"真实目录副本、且官方层存在 junction 目标"。
 * 只读。
 */
function scanCoreDuplicates(profileDir, dshHome) {
  const issues = [];
  const profileAi = join(profileDir, "node_modules", "@deepseek-ai");
  const officialAi = join(dshHome, "profiles", "node_modules", "@deepseek-ai");
  if (!existsSync(profileAi)) return issues;           // profile 层没有 @deepseek-ai → 正常
  for (const pkg of CORE_BUNDLES) {
    const real = join(profileAi, pkg);
    if (!existsSync(real)) continue;                    // 不存在 = 正常（靠官方层解析）
    if (isSymlink(real)) continue;                      // junction/symlink = 正常
    const official = join(officialAi, pkg);
    if (!existsSync(official)) { warn(`官方层缺少 ${pkg}，跳过（勿动）`); continue; }
    issues.push({ pkg, realDir: real, officialDir: official,
                  realVersion: readPkgVersion(real), officialVersion: readPkgVersion(official) });
  }
  return issues;
}
function readPkgVersion(dir) {
  try { return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version ?? "?"; }
  catch { return "?"; }
}

/** 修复：真实目录 → 改名备份 + 建 junction 指向官方层。返回 [{backup, link}]。 */
function fixCoreDuplicates(issues, profileDir) {
  const backupRoot = backupDir(profileDir);
  const done = [];
  for (const it of issues) {
    if (it.realVersion === it.officialVersion && !forceJunction()) {
      // 版本相同：理论上无需 junction，但官方设计要求唯一物理实例 → 仍修复指向官方层。
    }
    const ts = Date.now();
    const backup = join(backupRoot, `pkg-${it.pkg}-real-v${it.realVersion}-${ts}`);
    mkdirSync(backup, { recursive: true });
    renameSync(it.realDir, join(backup, basename(it.realDir)));   // 改名移出（不删除）
    symlinkSync(resolve(it.officialDir), it.realDir, "junction"); // Windows junction / POSIX symlink
    done.push({ pkg: it.pkg, backup, from: it.realVersion, to: it.officialVersion });
    info(`修复: ${it.pkg} ${it.realVersion} → junction 指向官方 ${it.officialVersion}（备份 ${backup}）`);
  }
  return done;
}
function forceJunction() { return process.env.DSH_GUARD_FORCE_JUNCTION === "1"; }

/* ------------------------------------------------------------------ *
 * 守卫阶段 2：组合树 double-mount 守护
 * ------------------------------------------------------------------ */

/** 检查已知 double-mount 条目是否已被 profile 层禁用；返回需要补充禁用的列表。 */
function scanDoubleMounts(profileDir) {
  const patchFile = join(profileDir, "cordis.patch.yml");
  let patchText = "";
  if (existsSync(patchFile)) patchText = readFileSync(patchFile, "utf8");
  const missing = [];
  for (const rule of KNOWN_DOUBLE_MOUNTS) {
    // 已存在该条目的 disabled 块？
    const re = new RegExp(`-\\s*id:\\s*${escapeRegExp(rule.entryId)}\\s*\\n[ \\t]+disabled:\\s*true`);
    if (re.test(patchText)) continue;             // 已禁用 ✓
    // 指向的插件是否真实存在（避免给不存在的插件禁用）
    if (!existsSync(join(profileDir, "node_modules", rule.name))) continue;
    missing.push(rule);
  }
  return missing;
}
function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

/** 追加禁用块（幂等：已存在则不动）。返回变更描述。 */
function applyDoubleMountFixes(rules, profileDir) {
  const patchFile = join(profileDir, "cordis.patch.yml");
  const backupRoot = backupDir(profileDir);
  const applied = [];
  const patchExists = existsSync(patchFile);
  let text = patchExists ? readFileSync(patchFile, "utf8") : "";
  for (const rule of rules) {
    const re = new RegExp(`-\\s*id:\\s*${escapeRegExp(rule.entryId)}\\s*\\n[ \\t]+disabled:\\s*true`);
    if (re.test(text)) continue;
    const block = `\n${GUARD_MARK} disabled ${rule.entryId}\n# ${rule.why}\n- id: ${rule.entryId}\n  disabled: true\n`;
    if (!text.endsWith("\n")) text += "\n";
    if (patchExists) {
      const backup = join(backupRoot, `patch-${rule.entryId}-${Date.now()}`);
      mkdirSync(backup, { recursive: true });
      copyFileSafe(patchFile, join(backup, "cordis.patch.yml")); // 有原件才备份
    }
    writeFileSync(patchFile, text + block, "utf8");
    applied.push({ entryId: rule.entryId });
    info(`组合树守护: 已禁用重复条目 ${rule.entryId}（${patchExists ? "已备份" : "新建 patch 文件"}）`);
  }
  return applied;
}

/* ------------------------------------------------------------------ *
 * 守卫阶段 3：格式巡检（只报告，不擅自改数据）
 * ------------------------------------------------------------------ */

/** 扫描 sessions 目录下列出的 session.jsonl.zstd，校验首帧是否为恰一行 header。 */
function scanSessionLogs(dshHome) {
  const sessionsRoot = join(dshHome, "sessions");
  if (!existsSync(sessionsRoot)) return [];
  const bad = [];
  const walk = (dir) => {
    for (const ent of readdirSync(dir)) {
      const p = join(dir, ent);
      if (!statSync(p).isDirectory()) continue;
      const logFile = join(p, SESSION_LOG);
      if (existsSync(logFile)) {
        const ok = checkZstdFirstFrame(logFile);
        if (!ok) bad.push(logFile);
      } else walk(p);
    }
  };
  walk(sessionsRoot);
  return bad;
}
/** 校验 zstd session 首帧：必须是"恰好一行、以换行结尾"的 header（与 DSH 的
 * assertZstdHeaderFrame 语义一致：plaintext.indexOf(10) === length-1）。
 * 用 node:zlib 真实解压第一帧（zstdDecompressSync 只解第一帧）。 */
function checkZstdFirstFrame(path) {
  try {
    const buf = readFileSync(path);
    if (buf.length === 0) return false;
    const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
    if (buf.indexOf(MAGIC) !== 0) return false;                    // 非 zstd
    // 解第一帧（node:zlib 对多帧输入只解首帧；对完整单帧输入则全部解出）
    let plain;
    try { plain = zstdDecompressSync(buf); }
    catch { return false; }                                        // 解不了 = 损坏
    return plain.length > 0 && plain.indexOf(10) === plain.length - 1;
  } catch { return false; }
}

/* ------------------------------------------------------------------ *
 * 备份 / 生命周期
 * ------------------------------------------------------------------ */

function backupDir(profileDir) {
  const root = process.env.DSH_GUARD_BACKUP_DIR
    ? resolve(process.env.DSH_GUARD_BACKUP_DIR)
    : join(profileDir, ".dsh-guard-backup", new Date().toISOString().replace(/[:.]/g, "-"));
  if (process.env.DSH_GUARD_SKIP_BACKUP) return null;
  return root;
}

/* ------------------------------------------------------------------ *
 * prepare 钩子注册（install/update）与移除（uninstall）
 * ------------------------------------------------------------------ */

function readManifest(profileDir) {
  const p = join(profileDir, "package.json");
  return { path: p, json: JSON.parse(readFileSync(p, "utf8")) };
}

/** 计算写进 prepare 钩子的脚本路径（必须对"真实执行方"有效）。
 *  - DSH 的 pnpm 跑在 Windows → 需要 Windows 盘符路径
 *  - 若本文件以 WSL 路径 (/mnt/<drv>/...) 存在且当前在 WSL，自动翻译为 <drv>:\...
 *  - 运行在原生 Windows 时直接用自身路径
 *  - 可用 DSH_GUARD_HOOK_CMD 显式覆盖（如安装在其他盘符/UNC）
 */
function hookTarget() {
  if (process.env.DSH_GUARD_HOOK_CMD) return process.env.DSH_GUARD_HOOK_CMD;
  const m = /^\/mnt\/([a-zA-Z])\//.exec(SELF);
  if (m && process.env.WSL_DISTRO_NAME) {
    const drive = m[1].toUpperCase();
    const rest = SELF.slice(m[0].length);
    return `${drive}:\\${rest.replace(/\//g, "\\")}`;
  }
  return SELF;
}

/** package.json 注入 prepare 钩子，指向本文件。返回是否变化。 */
function installHook(profileDir) {
  const { path, json } = readManifest(profileDir);
  const hookCmd = `node ${quoteWin(hookTarget())}`;
  const scripts = (json.scripts ??= {});
  if (scripts.prepare === hookCmd) { info("prepare 钩子已存在，幂等跳过"); return false; }
  const backup = backupDir(profileDir);
  if (backup) { mkdirSync(backup, { recursive: true }); copyFileSafe(path, join(backup, "package.json.orig")); }
  const prev = scripts.prepare;
  scripts.prepare = hookCmd;
  writeFileSync(path, JSON.stringify(json, null, 2) + "\n", "utf8");
  info(`已注册 prepare 钩子${prev ? `（原: ${prev}）` : ""} ${prev ? `；备份 ${backup}` : ""} → ${hookCmd}`);
  return true;
}
/** 移除 prepare 钩子（保留其他 scripts）。返回是否变化。 */
function uninstallHook(profileDir) {
  const { path, json } = readManifest(profileDir);
  const scripts = json.scripts ?? {};
  const hookCmd = `node ${quoteWin(hookTarget())}`;
  if (scripts.prepare !== hookCmd) { info("未发现 dsh-guard 钩子，无需卸载"); return false; }
  const backup = backupDir(profileDir);
  if (backup) { mkdirSync(backup, { recursive: true }); copyFileSafe(path, join(backup, "package.json.orig")); }
  delete scripts.prepare;
  if (Object.keys(scripts).length === 0) delete json.scripts;
  writeFileSync(path, JSON.stringify(json, null, 2) + "\n", "utf8");
  info(`已移除 prepare 钩子${backup ? `；备份 ${backup}` : ""}`);
  return true;
}
/** Windows 路径带空格时加引号。 */
function quoteWin(p) { return /[\s]/.test(p) ? `"${p}"` : p; }

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

function usage() {
  process.stdout.write(`dsh-guard v${VERSION} — DeepSeek Harness 统一守护件

用法:
  node dsh-guard.mjs install   [--profile <name|绝对路径>]   注册 prepare 钩子 + 立即 fix
  node dsh-guard.mjs uninstall [--profile <name|绝对路径>]   移除 prepare 钩子
  node dsh-guard.mjs check     [--profile <name|绝对路径>]   只读体检（报告偏差，不改动）
  node dsh-guard.mjs fix       [--profile <name|绝对路径>]   备份后修复所有偏差
  node dsh-guard.mjs status    [--profile <name|绝对路径>]   查看钩子/守护状态
  node dsh-guard.mjs --help

钩子生命周期: dsh plugin add/upgrade/remove 都会触发 pnpm install，
pnnp install 完成后自动执行本文件的 fix（幂等，无偏差则静默）。

环境变量:
  DSH_GUARD_BACKUP_DIR   自定义备份根目录（默认 <profile>/.dsh-guard-backup/<ts>）
  DSH_GUARD_SKIP_BACKUP  =1 跳过备份（仅测试，不推荐）
  DSH_GUARD_FORCE_JUNCTION =1 即使版本相同也强制 junction（默认：版本相同且指向官方层时仍建）
`);
}

function parseArgs(argv) {
  const out = { cmd: "fix", profile: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (["install", "uninstall", "check", "fix", "status", "--help", "-h", "help"].includes(a)) {
      out.cmd = a === "-h" || a === "--help" || a === "help" ? "help" : a;
    } else if (a === "--profile") { out.profile = argv[++i]; }
    else if (a.startsWith("--profile=")) { out.profile = a.slice(10); }
    else if (a.startsWith("-")) { /* 忽略未知 flag */ }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.cmd === "help") { usage(); process.exit(0); }

  const dshHome = findDshHome();
  let profileDir;
  try { profileDir = resolveProfile(args.profile, dshHome); }
  catch (e) { error(e.message); process.exit(2); }

  info(`DSH_HOME=${dshHome}`);
  info(`profile=${profileDir}`);

  try {
    switch (args.cmd) {
      case "install": {
        installHook(profileDir);
        info("install: 执行首次体检+修复…");
        await runFix(profileDir, dshHome);
        break;
      }
      case "uninstall": {
        uninstallHook(profileDir);
        break;
      }
      case "check": {
        const r = await runCheck(profileDir, dshHome);
        report(r);
        const hasIssue = r.core.length || r.doubles.length || r.sessions.length;
        process.exit(hasIssue ? 1 : 0);
        break;
      }
      case "status": {
        status(profileDir);
        break;
      }
      case "fix":
      default: {
        await runFix(profileDir, dshHome);
      }
    }
  } catch (e) {
    // fail-closed：任何异常 → 不产生部分修改风险已由"先全量扫描再统一修复"保证；
    // 这里兜底报错退出。
    error(`守护执行异常，未继续修改: ${e.message}`);
    if (process.env.DSH_GUARD_DEBUG) console.error(e);
    process.exit(3);
  }
}

async function runCheck(profileDir, dshHome) {
  const core = scanCoreDuplicates(profileDir, dshHome);
  const dm = scanDoubleMounts(profileDir);
  const sl = process.env.DSH_GUARD_CHECK_SESSIONS === "1" ? scanSessionLogs(dshHome) : [];
  return { core, doubles: dm, sessions: sl };
}
function report(r) {
  if (!r.core.length && !r.doubles.length && !r.sessions.length) { info("体检通过：无偏差"); return; }
  if (r.core.length) {
    warn("核心包重复副本（需 junction 修复）:");
    for (const c of r.core) error(`  ${c.pkg}: profile=${c.realVersion} / 官方=${c.officialVersion} @ ${c.realDir}`);
  }
  if (r.doubles.length) {
    warn("组合树 double-mount（需追加 disabled）:");
    for (const d of r.doubles) error(`  ${d.entryId} → ${d.name}（${d.why}）`);
  }
  if (r.sessions.length) {
    warn("session 日志 zstd 首帧异常（仅报告，未改动）:");
    for (const s of r.sessions) error(`  ${s}`);
  }
}
async function runFix(profileDir, dshHome) {
  const core = scanCoreDuplicates(profileDir, dshHome);
  const dm = scanDoubleMounts(profileDir);
  const sl = process.env.DSH_GUARD_FIX_SESSIONS === "1" ? scanSessionLogs(dshHome) : [];
  if (!core.length && !dm.length && !sl.length) { info("unclean 检查通过：无需修复"); return 0; }
  if (core.length) fixCoreDuplicates(core, profileDir);
  if (dm.length) applyDoubleMountFixes(dm, profileDir);
  if (sl.length) warn(`session 日志异常 ${sl.length} 个（需人工处理，dsh-guard 不擅自改写数据）`);
  info("fix 完成");
  return 0;
}
function status(profileDir) {
  const { json } = readManifest(profileDir);
  const hook = (json.scripts ?? {}).prepare;
  info(`prepare 钩子: ${hook ?? "(未注册)"}`);
  const backupRoot = join(profileDir, ".dsh-guard-backup");
  if (existsSync(backupRoot)) info(`历史备份目录: ${backupRoot}（${readdirSync(backupRoot).length} 次）`);
  const core = scanCoreDuplicates(profileDir, findDshHome());
  info(`核心包重复副本: ${core.length ? core.map(c=>c.pkg).join(", ") : "无 ✓"}`);
  const dm = scanDoubleMounts(profileDir);
  info(`待禁用的 double-mount: ${dm.length ? dm.map(d=>d.entryId).join(", ") : "无 ✓"}`);
}

main();
