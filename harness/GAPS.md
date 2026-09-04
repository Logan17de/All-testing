# Zet Harness — Gap Review (Addendum)

This file is an addendum to [`PLAN.md`](./PLAN.md) and [`TODO.md`](./TODO.md). It does not replace
either of them.

It records three things:

1. defects in the scaffold that already exists,
2. decisions that are cheap now and expensive after data exists, so they must be settled before the
   phase that depends on them,
3. items the original plan does not cover at all.

Where this file conflicts with `PLAN.md`, this file is the newer decision. `PLAN.md` should be
amended once an item here is accepted, not before.

**Review basis:** branch `zet-harness-v1` at `46e3682`, all files under `harness/`.

---

## 0. How to use this file

| Section | Content | Deadline |
|---|---|---|
| A | Defects in the current scaffold | Before finishing Phase 0 |
| B | Data-model decisions | Before the first Phase 1 migration |
| C | Runtime architecture decisions | Before Phase 3 |
| D | Additions to `PLAN.md` §17 (security) | Before Phase 5 |
| E | Windows-specific requirements for §11 | Before Phase 4 |
| F | Testing and CI | Before Phase 2 |
| G | Decisions that need a human, not a model | Any time; blocking for Phase 11 |
| H | The exact new TODO items, numbered to slot into `TODO.md` | — |

Sections A–F are implementable. Section G is not; do not guess at it.

---

## A. Defects in the current scaffold

### A1. Root `npm run typecheck` fails

Root `tsconfig.json` includes `apps/**/*.tsx`, but `tsconfig.base.json` sets no `jsx` option. Only
`apps/web/tsconfig.json` sets `"jsx": "preserve"`, so per-workspace typecheck passes and the
aggregate one does not.

Reproduced against the committed `tsconfig.base.json`:

```text
src/a.tsx(1,30): error TS17004: Cannot use JSX unless the '--jsx' flag is provided.
src/a.tsx(1,30): error TS7026: JSX element implicitly has type 'any' because no interface 'JSX.IntrinsicElements' exists.
```

Fix by one of:

- add `"jsx": "react-jsx"` to `tsconfig.base.json`, or
- drop `apps/**/*.tsx` from the root `include` and make the root `typecheck` script fan out to each
  workspace's own `typecheck`.

The second is preferable: each workspace already owns a correct `tsconfig.json`, and the root
project is not meant to compile React.

### A2. The workspace graph is disconnected

`apps/web/package.json` declares no dependency on `@zet-harness/core`, `db`, `models`, `tools`, or
`shared`. Nothing imports anything. The monorepo is five islands.

Two follow-on requirements once web imports a package:

- packages export raw `./src/index.ts`, so `apps/web/next.config.mjs` needs
  `transpilePackages: ["@zet-harness/core", ...]`;
- when SQLite lands in Phase 1, the same file needs `serverExternalPackages: ["better-sqlite3"]`
  (or the equivalent for the chosen driver), because a native module cannot be bundled.

Neither option is present in `next.config.mjs` today.

### A3. No lockfile and no Node version pin

`package-lock.json` is not committed, so `npm install` is not reproducible and the M0 acceptance
criterion in `PLAN.md` §18 cannot be trusted. `engines` requires `>=22.13.0` with no `.nvmrc` or
`.node-version` to make that enforceable.

### A4. No CI

There is no `.github/` directory. `TODO.md` is built entirely around "run the checkpoint test
before marking a phase complete" — that is exactly the rule that needs a machine enforcing it. One
workflow running install, `typecheck`, `lint`, and `test` on push and pull request is enough.

### A5. Directories from `PLAN.md` §4 do not exist

§4 shows `data/.gitkeep` and `tests/`. Neither is in the tree. `.gitignore` also ignores `/data/`
with no negation, so adding `data/.gitkeep` will not survive. Add:

```text
!/data/.gitkeep
```

### A6. Lint config is missing the Next and React rules

There is no `eslint-config-next` and no `eslint-plugin-react-hooks`, so an `apps/web` mistake such
as a bad hook dependency array is not caught. The TypeScript rules also use `typescript-eslint`
`recommended`, which is untyped-only; `recommendedTypeChecked` catches floating promises and unsafe
`any` flow, both of which matter in an agent loop.

### A7. No `LICENSE`

`README.md` describes the project as owned by us. Pick a license and commit it.

### A8. `deep-research-report.md` is about the wrong kind of harness

`harness/deep-research-report.md`, added in `46e3682`, is 445 lines on **physical safety
harnesses** — climbing webbing, fall-arrest PPE, EN 12277 and UIAA 105, dog and child restraints,
bar-tack stitching, and webbing suppliers. It contains no reference to models, agents, tools, or
persistence. A research pass resolved the word "harness" in the wrong sense and the result was
committed into the project.

Delete it, or move it out of `harness/` if it is wanted for another purpose. Leaving it in place
puts 445 lines of unrelated content in front of every future reader — and in front of any model
given this directory as context, where it is actively misleading.

### A9. `/api/health` proves less than the M0 checkpoint implies

The route added in `2cb72e4` returns a static object. That is correct for Phase 0, but it confirms
only that Next is serving. Once C1 is decided, health must also report the runtime process and the
database, or the M0 acceptance criterion in `PLAN.md` §18 will keep passing after the parts that
matter have stopped working.

---

## B. Data-model decisions to settle before the first migration

Every item here is a column or a table. Each is free while the database is empty and requires a
data migration afterwards.

### B1. `Message.content` must be structured, not text

`PLAN.md` §5 defines `Message.content` as a single field. Real provider messages are a list of
content parts: text, tool calls, tool results, images, and — for reasoning models — thinking
blocks. A flat text column breaks the moment Phase 4 introduces the tool-call loop, because a
message that *is* a tool call has no text to store.

Required shape:

```text
id
conversation_id
role
content_json        -- array of parts, discriminated by `type`
tool_call_id        -- set when role = tool, links to the tool_calls row
model
created_at
```

Part types for v1: `text`, `tool_use`, `tool_result`, `reasoning`. Add `image` when needed.

Reasoning content must be persisted as its own part, never concatenated into text, or the trace
cannot distinguish what the model thought from what it said.

### B2. Approvals need their own table

`PLAN.md` §12 exposes `GET /api/approvals` and `POST /api/approvals/:id/approve`, but §5 models
approval only as an `approval_state` column on Tool Call. Those are inconsistent, and the column
form has nowhere to record who decided, when, or with what scope — which is what §10's future
"per-project remembered approvals" needs.

```text
id
run_id
tool_call_id
project_id
requested_at
decision            -- pending | approved | denied
decided_at
scope               -- once | run | project
expires_at
reason
```

### B3. Tool calls need an idempotency key and an attempt number

`PLAN.md` §16 states that idempotency matters for write tools and `TODO.md` 5.13 schedules it, but
the Tool Call model in §5 has no field to carry it. Without one, resume-after-crash cannot prove a
write executed exactly once — it can only guess.

Add `idempotency_key` (deterministic over run, step, tool name, and normalised arguments) and
`attempt`.

### B4. Usage and cost columns must land at M2, not Phase 10

`PLAN.md` §15 says to record usage; `TODO.md` 10.6 defers cost reporting to Phase 10. The reporting
can wait. The *capture* cannot: token counts exist only in the provider response, so any run
completed before the columns exist has lost them permanently and they cannot be backfilled.

Add to the run and message tables at M2:

```text
prompt_tokens
completion_tokens
cached_input_tokens
reasoning_tokens
cost_micros         -- integer; do not store money as a float
```

### B5. `agent_runs.parent_run_id`

`PLAN.md` §19 correctly defers multi-agent hierarchies. Leaving the column out is a different
decision from deferring the feature — it forecloses it. One nullable column now costs nothing.

### B6. `events.schema_version`

The event stream is append-only and holds `payload_json`. The first time an event payload changes
shape, every historical row becomes ambiguous. Add an integer version column to each event row.

### B7. Fix the ID and timestamp formats now

Neither is specified anywhere in `PLAN.md`.

- IDs: ULID or UUIDv7. Both sort by creation time, which makes the event stream orderable without a
  secondary index and makes SSE cursors trivial (see C3). Do not use auto-increment integers; they
  leak volume and break if the store ever moves to Postgres with a merge.
- Timestamps: integer epoch milliseconds, UTC. No local time and no string dates, anywhere.

### B8. There is no record of what files changed

`PLAN.md` §20 defines success partly as knowing "what files changed", but no table stores it. The
cheapest sufficient version: record path plus before and after content hash on every write tool
call, and capture `git status` at run start and run end.

### B9. `Message.parent_message_id` (optional, cheap)

Edit-and-retry and conversation branching are standard expectations. The column is free now.

---

## C. Runtime architecture decisions

### C1. Decide where the agent loop actually runs — this is the largest open question

`PLAN.md` §3 draws a "Harness Server" box containing the Agent Runtime, Event Bus, and Run
Recorder. The repository contains a Next.js app and nothing else. Those are not compatible:

- Next route handlers are request-scoped; a run that outlives a request has no owner.
- Dev-mode HMR reloads modules underneath a running loop.
- `next start` provides no supervision, no restart policy, and no way to address a specific
  in-flight run.
- §12 promises `POST /api/runs/:id/pause` and §16 promises crash recovery. Both require a process
  that exists between requests.

Decide explicitly, and write the decision into `PLAN.md` §3:

1. **Separate daemon (recommended).** A long-lived Node process owns the loop, SQLite, and the
   event bus. Next is a thin client over HTTP and SSE. Costs one extra process; makes pause,
   resume, recovery, and headless operation straightforward, and makes the Phase 9 external clients
   nearly free.
2. **In-process with Next.** Fewer moving parts, but pause, resume, and recovery must be rebuilt
   around request lifetimes and HMR, and Phase 9 becomes awkward.

Everything in Phase 3 depends on this answer. Do not start 3.1 before it is made.

### C2. Runs need a per-project lock

Nothing in the plan prevents two runs on the same project from executing write tools against the
same files at the same time. A single-writer lock per `project_id`, enforced in the run creation
path, is a day-one invariant.

### C3. SSE needs a resume cursor

`GET /api/runs/:id/events` has no cursor parameter, so reloading the page mid-run loses the stream
with no way to catch up. Accept `?after=<event_id>` and honour the `Last-Event-ID` request header,
replaying from the events table. With B7's sortable IDs this is a single indexed query.

### C4. Cancellation must kill process trees

`PLAN.md` §8 includes an abort signal in `ModelRequest`, which covers model calls. It does not
cover tool processes. On Windows, `child.kill()` kills the shell and not its children — a cancelled
`shell.run` leaves orphans holding file locks. Use a job object or `taskkill /T /F`; on POSIX, kill
the process group.

### C5. The context budget needs a counting strategy

§7 gives the context builder "a token budget" without saying how tokens are counted. Providers
tokenise differently and local endpoints often report nothing. Specify:

- a per-provider `countTokens` hook with a conservative character-based fallback,
- a hard byte cap per context section that applies even when counting fails,
- truncation order — oldest conversation first, never the system policy or the active goal.

### C6. Tool calling must degrade when the endpoint does not support it

`TODO.md` 2.5 adds capability metadata, which is right, but there is no fallback path. The intended
first backends — Qwen, vLLM, and the existing local and Colab bridges — have inconsistent or absent
native tool-call support. Without a fallback the agent loop is unreachable on exactly the hardware
this project targets.

Define a second execution path (constrained JSON output, or a text protocol parsed by the harness)
selected by the capability flag, and make the tool registry able to emit both shapes.

### C7. SQLite durability belongs in M1, not Phase 11

`TODO.md` 11.3 schedules backup and export for the last phase. Enable WAL mode and a periodic
file-level backup at M1 instead. A corrupted database in month one ends the project; an export
feature in month one does not save it.

---

## D. Additions to `PLAN.md` §17 (security)

### D1. A local server is not a private server

§17 lists eight requirements and omits the most likely real exploit: any web page open in the
user's browser can issue requests to `http://localhost:3000`. On a harness that runs shell
commands, that is remote code execution by way of a visited page.

Required:

- bind to `127.0.0.1` only, never `0.0.0.0`,
- reject requests whose `Origin` or `Host` header is not the expected local origin,
- require a token or CSRF header on every mutating route, including in development.

### D2. Redaction needs a registry, not a regex

§15 says not to log secrets. Implement that as a redaction registry populated at startup from the
known secret sources — provider API keys, `HARNESS_CLIENT_TOKEN`, and any `.env` values — with
every trace write passing through it. Pattern matching alone will miss values that do not look like
credentials.

### D3. Extend the deny list beyond `.env`

§10 denies reading "known secret files". Enumerate at minimum: `.env*`, `.git/config`,
`.git-credentials`, `~/.ssh`, `~/.aws`, `~/.config/gh`, `.npmrc`, `.netrc`, and the workspace's own
harness database.

### D4. Denials must be structured, not silent

When the permission engine blocks a tool call, the model needs a machine-readable result explaining
what was denied and why, so it can choose a different action. A generic error, or nothing, produces
retry loops that burn the step budget.

---

## E. Windows requirements for `PLAN.md` §11

Windows is the primary platform, and §11's isolation rules are written for POSIX.

### E1. Path containment needs more than `realpath` plus a prefix check

The resolver must handle:

- **directory junctions**, which are not symlinks and are not reported as such by `lstat`,
- **case-insensitive comparison** — `D:\Project` and `d:\project` are the same directory,
- **8.3 short names** — `PROGRA~1` resolves outside an apparently contained path,
- **UNC paths** (`\\?\`, `\\server\share`),
- **drive-relative paths** — `C:foo` resolves against the per-drive current directory.

### E2. Process group kill

See C4.

### E3. Path length

Paths beyond 260 characters fail unless long paths are enabled. Detect this at startup and report
it clearly, rather than failing inside a tool call later.

---

## F. Testing and CI

### F1. A mock provider is a prerequisite, not an extra

There is no way to test the agent loop deterministically against a real model, which makes the
`TODO.md` 6.10 integration test impossible to write as specified. Add a scripted fake provider —
one that replays a fixed sequence of model events, including tool calls — before 2.3, and make it
the default provider in tests.

### F2. CI workflow

See A4.

### F3. Golden traces

Once the event stream exists, snapshot a full run's events for a fixed scripted provider and assert
against it. This is the only cheap way to catch a regression in loop ordering, which is otherwise
invisible until a real run misbehaves.

---

## G. Decisions that need a human

Do not resolve these by writing code.

### G1. Zet Harness and the existing Electron desktop app

`harness-desktop` already exists in this repository as a working Electron application with its own
plugin runtime. `PLAN.md` does not mention it, and §18 M9 and `TODO.md` 11.4 propose adding a
*Tauri* wrapper — which would leave two desktop shells for one product.

Decide: is Zet Harness the runtime that `harness-desktop` becomes a client of, or a replacement for
it? Each answer changes Phase 9 and Phase 11.

### G2. Repository placement

`harness/` sits inside `All-testing` alongside `llm/` and `tts/`, sharing one history and one CI
surface with Colab notebooks and TTS benchmarks. `README.md` states that Zet Harness is
intentionally separate from the `llm/` work; structurally it is not. Split it into its own
repository before it reaches a few hundred files, or accept the coupling deliberately.

---

## H. New TODO items

These slot into the existing phases in [`TODO.md`](./TODO.md). Numbering continues each phase's
existing sequence.

### Phase 0

- [ ] 0.9 Fix the root typecheck (A1).
- [ ] 0.10 Commit `package-lock.json` and add a Node version pin (A3).
- [ ] 0.11 Add a CI workflow running install, typecheck, lint, and test (A4).
- [ ] 0.12 Add `data/.gitkeep` with the matching `.gitignore` negation, and `tests/` (A5).
- [ ] 0.13 Add the Next and React lint configs; move the TypeScript rules to type-checked (A6).
- [ ] 0.14 Add `LICENSE` (A7).
- [ ] 0.15 Wire one package into `apps/web` and add `transpilePackages` to prove the graph (A2).
- [ ] 0.16 Remove or relocate `deep-research-report.md` (A8).
- [ ] 0.17 Extend `/api/health` to report the runtime and database once C1 is decided (A9).

### Phase 1

- [ ] 1.13 Settle every Section B decision and record it in `PLAN.md` §5 before writing migrations.
- [ ] 1.14 Enable WAL mode and add a file-level backup routine (C7).
- [ ] 1.15 Add the per-project run lock (C2).

### Phase 2

- [ ] 2.11 Add the scripted mock provider and make it the test default (F1).
- [ ] 2.12 Add the token-counting hook and the per-section byte caps (C5).
- [ ] 2.13 Add the non-native tool-calling fallback path (C6).
- [ ] 2.14 Capture usage and cost on every model call (B4).

### Phase 3

- [ ] 3.0 Decide and document where the agent loop runs (C1). Blocks 3.1.
- [ ] 3.10 Add the SSE resume cursor and `Last-Event-ID` support (C3).

### Phase 4

- [ ] 4.12 Implement the Windows path-containment rules (E1).
- [ ] 4.13 Implement process-tree cancellation (C4, E2).
- [ ] 4.14 Detect and report the long-path limitation at startup (E3).

### Phase 5

- [ ] 5.14 Bind to loopback and enforce origin and CSRF checks (D1).
- [ ] 5.15 Implement the redaction registry (D2).
- [ ] 5.16 Implement the extended secret deny list (D3).
- [ ] 5.17 Return structured denial results to the model (D4).
- [ ] 5.18 Record file changes per write tool call (B8).

### Phase 6

- [ ] 6.11 Add golden-trace assertions for the completed loop (F3).
