param(
    [switch]$Quiet
)

$ErrorActionPreference = "Stop"

$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME ".dsh" }
$profileTools = Join-Path $dshHome "profiles\web\node_modules\@deepseek-ai\dsh-tools"

if (-not (Test-Path -LiteralPath $profileTools)) {
    if (-not $Quiet) {
        Write-Host "No profile-local dsh-tools copy found. Nothing to repair." -ForegroundColor Green
    }
    exit 0
}

$item = Get-Item -LiteralPath $profileTools -Force
if ($item.LinkType) {
    if (-not $Quiet) {
        Write-Host "Profile dsh-tools is already a filesystem link. No change made." -ForegroundColor Yellow
    }
    exit 0
}

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$disabled = "$profileTools.disabled-$stamp"
Rename-Item -LiteralPath $profileTools -NewName (Split-Path $disabled -Leaf)

if (-not $Quiet) {
    Write-Host "Disabled duplicate profile-local dsh-tools:" -ForegroundColor Green
    Write-Host "  $profileTools"
    Write-Host "Backup:" -ForegroundColor DarkGray
    Write-Host "  $disabled"
    Write-Host ""
    Write-Host "Restart dsh web and test run_code." -ForegroundColor Cyan
}
