# DeepSeek Harness - New Windows Machine Bootstrap

This folder reproduces the working Harness setup on a fresh Windows machine without committing secrets or machine-specific information.

## What the bootstrap installs

- latest `@deepseek-ai/dsh`
- latest `pnpm`
- Harness `web` profile
- `@wnjxyk/dsh-codex-oauth` for ChatGPT/Codex subscription OAuth
- `qwen-power` preset
- `supervisor-qwen` preset
- optional custom OpenAI-compatible Qwen provider
- workaround for the duplicate `@deepseek-ai/dsh-tools` Web-profile bug that causes:

```text
Interrupted: interrupted
Cannot read properties of undefined (reading 'prepare')
```

The Qwen API key is requested interactively and stored only in the local Windows user environment as `QWEN_API_KEY`. It is never written to this repository.

## Prerequisite

Use Node.js 20 or newer. On Windows with `winget`:

```powershell
winget install -e --id OpenJS.NodeJS.LTS
```

Open a new PowerShell window after Node.js is installed.

## Fast install - no Git clone required

Download the bootstrap to a temporary local file and run it:

```powershell
$installer = "$env:TEMP\Install-Harness-Windows.ps1"
Invoke-WebRequest "https://raw.githubusercontent.com/Logan17de/All-testing/main/llm/harness-bootstrap/Install-Harness-Windows.ps1" -OutFile $installer
PowerShell -ExecutionPolicy Bypass -File $installer
```

The installer asks for the Qwen OpenAI-compatible base URL and API key. Leave the base URL blank if Qwen should not be configured on this machine.

To supply the non-secret base URL as an argument:

```powershell
PowerShell -ExecutionPolicy Bypass -File $installer -QwenBaseUrl "https://gateway.example/v1"
```

Never place the real API key in the command line, repository, screenshots, or shell history. The script prompts for it with hidden input.

## Install from a cloned repository

```powershell
git clone https://github.com/Logan17de/All-testing.git
cd All-testing
PowerShell -ExecutionPolicy Bypass -File .\llm\harness-bootstrap\Install-Harness-Windows.ps1
```

## After the installer finishes

Start Harness:

```powershell
dsh web
```

For Codex OAuth, keep Harness running and open:

```text
http://127.0.0.1:1456/start
```

Complete the OAuth flow. OAuth tokens remain in the local Harness home and must never be committed.

Create a **new conversation** and verify the local tool runtime:

```text
Use run_code only to execute console.log("hello"). Do not call any tools.
```

Expected tool output:

```text
hello
```

Then test a normal file search/edit workflow.

## Presets installed

The bootstrap copies these into the local Harness preset directory:

```text
qwen-power
supervisor-qwen
```

`supervisor-qwen` uses the selected parent/supervisor model and pins its Qwen builder child to `qwen/qwen3.8-27b`.

## Qwen configuration

The generated provider uses:

```text
Provider ID     qwen
Protocol        openai-completions
Credential ref  QWEN_API_KEY
Model           qwen3.8-27b
Context         262144
Max output      32768
```

A privacy-safe manual template is available in:

```text
qwen-provider.settings.example.yml
```

If `$DSH_HOME/settings.yaml` already contains an `llm-pi-ai:` section, the installer intentionally does **not** attempt a risky YAML merge. Instead it writes a local snippet under `$DSH_HOME` and tells the operator to merge it through **Settings -> Models** or manually.

## If `run_code` / tools break after a plugin update

A plugin install/update may recreate a profile-local `@deepseek-ai/dsh-tools` package and trigger the duplicate-runtime bug again.

From a cloned repository run:

```powershell
PowerShell -ExecutionPolicy Bypass -File .\llm\harness-bootstrap\Repair-DshTools-Windows.ps1
```

Or simply rerun the main installer. It reapplies the workaround after installing the Codex plugin.

The repair does not delete the duplicate package. It renames it to a timestamped `.disabled-*` backup and forces the Web profile to use the host Harness tool runtime.

## Useful optional switches

```powershell
# Harness + presets, no Qwen provider
PowerShell -ExecutionPolicy Bypass -File $installer -SkipQwen

# Harness + Qwen, no Codex OAuth plugin
PowerShell -ExecutionPolicy Bypass -File $installer -SkipCodexOAuth

# Do not install repository presets
PowerShell -ExecutionPolicy Bypass -File $installer -SkipPresets
```

## Privacy rules for this setup

Repository documentation and scripts must use generic placeholders for machine/user-specific values. Do not commit or publish:

- local usernames or home-directory paths
- API keys or OAuth tokens
- private keys or credentials
- personal email addresses
- private server/IP details
- machine-specific identifiers

Use terms such as `<USER_HOME>`, `<PROJECT_PATH>`, `<API_KEY>`, `<SERVER_IP>`, and example domains where concrete values are unnecessary.
