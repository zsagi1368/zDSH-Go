// Architecture boundary + originality guard for zdsh-autopilot.
//
// Rule 1 (originality): the source tree must never reference or depend on
//   third-party DSH plugin packages. This project is standalone by design.
// Rule 2 (facade): capability modules may import the kernel facade and
//   themselves — never each other. The kernel never imports modules upward.
//
// Run: node scripts/check-boundaries.mjs   (wired into `pnpm lint`)

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const BANNED_SUBSTRINGS = [
  'dsh-client-auto-continue',
  'dsh-auto-review',
  'dsh-auto-mode',
  '@nanmicoder',
];

const MODULES = ['kernel', 'shared-client', 'continue', 'guard', 'review', 'console'];
const SCAN_DIRS = ['src', 'tests', 'eval', 'corpus', 'scripts', 'bin'];
const EXTS = ['.ts', '.tsx', '.mts', '.mjs'];

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) yield* walk(p);
    else if (EXTS.some((e) => entry.endsWith(e))) yield p;
  }
}

const problems = [];

// --- Rule 1: third-party dependency guard ----------------------------------
const SELF = join(root, 'scripts', 'check-boundaries.mjs');
for (const dir of SCAN_DIRS) {
  for (const file of walk(join(root, dir))) {
    if (file === SELF) continue; // this checker quotes the banned names by definition
    const text = readFileSync(file, 'utf8');
    for (const banned of BANNED_SUBSTRINGS) {
      if (text.includes(banned)) {
        problems.push(
          `originality: ${relative(root, file)} references banned third-party identifier "${banned}"`,
        );
      }
    }
  }
}

// --- Rule 2: module boundary guard -----------------------------------------
// Collect relative-import edges between files under src/.
const srcFiles = [...walk(join(root, 'src'))];
const importRe = /(?:from\s+|import\s*\(\s*)['"](\.\.?\/[^'"]+)['"]/g;

function moduleOf(file) {
  const rel = relative(join(root, 'src'), file);
  const top = rel.split(sep)[0] ?? '';
  return MODULES.includes(top) ? top : '(root)';
}

function resolveImport(fromFile, spec) {
  const base = resolve(dirname(fromFile), spec);
  for (const candidate of [
    base,
    ...EXTS.map((e) => base + e),
    ...EXTS.map((e) => join(base, 'index' + e)),
  ]) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      /* keep probing */
    }
  }
  return null;
}

function edgeAllowed(fromMod, toMod) {
  if (fromMod === toMod) return true;
  // Any module may depend on the kernel or the shared client leaf; nothing
  // may depend downward on them except as explicitly listed here.
  if (toMod === 'kernel' || toMod === 'shared-client') return true;
  if (fromMod === 'kernel' || fromMod === 'shared-client') return false;
  // Capability modules must not import each other; console is reached via
  // src/index.ts composition only.
  return false;
}

for (const file of srcFiles) {
  const text = readFileSync(file, 'utf8');
  const fromMod = moduleOf(file);
  for (const match of text.matchAll(importRe)) {
    const target = resolveImport(file, match[1]);
    if (!target || !target.startsWith(join(root, 'src') + sep)) continue;
    const toMod = moduleOf(target);
    if (!edgeAllowed(fromMod, toMod)) {
      problems.push(
        `boundary: ${relative(root, file)} (${fromMod}) imports ${relative(root, target)} (${toMod}) — not allowed by the facade rule`,
      );
    }
  }
}

if (problems.length > 0) {
  console.error('check-boundaries failed:\n' + problems.map((p) => `  - ${p}`).join('\n'));
  process.exit(1);
}
console.log(`check-boundaries OK (${srcFiles.length} source files scanned)`);
