param(
    [string]$QwenBaseUrl = "",
    [switch]$SkipQwen,
    [switch]$SkipSubscriptions,
    [switch]$SkipPresets
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Write-Step([string]$Text) {
    Write-Host ""
    Write-Host "==> $Text" -ForegroundColor Cyan
}

function Require-Command([string]$Name, [string]$InstallHint) {
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "$Name is required. $InstallHint"
    }
}

function Disable-ProfileLocalDshTools([string]$DshHome) {
    $profileTools = Join-Path $DshHome "profiles\web\node_modules\@deepseek-ai\dsh-tools"
    if (-not (Test-Path -LiteralPath $profileTools)) {
        Write-Host "No duplicate profile-local dsh-tools copy found." -ForegroundColor DarkGray
        return
    }

    $item = Get-Item -LiteralPath $profileTools -Force
    if ($item.LinkType) {
        Write-Host "Profile dsh-tools is already a filesystem link; leaving it unchanged." -ForegroundColor DarkGray
        return
    }

    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $backupLeaf = "dsh-tools.disabled-$stamp"
    Rename-Item -LiteralPath $profileTools -NewName $backupLeaf
    Write-Host "Disabled duplicate profile-local dsh-tools (backup kept as $backupLeaf)." -ForegroundColor Green
}

function Remove-LegacySubscriptionPlugins {
    $pluginList = (& dsh plugin --profile web list 2>&1 | Out-String)
    $legacyPackages = @(
        "dsh-codex-oauth",
        "@wnjxyk/dsh-codex-oauth"
    )

    foreach ($package in $legacyPackages) {
        if ($pluginList -match [regex]::Escape($package)) {
            Write-Host "Removing legacy single-provider plugin: $package" -ForegroundColor Yellow
            & dsh plugin --profile web remove -w $package
            if ($LASTEXITCODE -ne 0) {
                throw "Failed to remove legacy plugin: $package"
            }
        }
    }
}

function Install-Preset([string]$Name, [string]$DshHome) {
    $targetDir = Join-Path $DshHome ".agent-presets\$Name"
    $target = Join-Path $targetDir "agent.cordis.yml"
    New-Item -ItemType Directory -Force -Path $targetDir | Out-Null

    $local = Join-Path $PSScriptRoot "..\harness-presets\$Name\agent.cordis.yml"
    if (Test-Path -LiteralPath $local) {
        Copy-Item -LiteralPath $local -Destination $target -Force
    }
    else {
        $url = "https://raw.githubusercontent.com/Logan17de/All-testing/main/llm/harness-presets/$Name/agent.cordis.yml"
        Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $target
    }
    Write-Host "Installed preset: $Name" -ForegroundColor Green
}

function Get-QwenAffinityId([string]$DshHome) {
    $affinityPath = Join-Path $DshHome "qwen-affinity.id"
    if (Test-Path -LiteralPath $affinityPath) {
        $existing = ([IO.File]::ReadAllText($affinityPath)).Trim()
        if ($existing -match '^[A-Za-z0-9_-]{16,128}$') {
            return $existing
        }
    }

    $value = [Guid]::NewGuid().ToString("N")
    [IO.File]::WriteAllText(
        $affinityPath,
        $value + [Environment]::NewLine,
        [Text.UTF8Encoding]::new($false)
    )
    return $value
}

function Configure-Qwen([string]$DshHome, [string]$BaseUrl) {
    if ([string]::IsNullOrWhiteSpace($BaseUrl)) {
        $BaseUrl = Read-Host "Qwen OpenAI-compatible base URL (blank = skip Qwen setup)"
    }
    if ([string]::IsNullOrWhiteSpace($BaseUrl)) {
        Write-Host "Skipping Qwen provider configuration." -ForegroundColor Yellow
        return
    }

    $BaseUrl = $BaseUrl.Trim().TrimEnd('/')
    $affinityId = Get-QwenAffinityId -DshHome $DshHome

    $settings = Join-Path $DshHome "settings.yaml"
    $snippetPath = Join-Path $DshHome "qwen-provider.settings-snippet.yml"
    $safeUrl = $BaseUrl.Replace("'", "''")
    $snippet = @"
llm-pi-ai:
  providers:
    qwen:
      displayName: Qwen
      api: openai-completions
      baseURL: '$safeUrl'
      headers:
        X-Qwen-Affinity: '$affinityId'
      models:
        - id: qwen3.8-27b
          name: Qwen
          contextWindow: 262144
          maxTokens: 32768
          reasoningEfforts:
            low: low
            medium: medium
            xhigh: xhigh
"@

    [IO.File]::WriteAllText($snippetPath, $snippet + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))

    if (-not (Test-Path -LiteralPath $settings)) {
        [IO.File]::WriteAllText($settings, $snippet + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
        Write-Host "Configured Qwen provider with worker affinity and without an API key." -ForegroundColor Green
        Write-Host "Enter the API key later in Harness Settings -> Models." -ForegroundColor Green
        return
    }

    $existing = [IO.File]::ReadAllText($settings)
    if ($existing -match '(?m)^llm-pi-ai\s*:') {
        Write-Host "settings.yaml already contains llm-pi-ai; automatic merge was skipped to avoid overwriting existing providers." -ForegroundColor Yellow
        Write-Host "Use this generated snippet to add/update the provider safely:" -ForegroundColor Yellow
        Write-Host "  $snippetPath"
        Write-Host "The snippet includes this machine's stable X-Qwen-Affinity header." -ForegroundColor Yellow
        Write-Host "Then enter the API key in Harness Settings -> Models." -ForegroundColor Yellow
        return
    }

    $backup = "$settings.pre-harness-bootstrap.bak"
    if (-not (Test-Path -LiteralPath $backup)) {
        Copy-Item -LiteralPath $settings -Destination $backup
    }
    $prefix = if ($existing.Length -gt 0 -and -not $existing.EndsWith("`n")) { "`r`n" } else { "" }
    [IO.File]::AppendAllText($settings, $prefix + $snippet + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
    Write-Host "Added Qwen provider with worker affinity and without an API key." -ForegroundColor Green
}

if ($env:OS -ne "Windows_NT") {
    throw "This bootstrap is for Windows. Use the repository instructions to adapt it for another OS."
}

Write-Step "Checking prerequisites"
Require-Command "node" "Install Node.js 20+ (for example: winget install OpenJS.NodeJS.LTS) and open a new terminal."
Require-Command "npm" "Install Node.js/npm and open a new terminal."

$nodeVersion = (& node -p "process.versions.node").Trim()
$nodeMajor = [int]($nodeVersion.Split('.')[0])
if ($nodeMajor -lt 20) {
    throw "Node.js 20+ is required. Detected $nodeVersion."
}
Write-Host "Node.js $nodeVersion" -ForegroundColor Green

Write-Step "Installing/updating pnpm and DeepSeek Harness"
& npm install -g pnpm @deepseek-ai/dsh@latest
if ($LASTEXITCODE -ne 0) { throw "npm global install failed." }

if (-not (Get-Command dsh -ErrorAction SilentlyContinue)) {
    throw "dsh was installed but is not visible in PATH. Open a new PowerShell window and re-run this script."
}

$dshVersion = (& dsh --version 2>&1 | Out-String).Trim()
Write-Host "DeepSeek Harness: $dshVersion" -ForegroundColor Green

Write-Step "Initializing the Harness Web profile"
& dsh --profile web --dump-default-config *> $null
if ($LASTEXITCODE -ne 0) { throw "Failed to initialize the web profile." }

$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME ".dsh" }

if (-not $SkipSubscriptions) {
    Write-Step "Installing subscription providers"
    Remove-LegacySubscriptionPlugins

    & dsh plugin --profile web add dsh-plugin-subscriptions
    if ($LASTEXITCODE -ne 0) { throw "Subscription plugin installation failed." }

    Write-Step "Applying duplicate dsh-tools workaround"
    Disable-ProfileLocalDshTools -DshHome $dshHome
}

if (-not $SkipPresets) {
    Write-Step "Installing Harness presets"
    Install-Preset -Name "qwen-power" -DshHome $dshHome
    Install-Preset -Name "supervisor-qwen" -DshHome $dshHome
}

if (-not $SkipQwen) {
    Write-Step "Configuring Qwen provider"
    Configure-Qwen -DshHome $dshHome -BaseUrl $QwenBaseUrl
}

Write-Step "Finished"
Write-Host "Harness installation is ready." -ForegroundColor Green
Write-Host ""
Write-Host "Next:" -ForegroundColor Cyan
Write-Host "  1. Run: dsh web"
if (-not $SkipSubscriptions) {
    Write-Host "  2. Open Settings -> Subscriptions."
    Write-Host "     Connect ChatGPT (Codex) to use ChatGPT subscription quota."
    Write-Host "     Connect Claude to use Claude Pro/Max subscription quota."
    Write-Host "     Claude can import an existing Claude Code login or use browser authorization."
}
if (-not $SkipQwen) {
    Write-Host "  3. Open Settings -> Models -> Qwen -> Edit, paste the Qwen API key, and Apply."
    Write-Host "     Worker affinity is already configured locally; the API key remains editable in Harness."
}
Write-Host '  4. Start a NEW conversation and test: Use run_code only to execute console.log("hello").'
Write-Host "  5. If tools ever regress after a plugin update, re-run Repair-DshTools-Windows.ps1 from this repository."
Write-Host ""
Write-Host "Important: do not launch Harness with QWEN_API_KEY set in the Windows environment if you want the Models UI key field to remain editable." -ForegroundColor Yellow
Write-Host "Subscription credentials stay in the local Harness profile and must never be committed." -ForegroundColor DarkGray
Write-Host "The generated Qwen affinity ID stays only under the local Harness home; it is never committed to this repository." -ForegroundColor DarkGray
Write-Host "No API keys, OAuth tokens, usernames, machine paths, IP addresses, or other private identifiers are stored in this repository." -ForegroundColor DarkGray
