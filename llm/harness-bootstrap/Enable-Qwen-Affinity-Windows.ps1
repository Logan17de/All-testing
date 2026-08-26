$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME ".dsh" }
$settingsPath = Join-Path $dshHome "settings.yaml"
$affinityPath = Join-Path $dshHome "qwen-affinity.id"

if (-not (Test-Path -LiteralPath $settingsPath)) {
    throw "Harness settings.yaml was not found under the configured DSH home."
}

$affinity = $null
if (Test-Path -LiteralPath $affinityPath) {
    $candidate = ([IO.File]::ReadAllText($affinityPath)).Trim()
    if ($candidate -match '^[A-Za-z0-9_-]{16,128}$') {
        $affinity = $candidate
    }
}

if (-not $affinity) {
    $affinity = [Guid]::NewGuid().ToString("N")
    [IO.File]::WriteAllText(
        $affinityPath,
        $affinity + [Environment]::NewLine,
        [Text.UTF8Encoding]::new($false)
    )
}

$settings = [IO.File]::ReadAllText($settingsPath)
$qwenPattern = '(?ms)^(?<head>\s{4}qwen:\s*\r?\n)(?<body>.*?)(?=^\s{4}\S|\z)'
$match = [regex]::Match($settings, $qwenPattern)
if (-not $match.Success) {
    throw "Could not locate the llm-pi-ai providers.qwen block. Configure Qwen in Harness first, then rerun this repair."
}

$head = $match.Groups['head'].Value
$body = $match.Groups['body'].Value

if ($body -match '(?m)^\s{6}headers:\s*$') {
    if ($body -match '(?m)^\s{8}X-Qwen-Affinity:\s*.*$') {
        $body = [regex]::Replace(
            $body,
            '(?m)^\s{8}X-Qwen-Affinity:\s*.*$',
            "        X-Qwen-Affinity: '$affinity'",
            1
        )
    }
    else {
        $body = [regex]::Replace(
            $body,
            '(?m)^(\s{6}headers:\s*\r?\n)',
            "`$1        X-Qwen-Affinity: '$affinity'`r`n",
            1
        )
    }
}
else {
    $body = "      headers:`r`n        X-Qwen-Affinity: '$affinity'`r`n" + $body
}

$replacement = $head + $body
$updated = $settings.Substring(0, $match.Index) + $replacement + $settings.Substring($match.Index + $match.Length)

$backupPath = "$settingsPath.pre-qwen-affinity.bak"
if (-not (Test-Path -LiteralPath $backupPath)) {
    Copy-Item -LiteralPath $settingsPath -Destination $backupPath
}

[IO.File]::WriteAllText($settingsPath, $updated, [Text.UTF8Encoding]::new($false))

Write-Host "Qwen worker affinity configured for this Harness installation." -ForegroundColor Green
Write-Host "The affinity value stays local and was not printed." -ForegroundColor DarkGray
Write-Host "Restart Harness if it is already running, then start a new Qwen conversation." -ForegroundColor Cyan
