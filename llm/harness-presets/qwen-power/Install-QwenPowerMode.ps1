$ErrorActionPreference = 'Stop'

$repoRaw = 'https://raw.githubusercontent.com/Logan17de/All-testing/main/llm/harness-presets/qwen-power'
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }
$presetDir = Join-Path $dshHome '.agent-presets\qwen-power'
$presetFile = Join-Path $presetDir 'agent.cordis.yml'
$settingsFile = Join-Path $presetDir 'settings-snippet.yml'

Write-Host ''
Write-Host 'Qwen Power Code Mode installer' -ForegroundColor Cyan
Write-Host "DSH home : $dshHome"
Write-Host "Preset   : $presetDir"
Write-Host ''

New-Item -ItemType Directory -Force -Path $presetDir | Out-Null

if (Test-Path $presetFile) {
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $backup = "$presetFile.$stamp.bak"
    Copy-Item $presetFile $backup
    Write-Host "Backed up existing preset -> $backup" -ForegroundColor Yellow
}

Invoke-WebRequest -UseBasicParsing "$repoRaw/agent.cordis.yml" -OutFile $presetFile
Invoke-WebRequest -UseBasicParsing "$repoRaw/settings-snippet.yml" -OutFile $settingsFile

if (-not (Test-Path $presetFile)) {
    throw 'Preset installation failed: agent.cordis.yml was not created.'
}

Write-Host ''
Write-Host 'Installed Qwen Power Code Mode successfully.' -ForegroundColor Green
Write-Host ''
Write-Host 'Next:'
Write-Host '  1. In Harness Qwen model settings set maxTokens to 32768.'
Write-Host '  2. Recommended default reasoning effort: medium.'
Write-Host '  3. Restart the Harness host.'
Write-Host '  4. Create a new session and select qwen-power.'
Write-Host ''
Write-Host "Preset file   : $presetFile"
Write-Host "Settings guide: $settingsFile"
