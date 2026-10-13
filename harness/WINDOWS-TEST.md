# Zet Harness: Windows testing kit

This is a **local test build**, not an installer, signed executable, published
package or completed production-security certification. Keep real credentials
and sensitive project folders out of initial testing.

## First run

1. Download the `zet-harness-windows-test-kit` artifact from the successful
   [Zet Harness CI workflow](https://github.com/Logan17de/All-testing/actions/workflows/harness-ci.yml).
   GitHub may require you to sign in to download artifacts.
2. Unzip it. Open the `harness` subfolder. **Do not run anything as
   Administrator**.
3. Install official **Node.js 24.20.x** and **npm 12.0.2** (or later 12.x) if
   they are not already available on PATH.
4. Double-click **Prepare Zet Harness.cmd**. It runs `npm ci` and builds the
   web and runtime from pinned sources. A network connection is needed for the
   first install. If it fails, inspect its command output before proceeding.
5. Double-click **Start Zet Harness.cmd**. After both local services are
   ready, open **http://127.0.0.1:3000**. Keep the console open while testing.
   Ctrl+C stops both services.
6. In Setup, explicitly select a **test-only project folder** and confirm
   trust. Connect a supported model using the settings UI only after you
   have checked the app behavior.

The launcher listens on loopback; it does not expose a public server. The
test kit installs dependencies from your npm configuration, compiles locally,
and does not include private model credentials, personal databases or tokens.

## Preserving data and upgrading

The Windows launcher explicitly sets both state locations under
`%LOCALAPPDATA%\ZetHarness`:

- `runtime.sqlite` — conversations, project settings and other persisted data
- `plugins` — installed plugin packages and configuration

Do not delete or overwrite that folder. It is intentionally **outside** the
downloaded application so extraction of a newer build does not replace it.
Make a backup of the database and its `-wal` and `-shm` sidecars **with the
runtime stopped**, or use the documented supported backup command. Do not
overwrite an in-use database. Production upgrades and migration rollback
must be tested separately. Never automatically restore a database into an
existing application state.

## Known acceptance limits

- The normal launcher does **not** turn on the human PTY or grant model shell
  permissions. Human-terminal support needs a separately verified host adapter
  and per-chat authorization.
- The native browser on the original Windows host has not yet completed an
  actual Chromium page launch. Browser tests or smoke checks alone cannot
  validate that host's GPU, sandbox, or local security configuration.
- Live login, model-to-tool roundtrips, OS notifications/audio and the browser
  file-download completion still require hands-on acceptance.
- Direct Windows project command execution remains restricted by the kernel
  security hold. Do not disable security controls to work around it.
- This build is not a Windows desktop executable. It is a local Node.js
  application, served by Next.js in your browser.

Please report any startup or tool failures with the stage and **redacted**
diagnostic code. Never paste keys, credentials, cookies, personal paths, or
private file contents into an issue.
