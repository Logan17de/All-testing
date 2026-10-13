# Workspace refresh verification

Date: 2026-10-07

## Delivered

- Applied the installed Codex application's observed layout and packaged UI tokens: shared system font, neutral surfaces, compact header/icons, 768px conversation width and a rounded composer.
- Moved secondary chat controls into the header and Graph/Activity/Terminal inspector. The composer retains model choice, approval status and send/stop.
- Added persistent, keyboard-accessible resizing to the navigation, chat inspector and graph side panels. Narrow screens use a modal chat inspector and stacked graph panels.
- Added larger graph ports, click-to-connect, a keyboard connection form, explicit disconnect controls, validation, undo/redo, local draft recovery and an in-app guide.
- Fixed stale-model submission after a catalogue refresh. A removed model immediately disables button, Enter and native form submission while preserving the draft.
- Added an explicit production launcher with build preflight and paired process cleanup.

## Results

| Check | Result |
| --- | --- |
| Final automated tests | 54 files, 252 tests passed |
| Final Next.js production build and TypeScript | Passed |
| Runtime and dependency production build | Passed |
| Production startup smoke on temporary port 3210, earlier in this task | Passed: `STARTUP_OK ... mode=production`; temporary server closed |
| Final Edge layout/graph browser checks on the existing isolated preview | 31/31 passed; no browser exceptions |
| Chat handler checks in isolated Edge with mocked API responses | 35/35 passed; no unexpected requests or browser exceptions |
| Full web ESLint (generated build folders excluded; zero warnings), changed-file TypeScript and formatting checks | Passed |

The final test command was:

```text
node node_modules/vitest/vitest.mjs run apps/web scripts/start-harness.test.ts scripts/process-tree.test.ts apps/runtime/src/runtime-conversation-http.test.ts
```

The web and runtime builds used the bundled Node 24.20.0 and npm 12.0.2:

```text
node <portable-npm>/bin/npm-cli.js run build --workspace @zet-harness/web
node <portable-npm>/bin/npm-cli.js run build --workspace @zet-harness/runtime
```

Browser coverage includes drag/keyboard resize, bounds/reset/reload persistence, modal focus and Escape, tablet background isolation, 320/390/768/1440px overflow checks, connection form and canvas connection, explicit disconnect, undo/redo, draft persistence and guide navigation. The documented Text box → Output box workflow executed through the actual isolated runtime.

Chat checks cover model gating, Enter/Shift+Enter/IME, settings and consent payloads, resume-before-start, stop, polling, submission refusal, draft retention, session changes, archive/restore, export-link and response contract, and model catalogue refresh. These checks use mocked API responses; export verification does not establish a native download.

The two conversation API tests use a real ephemeral daemon and trusted temporary workspace folders. Their former name-only project fixture failed the current `workspacePath` requirement; the fixture now satisfies that contract without changing runtime authorization.

## Evidence

Evidence directory: `D:\Owie\z-harness-fbd3b114\ui-review\workspace-refresh`.

- `results.json`: final 31 browser checks and viewport dimensions.
- `chat-network-mocked-results.json`: 35 chat handler checks.
- `conversation-fixture-diagnosis.json`: original fixture contract failure.
- `chat-desktop.png`, `graph-connected.png`, `graph-run.png`, `graph-guide.png`: desktop evidence.
- `chat-320.png`, `chat-390.png`, `chat-768.png`, `graph-320.png`, `graph-390.png`, `graph-768.png`: responsive evidence.
- `chat-320-composer.png`: phone conversation and composer with the inspector closed.
- `graph-narrow-stacked.png`: internal narrow graph layout with hidden horizontal handles.

See [Codex reference](codex-ui-reference.md), [design brief](design-brief.md), and [graph guide](../graph-guide.md).

## Run and remaining acceptance

The updated existing isolated development preview is at http://127.0.0.1:3005/agent. It uses fixture data and is not the user's production runtime.

The compiled application is ready for the local shortcut `D:\Owie\z-harness-fbd3b114\Start Z Harness (Production).cmd`, which serves http://127.0.0.1:3000 with its runtime at port 3211.

Automatic approval review rejected both attempts to start a new final production preview on port 3006 with “blocked by policy”; no specific reason was provided. The final compiled UI was therefore not browser-tested on a fresh production server, and the main production instance was not started. Final browser evidence uses the existing development preview. The earlier production startup smoke remains a separate passing check.

Live external provider execution, real terminal/browser/desktop integrations and native Windows project-command acceptance are not established by this refresh. The existing Windows security hold remains in place; consult TESTING.md and CODEX-ACCEPTANCE.md for broader release acceptance. This is a verified UI and workflow improvement, not a certification of all harness integrations.

The workspace is an extracted archive, not a Git checkout. Changes are saved locally; no commit, pull request or deployment was created.
