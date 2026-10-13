# Chat settings and archive retention — verification

Verified on 2026-10-07.

## Delivered

Settings → Chat now contains shared instructions and five tool preferences, checked by default. Choices persist in this browser and apply to subsequent task submissions. Main Settings manages model providers. The chat header gear and archived-chat selector are removed; archive/export remain current-chat actions.

Settings → Archived supports search, restoration, confirmed permanent deletion, and a runtime-persisted retention period. The default is -1 (never); positive whole days are measured from archiving. Finite policies require review and include existing older archives. Deletion preserves unrelated project files, goals and memories and refuses unfinished or shared activity.

The runtime performs cleanup at startup, on policy save and every minute. Archived listing no longer truncates at the sidebar's 200-chat limit. SQLite migration 28 adds scoped deletion guards; append-only protections remain outside the deletion transaction. Dispatcher state and cached plans are cleared after eligible deletion.

## Verification results

- 74 web/database suites: **393 tests passed**.
- 7 targeted runtime suites: **52 tests passed, 1 existing platform skip**. Coverage includes archive deletion, retention boundary/persistence/disable/startup/timer behavior, CSRF/origin guards, foreign-key integrity, assistant graph cleanup, in-flight cancellation and dispatcher state.
- Independent mocked browser checks: **29 passed** (24 Archived, 5 Chat), including 320px/390px layouts, defaults, persistence, restore/delete, cancellation, refused/malformed acknowledgments, retention validation/review and proxy origin protection.
- Actual chat UI submission handlers with mocked network: **27 passed**, including four turn/start requests. Covered five checked defaults, saved options, immutable options during a held resume, persistence through send/new chat/reload, and model catalogue refresh.
- Final production web/runtime builds, runtime/web type checks and changed-file ESLint passed.
- Direct Settings links against the updated live preview: **14 checks passed**, covering Chat/Archived opening, focus, checked defaults, the real never-delete policy, Escape, reopening and no hydration/browser errors. The popup now mounts after hydration, avoiding a server/client portal mismatch.
- Upgrade tested against a backup of the existing preview DB: migration 27 → 28 preserved all 15 chats, policy remained -1 and foreign_key_check returned no errors.

The app-shell rendering test was updated to assert the new location of approval information and absence of the removed chat-settings gear. Assistant integration fixture setup now canonicalizes and trusts its temporary Windows workspace, matching the existing runtime contract; security guards and original integration assertions were retained.

## Evidence and activation

Evidence directory: `D:\Owie\z-harness-fbd3b114\ui-review\chat-settings-retention`.

- `archive-ui-results.json`, `chat-ui-results.json`: independent browser checks.
- `chat-network-mocked-results.json`: submission handler checks with all API requests mocked.
- `migration-check.json`: copied-database upgrade and integrity check.
- `settings-deep-link-results.json`: 14 read-only checks against the updated preview; no mutation actions invoked.
- `live-preview-check.json`: healthy runtime, migration28, all15 chats present, retention-1 and zero foreign-key errors after activation.
- `independent-review.md`: deletion, shared references, authorization and mobile review.
- Desktop and phone screenshots in the same directory.
- `preview-before-retention-1791360905027.sqlite`: consistent SQLite backup made before activating the new preview runtime.

The existing isolated preview at http://127.0.0.1:3005 now uses the compiled runtime on port3215 through `ui-review/start-chat-settings-retention-runtime.mjs`. The previous fixture runtime was identified by its exact process command before replacement. Production data at the main installation was not opened or modified.

All destructive test operations used isolated test databases or mocked API responses. No existing preview chat was deleted and its retention setting remains never. These checks establish the requested controls and runtime lifecycle, not external provider or native OS integration acceptance.

See [user guide](../chat-settings.md) and [design decisions](chat-settings-retention.md).
