# Connect OpenAI Codex Subscription to DeepSeek Harness

This document records the **working Windows setup** for using an OpenAI Codex / ChatGPT subscription directly inside **DeepSeek Harness**, without OmniRoute and without a normal OpenAI API key.

The final setup uses the community plugin:

```text
@wnjxyk/dsh-codex-oauth
```

It activates Harness's built-in `openai-codex` provider, performs OAuth login against the ChatGPT/Codex subscription, refreshes credentials automatically, discovers the models available to the account, and can also expose Codex-backed web search, image generation, and subscription-usage information.

> This is subscription OAuth access, not OpenAI Platform API billing. The requests consume the limits associated with the signed-in ChatGPT/Codex subscription.

---

## 1. Final Architecture

```text
DeepSeek Harness
      ↓
openai-codex provider
      ↓
Harness credential service
      ↓
DSH_OPENAI_CODEX_TOKEN
      ↓
@wnjxyk/dsh-codex-oauth
      ↓
OpenAI OAuth / Codex subscription backend
      ↓
Codex model
```

No local proxy such as OmniRoute is required for Codex access.

The plugin handles the OAuth credential and makes the resulting access token available to Harness's existing `openai-codex` provider.

---

## 2. What the Plugin Adds

The working plugin adds several pieces to the Harness Web profile:

```text
codex-oauth
codex-oauth/web-search
codex-oauth/image-tool
```

It also patches `llm-pi-ai` so that the built-in provider route:

```text
openai-codex
```

is enabled.

Internally, the provider expects a Harness credential reference named:

```text
DSH_OPENAI_CODEX_TOKEN
```

The OAuth plugin is responsible for populating that credential. The user should **not manually paste a normal OpenAI API key into the Models page for this provider**.

---

## 3. Prerequisites

The setup used:

```text
Windows
Node.js / npm
DeepSeek Harness
Harness Web profile
ChatGPT/Codex subscription account
```

If `pnpm` is not available on Windows, install it once:

```powershell
npm install -g pnpm
```

Verify:

```powershell
pnpm --version
```

---

## 4. Install the Working Codex OAuth Plugin

Install the plugin into the Harness `web` profile:

```powershell
dsh plugin --profile web add -w @wnjxyk/dsh-codex-oauth@latest
```

Then inspect the installed plugins:

```powershell
dsh plugin --profile web list
```

A healthy installation should contain a dependency similar to:

```text
@wnjxyk/dsh-codex-oauth@<version>
```

The exact version may change over time.

---

## 5. Remove the Older Incompatible Plugin if Present

An older plugin was tested first:

```text
dsh-codex-oauth@0.1.5
```

That package should not remain installed together with the newer `@wnjxyk` plugin.

Check:

```powershell
dsh plugin --profile web list
```

If both are present, remove only the old package:

```powershell
dsh plugin --profile web remove -w dsh-codex-oauth
```

Then check again:

```powershell
dsh plugin --profile web list
```

The goal is to keep:

```text
@wnjxyk/dsh-codex-oauth
```

and remove:

```text
dsh-codex-oauth@0.1.5
```

This also prevents duplicate `codex-oauth` entries and conflicting OAuth implementations.

---

## 6. Restart Harness

After installing or removing plugins, fully stop the Harness process and start it again:

```powershell
npx @deepseek-ai/dsh web
```

Do not rely only on refreshing the browser after a plugin installation. The Harness host itself should be restarted so the Cordis composition is rebuilt.

---

## 7. Verify the Plugin Is Mounted

Open Harness and go to the plugin page.

The Codex integration should appear as mounted/enabled components similar to:

```text
codex-oauth
codex-oauth/web-search
codex-oauth/image-tool
```

Depending on how Harness renders bundled plugins, an additional include/wrapper entry may also appear. That is not necessarily a duplicate by itself.

The important check is the CLI dependency list:

```powershell
dsh plugin --profile web list
```

Only one Codex OAuth package implementation should be installed.

---

## 8. Login Through the New Plugin

Keep Harness running.

The OAuth plugin starts a local loopback control service on:

```text
127.0.0.1:1456
```

### Browser OAuth

Open this URL in the browser:

```text
http://127.0.0.1:1456/start
```

Complete the OpenAI/ChatGPT authorization flow.

### Device-code OAuth

For a device-style flow, use:

```text
http://127.0.0.1:1456/start-device
```

This is useful if normal browser callback login is inconvenient.

---

## 9. What Happens After Login

After a successful login, the plugin stores and manages an OAuth credential containing information such as:

```text
access token
refresh token
expiry
ChatGPT account id
```

The plugin then injects the active bearer token into Harness's credential service using the reference:

```text
DSH_OPENAI_CODEX_TOKEN
```

Harness's built-in `openai-codex` provider reads that credential and can begin making Codex requests.

The plugin also refreshes credentials automatically while running.

The default OAuth credential document is stored under the Harness home directory, typically similar to:

```text
%USERPROFILE%\.dsh\codex-oauth.json
```

Do not commit this file to GitHub or copy it into a project workspace.

---

## 10. Do Not Add a Normal API Key

This setup does **not** require manually creating an API-key provider card for Codex.

Do not create a custom provider just to enter:

```text
openai
```

or:

```text
openai-codex
```

with a blank/random API key.

The OAuth plugin activates the real `openai-codex` route and supplies its credential through Harness's credential service.

This is why the correct chain is:

```text
OAuth login
   ↓
Codex credential file
   ↓
OAuth plugin
   ↓
Harness credentials service
   ↓
DSH_OPENAI_CODEX_TOKEN
   ↓
openai-codex provider
```

rather than:

```text
Models page
   ↓
manual API key
```

---

## 11. Select a Codex Model

After successful login, refresh/reopen Harness if necessary and use the **chat model picker**.

Models exposed by the account should be available through:

```text
provider: openai-codex
```

The model catalog is discovered dynamically, so the exact set of GPT/Codex models may change over time or by subscription/account.

Select one of the models returned by the plugin/provider rather than manually inventing a model id.

Then send a simple test message:

```text
Hi
```

A normal model response confirms the full path is working.

---

## 12. Subscription Usage

One reason this integration is useful is that the plugin can query Codex/ChatGPT subscription usage information.

Depending on the account and current backend response, it can display information such as:

```text
plan
primary usage window
secondary usage window
remaining/reset state
limit reached state
```

This can include windows such as the commonly exposed short-term and weekly Codex limits.

This makes a separate routing application unnecessary if the main reason for using it was to consume and inspect Codex subscription quota from Harness.

---

## 13. Optional Codex Features

The plugin bundle also includes:

```text
codex-oauth/web-search
codex-oauth/image-tool
```

These allow Harness to route supported web-search and image-generation features through the Codex subscription integration when enabled.

Their presence does not change the basic model-authentication flow.

---

## 14. Normal Startup After Initial Setup

Once the plugin is installed and OAuth has been completed, normal startup is simple:

```text
1. Start DeepSeek Harness.
2. Open the Harness Web UI.
3. Select an openai-codex model.
4. Start working.
```

Normally there is no need to perform OAuth login on every launch because the plugin stores the refresh credential and renews access automatically.

Re-login is only necessary if the credential is removed, revoked, expired in a way that cannot be refreshed, or the account authorization changes.

---

# Troubleshooting

## A. Error: `Provider is not configured: openai`

Example:

```text
Provider is not configured: openai
```

Cause:

A provider was manually selected/created without an actual Harness adapter configured for that route.

Fix:

Use the plugin-provided `openai-codex` route after the OAuth plugin is mounted.

---

## B. Error: `Provider is not configured: openai-codex`

Cause:

OAuth login alone does not mount the provider. The plugin must actually be installed into the Harness Web profile.

Check:

```powershell
dsh plugin --profile web list
```

Install:

```powershell
dsh plugin --profile web add -w @wnjxyk/dsh-codex-oauth@latest
```

Then restart Harness.

---

## C. Error: `MISSING_CREDENTIAL`

Example:

```text
llm-pi-ai: no credential for provider route "openai-codex";
its profile resolves DSH_OPENAI_CODEX_TOKEN, which is not set
```

This is actually a useful diagnostic.

It proves:

```text
plugin/provider route mounted ✅
model request reached openai-codex ✅
OAuth token not yet supplied ❌
```

Fix while Harness is running:

```text
http://127.0.0.1:1456/start
```

Complete OAuth. The plugin will populate `DSH_OPENAI_CODEX_TOKEN` automatically.

---

## D. `/codex login` Is Sent as a Normal Model Message

If typing:

```text
/codex login
```

creates an ordinary LLM request rather than an OAuth action, the command plugin being expected is not mounted in the current Harness composition.

For the working `@wnjxyk/dsh-codex-oauth` setup, use its local control UI instead:

```text
http://127.0.0.1:1456/start
```

There is no need to depend on the older slash-command implementation.

---

## E. OpenAI Browser Page Shows `missing_required_parameter`

This occurred with the older `dsh-codex-oauth@0.1.5` browser flow.

Example:

```text
Authentication Error
error_code: missing_required_parameter
```

The fix is not to keep retrying that old OAuth URL.

Remove the old plugin:

```powershell
dsh plugin --profile web remove -w dsh-codex-oauth
```

Install/keep the newer plugin:

```powershell
dsh plugin --profile web add -w @wnjxyk/dsh-codex-oauth@latest
```

Then use:

```text
http://127.0.0.1:1456/start
```

---

## F. Duplicate `codex-oauth` Cards

Check installed dependencies:

```powershell
dsh plugin --profile web list
```

If the output contains both:

```text
@wnjxyk/dsh-codex-oauth
```

and:

```text
dsh-codex-oauth@0.1.5
```

remove the old package.

Some remaining multiple cards can still be normal because the new bundle contains a parent/include composition plus separate OAuth/search/image components.

---

## G. `pnpm` Is Not Recognized

Install it globally:

```powershell
npm install -g pnpm
```

Then verify:

```powershell
pnpm --version
```

---

# Using Codex as the Supervisor and Qwen as the Builder

This Codex integration is especially useful with the custom Harness preset in this repository:

```text
llm/harness-presets/supervisor-qwen/
```

That architecture is:

```text
Human
  ↓
Codex supervisor
  ↓
Qwen builder
  ↓
shared repository/workspace
  ↓
Codex verifies actual diff/tests
  ↓
Qwen receives correction or next task
  ↓
repeat
```

The parent session can use an `openai-codex` model while the `qwen_builder` subagent remains pinned to:

```text
provider: qwen
model: qwen3.8-27b
```

This separates responsibilities:

```text
Codex = planning, review, verification, next-step decisions
Qwen  = implementation, editing, testing, repetitive coding work
```

It also avoids requiring OmniRoute simply to access Codex subscription quota.

---

# Security Notes

The OAuth credential should be treated like an API secret.

Do not:

```text
commit codex-oauth.json
paste OAuth access/refresh tokens into GitHub
put the Harness home directory inside a model workspace
share the credential file between untrusted machines
```

The plugin is a third-party integration and its own documentation notes that it depends on Codex/ChatGPT backend behavior that may change. An OpenAI protocol/backend change can temporarily break the integration until the plugin is updated.

For production or business-critical systems, evaluate the security and support implications of relying on a community OAuth bridge.

---

# Quick Setup Summary

For a clean machine/profile, the essential sequence is:

```powershell
# Optional if pnpm is missing
npm install -g pnpm

# Install Codex OAuth integration into Harness Web profile
dsh plugin --profile web add -w @wnjxyk/dsh-codex-oauth@latest

# Verify
dsh plugin --profile web list

# Start/restart Harness
npx @deepseek-ai/dsh web
```

Then, while Harness is running, open:

```text
http://127.0.0.1:1456/start
```

Complete OAuth and select an `openai-codex` model from the Harness chat model picker.

No ordinary OpenAI API key and no OmniRoute are required for this Codex subscription path.

---

## Reference

Working plugin used by this setup:

```text
https://github.com/WNJXYK/dsh-codex-oauth
```

DeepSeek Harness:

```text
https://github.com/deepseek-ai/deepseek-harness
```
