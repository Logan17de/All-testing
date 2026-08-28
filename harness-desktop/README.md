# Harness Desktop v0.1

Windows desktop shell for DeepSeek Harness focused on one safe iteration loop:

**Receive plugin → validate format → install dependencies → compile → snapshot the current profile → activate → verify composed config → health-check → restart.**

If activation or the health check fails, the previous profile is restored automatically. A manual **Rollback previous change** control is also available inside the app.

## Included in v0.1

- Clean English-only desktop UI.
- DeepSeek Harness `0.1.1-rc.2` bundled as an application dependency.
- Bundled pnpm runtime for DSH plugin operations.
- Harness startup/restart and health status.
- Embedded Harness web UI at `127.0.0.1:3080`.
- Workspace selector.
- OpenAI-compatible API `/models` connection check.
- `.zip` plugin receiver.
- DSH plugin-format validator (`package.json` + `dsh.bundle.patch`).
- Optional plugin permission declarations under `harnessDesktop.permissions`.
- Staging and plugin dependency install/build before touching the live profile.
- Profile snapshot before activation/disable.
- Post-install `--dump-config` verification.
- Post-start health check with automatic rollback on failure.
- Plugin disable.
- Manual rollback to the previous profile snapshot.
- Safe Mode after an interrupted boot; Harness does not auto-start so rollback stays usable.
- App/Harness/plugin build logs.
- Full desktop relaunch after successful activation, disable, or rollback.

## Run from source

```powershell
cd harness-desktop
npm install
npm test
npm start
```

## Build the Windows EXE

```powershell
npm install
npm test
npm run dist
```

The installer is created under `dist/` as `Harness-Desktop-Setup-<version>-x64.exe`.

## Plugin archive format

A plugin ZIP must contain one plugin root with a `package.json`. Standard DSH bundle plugins are accepted. Minimum example:

```json
{
  "name": "dsh-my-plugin",
  "version": "1.0.0",
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"
    }
  }
}
```

If the plugin has a `build` script, Harness Desktop runs it after dependency installation and before activation.

Optional permission metadata for the desktop review screen:

```json
{
  "harnessDesktop": {
    "permissions": ["filesystem", "network", "shell", "models", "ui", "workspace"]
  }
}
```

This metadata is descriptive in v0.1; it does not attempt to sandbox Cordis/DSH plugins. A plugin is trusted executable code, so only activate plugins you trust.

## Recovery

Run the executable with `--safe-mode` to open the shell without starting Harness. The app also enters Safe Mode automatically when it detects that the previous desktop boot was interrupted during Harness startup.

Plugin versions, staging files, and profile snapshots live in the app's Electron `userData` directory. DeepSeek Harness itself continues to use `$DSH_HOME`, defaulting to `~/.dsh`.

## Current limitation

This is a Windows x64 v0.1 build. The UI wraps the existing Harness web application while keeping plugin installation, verification, recovery, and rollback in the desktop shell. DeepSeek Harness is still a developer-preview project, so its plugin contract may change and this wrapper should remain version-pinned until compatibility is retested.
