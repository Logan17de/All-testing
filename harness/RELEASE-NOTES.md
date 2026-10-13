# Zet Harness source snapshot — October 13, 2026

This snapshot brings the local Z Harness implementation developed October 6–7 into the `zet-harness-v1` branch and existing draft PR #9. It builds on `fbd3b11429ce21e10a0c4450215c0873dd132dad`. Private workspace packages retain their existing `0.0.0` versions; this is a dated source checkpoint, not a published npm package or binary release.

## Changes

- Shared application shell, responsive sidebar, pinned projects/chats, title search, project menus and folder settings, graph controls, connection editing, and graph guide.
- Embedded Settings pages and modal navigation, persistent General/Chat preferences, task and approval notifications, archived-chat restore/delete, and configurable retention with never-delete as the default.
- Durable chat pins and bounded, redacted Markdown exports of the selected saved branch.
- Host-configured human terminal with explicit per-chat grants, output streaming, resize, interrupt, reconnect, lease expiry, and revocation. Browser worker isolation, launch diagnostics, and bounded browser/terminal proxy requests.
- Trusted-folder checks, clearer provider/context diagnostics, model response hardening, and assistant routing coverage.
- Production startup serving compiled runtime/UI builds, missing-build refusal before restart, portable npm resolution, and launcher regressions.

Runtime databases, installed plugins, credentials, portable tools, screenshots, fixture state, caches, and compiled outputs are excluded. The separate Windows checkpoint branches retain their security investigations and commits; this update does not merge or replace them.

## Validation

- Fresh `npm ci` with portable Node 24.20.0 and npm 12.0.2: passed.
- Complete `npm run build`, repository typecheck, lint, formatting, and generated message-inventory checks: passed.
- Real compiled-runtime startup with a temporary SQLite database and SSE handshake: passed. Optimized production web startup and health probe: passed. Both temporary services stopped after their checks.
- The complete Vitest run covered 301 files and 2,399 tests. It initially found 21 failures in 14 files: fixtures missing explicit trusted-folder setup, noncanonical Windows temporary paths, stale deletion-guard messages, and Linux-only symlink setup requiring privileges on Windows.
- After test-only fixture repairs, all 14 affected files were rerun: 87/87 tests passed. Consolidating those results with the unchanged files yields **2,357 passing tests and 42 platform skips, with no remaining failures**. Runtime/script typechecks and scoped lint passed again. The complete suite was not rerun after these fixture-only repairs.

Fixture repairs preserve production security checks and refusal assertions. Linux symlink coverage remains active; unsupported platforms retain their fail-closed checks without needing symlink privileges. Generated build variants, PowerShell module-analysis cache, and private state are excluded from publication.

Historical local browser checks are documented under `docs/frontend/`; their referenced evidence directories are local artifacts and are not included in this repository. GitHub Actions independently runs the full Linux/Windows workflow after publication; local results do not claim a completed remote run.

## Known limitations

- The normal launcher does not enable the human terminal. A host must configure the verified adapter and explicit folder scope, and the user must grant access for the selected chat. Human terminal support does not enable agent shell execution.
- Browser launch was still failing before page creation in the local Windows installation. Worker tests and diagnostics do not demonstrate a successful live browser session.
- Real-provider tool roundtrips and operating-system notification/audio delivery have not been verified for these changes. Scripted model tests do not establish live provider success.
- The Markdown export HTTP route was verified locally; completion of a browser-saved download remained unconfirmed.
- Search covers loaded chat titles rather than exhaustive transcript content.
- Historical fixture previews and screenshots describe October 6–7 test sessions, not current service availability.

See [testing instructions](TESTING.md), [capability acceptance](CODEX-ACCEPTANCE.md), [chat settings](docs/chat-settings.md), and [General settings](docs/general-settings.md). Publishing source does not restart or migrate the user's existing local runtime.
