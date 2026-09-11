# Phase 6.17–6.20 — Bounded process execution, git tools, durable file changes

## Delivered scope

`@zet-harness/tools` gains a bounded process runner, a declarative command allowlist, `shell.run`,
and the git tools. `@zet-harness/db` gains durable file-change records as migration 7, which the
runtime daemon now applies.

This covers TODO 6.17, 6.18, 6.19 and 6.20, completing Phase 6 except for the model-side items
6.6–6.12. Graph JSON, Execution IR, compiler identity and the scheduler are unchanged.

## No shell is involved (6.17)

Despite the `shell.run` name inherited from the plan, nothing is ever handed to a shell.
`runBoundedProcess` always spawns the executable directly with an argument vector and
`shell: false`. Argument content therefore cannot become a second command, whatever it contains —
a test passes ``hi; echo pwned $HOME `whoami` `` as one argument and asserts it arrives intact.

The child receives a **minimal constructed environment**, never the harness environment. The
harness process can hold provider API keys, so only the variables a process needs to start are
copied. A test sets a secret in `process.env` and asserts the child cannot see it.

What may run is decided entirely by the host allowlist, which is **empty by default**: every
invocation is refused until a host configures a policy. Installing a tool and authorizing what it
may do stay separate decisions.

### Why option allowlisting is strict

The allowlist refuses unknown options rather than unknown commands alone. This is not defensive
excess. Several ordinary read-only tools accept options that execute arbitrary programs or write
arbitrary files:

| Refused | Why it matters |
|---|---|
| `git -c core.sshCommand=...` | runs an arbitrary command |
| `git log --upload-pack=...` | runs an arbitrary command |
| `git diff --output=/etc/cron.d/x` | writes an arbitrary file |
| `git --git-dir=/elsewhere status` | escapes the project repository |
| `git diff --ext-diff` | runs a configured external diff driver |

Permitting unknown options would hand back everything the allowlist exists to withhold, so each of
these has a regression test. Option values are restricted to a narrow character set, and a
non-option argument is treated as a path operand and contained by the same workspace resolver used
by the filesystem tools.

`shell.run` derives its manifest effect class from the configured allowlist: all-read-only becomes
`external-read` with `rerun` recovery, anything else becomes `external-write` with `unknown`
idempotency and `manual` recovery. An empty allowlist is classified as a write, because it permits
nothing to reason about.

## Process-tree cancellation and limits (6.18)

`child.kill()` signals only the direct child, leaving grandchildren holding CPU and file locks.
`terminateProcessTree` kills the whole tree: through `taskkill /pid <pid> /T /F` on Windows, which
has no usable process groups from Node, and through a negative PID on POSIX, where children are
spawned detached so the process group can be signalled together.

A regression test proves this rather than assuming it: a parent spawns a grandchild that writes a
marker file after 2.5 seconds, the parent is killed at 500ms, and the test then waits past the
deadline and asserts the marker never appears. It passes on Windows with a real `taskkill`.

Limits are wall-clock time, bytes retained per stream, and a kill grace period. Output past the cap
is dropped rather than buffered, so a flooding process cannot exhaust harness memory before the
kill lands. The first stop reason wins, so a cancellation racing a timeout cannot relabel it.
`close` rather than `exit` is awaited, so a fast-exiting process does not lose its output tail.

A non-zero exit status is reported as a normal `exited` outcome. It is a result, not a harness
failure.

## Git tools (6.19)

`git.status` and `git.diff` are read-only and demand `git:read` alongside `process:exec`. Status
uses `--porcelain=v1 -z`, because the default output quotes and escapes unusual filenames and
un-escaping that correctly is an avoidable risk; a test asserts a filename containing spaces round
trips intact. A diff path operand is contained and then passed after `--`, so a path beginning with
a dash cannot be read as an option.

`git.commit` demands a separate `git:commit` capability — granting `git:read` never implies it —
and is declared `external-write` with `manual` recovery.

**Approval is a real gate, not a flag.** In this architecture approval is a durable graph-level
interrupt, and `ToolManifest` has no approval field, so the commit tool takes a host-supplied
`approveCommit` callback, following the same precedent as the model adapter's trusted
`resolveImage` resolver. Without that callback the commit tool **is not created at all**. The
callback must be wired to the durable human-approval boundary; a host that returns true from
privileged code has not built a second permission broker, it has removed the gate.

A refusal is a normal outcome (`committed: false`), not an error: a human declining is not a fault.
Tests prove against a real repository that a refused approval leaves the commit count at zero, that
the gate is consulted before the effect, and that an approved commit reports its sha.

## Durable file-change records (6.20)

Migration 7 adds `file_changes`, keyed to `(run_id, op_index, iteration, logical_effect_id,
attempt, workspace_path)` and foreign-keyed to `node_invocations`, so every recorded change is
anchored to the exact logical effect that caused it.

The table stores **hashes, not content**. That is enough to prove what a run changed, to detect
later outside modification, and to decide during recovery whether an ambiguous external write
actually landed — without copying possibly sensitive file contents into the journal. Paths are
stored workspace-relative; absolute host paths never enter the journal.

Invariants are enforced by CHECK constraints, not only by the helper: a creation may not claim a
before hash, a modification must carry both, and a deletion may not claim an after hash. Two
triggers make the history append-only — `UPDATE` and `DELETE` both abort.

## Verification

Run from `harness/`:

```sh
npm run typecheck
npm run lint
npm run format:check
npm test
npm run test:startup
```

877 tests pass, up from 761. New coverage is 23 process-runner tests, 41 allowlist tests, 30 git
and shell tool tests, and 22 file-change record tests. The git tests build real repositories with
real commits rather than simulating git.

## Not included

- Registering these tools into the daemon's executor, which remains host wiring
- Writing a `file_changes` row automatically from `fs.write`; the hashes are produced and the table
  exists, but the executor that connects them is the same open wiring work
- 6.6–6.12, the remaining model-side Phase 6 items
- Windows `.cmd`/`.bat` entry points: Node refuses to spawn them without a shell, and this runner
  never uses one, so only real executables are supported
