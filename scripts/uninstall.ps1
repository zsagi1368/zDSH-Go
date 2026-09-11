# zDSH-go uninstaller (Windows PowerShell 5.1+).
# Default mode: remove every gitignored artifact inside the repository checkout
# (node_modules, build output, data\, env files), restoring a pristine checkout.
#   -Purge        also delete the whole repository directory afterwards
#   -CleanLegacy  also remove the zDSH-go home directory (~/.dsh-zdsh-go) and the
#                 legacy plugin homes (~/.zdsh-*); the main-tree zDSH data
#                 directory ~/.dsh-zdsh is NOT touched
#   -Yes          answer "yes" to the interactive ~/.dsh confirmation (official-release data)
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File scripts\uninstall.ps1 [-Purge] [-CleanLegacy] [-Yes]

param(
    [switch]$Purge,
    [switch]$CleanLegacy,
    [switch]$Yes
)

$ErrorActionPreference = 'Continue'

$ROOT = Split-Path -Parent $PSScriptRoot
if (-not $ROOT) { $ROOT = (Get-Location).Path }

# Resolve the user profile from the environment first: $HOME is engine-level
# in PowerShell and ignores USERPROFILE overrides, which made -CleanLegacy
# impossible to sandbox-test (and once risked touching the real profile).
$homeBase = if ($env:USERPROFILE) { $env:USERPROFILE } else { $HOME }

$legacyZdshDirs = @(
    @{ Path = Join-Path $homeBase '.dsh-zdsh-go';        Label = 'zDSH-go governance data (default home without DSH_HOME)' },
    @{ Path = Join-Path $homeBase '.zdsh-workbench';     Label = 'zDSH legacy workbench data' },
    @{ Path = Join-Path $homeBase '.zdsh-plugin-center'; Label = 'zDSH legacy plugin center data' }
)
$officialDirs = @(
    @{ Path = Join-Path $homeBase '.dsh';    Label = 'OFFICIAL DeepSeek Harness data; may be shared with the official release' },
    @{ Path = Join-Path $homeBase '.agents'; Label = 'OFFICIAL agents skills home; may be shared with the official release' }
)

function Test-DirExists([string]$Path) {
    Test-Path -LiteralPath $Path -PathType Container
}

function Write-ResidueReport {
    Write-Host ''
    Write-Host 'Residue scan (user home directory):'
    foreach ($dir in $legacyZdshDirs) {
        if (Test-DirExists $dir.Path) {
            Write-Host "  [present] $($dir.Path)  ($($dir.Label); remove with -CleanLegacy)"
        }
        else {
            Write-Host "  [absent ] $($dir.Path)"
        }
    }
    foreach ($dir in $officialDirs) {
        if (Test-DirExists $dir.Path) {
            Write-Host "  [present] $($dir.Path)  ($($dir.Label); NOT removed by this script)"
        }
        else {
            Write-Host "  [absent ] $($dir.Path)"
        }
    }
}

function Copy-UserLocalBackup {
    # git clean -Xdf removes every ignored file; preserve user-authored local
    # files (.env, CLAUDE.local.md, mise.toml) and user-local directories
    # (.vscode, .claude, .idea, .DS_Store) outside the repository first.
    # List mirrors the user-local entries in .gitignore.
    $preserve = @('.env', 'CLAUDE.local.md', 'mise.toml', '.vscode', '.claude', '.idea', '.DS_Store')
    $backedUp = @()
    foreach ($name in $preserve) {
        $source = Join-Path $ROOT $name
        if (Test-Path -LiteralPath $source) {
            if ($backedUp.Count -eq 0) {
                $script:backupDir = Join-Path ([IO.Path]::GetTempPath()) ('zdsh-uninstall-backup-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
                New-Item -ItemType Directory -Path $script:backupDir -Force | Out-Null
            }
            Copy-Item -LiteralPath $source -Destination $script:backupDir -Recurse -Force
            $backedUp += $name
        }
    }
    if ($backedUp.Count -gt 0) {
        $restoreLines = $backedUp | ForEach-Object { "Restore by copying this item back to: $(Join-Path $ROOT $_)" }
        [IO.File]::WriteAllText((Join-Path $script:backupDir 'RESTORE.txt'), ($restoreLines -join "`r`n") + "`r`n")
        Write-Host "Backed up user-local files before cleaning: $($backedUp -join ', ')"
        Write-Host "Backup location: $script:backupDir"
    }
}

function Get-WorkspacePackageDirs {
    # Workspace package directories per pnpm-workspace.yaml: single-level
    # roots (apps/*, vendor/*, examples/*, native/landlock-run/packages/*),
    # the two-level expansion (packages/*/*), and the single-package roots
    # (website, python/sdk-runtime, native/landlock-run).
    $dirs = @()
    foreach ($name in @('apps', 'vendor', 'examples', 'native/landlock-run/packages')) {
        $workspaceRoot = Join-Path $ROOT $name
        if (-not (Test-Path -LiteralPath $workspaceRoot)) { continue }
        $dirs += @(Get-ChildItem -LiteralPath $workspaceRoot -Directory -ErrorAction SilentlyContinue).FullName
    }
    foreach ($name in @('packages')) {
        $workspaceRoot = Join-Path $ROOT $name
        if (-not (Test-Path -LiteralPath $workspaceRoot)) { continue }
        foreach ($group in @(Get-ChildItem -LiteralPath $workspaceRoot -Directory -ErrorAction SilentlyContinue)) {
            $dirs += @(Get-ChildItem -LiteralPath $group.FullName -Directory -ErrorAction SilentlyContinue).FullName
        }
    }
    foreach ($name in @('website', 'python/sdk-runtime', 'native/landlock-run')) {
        $packageRoot = Join-Path $ROOT $name
        if (Test-Path -LiteralPath $packageRoot) { $dirs += $packageRoot }
    }
    return ,$dirs
}

function Remove-KnownArtifacts {
    # Fallback for when git is unavailable: delete the artifact set that
    # .gitignore would otherwise let `git clean -Xdf` remove. Expands the
    # pnpm-workspace.yaml layout two levels deep (apps/*, packages/*/*,
    # vendor/*, native/landlock-run/packages/*) and includes lib/.
    $rootArtifacts = @(
        'node_modules', 'lib', 'coverage', '.pnpm-store', '.cache', 'data',
        'env.ps1', 'env.sh', 'tsconfig.client.tsbuildinfo', 'tsconfig.host.tsbuildinfo',
        '.DS_Store', 'mise.toml'
    )
    foreach ($name in $rootArtifacts) {
        $path = Join-Path $ROOT $name
        if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Recurse -Force }
    }
    foreach ($packageRoot in (Get-WorkspacePackageDirs)) {
        foreach ($artifact in @('lib', 'node_modules')) {
            $path = Join-Path $packageRoot $artifact
            if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Recurse -Force }
        }
    }
    Get-ChildItem -LiteralPath $ROOT -Filter 'oxlint-contract-*.ts' -File -ErrorAction SilentlyContinue |
        Remove-Item -Force
}

Write-Host 'zDSH-go uninstaller'
Write-Host "Repository root: $ROOT"
Write-ResidueReport

Write-Host ''
Write-Host '[1/2] Cleaning gitignored artifacts inside the repository'
Copy-UserLocalBackup

$gitAvailable = $false
if (Get-Command git -ErrorAction SilentlyContinue) {
    $insideWorkTree = & git -C $ROOT rev-parse --is-inside-work-tree 2>$null
    if ($LASTEXITCODE -eq 0 -and $insideWorkTree -eq 'true') { $gitAvailable = $true }
}

if ($gitAvailable) {
    # Guard the del/ backup area (zero-risk-change protocol, 7-day retention).
    # git clean's -e/--exclude patterns never apply to ignored files in -X
    # mode, and excluding the del/ directory outright makes clean remove it
    # whole (untracked backups included) — verified against git 2.54. The one
    # mechanism that does work is a temporary negation rule: append !del/**
    # to .gitignore for the sweep so nothing under del/ counts as ignored,
    # then restore the original bytes. The copy below also covers a crash
    # between append and restore.
    $gitignorePath = Join-Path $ROOT '.gitignore'
    $ignoreBackup = $null
    if ((Test-Path -LiteralPath $gitignorePath) -and
        -not (Select-String -LiteralPath $gitignorePath -SimpleMatch '!del/**' -Quiet)) {
        $ignoreBackup = Join-Path ([IO.Path]::GetTempPath()) ('zdsh-gitignore-' + [IO.Path]::GetRandomFileName())
        Copy-Item -LiteralPath $gitignorePath -Destination $ignoreBackup
        Add-Content -LiteralPath $gitignorePath -Value "`n!del/**"
    }
    try {
        Write-Host 'Preview (git clean -Xdn, del/ backup area guarded):'
        & git -C $ROOT clean -Xdn
        & git -C $ROOT clean -Xdf
        if ($LASTEXITCODE -ne 0) {
            Write-Host '[X] git clean failed.' -ForegroundColor Red
            exit $LASTEXITCODE
        }
    }
    finally {
        if ($ignoreBackup) {
            Copy-Item -LiteralPath $ignoreBackup -Destination $gitignorePath -Force
            Remove-Item -LiteralPath $ignoreBackup -Force
        }
    }
}
else {
    Write-Host 'git is unavailable (or the checkout is not a git repository); removing known artifact directories manually.'
    Remove-KnownArtifacts
}

if ($CleanLegacy) {
    Write-Host ''
    Write-Host '[legacy] Removing existing zDSH-go home and legacy plugin home directories'
    foreach ($dir in $legacyZdshDirs) {
        if (Test-DirExists $dir.Path) {
            Remove-Item -LiteralPath $dir.Path -Recurse -Force
            Write-Host "  [removed] $($dir.Path)"
        }
    }
    $officialDsh = Join-Path $homeBase '.dsh'
    if (Test-DirExists $officialDsh) {
        Write-Host "  [warn] $officialDsh belongs to the OFFICIAL DeepSeek Harness release and may hold data shared with it." -ForegroundColor Yellow
        $confirmed = $false
        if ($Yes) {
            $confirmed = $true
        }
        else {
            $answer = Read-Host "  Type 'yes' to delete it anyway (anything else keeps it)"
            if ($answer -eq 'yes') { $confirmed = $true }
        }
        if ($confirmed) {
            Remove-Item -LiteralPath $officialDsh -Recurse -Force
            Write-Host "  [removed] $officialDsh"
        }
        else {
            Write-Host "  [kept] $officialDsh"
        }
    }
}

Write-Host ''
Write-Host '[2/2] Zero-residue checklist'
$repoArtifacts = @('node_modules', 'lib', 'data', 'env.ps1', 'env.sh')
$allClean = $true
foreach ($name in $repoArtifacts) {
    $path = Join-Path $ROOT $name
    if (Test-Path -LiteralPath $path) {
        Write-Host "  [REMAINS] $path"
        $allClean = $false
    }
    else {
        Write-Host "  [clean  ] $path"
    }
}
# Nested residue scan mirrors the fallback expansion: every workspace package
# (two levels deep under packages/) must not keep a lib/ or node_modules/ behind.
foreach ($packageRoot in (Get-WorkspacePackageDirs)) {
    foreach ($artifact in @('lib', 'node_modules')) {
        $path = Join-Path $packageRoot $artifact
        if (Test-Path -LiteralPath $path) {
            Write-Host "  [REMAINS] $path"
            $allClean = $false
        }
    }
}
foreach ($dir in $legacyZdshDirs) {
    if (Test-DirExists $dir.Path) {
        Write-Host "  [REMAINS] $($dir.Path)  (use -CleanLegacy to remove)"
        $allClean = $false
    }
    else {
        Write-Host "  [clean  ] $($dir.Path)"
    }
}
if ($allClean) { Write-Host '  Result: repository artifacts fully removed.' }
else { Write-Host '  Result: some items remain; see the [REMAINS] lines above.' }

if ($Purge) {
    Write-Host ''
    Write-Host '[purge] Deleting the whole repository directory in a detached process...'
    $quotedRoot = '"' + $ROOT + '"'
    Start-Process cmd.exe -ArgumentList "/c timeout /t 2 /nobreak >nul & rmdir /s /q $quotedRoot" -WindowStyle Hidden | Out-Null
    Write-Host "[purge] If the directory is still occupied (open editor, shell, or server), delete it manually: $ROOT"
    exit 0
}
