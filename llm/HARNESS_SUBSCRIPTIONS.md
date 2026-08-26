# DeepSeek Harness Subscription Providers

This guide documents the current subscription-based Harness setup for using supported consumer subscriptions directly inside DeepSeek Harness without adding ordinary API keys for those providers.

The current setup uses:

```text
dsh-plugin-subscriptions
```

Primary providers used by this repository:

```text
ChatGPT (Codex) -> ChatGPT Plus/Pro subscription usage
Claude           -> Claude Pro/Max subscription usage
Qwen             -> separate custom OpenAI-compatible provider
```

The subscription plugin may expose additional providers as supported by its upstream project. They are optional and do not need to be connected.

## Install

With the `dsh` CLI already installed:

```powershell
dsh plugin --profile web add dsh-plugin-subscriptions
```

Restart Harness after installation:

```powershell
dsh web
```

The repository bootstrap performs this automatically on a new Windows machine:

```text
llm/harness-bootstrap/Install-Harness-Windows.ps1
```

## Connect subscriptions

Start Harness and open:

```text
Settings -> Subscriptions
```

Only connect the providers you want to use.

### ChatGPT / Codex

Choose the ChatGPT/Codex subscription card and click **Connect**.

Complete the browser authorization flow. Once authenticated, available Codex models appear in the Harness model picker.

This route uses the signed-in ChatGPT subscription quota rather than an ordinary OpenAI Platform API key.

### Claude

Choose the Claude subscription card and click **Connect**.

If a valid Claude Code session already exists on the machine, the plugin can import its authorization. If not, it can use browser authorization directly, so Claude Code CLI installation is optional for this Harness path.

Once authenticated, supported Claude subscription models appear in the Harness model picker and use the signed-in Claude Pro/Max subscription quota.

## Credentials

The plugin stores subscription authorization locally under the Harness home, typically:

```text
~/.dsh/plugins/subscriptions/auth.json
```

The authorization data refreshes locally as supported by the plugin.

Treat this file like an API secret.

Never:

```text
commit it to GitHub
paste its contents into issues or documentation
share access or refresh tokens
copy the entire Harness home into a project repository
publish screenshots containing credential material
```

## Subscription usage

When supported by the upstream provider, **Settings -> Subscriptions** can display usage windows, used percentage, and reset timing.

This is useful for checking whether a model request is consuming subscription quota without relying on a separate routing application.

## Verify Codex

Select a Codex subscription model in the Harness model picker and send:

```text
Reply exactly: CODEX_OK
```

Expected response:

```text
CODEX_OK
```

## Verify Claude

Select a Claude subscription model and send:

```text
Reply exactly: CLAUDE_OK
```

Expected response:

```text
CLAUDE_OK
```

## Use with the supervisor preset

The repository preset:

```text
llm/harness-presets/supervisor-qwen/
```

keeps the delegated builder pinned to Qwen while allowing the parent session to use whichever supervisor model is selected.

Examples:

```text
Codex subscription model
        ↓
 supervisor-qwen
        ↓
 qwen_builder
```

or:

```text
Claude subscription model
        ↓
 supervisor-qwen
        ↓
 qwen_builder
```

A minimal delegation smoke test is:

```text
You are the supervisor.
Delegate exactly one task to qwen_builder:
Reply with exactly `hello`.
Do not answer the task yourself.
After qwen_builder returns, report the exact worker response.
```

## Update

For an npm installation:

```powershell
dsh plugin --profile web update --latest dsh-plugin-subscriptions
```

Then fully restart Harness:

```powershell
dsh web
```

## Migration from the older single-provider setup

The current bootstrap no longer installs the previous Codex-only OAuth package.

When rerun on an older machine, the bootstrap checks for the old single-provider packages and removes them before installing `dsh-plugin-subscriptions`.

The current login path is:

```text
Harness
  -> Settings
  -> Subscriptions
  -> Connect provider
```

Do not follow older instructions that use a separate localhost OAuth control page.

## Tool-runtime compatibility

This repository also carries a workaround for a previously observed duplicate `@deepseek-ai/dsh-tools` installation that caused errors such as:

```text
Interrupted: interrupted
Cannot read properties of undefined (reading 'prepare')
```

If that issue returns after a plugin or Harness update, run:

```powershell
PowerShell -ExecutionPolicy Bypass -File .\llm\harness-bootstrap\Repair-DshTools-Windows.ps1
```

or rerun the main bootstrap.

## Privacy rules

Do not place user-specific or machine-specific values in repository documentation.

Use generic placeholders such as:

```text
<USER_HOME>
<PROJECT_PATH>
<API_KEY>
<SERVER_IP>
<EMAIL>
```

Never commit OAuth tokens, subscription credentials, API keys, local usernames, private server details, or other personal environment information.

## Upstream project

Subscription plugin:

```text
https://github.com/V1ki/dsh-plugin-subscriptions
```

DeepSeek Harness:

```text
https://github.com/deepseek-ai/deepseek-harness
```
