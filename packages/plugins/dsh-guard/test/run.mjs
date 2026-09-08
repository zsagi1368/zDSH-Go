#!/usr/bin/env node
/**
 * dsh-guard 自动化测试 —— 在临时目录构造模仿 DSH 结构的 fixture，
 * 不触碰真实 profile。用法：node test/run.mjs
 */
"use strict";

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync,
         readdirSync, rmSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const PROJECT = fileURLToPath(new URL("..", import.meta.url));
const GUARD = join(PROJECT, "dsh-guard.mjs");

let passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}`); }
}

/** 构造一个迷你 DSH 树 fixture，返回其 dshRoot。 */
function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), "dsh-guard-test-"));
  const profiles = join(root, "profiles");
  const web = join(profiles, "web");
  const officialAi = join(profiles, "node_modules", "@deepseek-ai");
  const webAi = join(web, "node_modules", "@deepseek-ai");
  mkdirSync(officialAi, { recursive: true });
  mkdirSync(webAi, { recursive: true });
  // 注意：不在此处创建 dsh-better-sidebar —— T1/T2 需要 true-clean；
  // double-mount 偏差在 T3 前显式制造（见下）
  // 官方层核心包（真实目录）
  for (const pkg of ["dsh-tools", "cosmokit", "schemastery"]) {
    const p = join(officialAi, pkg);
    mkdirSync(p, { recursive: true });
    writeFileSync(join(p, "package.json"), JSON.stringify({ name: pkg, version: "0.1.0-rc.7" }));
  }
  // profile package.json
  writeFileSync(join(web, "package.json"), JSON.stringify({ name: "dsh-profile-web", scripts: {} }));
  // cordis.patch.yml（空初始）
  writeFileSync(join(web, "cordis.patch.yml"), "# fixture\n");
  return { root, web };
}

function run(args, env = {}) {
  return spawnSync("node", [GUARD, ...args], {
    encoding: "utf8", env: { ...process.env, DSH_HOME: fixture.root, ...env } });
}

const fixture = makeFixture();
const { root, web } = fixture;
console.log(`fixture: ${root}`);

// --- T1: clean check pass ---
console.log("\nT1: clean fixture check 应通过");
let r = run(["check", "--profile", web]);
ok(r.status === 0, "clean check exit 0（无偏差）");
ok(/体检通过/.test(r.stdout), "输出含 体检通过");

// --- T2: 制造核心包重复副本（rc.6 真实目录）→ check 检出 → fix 修复 ---
console.log("\nT2: 核心包重复副本 检出+修复");
const evil = join(web, "node_modules", "@deepseek-ai", "dsh-tools");
mkdirSync(evil, { recursive: true });
writeFileSync(join(evil, "package.json"), JSON.stringify({ name: "dsh-tools", version: "0.1.0-rc.6" }));
r = run(["check", "--profile", web]);
ok(r.status === 1, "有偏差时 check exit 1");
ok(/dsh-tools/.test(r.stdout), "报告 dsh-tools 偏差");
r = run(["fix", "--profile", web]);
ok(r.status === 0, "fix exit 0");
ok(/修复: dsh-tools/.test(r.stdout), "执行了 junction 修复");
// 修复后应是 junction/symlink
ok(lstatSync(evil).isSymbolicLink(), "修复后 dsh-tools 是 symlink/junction");
// 备份落在 <web>/.dsh-guard-backup/<ts>/{pkg-...} 下（backupDir 含 ts 层）
const backups = readdirSync(join(web, ".dsh-guard-backup"));
const nested = backups.flatMap(b => readdirSync(join(web, ".dsh-guard-backup", b)));
ok(nested.some(n => n.includes("pkg-dsh-tools")), "生成了 pkg-dsh-tools 备份");
// 幂等
r = run(["fix", "--profile", web]);
ok(/无需修复/.test(r.stdout), "二次 fix 幂等（无需修复）");

// --- T3: double-mount → check 检出 → fix 补 disabled ---
console.log("\nT3: double-mount 守护");
// 制造偏差：安装 dsh-better-sidebar（模拟已单独安装），且 profile 层无禁用
mkdirSync(join(web, "node_modules", "dsh-better-sidebar"), { recursive: true });
writeFileSync(join(web, "node_modules", "dsh-better-sidebar", "package.json"),
  JSON.stringify({ name: "dsh-better-sidebar", version: "0.13.0" }));
// 手动移除 profile 层已加的禁用（回到初始态）
writeFileSync(join(web, "cordis.patch.yml"), "# fixture\n");
r = run(["check", "--profile", web]);
ok(/web-ui-better-sidebar/.test(r.stdout), "check 检出 double-mount");
r = run(["fix", "--profile", web]);
const patchText = readFileSync(join(web, "cordis.patch.yml"), "utf8");
ok(/web-ui-better-sidebar[\s\S]*disabled: true/.test(patchText), "fix 追加 disabled 块");
r = run(["fix", "--profile", web]);
ok(/无需修复/.test(r.stdout), "二次 fix 幂等");

// --- T4: patch 文件不存在时的 fix（应能新建） ---
console.log("\nT4: 无 cordis.patch.yml 时 fix 应新建并追加");
writeFileSync(join(web, "cordis.patch.yml"), "# fixture\n");
rmSync(join(web, "cordis.patch.yml"));
r = run(["fix", "--profile", web]);
ok(r.status === 0, "无 patch 文件时 fix 不崩");
ok(existsSync(join(web, "cordis.patch.yml")), "创建了 cordis.patch.yml");
ok(/disabled: true/.test(readFileSync(join(web, "cordis.patch.yml"), "utf8")), "含禁用块");

// --- T5: install / uninstall 往返 ---
console.log("\nT5: install/status/uninstall");
r = run(["install", "--profile", web]);
ok(r.status === 0, "install exit 0");
let pkg = JSON.parse(readFileSync(join(web, "package.json"), "utf8"));
ok(pkg.scripts?.prepare, "install 注册了 prepare 钩子");
r = run(["status", "--profile", web]);
ok(/prepare 钩子/.test(r.stdout), "status 显示钩子");
r = run(["uninstall", "--profile", web]);
ok(r.status === 0, "uninstall exit 0");
pkg = JSON.parse(readFileSync(join(web, "package.json"), "utf8"));
ok(!pkg.scripts?.prepare, "uninstall 移除 prepare 钩子");

// --- 清理 ---
rmSync(root, { recursive: true, force: true });
console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed ? 1 : 0);
