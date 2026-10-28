#!/usr/bin/env node
/**
 * Re-apply the installed-badge patch to the profile's dsh-hub client bundle.
 *
 * WHY THIS EXISTS: dsh-hub is a third-party marketplace plugin (sliverp/
 * dsh-hub-plugin) whose client bundle has no installed-state awareness — every
 * catalog card renders the "交给 DSH 安装" button whether or not the plugin is
 * already installed. The upstream repo is not ours to push, so the patch lives
 * here and must be re-applied whenever a pnpm operation or a pin rotation
 * reinstalls the plugin under `data/profiles/web/node_modules/dsh-hub`.
 *
 * WHAT IT DOES (idempotent): reads the installed `lib/client.js`, and when the
 * `installedBadge` marker is absent, (1) adds the zh/en dictionary entries,
 * (2) threads an `installedNames` face through Marketplace — the card grid
 * joins `plugin.name`/`plugin.fullName` against the Host's installed bundles
 * (`remote.pluginManager.listBundles`) and governed roster
 * (`remote.pluginGovernance.list`), rendering a green 已安装/Installed badge
 * and disabling the install button for rows that are already on the box.
 *
 * USAGE: node scripts/reapply-dsh-hub-installed-badge.mjs [--check]
 *   --check  report whether the patch is present without writing.
 * Exit 0 = patched (or already patched); exit 1 = anchor mismatch or missing
 * file, which means upstream changed and this script needs rework.
 */

import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const target = join(repoRoot, 'data', 'profiles', 'web', 'node_modules', 'dsh-hub', 'lib', 'client.js')
const MARKER = 'installedBadge'
const checkOnly = process.argv.includes('--check')

if (!existsSync(target)) {
  console.error(`reapply: ${target} does not exist; is dsh-hub installed in the web profile?`)
  process.exit(1)
}

let text = readFileSync(target, 'utf8')
if (text.includes(MARKER)) {
  console.log('reapply: dsh-hub client already carries the installed-badge patch; nothing to do')
  process.exit(0)
}

const original = text
let failed = null
const replace = (oldText, newText, label) => {
  if (failed !== null) return
  const count = text.split(oldText).length - 1
  if (count !== 1) {
    failed = `${label}: anchor found ${count} times (expected 1); upstream moved — rework this script against the new bundle`
    return
  }
  text = text.replace(oldText, newText)
}

// 1. Dictionary entries (zh + en).
replace('install: "交给 DSH 安装",', 'install: "交给 DSH 安装",\n\t\t\t\tinstalledBadge: "已安装",', 'zh dictionary')
replace('install: "Install with DSH",', 'install: "Install with DSH",\n\t\t\t\tinstalledBadge: "Installed",', 'en dictionary')

// 2. Marketplace signature + the installed-name state (loaded once per mount).
replace('function Marketplace({ install }) {', 'function Marketplace({ install, installedNames }) {', 'Marketplace signature')
const stateAnchor = '\t\t\tconst [sending, setSending] = (0, react.useState)(null);\n\t\t\tconst [feedback, setFeedback] = (0, react.useState)(null);'
replace(stateAnchor, `${stateAnchor}
			const [installed, setInstalled] = (0, react.useState)(() => new Set());
			(0, react.useEffect)(() => {
				let alive = true;
				Promise.resolve().then(installedNames).then((names) => {
					if (alive) setInstalled(names instanceof Set ? names : new Set());
				}, () => {});
				return () => { alive = false; };
			}, [installedNames]);`, 'installed state + effect')

// 3. Card map: block body computing isInstalled, closing adjusted, badge + button.
replace('state.page.items.map((plugin) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("article", {',
  'state.page.items.map((plugin) => {\n\t\t\t\t\t\t\tconst isInstalled = installed.has(String(plugin.name ?? "").toLowerCase()) || installed.has(String(plugin.fullName ?? "").toLowerCase());\n\t\t\t\t\t\t\treturn /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("article", {',
  'card map block body')
replace('}, plugin.id))', '}, plugin.id); \t\t\t\t\t\t})', 'map close')
const badgeAnchor = 'children: plugin.installability === "verified" ? dictionary.verified : plugin.installability === "candidate" ? dictionary.candidate : dictionary.topicOnly\n\t\t\t\t\t\t\t\t\t})]'
replace(badgeAnchor, `${badgeAnchor.slice(0, -1)}, isInstalled ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
\t\t\t\t\t\t\t\t\t\tclassName: "dsh-hub-badge",
\t\t\t\t\t\t\t\t\t\t"data-verified": "true",
\t\t\t\t\t\t\t\t\t\tchildren: dictionary.installedBadge
\t\t\t\t\t\t\t\t\t}) : null]`, 'installed badge')
replace('disabled: sending === plugin.id || plugin.installability === "unsupported",',
  'disabled: sending === plugin.id || plugin.installability === "unsupported" || isInstalled,', 'button disabled')
replace('children: plugin.installability === "unsupported" ? dictionary.unsupported : sending === plugin.id ? dictionary.sending : dictionary.install',
  'children: isInstalled ? dictionary.installedBadge : plugin.installability === "unsupported" ? dictionary.unsupported : sending === plugin.id ? dictionary.sending : dictionary.install', 'button label')

if (failed !== null) {
  console.error(`reapply: ${failed}`)
  process.exit(1)
}

// 4. apply(): the installed-names face — profile bundles joined with the
// governed roster, matched lowercase against the catalog row's repo name.
const applyAnchor = '\t\t\tctx.slots.inject("settings.section", () => ctx.slots.register({\n\t\t\t\tname: "settings.section",\n\t\t\t\tid: "dsh-hub",'
const faceHelper = `\t\t\tconst loadInstalledNames = async () => {
\t\t\t\tconst names = new Set();
\t\t\t\tconst unwrap = (answer) => (answer !== null && typeof answer === "object" && "ok" in answer ? (answer.ok === true ? answer.value : null) : answer);
\t\t\t\ttry {
\t\t\t\t\tconst value = unwrap(await ctx.remote.pluginManager.listBundles());
\t\t\t\t\tif (Array.isArray(value)) for (const row of value) {
\t\t\t\t\t\tif (typeof row?.name === "string") names.add(row.name.toLowerCase());
\t\t\t\t\t\tif (typeof row?.meta?.name === "string") names.add(row.meta.name.toLowerCase());
\t\t\t\t\t}
\t\t\t\t} catch {}
\t\t\t\ttry {
\t\t\t\t\tconst value = unwrap(await ctx.remote.pluginGovernance.list());
\t\t\t\t\tconst plugins = value?.plugins;
\t\t\t\t\tif (Array.isArray(plugins)) for (const row of plugins) {
\t\t\t\t\t\tif (typeof row?.pluginId === "string") {
\t\t\t\t\t\t\tnames.add(row.pluginId.toLowerCase());
\t\t\t\t\t\t\tconst slash = row.pluginId.indexOf("/");
\t\t\t\t\t\t\tif (slash >= 0) names.add(row.pluginId.slice(slash + 1).toLowerCase());
\t\t\t\t\t\t}
\t\t\t\t\t\tif (typeof row?.displayName === "string") names.add(row.displayName.toLowerCase());
\t\t\t\t\t}
\t\t\t\t} catch {}
\t\t\t\treturn names;
\t\t\t};
${applyAnchor}`
replace(applyAnchor, faceHelper, 'installed-names face')
replace(', () => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Marketplace, { install })));',
  ', () => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Marketplace, { install, installedNames: loadInstalledNames })));', 'Marketplace wiring')

if (failed !== null) {
  console.error(`reapply: ${failed}`)
  process.exit(1)
}

if (checkOnly) {
  console.log('reapply: --check — the patch would apply cleanly (not written)')
  process.exit(0)
}

// Atomic replace: write a sibling temp file, then rename over the target.
const staging = mkdtempSync(join(dirname(target), '.reapply-'))
const temp = join(staging, 'client.js')
writeFileSync(temp, text)
renameSync(temp, target)
rmSync(staging, { recursive: true, force: true })
console.log(`reapply: patched ${target} (${original.length} -> ${text.length} bytes)`)
console.log('reapply: reload the web client (or restart dsh web) to see the installed badges')
