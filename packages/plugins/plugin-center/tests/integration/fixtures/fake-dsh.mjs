/**
 * Minimal stand-in for the official `dsh` CLI used by integration tests.
 *
 * Supported surface (argv shape mirrors the real command):
 *   node fake-dsh.mjs plugin --profile <dir> add    <git+https://...#sha | name@version>
 *   node fake-dsh.mjs plugin --profile <dir> remove <pkg>
 *
 * Behavior: mutates <dir>/package.json dependencies and materializes a
 * node_modules/<pkg>/package.json marker. FAKE_DSH_MODE=fail exits non-zero
 * before touching anything so rollback paths can be exercised.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
if (process.env.FAKE_DSH_MODE === 'fail') {
  console.error('fake-dsh: forced failure');
  process.exit(1);
}

function fail(message) {
  console.error(`fake-dsh: ${message}`);
  process.exit(2);
}

const pluginIndex = argv.indexOf('plugin');
if (pluginIndex === -1 || argv[pluginIndex + 1] !== '--profile') fail('expected: plugin --profile <dir>');
const profileDir = argv[pluginIndex + 2];
const verb = argv[pluginIndex + 3];
const operand = argv[pluginIndex + 4];
if (!profileDir || !existsSync(profileDir)) fail(`profile dir missing: ${String(profileDir)}`);
if (!operand) fail('missing target operand');

function parseTarget(target) {
  const gitMatch = target.match(/^git\+https:\/\/github\.com\/([^/]+)\/([^/]+)\.git#([0-9a-f]{40})$/);
  if (gitMatch) {
    return { name: gitMatch[2], reference: gitMatch[3].slice(0, 10) };
  }
  const at = target.lastIndexOf('@');
  if (at > 0) return { name: target.slice(0, at), reference: target.slice(at + 1) };
  return { name: target, reference: '*' };
}

const pkgPath = join(profileDir, 'package.json');
const manifest = JSON.parse(readFileSync(pkgPath, 'utf8'));
manifest.dependencies = manifest.dependencies ?? {};
const markerRoot = join(profileDir, 'node_modules');

if (verb === 'add') {
  const { name, reference } = parseTarget(operand);
  manifest.dependencies[name] = reference;
  const markerDir = join(markerRoot, name);
  mkdirSync(markerDir, { recursive: true });
  writeFileSync(join(markerDir, 'package.json'), JSON.stringify({ name, version: reference }), 'utf8');
  writeFileSync(pkgPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  process.exit(0);
}

if (verb === 'remove') {
  delete manifest.dependencies[operand];
  writeFileSync(pkgPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  rmSync(join(markerRoot, operand), { recursive: true, force: true });
  process.exit(0);
}

fail(`unknown verb: ${String(verb)}`);
