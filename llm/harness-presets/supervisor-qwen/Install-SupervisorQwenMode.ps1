param(
    [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\.."))
)

$ErrorActionPreference = "Stop"

$source = Join-Path $RepoRoot "llm\harness-presets\supervisor-qwen\agent.cordis.yml"
if (-not (Test-Path $source)) {
    throw "Preset source not found: $source"
}

$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME ".dsh" }
$targetDir = Join-Path $dshHome ".agent-presets\supervisor-qwen"
$target = Join-Path $targetDir "agent.cordis.yml"

New-Item -ItemType Directory -Force -Path $targetDir | Out-Null
Copy-Item -Force $source $target

Write-Host ""
Write-Host "Supervisor -> Qwen mode installed." -ForegroundColor Green
Write-Host "Preset: $target"
Write-Host ""
Write-Host "Restart the DeepSeek Harness host, select the supervisor-qwen preset,"
Write-Host "then choose the model you want to act as the supervisor."
Write-Host "The qwen_builder child is pinned to qwen/qwen3.8-27b with 32768 max tokens."
