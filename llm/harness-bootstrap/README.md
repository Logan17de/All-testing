# DeepSeek Harness - New Windows Machine Bootstrap

This folder reproduces the working Harness setup on a fresh Windows machine without committing secrets or machine-specific information.

## What the bootstrap installs

- latest `@deepseek-ai/dsh`
- latest `pnpm`
- Harness `web` profile
- `dsh-plugin-subscriptions` for subscription-backed models
- ChatGPT/Codex subscription support
- Claude Pro/Max subscription support
- `qwen-power` preset
- `supervisor-qwen` preset
- optional custom OpenAI-compatible Qwen provider
- stable local Qwen worker affinity
- workaround for the duplicate `@deepseek-ai/dsh-tools` Web-profile bug that causes:

```text
Interrupted: interrupted
Cannot read properties of undefined (reading 'prepare')
```

The subscription plugin uses account authorization instead of ordinary API keys. Subscription credentials stay in the local Harness profile and are never committed by this repository.

The bootstrap also does **not** store the Qwen API key in a Windows environment variable. The user enters the key directly in **Harness -> Settings -> Models -> Qwen** and Harness stores it in its own local credential store.

## Subscription providers

The bootstrap installs:

```text
dsh-plugin-subscriptions
```

The plugin can expose subscription-backed providers in Harness. This setup is primarily intended for:

```text
ChatGPT (Codex) -> ChatGPT Plus/Pro subscription usage
Claude           -> Claude Pro/Max subscription usage
Qwen             -> custom OpenAI-compatible API
```

The plugin may also support additional subscription providers. They do not need to be connected unless desired.

After installation, start Harness and open:

```text
Settings -> Subscriptions
```

Then connect the providers you want.

### ChatGPT / Codex

Click **Connect** on the ChatGPT/Codex card and complete the browser authorization flow. After login, available Codex models appear in the model picker and requests consume the signed-in ChatGPT subscription limits rather than OpenAI Platform API billing.

### Claude

Click **Connect** on the Claude card.

If a valid Claude Code login already exists locally, the plugin can import that authorization. Otherwise it falls back to browser authorization. The Claude Code CLI is therefore optional for Harness subscription access.

After login, Claude subscription models appear in the Harness model picker and consume the signed-in Claude Pro/Max subscription limits.

### Subscription usage

The plugin can display available subscription usage information and reset windows in **Settings -> Subscriptions** when the upstream provider exposes that information.

The plugin stores its subscription authorization data locally under the Harness home, typically:

```text
~/.dsh/plugins/subscriptions/auth.json
```

Treat that file as a secret. Never commit, upload, screenshot, or paste its contents into repository documentation or issues.

More details are documented in:

```text
llm/HARNESS_SUBSCRIPTIONS.md
```

## Migration from older single-provider plugins

The current bootstrap no longer installs the previous Codex-only OAuth integration.

When the installer detects an older single-provider package, it removes it before installing `dsh-plugin-subscriptions`. This avoids overlapping provider/auth implementations in the same Web profile.

For new installations, use **Settings -> Subscriptions** rather than a separate localhost OAuth control page.

## Qwen worker affinity

Each Harness installation gets one random local affinity ID. The installer stores it under the local Harness home and adds it to the Qwen provider as:

```yaml
headers:
  X-Qwen-Affinity: <LOCAL_RANDOM_AFFINITY_ID>
```

The public gateway hashes this value before sending it to the relay. The raw affinity value is not stored in Supabase.

Routing behavior:

```text
Harness installation
        ↓
X-Qwen-Affinity
        ↓
Gateway hashes it
        ↓
Affinity map
        ↓
Colab worker A
```

As long as worker A remains online, inference-ready, and heartbeating, later requests from that Harness installation remain on worker A. This preserves vLLM prefix-cache locality instead of bouncing the same client between Colabs.

If worker A disappears or stops heartbeating, the next queued request may be claimed by another healthy worker and the affinity is automatically rebound to that worker. A newly started Colab does **not** steal an existing healthy affinity.

Older Harness installs that do not yet send `X-Qwen-Affinity` still get a compatibility fallback based on an opaque hash of the API credential. Rerunning/updating the bootstrap is recommended so separate machines receive separate affinity IDs.

The generated affinity ID is machine-local configuration. Never copy its concrete value into public documentation, screenshots, issues, or repository files.

## Prerequisite

Use Node.js 20 or newer. On Windows with `winget`:

```powershell
winget install -e --id OpenJS.NodeJS.LTS
```

Open a new PowerShell window after Node.js is installed.

## Fast install - no Git clone required

```powershell
$installer = "$env:TEMP\Install-Harness-Windows.ps1"
Invoke-WebRequest "https://raw.githubusercontent.com/Logan17de/All-testing/main/llm/harness-bootstrap/Install-Harness-Windows.ps1" -OutFile $installer
PowerShell -ExecutionPolicy Bypass -File $installer
```

The installer asks only for the Qwen OpenAI-compatible base URL. Leave it blank if Qwen should not be configured on this machine.

To supply the non-secret base URL as an argument:

```powershell
PowerShell -ExecutionPolicy Bypass -File $installer -QwenBaseUrl "https://gateway.example/v1"
```

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

Then configure subscriptions:

```text
Settings -> Subscriptions
```

Connect:

```text
ChatGPT (Codex)
Claude
```

Then configure Qwen if required:

```text
Settings -> Models -> Qwen -> Edit
```

Paste the Qwen API key into the **API key** field and click **Apply**.

Harness stores the Qwen secret in its local credential store. The settings document may subsequently contain a credential reference such as:

```text
QWEN_API_KEY
```

That reference is not the secret itself.

### Important: avoid Qwen launch-environment locking

If `QWEN_API_KEY` is already set as an operating-system environment variable when Harness starts, the Models UI treats that credential as launch-provided and displays:

```text
Provided by the launch environment (read-only)
```

If direct editing in Harness is desired, do **not** launch Harness with that environment variable set.

For a machine that used an older version of this bootstrap, close Harness and remove the old user-level variable:

```powershell
[Environment]::SetEnvironmentVariable("QWEN_API_KEY", $null, "User")
Remove-Item Env:QWEN_API_KEY -ErrorAction SilentlyContinue
```

Then start a fresh Harness process:

```powershell
dsh web
```

The Qwen API-key field should now be writable. Enter the key in the Models UI and Apply.

## Verify the tool runtime

Create a **new conversation** and run:

```text
Use run_code only to execute console.log("hello"). Do not call any tools.
```

Expected tool output:

```text
hello
```

Then test a normal file search/edit workflow.

## Verify subscription models

For Codex, choose a model under the ChatGPT/Codex subscription provider and send:

```text
Reply exactly: CODEX_OK
```

For Claude, choose a Claude subscription model and send:

```text
Reply exactly: CLAUDE_OK
```

If both return correctly, the subscription routes are available to Harness.

## Presets installed

The bootstrap copies:

```text
qwen-power
supervisor-qwen
```

`supervisor-qwen` uses the selected parent/supervisor model and pins its Qwen builder child to `qwen/qwen3.8-27b`.

This means the parent can be a subscription-backed Codex or Claude model while Qwen remains the delegated builder.

## Agent Team workflow (optional)

`agent-team/` adds the same supervisor/worker idea as a real team instead of a
single session: an **Engineering Leader** and a **Qwen Coder** that are
independent root sessions sharing one Workspace, each with its own model,
context and permissions. The Leader delegates, then inspects the Workspace and
verifies before accepting.

```powershell
cd agent-team
.\Install-AgentTeam-Windows.ps1 -Workspace "<PROJECT_PATH>"
```

It also installs the plugin market, a file explorer with source control, and
session deletion (DSH ships `archiveSession` but no delete).

`supervisor-qwen` is **not** replaced. It remains the only one of the two that
works without Agent Team installed, so it stays as the fallback. See
[agent-team/README.md](agent-team/README.md).

> The installer runs `Repair-DshTools-Windows.ps1` **after** installing plugins,
> because plugin installs are what reintroduce the duplicate `dsh-tools` copy.

## Qwen configuration

The generated provider uses:

```text
Provider ID     qwen
Protocol        openai-completions
API key         entered directly in Harness Models UI
Affinity        stable random ID generated locally
Model           qwen3.8-27b
Context         262144
Max output      32768
```

A privacy-safe manual template is available in:

```text
qwen-provider.settings.example.yml
```

If `$DSH_HOME/settings.yaml` already contains an `llm-pi-ai:` section, the installer intentionally does **not** attempt a risky YAML merge. Instead it writes a local snippet under `$DSH_HOME` containing the generated affinity header and tells the operator to merge/add the provider safely. The API key should still be entered through **Settings -> Models**.

## If `run_code` / tools break after a plugin update

A plugin install/update may recreate a profile-local `@deepseek-ai/dsh-tools` package and trigger the duplicate-runtime bug again.

From a cloned repository run:

```powershell
PowerShell -ExecutionPolicy Bypass -File .\llm\harness-bootstrap\Repair-DshTools-Windows.ps1
```

Or rerun the main installer. It reapplies the workaround after plugin installation.

The repair does not delete the duplicate package. It renames it to a timestamped `.disabled-*` backup and forces the Web profile to use the host Harness tool runtime.

## Update the subscription plugin

To update an npm-installed subscription plugin:

```powershell
dsh plugin --profile web update --latest dsh-plugin-subscriptions
```

Then fully restart `dsh web`.

## Useful optional switches

```powershell
# Harness + subscriptions + presets, no Qwen provider
PowerShell -ExecutionPolicy Bypass -File $installer -SkipQwen

# Harness + Qwen + presets, no subscription plugin
PowerShell -ExecutionPolicy Bypass -File $installer -SkipSubscriptions

# Do not install repository presets
PowerShell -ExecutionPolicy Bypass -File $installer -SkipPresets
```

## Privacy rules for this setup

Repository documentation and scripts must use generic placeholders for machine/user-specific values. Do not commit or publish:

- local usernames or home-directory paths
- API keys or OAuth tokens
- subscription authorization files
- private keys or credentials
- personal email addresses
- private server/IP details
- machine-specific identifiers, including concrete affinity IDs

Use terms such as `<USER_HOME>`, `<PROJECT_PATH>`, `<API_KEY>`, `<SERVER_IP>`, `<LOCAL_RANDOM_AFFINITY_ID>`, and example domains where concrete values are unnecessary.
