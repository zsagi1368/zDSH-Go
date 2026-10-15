# zDSH-go upgrade (Windows PowerShell 5.1+).
# Fetches the newest revision, verifies the factory pins it will install,
# reinstalls, and smoke-checks that the host still boots.
#
# Usage:
#   .\upgrade.cmd                       # pull, verify, install, smoke-check
#   .\upgrade.cmd -Check                # verify only, change nothing
#   .\upgrade.cmd -Force                # proceed with a dirty working tree
#   .\upgrade.cmd -Remote zshgo         # pull from a specific remote
#   .\upgrade.cmd -Branch main          # pull a specific branch
#   .\upgrade.cmd -NoSmoke              # skip the post-install boot check
#
# Why this is its own script instead of "git pull && install.cmd": the failures
# that actually bite an upgrade are silent ones. Factory plugins are installed
# from git URLs pinned in TWO places (the bundle's dependency ref and the seed's
# entries[].pin), and a pin that drifted from its twin, or that trails the plugin
# repo's own fixes, does not fail the pull — it either fails deep inside pnpm or,
# worse, installs cleanly and boots with a plugin that cannot load. Both are
# cheap to see before the long install, so they are checked here first.

param(
    [switch]$Check,
    [switch]$Force,
    [switch]$NoSmoke,
    [string]$Remote = '',
    [string]$Branch = ''
)

$ErrorActionPreference = 'Continue'

$ROOT = Split-Path -Parent $PSScriptRoot
if (-not $ROOT) { $ROOT = (Get-Location).Path }
$SEED = Join-Path $ROOT 'zdsh-factory\seed.json'
$BUNDLE = Join-Path $ROOT 'packages\zdsh\factory-bundle\package.json'

Write-Host 'zDSH-go upgrade'
Write-Host "Repository root: $ROOT"

function Fail([string]$message) {
    Write-Host "[X] $message" -ForegroundColor Red
    exit 1
}

# ------------------------------------------------------------------ preflight

if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Fail 'git was not found on PATH.' }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Fail 'Node.js was not found on PATH.' }
if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) { Fail 'pnpm was not found on PATH. Enable it with: corepack enable pnpm' }
if (-not (Test-Path $SEED)) { Fail "factory seed is missing: $SEED" }
if (-not (Test-Path $BUNDLE)) { Fail "factory bundle manifest is missing: $BUNDLE" }

Push-Location $ROOT
try {
    $dirty = & git status --porcelain
    if ($dirty) {
        if ($Force) {
            Write-Host '[!] Working tree has local changes; continuing because -Force was given.'
        }
        else {
            Fail 'Working tree has local changes. Commit or stash them first, or re-run with -Force.'
        }
    }

    # ---------------------------------------------------- pull (unless -Check)

    $before = (& git rev-parse --short HEAD).Trim()
    if ($Check) {
        Write-Host "[1/4] -Check given: skipping git pull (HEAD is $before)"
    }
    else {
        Write-Host '[1/4] git pull'
        $pullArgs = @('pull', '--ff-only')
        if ($Remote) { $pullArgs += $Remote }
        if ($Branch) { $pullArgs += $Branch }
        & git @pullArgs
        if ($LASTEXITCODE -ne 0) { Fail 'git pull failed (see above). Resolve it, then re-run.' }
    }
    $after = (& git rev-parse --short HEAD).Trim()
    if ($before -eq $after) { Write-Host "      already at $after" }
    else { Write-Host "      $before -> $after" }

    # ------------------------------------------------ factory pin verification

    Write-Host '[2/4] Verifying factory pins'

    $seed = Get-Content -Raw $SEED | ConvertFrom-Json
    $bundle = Get-Content -Raw $BUNDLE | ConvertFrom-Json

    $rows = @()
    foreach ($prop in $bundle.dependencies.PSObject.Properties) {
        $spec = [string]$prop.Value
        if (-not $spec.StartsWith('git+')) { continue }
        $hashAt = $spec.IndexOf('#')
        if ($hashAt -lt 0) { $url = $spec; $ref = '' }
        else { $url = $spec.Substring(0, $hashAt); $ref = $spec.Substring($hashAt + 1) }
        $url = $url -replace '^git\+', ''
        $entry = $seed.entries | Where-Object { $_.package -eq $prop.Name } | Select-Object -First 1
        $seedPin = $null
        if ($entry) { $seedPin = [string]$entry.pin }
        $rows += [pscustomobject]@{ Name = $prop.Name; Url = $url; Ref = $ref; SeedPin = $seedPin }
    }

    Write-Host "      $($rows.Count) pinned plugin(s) across both carriers."

    $mismatched = $rows | Where-Object { $_.SeedPin -and $_.SeedPin -ne $_.Ref }
    foreach ($row in $rows) {
        if (-not $row.SeedPin) { Write-Host "      NOTE $($row.Name): no seed entry (bundle-only dependency)" }
    }
    foreach ($row in $mismatched) {
        Write-Host "      MISMATCH $($row.Name)" -ForegroundColor Red
        Write-Host "        bundle: $($row.Ref)"
        Write-Host "        seed:   $($row.SeedPin)"
    }
    if ($mismatched) {
        Write-Host ''
        Write-Host '      packages\zdsh\factory-bundle\package.json and zdsh-factory\seed.json'
        Write-Host '      must pin the same commit for the same package; a mismatch means the'
        Write-Host '      installer and the running host would load different builds.'
        exit 1
    }

    foreach ($row in $rows) {
        $tip = ''
        try { $tip = ((& git ls-remote $row.Url HEAD 2>$null) | Select-Object -First 1) }
        catch { $tip = '' }
        if (-not $tip) { Write-Host "      ?  $($row.Name): could not reach $($row.Url)"; continue }
        $tipSha = ($tip -split '\s+')[0]
        if ($tipSha -eq $row.Ref) { Write-Host "      ok $($row.Name)" }
        else {
            Write-Host "      !  $($row.Name): pin $($row.Ref.Substring(0, 10)) trails repo tip $($tipSha.Substring(0, 10))" -ForegroundColor Yellow
        }
    }

    if ($Check) {
        Write-Host ''
        Write-Host '[3/4] -Check given: skipping install'
        Write-Host '[4/4] -Check given: skipping smoke check'
        Write-Host ''
        Write-Host 'Verification finished; nothing was changed.'
        exit 0
    }

    # --------------------------------------------------------- install + build

    Write-Host '[3/4] Running scripts\install.ps1 (pnpm install --frozen-lockfile, build, env files)'
    # Delegates rather than duplicating: install.ps1 owns the dependency install,
    # the build and the env-file generation, and an upgrade must redo exactly those.
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'install.ps1')
    if ($LASTEXITCODE -ne 0) { Fail 'install.ps1 failed; the upgrade is incomplete.' }

    # ------------------------------------------------------------ smoke check

    if ($NoSmoke) {
        Write-Host '[4/4] -NoSmoke given: skipping the boot check'
        exit 0
    }

    Write-Host '[4/4] Smoke check: booting the host on a spare port'

    # First candidate port that binds is free; the host binds 127.0.0.1 too.
    $port = 0
    foreach ($candidate in 3180, 3181, 3182, 3183, 3184) {
        try {
            $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $candidate)
            $listener.Start()
            $listener.Stop()
            $port = $candidate
            break
        }
        catch { }
    }
    if ($port -eq 0) { Fail 'no free port among 3180-3184 for the smoke check.' }

    $env:DSH_HOME = Join-Path $ROOT 'data'
    $env:DSH_BRANCH_HOME = Join-Path $ROOT 'data\zdsh'
    $env:DSH_AGENTS_HOME = Join-Path $ROOT 'data\agents'

    $smokeLog = [System.IO.Path]::GetTempFileName()
    $cli = Join-Path $ROOT 'apps\cli\lib\bin.js'
    $proc = Start-Process -FilePath 'node' -ArgumentList @($cli, 'web', '--no-open', '--port', "$port") `
        -RedirectStandardOutput $smokeLog -RedirectStandardError "$smokeLog.err" -PassThru -WindowStyle Hidden

    try {
        $ready = $false
        for ($i = 0; $i -lt 60; $i++) {
            Start-Sleep -Seconds 1
            $text = ''
            if (Test-Path $smokeLog) { $text = Get-Content -Raw $smokeLog -ErrorAction SilentlyContinue }
            if ($text -match 'dsh web: http') { $ready = $true; break }
            if ($text -match 'startup failed|Failed plugins') { break }
            if ($proc.HasExited) { break }
        }

        $allText = ''
        if (Test-Path $smokeLog) { $allText = Get-Content -Raw $smokeLog -ErrorAction SilentlyContinue }
        if (Test-Path "$smokeLog.err") { $allText += (Get-Content -Raw "$smokeLog.err" -ErrorAction SilentlyContinue) }

        if (-not $ready) {
            Write-Host ''
            Write-Host '[X] The host did not come up after the upgrade.' -ForegroundColor Red
            Write-Host '---- boot output ----'
            Write-Host $allText
            Write-Host '--------------------'
            Write-Host ''
            Write-Host 'The install finished; the composition did not. To go back:'
            Write-Host "  git reset --hard $before"
            Write-Host 'then re-run this script.'
            exit 1
        }

        # A host that answers is not yet a host that loaded everything: a plugin
        # can fail to import while the server still serves.
        $trouble = ($allText -split "`n") | Where-Object { $_ -match 'did not activate|import failed' } | Select-Object -First 10
        if ($trouble) {
            Write-Host ''
            Write-Host '[!] The host booted, but the boot log reports a plugin that did not load:' -ForegroundColor Yellow
            $trouble | ForEach-Object { Write-Host $_ }
            Write-Host ''
            Write-Host 'Open the app and check Built-in plugins before relying on this install.'
        }

        Write-Host ''
        Write-Host 'Upgrade complete.'
        Write-Host "  Revision: $after"
        Write-Host "  Smoke check: the host booted on port $port and answered."
        Write-Host ''
        Write-Host 'Restart your own dsh web and open the URL it prints — the access token is'
        Write-Host 'regenerated on every start, so an older browser tab will not reconnect.'
    }
    finally {
        if ($proc -and -not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
        Remove-Item -Force -ErrorAction SilentlyContinue $smokeLog, "$smokeLog.err"
    }
}
finally {
    Pop-Location
}
