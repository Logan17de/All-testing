# Phase 6.13–6.16, 6.21 — Native filesystem tools and host path limits

## Delivered scope

`@zet-harness/tools` now contains a workspace path resolver and a first-party native filesystem
tool plugin. `@zet-harness/runtime` measures host path limits during daemon startup.

This covers TODO items 6.13, 6.14, 6.15, 6.16 and 6.21. It does not complete 6.17–6.20
(shell, process-tree cancellation, git, durable file-change records), and it does not change
Graph JSON, Execution IR, compiler identity, the scheduler, or any database migration.

## Path containment (6.14, 6.15)

`WorkspacePathResolver` is the only place that turns untrusted text into a host path. Nothing
else joins a model-supplied string onto the project root.

Resolution runs in two passes. The lexical pass performs no filesystem access, so a hostile path
is refused before any syscall and the rules are testable without fixtures. The real-path pass then
re-checks containment against resolved paths so a symlink or Windows junction cannot redirect an
already-accepted path outside the root.

Refused inputs carry a closed `WorkspacePathDenialCode`:

| Code | Rejects |
|---|---|
| `invalid-input`, `empty-path`, `embedded-nul` | malformed input |
| `path-too-long` | input or resolved path past the configured limit |
| `unc-path` | `\\server\share`, `//server/share` |
| `device-namespace` | `\\?\`, `\\.\` |
| `drive-relative` | `C:work`, which follows the current directory of drive C |
| `alternate-data-stream` | any `:` inside a segment, such as `notes.txt:hidden` |
| `reserved-device-name` | `CON`, `NUL`, `COM1`, `CONIN$`, including `CON.txt` |
| `trailing-dot-or-space` | `secret.` and `secret `, which Windows silently folds together |
| `short-name` | `PROGRA~1` style 8.3 aliases |
| `escapes-root` | traversal or an absolute path landing outside the root |
| `symlink-escapes-root` | a link or junction whose real path leaves the root |

The Windows-specific rules are enforced on **every** platform deliberately. A graph authored on
Linux must not produce a path that means something different when the same graph runs on Windows.
The cost is that a POSIX file literally named `CON` or `a:b` is unreachable; portability is worth
more than addressing those.

Containment comparison folds case on Windows and macOS and stays case-sensitive on Linux, because
a case-sensitive prefix test on a case-insensitive filesystem accepts a path the OS then resolves
from a different directory.

Error provenance uses a private symbol rather than `instanceof`, matching the model transport
convention: a forged prototype must not impersonate a host authority decision.

## Filesystem tools (6.13, 6.16)

`createNativeFileSystemTools` returns `harness.fs.list`, `harness.fs.read`, and — only when
`enableWrite` is set — `harness.fs.write`. `createNativeFileSystemPlugin` registers them through
the ordinary `PluginContext.tools.register` path. Registration performs no filesystem access.

The tools declare `fs:read`/`fs:write` as **demand**. They do not grant anything. The host
invocation broker authorizes the call; reaching this code is not itself proof of permission.
Granting `fs:read` never implies `fs:write`, and a read-only deployment does not carry a write
implementation at all.

Host limits are ceilings. A model may lower `maxBytes` or `maxEntries` through arguments but
cannot raise them past the configured host value.

`fs.list` sorts entries so a run trace is reproducible across hosts, which `readdir` order alone
does not guarantee. It skips `.git`, `node_modules`, `dist` and similar directories by default,
and reports `truncated` rather than silently shortening a listing.

`fs.read` refuses directories and non-regular files: a device or FIFO can block forever or produce
unbounded data. It reads one byte past the cap to distinguish "exactly at the limit" from
"truncated", and returns a sha256 of the bytes it actually returned.

`fs.write` replaces whole file contents. **Append is deliberately absent**, which is what lets the
manifest declare `idempotency: "idempotent"` honestly: repeating one write reaches the same state.
Writes go to a sibling temporary file and are renamed into place, so a crash mid-write cannot
leave a half-written file where a durable record claims a complete one. The result reports
`beforeSha256` (null when the file did not exist), `afterSha256`, and `created`.

Those hashes are the data a file-change record needs, but **6.20 remains open**: nothing persists
them to a durable table yet.

## Host path limits (6.21)

`probeRuntimePathLimits` detects long-path support by exercising it rather than reading
`LongPathsEnabled` from the registry. Reading the registry would require spawning `reg.exe` at
startup and still would not answer the question that matters, which is whether this process can
address such a path. The probe creates a directory tree past `MAX_PATH` under the temp directory,
writes and reads a file in it, then removes it.

Creating the probe root is treated as setup, not measurement: an `ENOENT` there means the base
directory is unusable and reports `inconclusive`, never a long-path refusal.

On Windows, `recommendedExternalPathLimit` stays at 260 **even when the probe succeeds**, because
Node prefixes long absolute paths for its own syscalls and a spawned child process does not
inherit that handling. Both outcomes emit a warning, so the limitation is never silent.

`RuntimeDaemon.start()` runs the probe before the HTTP listener binds and publishes the report on
`snapshot().pathLimits`. The probe never fails startup and can be disabled with
`probePathLimits: false`.

Measured on the development host (Windows 11, Node 24.20.0):

```json
{
  "platform": "win32",
  "longPathsUsableByRuntime": true,
  "probe": "supported",
  "recommendedExternalPathLimit": 260
}
```

## Verification

Run from `harness/`:

```sh
npm run typecheck
npm run lint
npm run format:check
npm test
npm run test:startup
```

757 tests pass, up from 646. The new coverage is 56 path-containment tests, 46 filesystem tool
tests, 9 path-limit probe tests, and 4 daemon reporting tests.

Two Windows behaviours are proven against the real filesystem rather than a mock: junction escape
refusal for both reads and not-yet-created write targets. Unprivileged Windows cannot create file
symlinks, so those specific cases exercise fully only on Linux CI; junctions, which need no
privilege, are the case that matters most on Windows and do run locally.

## Not included

- 6.17 read-only command allowlist and `shell.run`
- 6.18 process-tree cancellation and output/time limits
- 6.19 `git.status`, `git.diff`, approval-gated `git.commit`
- 6.20 durable file-change records (the hashes exist; the table does not)
- automatic registration of these tools into the daemon's executor, which stays host wiring
