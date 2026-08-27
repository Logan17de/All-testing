<#
.SYNOPSIS
    Install the Agent Team workflow and companion plugins into the Harness web profile.

.DESCRIPTION
    Adds Agent Team plus the plugins this setup relies on, repairs the duplicate
    dsh-tools copy that plugin installs keep reintroducing, optionally builds an
    English UI for Agent Team, optionally installs the destructive-command guard,
    and provisions the "AI Coding Team" (Engineering Leader + Qwen Coder).

    No credentials are read, written or committed. Providers are connected in
    Harness -> Settings -> Subscriptions and Settings -> Models.

.PARAMETER LeaderProvider
    Provider for the Engineering Leader. The role is deliberately vendor-neutral;
    any provider configured in Harness is valid.

.PARAMETER LeaderModel
    Model for the Engineering Leader.

.PARAMETER Workspace
    Workspace path the team collaborates in. Must already be registered in
    Harness (sidebar -> Add workspace).

.PARAMETER SkipEnglishUi
    Leave Agent Team's Chinese UI as upstream ships it.

.PARAMETER SkipBarricade
    Do not install the destructive-command guard.

.PARAMETER SkipProvision
    Install plugins only; do not create assistants or the team.

.EXAMPLE
    .\Install-AgentTeam-Windows.ps1 -Workspace "C:\path\to\project"
#>
param(
    [string]$LeaderProvider = "codex",
    [string]$LeaderModel = "gpt-5.6-sol",
    [string]$Workspace = "",
    [switch]$SkipEnglishUi,
    [switch]$SkipBarricade,
    [switch]$SkipProvision
)

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

function Write-Step([string]$Text) {
    Write-Host ""
    Write-Host "==> $Text" -ForegroundColor Cyan
}

function Require-Command([string]$Name, [string]$InstallHint) {
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "$Name not found on PATH. $InstallHint"
    }
}

Require-Command "dsh"  "Install with: npm install -g @deepseek-ai/dsh"
Require-Command "pnpm" "Install with: npm install -g pnpm"
Require-Command "node" "Install Node.js 22.19+ or 24+."

$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME ".dsh" }
$webProfile = Join-Path $dshHome "profiles\web"
if (-not (Test-Path -LiteralPath $webProfile)) {
    throw "Web profile not found at $webProfile. Run Install-Harness-Windows.ps1 first."
}

# ---------------------------------------------------------------------------
# Plugins
# ---------------------------------------------------------------------------
# Pin Agent Team: 0.1.4 declares peers ^0.1.1-rc.2, matching the DSH this setup
# targets. 0.1.3 declares ^0.1.0-rc.7, which 0.1.1-rc.2 does NOT satisfy under
# default semver rules. Check before moving:
#   npm view @limuyang2/dsh-agent-team version peerDependencies --json
$plugins = @(
    "@limuyang2/dsh-agent-team@0.1.4",  # independent agents, shared Workspace
    "dshmarket",                        # plugin market inside Settings
    "dsh-solution-explorer",            # file explorer + source control in the web UI
    "dsh-session-manager"               # delete/restore sessions (DSH ships no delete)
)

Write-Step "Installing plugins into the web profile"
foreach ($plugin in $plugins) {
    Write-Host "  $plugin"
    & dsh plugin --profile web add $plugin
    if ($LASTEXITCODE -ne 0) { throw "Failed to install $plugin" }
}

if (-not $SkipBarricade) {
    Write-Step "Installing the destructive-command rule engine"
    # Upstream's own plugin entry cannot mount on this DSH build; the adapter in
    # barricade-guard/ mounts its rules through ctx.tools.guard() instead. The
    # upstream package must be installed but must NOT be bundled.
    & dsh plugin --profile web add "github:JohnXu22786/safety-net"
    if ($LASTEXITCODE -ne 0) { throw "Failed to install dsh-barricade" }

    $guardDest = Join-Path $webProfile "barricade-guard"
    if (Test-Path -LiteralPath $guardDest) { Remove-Item -LiteralPath $guardDest -Recurse -Force }
    Copy-Item (Join-Path $here "barricade-guard") $guardDest -Recurse
    Push-Location $webProfile
    try {
        & pnpm add "file:./barricade-guard"
        if ($LASTEXITCODE -ne 0) { throw "Failed to link barricade-guard" }
    } finally { Pop-Location }
}

# ---------------------------------------------------------------------------
# Duplicate dsh-tools
# ---------------------------------------------------------------------------
# @wnjxyk/dsh-codex-oauth declares @deepseek-ai/dsh-tools as a regular dependency
# rather than a peer, so pnpm materialises a second physical copy on EVERY
# install. dsh-tools keys its scheduler with Symbol("...") (not Symbol.for), so
# two copies mint different symbols, the lookup returns undefined, and every
# tool call dies with:
#     Cannot read properties of undefined (reading 'prepare')
# This must run AFTER the plugin installs above, not before.
Write-Step "Repairing duplicate dsh-tools (plugin installs reintroduce it)"
$repair = Join-Path (Split-Path -Parent $here) "Repair-DshTools-Windows.ps1"
if (Test-Path -LiteralPath $repair) {
    & $repair
} else {
    Write-Host "  Repair-DshTools-Windows.ps1 not found; check for a profile-local copy manually." -ForegroundColor Yellow
}

# ---------------------------------------------------------------------------
# English UI
# ---------------------------------------------------------------------------
if (-not $SkipEnglishUi) {
    Write-Step "Building the English Agent Team UI"
    # Agent Team ships no i18n; its UI strings are hardcoded Chinese literals.
    # Build from a PRISTINE upstream tarball, never from the already-patched
    # copy in node_modules.
    $work = Join-Path ([System.IO.Path]::GetTempPath()) ("dsh-agent-team-en-" + [guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $work -Force | Out-Null
    Push-Location $work
    try {
        & npm pack "@limuyang2/dsh-agent-team@0.1.4" | Out-Null
        $tgz = Get-ChildItem -Filter "*.tgz" | Select-Object -First 1
        & tar -xzf $tgz.FullName
        $pristine = Join-Path $work "package"

        $enDest = Join-Path $webProfile "agent-team-en"
        & node (Join-Path $here "i18n\build.mjs") --source $pristine --out $enDest
        if ($LASTEXITCODE -ne 0) { throw "English build failed" }
    } finally {
        Pop-Location
        Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
    }

    Push-Location $webProfile
    try {
        # Keeps the package NAME identical, which is what dsh.profile.bundles resolves.
        & pnpm add "file:./agent-team-en"
        if ($LASTEXITCODE -ne 0) { throw "Failed to link the English build" }
    } finally { Pop-Location }

    Write-Step "Re-repairing dsh-tools after the relink"
    if (Test-Path -LiteralPath $repair) { & $repair -Quiet }
}

# ---------------------------------------------------------------------------
# Bundle activation
# ---------------------------------------------------------------------------
# `pnpm add` installs a package but does NOT activate it. Only the `dsh plugin
# add` wrapper appends to dsh.profile.bundles, so anything linked with pnpm
# (the English build, barricade-guard) must be listed here explicitly.
Write-Step "Activating bundles"
$pkgPath = Join-Path $webProfile "package.json"
$pkg = Get-Content -LiteralPath $pkgPath -Raw | ConvertFrom-Json
$bundles = [System.Collections.Generic.List[string]]::new()
foreach ($b in $pkg.dsh.profile.bundles) { $bundles.Add($b) }

$wanted = @("@limuyang2/dsh-agent-team", "dshmarket", "dsh-solution-explorer", "dsh-session-manager")
if (-not $SkipBarricade) { $wanted += "dsh-barricade-guard" }   # NOT dsh-barricade itself

foreach ($name in $wanted) {
    if (-not $bundles.Contains($name)) {
        $bundles.Add($name)
        Write-Host "  + $name"
    }
}
$pkg.dsh.profile.bundles = $bundles.ToArray()
$pkg | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $pkgPath -Encoding utf8

Write-Step "Plugins installed. Restart Harness now:  dsh web"

# ---------------------------------------------------------------------------
# Provisioning
# ---------------------------------------------------------------------------
if ($SkipProvision) {
    Write-Host ""
    Write-Host "Skipping provisioning (-SkipProvision)." -ForegroundColor Yellow
    Write-Host "After restarting Harness, run:" -ForegroundColor DarkGray
    Write-Host "  node provision\src\provision.js --set engineering-leader.provider=$LeaderProvider --set engineering-leader.model=$LeaderModel --workspace `"<PROJECT_PATH>`""
    exit 0
}

if ([string]::IsNullOrWhiteSpace($Workspace)) {
    Write-Host ""
    Write-Host "No -Workspace given, so the team was not created." -ForegroundColor Yellow
    Write-Host "Register a workspace in the Harness sidebar, restart Harness, then run:" -ForegroundColor DarkGray
    Write-Host "  node provision\src\provision.js --set engineering-leader.provider=$LeaderProvider --set engineering-leader.model=$LeaderModel --workspace `"<PROJECT_PATH>`""
    exit 0
}

Write-Host ""
Write-Host "Restart Harness (dsh web) in another terminal, then press Enter to provision the team." -ForegroundColor Cyan
[void](Read-Host)

Push-Location (Join-Path $here "provision")
try {
    & node "src\provision.js" `
        --set "engineering-leader.provider=$LeaderProvider" `
        --set "engineering-leader.model=$LeaderModel" `
        --workspace $Workspace
    if ($LASTEXITCODE -ne 0) { throw "Provisioning failed" }
} finally { Pop-Location }

Write-Step "Done. Open the Team workbench from the floating Team button."
