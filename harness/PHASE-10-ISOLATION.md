# Phase 10.9 — Process-isolated plugin execution

## Why this exists

Before this, "installing is not authorizing" was only half true. Capability grants governed the
harness's own brokered surfaces, but an enabled plugin ran in the harness process with full Node
privileges — so withholding `fs:write` did nothing to a plugin that simply imported `node:fs`.

For a harness anyone can add plugins to, that gap is the whole security story. This closes it.

## Two tiers, chosen per plugin

| Tier | How | When |
|---|---|---|
| Trusted in-process | default | plugins you wrote or have read |
| Process-isolated | `"isolated": true` | anything else |

Isolation is opt-in rather than default because it costs a process per plugin, and the first-party
plugins a host ships are already trusted. The choice is the host's, per plugin, in configuration.

## What the sandbox actually does

The plugin runs in a child process started with Node's permission model. Granted capabilities
become permission flags:

| Grant | Flag |
|---|---|
| *(always)* | `--allow-fs-read=<package>/*` — it must be able to import itself |
| `fs:read` | `--allow-fs-read=<workspace>/*` |
| `fs:write` | `--allow-fs-write=<workspace>/*` |
| `process:exec` | `--allow-child-process` |
| `worker` | `--allow-worker` |

`deriveSandboxFlags` is pure and separately tested, because this mapping *is* the boundary: a
mistake there silently widens what a plugin can reach.

The child also receives a minimal environment — only the entry URL and optional config — so an
isolated plugin cannot read provider credentials out of `process.env`.

## Proven, not asserted

The decisive tests use a plugin that imports `node:fs` and calls `writeFileSync` directly:

- without `fs:write`, the write fails and the file does not exist;
- the failure is `ERR_ACCESS_DENIED`, not a silent no-op;
- with `fs:write`, the same plugin writes successfully;
- with `fs:write`, a write *outside* the workspace root still fails.

That last one matters: `fs:write` authorizes the workspace, not the disk.

## The bootstrap

The child is started with `--input-type=module -e`, not a bootstrap file. That means the sandbox
needs no read grant beyond the plugin's own package, and there is no bootstrap file on disk for a
plugin to tamper with.

Registrations come back as manifests and are republished in the parent as proxy definitions that
forward each invocation over IPC. The plugin's code never runs in the harness process.

## Honest limits

- **Network is not covered.** Node's permission model has no network dimension, so an isolated
  plugin can still open sockets. Network capabilities remain enforced only at the harness's
  brokered surfaces. This is the model's limit, not a choice made here.
- **Model adapters are not supported in an isolated plugin yet**; registering one throws inside
  the child rather than silently doing nothing.
- **A plugin must be self-contained.** Imports reaching outside its package directory are denied,
  so dependencies have to be vendored into the package.
- **WASI (10.10) is not implemented.** Process isolation is the strongest tier available today.

## A build-chain consequence

Tests that exercise the runtime resolve `@zet-harness/core` through its built `dist`, so a change
to core's source is invisible to them until it is rebuilt. `npm test` handles this because the
runtime build pre-builds its dependencies; running `vitest` directly against a stale `dist` does
not. This surfaced as isolation silently not activating until the rebuild.

## Verification

Run from `harness/`:

```sh
npm run typecheck
npm run lint
npm run format:check
npm test
```

1164 tests pass, up from 1144. New coverage is 15 isolation tests and 5 runtime wiring tests.
