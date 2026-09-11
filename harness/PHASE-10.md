# Phase 10.1, 10.2, 10.6–10.8 — Third-party plugins

## Delivered scope

The harness is now externally extensible. Anyone can write a plugin, install it into a plugins
directory, and enable it, without modifying the harness.

Two new packages: `@zet-harness/plugin-loader` (discovery, integrity, loading) and
`@zet-harness/plugin-sdk` (authoring helpers). `@zet-harness/core` gains package-manifest and
plugin-config validation. `examples/hello-plugin/` is a complete working plugin.

Covers TODO 10.1, 10.2, 10.6, 10.7, 10.8. MCP (10.3–10.5), trust tiers (10.9–10.10) and remote
installation (10.11) remain open.

## The package manifest (10.7)

A plugin package is a directory containing `zet-plugin.json` and whatever the manifest's `entry`
points at. The manifest is **inert data read before any plugin code is imported**, so a host can
list what is installed and show what each package asks for without executing anything a package
shipped. A test proves this: a package whose entry throws on import is still fully discoverable.

Every required field earns its place:

| Field | Why it is required |
|---|---|
| `id` | Lowercase dot-separated namespace, so node types cannot collide between authors |
| `license` | An installable package must state its terms |
| `version` | Strict `major.minor.patch`; `latest` and `v1.0.0` are refused |
| `entry` | Must resolve inside the package — traversal, absolute and drive paths are refused |
| `requestedCapabilities` | Required even when empty, so "asks for nothing" is explicit |
| `nodes` | Required even when empty; see enforcement below |
| `minHarnessVersion` | Optional, but compared when the host version is known |
| `integrity` | Optional sha256 digests, verified before import |

Validation collects **every** defect rather than throwing on the first, so a plugin author fixing a
manifest sees the whole list instead of discovering problems one run at a time.

## Installation is not authorization (10.8)

This is the central property, and it is enforced in three separate places.

**A request is never a grant.** `requestedCapabilities` records what a package wants.
`reconcilePluginGrants` intersects that with what the host actually granted and reports the
difference, so a host UI can show a person what a plugin asked for next to what it received, and a
plugin failing for lack of permission is explainable rather than mysterious.

**Plugins are off by default.** A plugin absent from the configuration is not enabled, and
`enabled` must be a literal `true` — `"yes"` and `1` do not enable anything. Dropping a folder into
a plugins directory is not enough to make it run.

**Plugin config data carries no authority.** A test puts `grantedCapabilities` inside a plugin's
opaque `config` block and asserts the resulting policy still denies it. Configuration is data; the
host's `CapabilityPermissionPolicy` is the only authority.

## Loading (10.2)

Discovery reads manifests only. Loading then, in order:

1. verifies integrity digests,
2. resolves the entry path and confirms it stays inside the package,
3. imports the entry module,
4. checks the loaded plugin's `id` and `version` against the package manifest.

**Integrity is verified before the import, because verifying after execution would verify
nothing.** A regression test tampers with a signed package so the modified module would set a
global if it ran, then asserts both that loading is refused and that the global was never set.

Step 4 matters on its own: without it a package could advertise one identity for review and
register another after being approved.

A package with no integrity block is reported as `unsigned` rather than quietly treated as
verified, so a host can refuse unsigned packages by policy (`requireIntegrity`) instead of the
loader deciding on everyone's behalf.

## Declared nodes are binding

`enforceDeclaredNodes` wraps a loaded plugin so it can only register the node types its manifest
declares. Registering an undeclared node **fails activation** rather than being ignored.

The manifest is what a person reviews before enabling a plugin. If the plugin could then register
anything, that review would be meaningless. Because `PluginHost` activation is transactional, a
refused registration also rolls back cleanly — a test asserts no node survives the failure.

## The authoring SDK (10.6)

`@zet-harness/plugin-sdk` is built on `@zet-harness/plugin-api` and nothing else. It gives an
external author exactly the surface a first-party plugin has: there is no privileged authoring
path.

`definePureNode` fills in behavior metadata, because a pure node is genuinely safe to rerun.
`defineEffectNode` deliberately does **not**: effect, idempotency and recovery must all be stated
explicitly. The host uses them to decide whether an interrupted attempt may be repeated, so
defaulting them is how duplicate side effects happen. It also refuses the contradiction of an
`external-write` declaring `reuse` recovery — there is no stored output to reuse.

`definePlugin` checks that every capability its nodes require is declared by the plugin, catching
the mismatch while the author can still fix it rather than at activation on a user's machine.
`describeNodesForManifest` generates the manifest's `nodes` array from the same definitions, so the
code and the manifest cannot drift apart.

## The example plugin

`examples/hello-plugin/` is a complete plugin with **no dependencies and no build step**: one JSON
file and one JavaScript file. That is deliberately the floor for writing a plugin.

`scripts/example-plugin-integration.test.ts` loads it from its real location in the repository,
activates it through the ordinary `PluginHost`, executes its node and checks the output, and
verifies its integrity. The example is what an outside author copies, so a broken example is worse
than no example; this test fails CI if it stops working.

## Reaching it from the running app

A plugin system nobody can reach is not extensibility, so `RuntimeDaemon` loads plugins at startup
when given a `plugins` option. It discovers every installed package, activates only the ones the
configuration enables, and builds each plugin's capability policy from host grants alone.

**A failing plugin never stops the daemon.** A third-party package is not trusted to be correct,
and one bad plugin taking down the whole runtime would make installing anything unreasonably
risky. Failures are collected into the startup report instead.

`GET /api/plugins` serves that report read-only, so a UI can show what is installed alongside what
each package asked for and what it received. Enabling a plugin or granting a capability stays a
configuration decision; a `POST` to that endpoint is refused with 405.

### A build-chain consequence

`apps/runtime` compiles to real JavaScript and runs from `dist`, so everything it imports at
runtime must be built JavaScript too. `@zet-harness/plugin-api`, `core` and `plugin-loader`
previously exported raw `./src/index.ts`, which was fine while only tests imported them. They now
carry `tsconfig.build.json` and dual `types`/`default` exports like `db` and `scheduler`, and the
runtime build pre-builds them.

This surfaced as a real failure: the process-kill recovery test started failing because its child
process could not import TypeScript from the built runtime.

## From plugin to executed run

A plugin registering a node is only useful if the scheduler can invoke it.
`createPluginNodeExecutor` is that link: it resolves a node type to whichever loaded plugin
provides it — in-process first, then sandboxes — checks the capability policy, and executes.

The check happens in host code on **every** invocation, not once at load. A node's declared
`requiredCapabilities` are demand; this is where demand meets the host's decision.

One rule is worth naming: a plugin with no policy entry is treated as granting **nothing**, not as
unrestricted. Failing open for an unmapped plugin would quietly undo the capability model, so a
test pins that behaviour.

## Verification

Run from `harness/`:

```sh
npm run typecheck
npm run lint
npm run format:check
npm test
```

1176 tests pass, up from 945. New coverage is 33 loader tests, 47 manifest tests, 29 config
tests, 32 SDK tests, 24 runtime startup and HTTP tests, 12 plugin-executor tests, and 11
example-plugin integration tests.

## Not included

- MCP client, discovery and schema translation (10.3–10.5)
- Execution trust tiers and WASI isolation (10.9–10.10): every plugin currently runs in-process and
  fully trusted once enabled, so capability grants are the only boundary
- npm/Git installation (10.11), which the plan gates behind solid local loading
- A UI for browsing and enabling plugins; the view model and `/api/plugins` exist, but rendering
  belongs to Phase 7
- Editing plugin configuration through the API; enabling and granting stay file-based decisions
