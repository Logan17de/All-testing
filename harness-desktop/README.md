# Harness Desktop v0.1

Native Windows client for DeepSeek Harness focused on everyday agent work and one safe plugin iteration loop:

**Receive plugin → validate format → install dependencies → compile → snapshot the current profile → activate → verify composed config → health-check → restart.**

If activation or the health check fails, the previous profile is restored automatically. A manual **Rollback previous change** control is also available inside the app.

## Included in v0.1

- Native desktop Work surface with tasks, multi-turn conversations, live run state, model selection, and cancellation.
- DeepSeek Harness `0.1.1-rc.2` bundled as an application dependency.
- Bundled pnpm runtime for DSH plugin operations.
- Harness engine startup/restart and health status over narrow process IPC.
- No embedded website, webview, or localhost UI server during normal operation.
- Workspace selection, DSH registration, and restart persistence.
- OpenAI-compatible API `/models` connection check plus validated DeepSeek provider saving.
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

### Why the DSH runtime closure is pinned explicitly

`electron-builder` collects `dependencies` only. Parts of the DSH engine are
reached through `peerDependencies` (satisfied in development by pnpm's
`autoInstallPeers`) and through platform-specific `optionalDependencies` such as
`@img/sharp-win32-x64` and `@koromix/koffi-win32-x64`. Neither kind is copied
into the packaged application, so a build that omits them installs and launches
but can never start the engine — it fails with
`Cannot find package '@deepseek-ai/cordis-plugin-group'` and drops into Safe Mode.

Those packages are therefore pinned as direct `dependencies` of this app.
`test/packaging.test.js` fails if a DSH upgrade introduces a new engine peer
dependency that would not ship, so run `npm test` before cutting a build.

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

Run the executable with `--safe-mode` to open the desktop client without starting the engine. The app also enters Safe Mode automatically when it detects that the previous desktop boot was interrupted during Harness startup.

Plugin versions, staging files, and profile snapshots live in the app's Electron `userData` directory. DeepSeek Harness itself continues to use `$DSH_HOME`, defaulting to `~/.dsh`.

## Current limitation

This is a Windows x64 v0.1 build. DeepSeek Harness is still a developer-preview project, so its engine and plugin contracts are version-pinned until compatibility is retested. The Windows installer is unsigned unless a signing certificate is supplied to the build environment.
