#!/usr/bin/env bash
# zDSH-go uninstaller (Linux/macOS/WSL/Git Bash).
# Default mode: remove every gitignored artifact inside the repository checkout
# (node_modules, build output, data/, env files), restoring a pristine checkout.
#   --purge        also delete the whole repository directory afterwards
#   --clean-legacy also remove the zDSH-go home directory (~/.dsh-zdsh-go) and
#                  the legacy plugin homes (~/.zdsh-*); the main-tree zDSH data
#                  directory ~/.dsh-zdsh is NOT touched
#   --yes          answer "yes" to the interactive ~/.dsh confirmation (official-release data)
# Usage: ./scripts/uninstall.sh [--purge] [--clean-legacy] [--yes]

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"

PURGE=0
CLEAN_LEGACY=0
ASSUME_YES=0

for argument in "$@"; do
  case "$argument" in
    --purge) PURGE=1 ;;
    --clean-legacy) CLEAN_LEGACY=1 ;;
    --yes) ASSUME_YES=1 ;;
    -h|--help)
      sed -n '2,9p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "Unknown option: $argument" >&2
      echo 'Usage: ./scripts/uninstall.sh [--purge] [--clean-legacy] [--yes]' >&2
      exit 2
      ;;
  esac
done

LEGACY_ZDSH_DIRS=(
  "$HOME/.dsh-zdsh-go|zDSH-go governance data (default home without DSH_HOME); remove with --clean-legacy"
  "$HOME/.zdsh-workbench|zDSH legacy workbench data; remove with --clean-legacy"
  "$HOME/.zdsh-plugin-center|zDSH legacy plugin center data; remove with --clean-legacy"
)
OFFICIAL_DIRS=(
  "$HOME/.dsh|OFFICIAL DeepSeek Harness data; may be shared with the official release; NOT removed by this script"
  "$HOME/.agents|OFFICIAL agents skills home; may be shared with the official release; NOT removed by this script"
)

dir_exists() { [ -d "$1" ]; }

print_residue_report() {
  echo ''
  echo 'Residue scan (user home directory):'
  local entry path label
  for entry in "${LEGACY_ZDSH_DIRS[@]}"; do
    path="${entry%%|*}"
    label="${entry#*|}"
    if dir_exists "$path"; then
      echo "  [present] $path  ($label)"
    else
      echo "  [absent ] $path"
    fi
  done
  for entry in "${OFFICIAL_DIRS[@]}"; do
    path="${entry%%|*}"
    label="${entry#*|}"
    if dir_exists "$path"; then
      echo "  [present] $path  ($label)"
    else
      echo "  [absent ] $path"
    fi
  done
}

backup_user_local_files() {
  # git clean -Xdf removes every ignored file; preserve user-authored local
  # files (.env, CLAUDE.local.md, mise.toml) and user-local directories
  # (.vscode, .claude, .idea, .DS_Store) outside the repository first.
  # List mirrors the user-local entries in .gitignore.
  # -rL dereferences symlinks: tracked links like .claude/skills cannot be
  # recreated inside the backup dir on MSYS (their relative target does not
  # exist there), and Copy-Item on the PowerShell side dereferences too —
  # keep both platforms aligned. Restoring a dereferenced copy must never
  # clobber a git-tracked symlink (see RESTORE.txt warning below).
  local backup_dir='' name source
  for name in .env CLAUDE.local.md mise.toml .vscode .claude .idea .DS_Store; do
    source="$ROOT/$name"
    if [ -e "$source" ]; then
      if [ -z "$backup_dir" ]; then
        backup_dir="${TMPDIR:-/tmp}/zdsh-uninstall-backup-$(date +%Y%m%d-%H%M%S)"
        mkdir -p -- "$backup_dir"
      fi
      cp -rL -- "$source" "$backup_dir/"
      printf 'Restore by copying this item back to: %s\n' "$ROOT/$name" >> "$backup_dir/RESTORE.txt"
      echo "Backed up user-local file before cleaning: $name"
    fi
  done
  if [ -n "$backup_dir" ]; then
    printf 'CAUTION: items that are git-tracked (e.g. the .claude/skills symlink) were\n' >> "$backup_dir/RESTORE.txt"
    printf 'backed up dereferenced; restore only user-authored files, never over git-tracked paths.\n' >> "$backup_dir/RESTORE.txt"
    echo "Backup location: $backup_dir"
  fi
}

workspace_package_dirs() {
  # Workspace package directories per pnpm-workspace.yaml: single-level roots
  # (apps/*, vendor/*, examples/*, native/landlock-run/packages/*), the
  # two-level expansion (packages/*/*), and the single-package roots
  # (website, python/sdk-runtime, native/landlock-run). Prints one directory
  # per line.
  local name group sub
  for name in apps vendor examples native/landlock-run/packages; do
    [ -d "$ROOT/$name" ] || continue
    for group in "$ROOT/$name"/*/; do
      [ -d "$group" ] || continue
      printf '%s\n' "${group%/}"
    done
  done
  for name in packages; do
    [ -d "$ROOT/$name" ] || continue
    for group in "$ROOT/$name"/*/; do
      [ -d "$group" ] || continue
      for sub in "$group"*/; do
        [ -d "$sub" ] || continue
        printf '%s\n' "${sub%/}"
      done
    done
  done
  for name in website python/sdk-runtime native/landlock-run; do
    [ -d "$ROOT/$name" ] && printf '%s\n' "$ROOT/$name"
  done
}

remove_known_artifacts() {
  # Fallback for when git is unavailable: delete the artifact set that
  # .gitignore would otherwise let `git clean -Xdf` remove. Expands the
  # pnpm-workspace.yaml layout two levels deep (apps/*, packages/*/*,
  # vendor/*, native/landlock-run/packages/*) and includes lib/.
  local name path
  for name in node_modules lib coverage .pnpm-store .cache data env.sh env.ps1 .DS_Store mise.toml; do
    path="$ROOT/$name"
    if [ -e "$path" ]; then rm -rf -- "$path"; fi
  done
  local package_dir
  while IFS= read -r package_dir; do
    for name in lib node_modules; do
      path="$package_dir/$name"
      if [ -e "$path" ]; then rm -rf -- "$path"; fi
    done
  done < <(workspace_package_dirs)
  find "$ROOT" -maxdepth 1 -name 'oxlint-contract-*.ts' -type f -exec rm -f -- {} +
}

echo 'zDSH-go uninstaller'
echo "Repository root: $ROOT"
print_residue_report

echo ''
echo '[1/2] Cleaning gitignored artifacts inside the repository'
backup_user_local_files

GIT_AVAILABLE=0
if command -v git >/dev/null 2>&1 \
  && git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
  && [ "$(git -C "$ROOT" rev-parse --is-inside-work-tree)" = 'true' ]; then
  GIT_AVAILABLE=1
fi

if [ "$GIT_AVAILABLE" -eq 1 ]; then
  # Guard the del/ backup area (zero-risk-change protocol, 7-day retention).
  # git clean's -e/--exclude patterns never apply to ignored files in -X
  # mode, and excluding the del/ directory outright makes clean remove it
  # whole (untracked backups included) — verified against git 2.54. The one
  # mechanism that does work is a temporary negation rule: append !del/**
  # to .gitignore for the sweep so nothing under del/ counts as ignored,
  # then restore the original bytes (trap covers an interrupt mid-sweep).
  GITIGNORE_RESTORE=''
  if [ -f "$ROOT/.gitignore" ] && ! grep -qxF '!del/**' "$ROOT/.gitignore"; then
    GITIGNORE_RESTORE="$(mktemp "${TMPDIR:-/tmp}/zdsh-gitignore-XXXXXXXX")"
    cp -- "$ROOT/.gitignore" "$GITIGNORE_RESTORE"
    printf '\n!del/**\n' >> "$ROOT/.gitignore"
  fi
  trap 'if [ -n "${GITIGNORE_RESTORE:-}" ] && [ -f "$GITIGNORE_RESTORE" ]; then cp -- "$GITIGNORE_RESTORE" "$ROOT/.gitignore"; rm -f -- "$GITIGNORE_RESTORE"; fi' EXIT
  echo 'Preview (git clean -Xdn, del/ backup area guarded):'
  git -C "$ROOT" clean -Xdn
  git -C "$ROOT" clean -Xdf
else
  echo 'git is unavailable (or the checkout is not a git repository); removing known artifact directories manually.'
  remove_known_artifacts
fi

if [ "$CLEAN_LEGACY" -eq 1 ]; then
  echo ''
  echo '[legacy] Removing existing zDSH-go home and legacy plugin home directories'
  for entry in "${LEGACY_ZDSH_DIRS[@]}"; do
    path="${entry%%|*}"
    if dir_exists "$path"; then
      rm -rf -- "$path"
      echo "  [removed] $path"
    fi
  done
  if dir_exists "$HOME/.dsh"; then
    echo "  [warn] $HOME/.dsh belongs to the OFFICIAL DeepSeek Harness release and may hold data shared with it."
    confirmed=0
    if [ "$ASSUME_YES" -eq 1 ]; then
      confirmed=1
    else
      printf "  Type 'yes' to delete it anyway (anything else keeps it): "
      read -r answer || answer=''
      if [ "$answer" = 'yes' ]; then confirmed=1; fi
    fi
    if [ "$confirmed" -eq 1 ]; then
      rm -rf -- "$HOME/.dsh"
      echo "  [removed] $HOME/.dsh"
    else
      echo "  [kept] $HOME/.dsh"
    fi
  fi
fi

echo ''
echo '[2/2] Zero-residue checklist'
ALL_CLEAN=1
for name in node_modules lib data env.sh env.ps1; do
  path="$ROOT/$name"
  if [ -e "$path" ]; then
    echo "  [REMAINS] $path"
    ALL_CLEAN=0
  else
    echo "  [clean  ] $path"
  fi
done
# Nested residue scan mirrors the fallback expansion: every workspace package
# (two levels deep under packages/) must not keep a lib/ or node_modules/ behind.
while IFS= read -r package_dir; do
  for name in lib node_modules; do
    path="$package_dir/$name"
    if [ -e "$path" ]; then
      echo "  [REMAINS] $path"
      ALL_CLEAN=0
    fi
  done
done < <(workspace_package_dirs)
for entry in "${LEGACY_ZDSH_DIRS[@]}"; do
  path="${entry%%|*}"
  if dir_exists "$path"; then
    echo "  [REMAINS] $path  (use --clean-legacy to remove)"
    ALL_CLEAN=0
  else
    echo "  [clean  ] $path"
  fi
done
if [ "$ALL_CLEAN" -eq 1 ]; then
  echo '  Result: repository artifacts fully removed.'
else
  echo '  Result: some items remain; see the [REMAINS] lines above.'
fi

if [ "$PURGE" -eq 1 ]; then
  echo ''
  echo '[purge] Deleting the whole repository directory in a detached process...'
  if command -v setsid >/dev/null 2>&1; then
    ( cd / && setsid bash -c 'sleep 2; rm -rf -- "$0"' "$ROOT" >/dev/null 2>&1 ) &
  else
    ( cd / && sleep 2 && rm -rf -- "$ROOT" ) >/dev/null 2>&1 &
  fi
  disown 2>/dev/null || true
  echo "[purge] If the directory is still occupied (open editor, shell, or server), delete it manually: $ROOT"
fi

exit 0
