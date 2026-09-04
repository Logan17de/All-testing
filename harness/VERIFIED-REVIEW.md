# Zet Harness — Verified Phase 0 Review

This file records externally reproduced behavior from a real Windows checkout so planning does not drift away from what the tree actually does.

## Test basis

Reported test environment:

- Windows
- Node 24.19.0
- npm 11.3.0 initially
- npm 12.0.2 for the successful dependency resolution
- branch state around `8b4f018`

## Verified checkpoint results before fixes

| Check | Result |
|---|---|
| clean install with npm 11.3.0 | FAIL |
| typecheck | PASS |
| lint | FAIL |
| tests | PASS (no test files yet) |
| startup smoke | PASS (`STARTUP_OK`) |
| build | PASS (3 routes) |

## Verified failure 1 — npm 11.3.0 resolver crash

The dependency resolver crashed in npm's Arborist while resolving the current dev dependency tree:

```text
Cannot read properties of null (reading 'edgesOut')
```

The report bisected the trigger to Vitest 4.1.x under npm 11.3.0. The same tree resolved with npm 12.0.2.

### Applied response

- Node is pinned to 24.20.0 LTS.
- npm is pinned in `package.json` to 12.0.2.
- the engine range requires npm 12.x.
- the reproducible `package-lock.json` is committed.
- CI explicitly installs npm 12.0.2 before `npm ci`.

The project checkpoint now uses `npm ci`, not dependency re-resolution via an unconstrained `npm install`.

## Verified failure 2 — startup smoke lint globals

`startup-smoke.mjs` was valid at runtime but ESLint treated Node globals as undefined:

- `process`
- `fetch`
- `console`

### Applied response

The ESLint flat config now declares the required Node runtime globals for `scripts/**/*.mjs`.

## Verified favorable findings

The startup smoke test itself behaved correctly on Windows:

- two consecutive runs left no orphan process;
- the port was free after shutdown;
- deliberately occupying the port caused a fast surfaced `EADDRINUSE` failure instead of a long hang;
- output capture and cleanup worked as intended.

Therefore Windows process-tree handling remains a requirement for general tool execution, but the current startup smoke script is not blocked by it.

## Windows long-path observation

A scratch checkout hit `Filename too long` while deleting `node_modules` through a worktree cleanup.

This is direct evidence for the existing Windows long-path detection requirement; keep it in the plan.

## Vitest config warning

Vite warned that the ESM config was being loaded through a CommonJS path.

### Applied response

The harness root package is now `"type": "module"`.

## CI consequence

The absence of CI allowed a valid startup script and an invalid lint configuration to coexist for several commits.

`harness-ci.yml` is therefore a Phase 0 gate, not optional hygiene. It runs:

```text
npm ci
→ typecheck
→ lint
→ tests
→ startup smoke
→ build
```

## Data-model decisions that remain mandatory before migrations

Before the first persistent schema is treated as stable, preserve the decisions already documented in `GAPS.md`:

- structured message parts instead of flat message text;
- a first-class approvals table;
- tool-call idempotency key and attempt number;
- capture provider usage/cost metadata when the provider returns it;
- sortable IDs and one UTC timestamp format;
- event schema versions;
- file-change records for write tools.

These are cheap while the database is empty and expensive after real runs exist.

## Runtime ownership decision

The open runtime question is now resolved in `RUNTIME.md`:

> a long-lived lightweight Node daemon owns SQLite, plugins, runs and events; the Next.js UI is a client.

That decision must be reflected when Phase 1 creates the first database/runtime code.
