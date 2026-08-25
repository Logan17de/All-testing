$ErrorActionPreference = "Stop"

Write-Host "Installing/updating the Qwen Harness bridge from GitHub..."
py -m pip install --upgrade "git+https://github.com/Logan17de/All-testing.git#subdirectory=llm"

Write-Host ""
Write-Host "Starting local OpenAI-compatible bridge on 127.0.0.1:8787..."
Write-Host "If QWEN_RELAY_SECRET is not already set, the bridge will prompt for it securely."
Write-Host ""

py -m qwen_harness_bridge
