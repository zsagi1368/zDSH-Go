#!/usr/bin/env bash
# zDSH-go upgrade: fetch the newest revision, verify the factory pins it will
# install, reinstall, and smoke-check that the host still boots.
#
# Usage:
#   ./scripts/upgrade.sh                 # pull, verify, install, smoke-check
#   ./scripts/upgrade.sh --check         # verify only, change nothing
#   ./scripts/upgrade.sh --force         # proceed with a dirty working tree
#   ./scripts/upgrade.sh --remote zshgo  # pull from a specific remote
#   ./scripts/upgrade.sh --branch main   # pull a specific branch
#   ./scripts/upgrade.sh --no-smoke      # skip the post-install boot check
#
# Why this is its own script instead of "git pull && install.sh": the failures
# that actually bite an upgrade are silent ones. Factory plugins are installed
# from git URLs pinned in TWO places (the bundle's dependency ref and the seed's
# entries[].pin), and a pin that drifted from its twin, or that trails the plugin
# repo's own fixes, does not fail the pull — it either fails deep inside pnpm or,
# worse, installs cleanly and boots with a plugin that cannot load. Both are
# cheap to see before the long install, so they are checked here first.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
SEED="$ROOT/zdsh-factory/seed.json"
BUNDLE="$ROOT/packages/zdsh/factory-bundle/package.json"

CHECK_ONLY=false
FORCE=false
SMOKE=true
REMOTE=""
BRANCH=""

while [ $# -gt 0 ]; do
  case "$1" in
    --check) CHECK_ONLY=true ;;
    --force) FORCE=true ;;
    --no-smoke) SMOKE=false ;;
    --remote) REMOTE="${2:-}"; shift ;;
    --branch) BRANCH="${2:-}"; shift ;;
    -h|--help) sed -n '2,14p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "[X] unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

say() { echo "$*"; }
die() { echo "[X] $*" >&2; exit 1; }

cd -- "$ROOT"

# ------------------------------------------------------------------ preflight

command -v git >/dev/null 2>&1 || die 'git was not found on PATH.'
command -v node >/dev/null 2>&1 || die 'Node.js was not found on PATH.'
command -v pnpm >/dev/null 2>&1 || die 'pnpm was not found on PATH. Enable it with: corepack enable pnpm'

[ -f "$SEED" ] || die "factory seed is missing: $SEED"
[ -f "$BUNDLE" ] || die "factory bundle manifest is missing: $BUNDLE"

say "zDSH-go upgrade"
say "Repository root: $ROOT"

if [ -n "$(git status --porcelain)" ]; then
  if [ "$FORCE" = true ]; then
    say '[!] Working tree has local changes; continuing because --force was given.'
  else
    die 'Working tree has local changes. Commit or stash them first, or re-run with --force.'
  fi
fi

# -------------------------------------------------------- pull (unless --check)

BEFORE="$(git rev-parse --short HEAD)"
if [ "$CHECK_ONLY" = true ]; then
  say "[1/4] --check given: skipping git pull (HEAD is $BEFORE)"
else
  say "[1/4] git pull"
  PULL_ARGS=(--ff-only)
  [ -n "$REMOTE" ] && PULL_ARGS+=("$REMOTE")
  [ -n "$BRANCH" ] && PULL_ARGS+=("$BRANCH")
  git pull "${PULL_ARGS[@]}"
fi
AFTER="$(git rev-parse --short HEAD)"
if [ "$BEFORE" = "$AFTER" ]; then
  say "      already at $AFTER"
else
  say "      $BEFORE -> $AFTER"
fi

# ---------------------------------------------------- factory pin verification

say '[2/4] Verifying factory pins'

# One pass over both carriers. Exit 2 means they disagree, which is fatal.
# Drift against a plugin repo tip is reported but never fatal: pinning behind a
# tip is a deliberate choice, and it is also how a fix that landed in a plugin
# repo fails to reach an install — worth seeing before the long install.
set +e
PIN_OUTPUT="$(node -e '
const fs = require("node:fs")
const { execFileSync } = require("node:child_process")
const seed = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
const bundle = JSON.parse(fs.readFileSync(process.argv[2], "utf8"))

const deps = Object.entries(bundle.dependencies || {})
  .filter(([, spec]) => typeof spec === "string" && spec.startsWith("git+"))
const rows = deps.map(([name, spec]) => {
  const hashAt = spec.indexOf("#")
  const url = (hashAt === -1 ? spec : spec.slice(0, hashAt)).replace(/^git\+/, "")
  const ref = hashAt === -1 ? "" : spec.slice(hashAt + 1)
  const entry = (seed.entries || []).find((e) => e.package === name)
  return { name, url, ref, seedPin: entry ? entry.pin : null }
})

const mismatched = rows.filter((r) => r.seedPin !== null && r.seedPin !== r.ref)
const unpinned = rows.filter((r) => r.seedPin === null)

console.log(`      ${rows.length} pinned plugin(s) across both carriers.`)
for (const r of unpinned) console.log(`      NOTE ${r.name}: no seed entry (bundle-only dependency)`)
for (const r of mismatched) {
  console.log(`      MISMATCH ${r.name}`)
  console.log(`        bundle: ${r.ref}`)
  console.log(`        seed:   ${r.seedPin}`)
}

if (mismatched.length > 0) {
  console.log("")
  console.log("      packages/zdsh/factory-bundle/package.json and zdsh-factory/seed.json")
  console.log("      must pin the same commit for the same package; a mismatch means the")
  console.log("      installer and the running host would load different builds.")
  process.exit(2)
}

for (const r of rows) {
  let tip = ""
  try {
    const out = execFileSync("git", ["ls-remote", r.url, "HEAD"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    })
    tip = out.trim().split(/\s+/)[0] || ""
  } catch {
    console.log(`      ?  ${r.name}: could not reach ${r.url}`)
    continue
  }
  if (!tip) console.log(`      ?  ${r.name}: remote reported no HEAD`)
  else if (tip === r.ref) console.log(`      ok ${r.name}`)
  else console.log(`      !  ${r.name}: pin ${r.ref.slice(0, 10)} trails repo tip ${tip.slice(0, 10)}`)
}
' "$SEED" "$BUNDLE")"
PIN_STATUS=$?
set -e

say "$PIN_OUTPUT"

[ "$PIN_STATUS" -eq 2 ] && exit 1
[ "$PIN_STATUS" -ne 0 ] && die 'factory pin verification failed to run.'
true

if [ "$CHECK_ONLY" = true ]; then
  say ''
  say '[3/4] --check given: skipping install'
  say '[4/4] --check given: skipping smoke check'
  say ''
  say 'Verification finished; nothing was changed.'
  exit 0
fi

# ------------------------------------------------------------- install + build

say '[3/4] Running scripts/install.sh (pnpm install --frozen-lockfile, build, env files)'
# Delegates rather than duplicating: install.sh owns the dependency install, the
# build and the env-file generation, and an upgrade must redo exactly those.
bash "$SCRIPT_DIR/install.sh"

# ---------------------------------------------------------------- smoke check

if [ "$SMOKE" = false ]; then
  say '[4/4] --no-smoke given: skipping the boot check'
  exit 0
fi

say '[4/4] Smoke check: booting the host on a spare port'

# The host binds 127.0.0.1, so a TCP probe on the same address is the same test
# it will make. First candidate that binds is free.
PORT=""
for candidate in 3180 3181 3182 3183 3184; do
  if node -e '
const net = require("node:net")
const server = net.createServer()
server.once("error", () => process.exit(1))
server.once("listening", () => server.close(() => process.exit(0)))
server.listen(Number(process.argv[1]), "127.0.0.1")
' "$candidate" 2>/dev/null; then
    PORT="$candidate"
    break
  fi
done
[ -n "$PORT" ] || die 'no free port among 3180-3184 for the smoke check.'

export DSH_HOME="$ROOT/data"
export DSH_BRANCH_HOME="$ROOT/data/zdsh"
export DSH_AGENTS_HOME="$ROOT/data/agents"

SMOKE_LOG="$(mktemp)"
node "$ROOT/apps/cli/lib/bin.js" web --no-open --port "$PORT" > "$SMOKE_LOG" 2>&1 &
SMOKE_PID=$!

stop_smoke() {
  kill "$SMOKE_PID" 2>/dev/null || true
  wait "$SMOKE_PID" 2>/dev/null || true
}
trap 'stop_smoke; rm -f "$SMOKE_LOG"' EXIT

# The host prints "dsh web: http://..." on success and "startup failed: N
# required plugins did not activate" on a broken composition, so both outcomes
# are visible in the same stream.
READY=false
for _ in $(seq 1 60); do
  if grep -q 'dsh web: http' "$SMOKE_LOG" 2>/dev/null; then READY=true; break; fi
  if grep -qE 'startup failed|Failed plugins' "$SMOKE_LOG" 2>/dev/null; then break; fi
  if ! kill -0 "$SMOKE_PID" 2>/dev/null; then break; fi
  sleep 1
done

if [ "$READY" != true ]; then
  say ''
  say '[X] The host did not come up after the upgrade.'
  say '---- boot output ----'
  cat "$SMOKE_LOG"
  say '--------------------'
  say ''
  say 'The install finished; the composition did not. To go back:'
  say "  git reset --hard $BEFORE"
  say 'then re-run this script.'
  exit 1
fi

# A host that answers is not yet a host that loaded everything: a plugin can
# fail to import while the server still serves. Check the boot log for that.
PLUGIN_TROUBLE="$(grep -E 'did not activate|import failed' "$SMOKE_LOG" | head -10 || true)"
if [ -n "$PLUGIN_TROUBLE" ]; then
  say ''
  say '[!] The host booted, but the boot log reports a plugin that did not load:'
  say "$PLUGIN_TROUBLE"
  say ''
  say 'Open the app and check Built-in plugins before relying on this install.'
fi

stop_smoke
trap 'rm -f "$SMOKE_LOG"' EXIT
rm -f "$SMOKE_LOG"
trap - EXIT

say ''
say 'Upgrade complete.'
say "  Revision: $AFTER"
say "  Smoke check: the host booted on port $PORT and answered."
say ''
say 'Restart your own dsh web and open the URL it prints — the access token is'
say 'regenerated on every start, so an older browser tab will not reconnect.'
