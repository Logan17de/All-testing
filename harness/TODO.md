# Zet Harness — Ordered TODO

We implement this list in order. Do not jump ahead unless an earlier item is blocked.

Current architecture constraints are defined by `LIGHTWEIGHT.md`, `PLUGINS.md`, `RUNTIME.md`, `GRAPH.md`, and `VERIFIED-REVIEW.md`.

## Phase 0 — Project skeleton

- [x] 0.1 Create `harness/package.json` and workspace layout.
- [x] 0.2 Add TypeScript, linting, formatting, and test configuration.
- [x] 0.3 Create `apps/web` Next.js app.
- [x] 0.4 Create `packages/core`, `packages/db`, `packages/models`, `packages/tools`, and `packages/shared`.
- [x] 0.5 Add `.env.example` with placeholders only.
- [x] 0.6 Add `.gitignore` rules for local DB, runtime state, logs, and secrets.
- [x] 0.7 Add `/api/health`.
- [x] 0.8 Add basic startup test.
- [x] 0.9 Fix the root typecheck so each workspace owns its own TypeScript configuration.
- [x] 0.10 Commit `package-lock.json`; pin Node 24.20.0 LTS and npm 12.0.2.
- [x] 0.11 Add CI for clean install, typecheck, lint, tests, startup smoke, and build.
- [x] 0.12 Add `data/.gitkeep` with the matching `.gitignore` negation, plus `tests/`.
- [ ] 0.13 Add Next/React lint rules and move TypeScript linting to type-checked rules.
- [ ] 0.14 Add a project `LICENSE`.
- [ ] 0.15 Wire one internal package into `apps/web` and add `transpilePackages` to prove the workspace graph.
- [x] 0.16 Remove the unrelated physical-safety `deep-research-report.md`.
- [ ] 0.17 Extend `/api/health` with runtime/database checks once those components exist. Deferred; not a Phase 0 blocker.
- [ ] 0.18 Create tiny public `@zet-harness/plugin-api` package with no/near-zero runtime dependencies.
- [ ] 0.19 Implement plugin host lifecycle in `core`: load → activate → tracked registrations → dispose.
- [ ] 0.20 Prove one built-in plugin and one external/local test plugin use the exact same host path.
- [ ] 0.21 Add a lightweight baseline check for startup time, idle memory, and direct runtime dependency count.
- [x] 0.22 Decide runtime ownership: a long-lived lightweight Node daemon owns SQLite/plugins/runs/events; the web UI is a client. See `RUNTIME.md`.

**Checkpoint:** npm 12.0.2 + clean `npm ci` → typecheck → lint → tests → startup smoke → build → plugin smoke all pass, and record the lightweight baseline.

---

## Phase 1 — Runtime daemon, SQLite, and persistent task state

- [ ] 1.0 Create `apps/runtime`: a long-lived Node process using built-in `node:http`/SSE where practical; move durable API/runtime ownership out of Next.js.
- [ ] 1.1 Add SQLite using pinned Node 24 `node:sqlite`; no ORM initially.
- [ ] 1.2 Create schema for projects.
- [ ] 1.3 Create schema for conversations/messages using structured message parts.
- [ ] 1.4 Create schema for goals/todos.
- [ ] 1.5 Create schema for runs/tool calls/events/approvals, including idempotency/attempt metadata and event schema versions.
- [ ] 1.6 Add a tiny ordered SQL migration runner + `schema_migrations` table.
- [ ] 1.7 Add project CRUD API.
- [ ] 1.8 Add goal CRUD API.
- [ ] 1.9 Add todo CRUD API.
- [ ] 1.10 Add valid status-transition guards.
- [ ] 1.11 Add minimal project/goals/todos UI.
- [ ] 1.12 Add persistence restart test.
- [ ] 1.13 Enable WAL mode and add a simple file-level backup routine.
- [ ] 1.14 Add a per-project run lock so two autonomous runs cannot mutate the same project concurrently.
- [ ] 1.15 Standardize sortable IDs and UTC epoch-millisecond timestamps before real data exists.
- [ ] 1.16 Add file-change records for write operations (path + before/after hashes).

**Checkpoint:** runtime daemon starts headlessly; create goal → add todos → restart → state is unchanged; backup/restore a test DB successfully.

---

## Phase 2 — Model provider plugins

- [ ] 2.1 Define public model/provider contracts in plugin API.
- [ ] 2.2 Add model registry as a plugin service.
- [ ] 2.3 Implement OpenAI-compatible provider as a first-party plugin, not core logic.
- [ ] 2.4 Support custom base URL and credential references through config/environment.
- [ ] 2.5 Add model capability metadata instead of assuming every model has the same options.
- [ ] 2.6 Add streamed generation events.
- [ ] 2.7 Persist conversations/messages.
- [ ] 2.8 Add chat UI.
- [ ] 2.9 Add abort/cancel support.
- [ ] 2.10 Add provider error normalization and retry policy.
- [ ] 2.11 Add scripted mock-provider plugin for deterministic tests.
- [ ] 2.12 Capture token/usage/cost metadata when providers expose it; capture now, reporting UI can wait.
- [ ] 2.13 Add fallback support for models/providers without native tool calling only when needed.

**Checkpoint:** swap between the scripted provider and one OpenAI-compatible provider through plugin configuration without changing core code.

---

## Phase 3 — Run engine

- [x] 3.0 Decide/document where the agent loop runs: the long-lived runtime daemon. See `RUNTIME.md`.
- [ ] 3.1 Add run creation.
- [ ] 3.2 Add append-only run events.
- [ ] 3.3 Add run status machine.
- [ ] 3.4 Add step counter and hard limits.
- [ ] 3.5 Add pause/cancel support.
- [ ] 3.6 Add context builder with hard byte/token-budget hooks.
- [ ] 3.7 Inject active goal and todos into context.
- [ ] 3.8 Add run inspector UI.
- [ ] 3.9 Add recovery behavior for interrupted runs.
- [ ] 3.10 Add SSE resume cursor / `Last-Event-ID` behavior.

**Checkpoint:** a model run can be started, inspected, cancelled, and recovered without losing durable state.

---

## Phase 4 — Tool plugins and safe read tools

- [ ] 4.1 Define public `HarnessTool` contract in plugin API.
- [ ] 4.2 Add lightweight argument validation at the tool boundary.
- [ ] 4.3 Add tool registry as a plugin service.
- [ ] 4.4 Add project-root path resolver.
- [ ] 4.5 Add symlink/path-traversal protection.
- [ ] 4.6 Add `fs.list` through the first-party native-tools plugin.
- [ ] 4.7 Add `fs.read` through the same plugin.
- [ ] 4.8 Add safe read-only command allowlist.
- [ ] 4.9 Persist every tool request/result.
- [ ] 4.10 Feed tool results back into the model loop.
- [ ] 4.11 Add tool-call tests.
- [ ] 4.12 Implement Windows path containment rules: junctions, case folding, short names, UNC/drive-relative paths.
- [ ] 4.13 Implement process-tree cancellation for general tool processes.
- [ ] 4.14 Detect/report Windows long-path limitations at startup.

**Checkpoint:** native and external plugin tools both run through the same registry, policy, and trace path.

---

## Phase 5 — Permissions and write tools

- [ ] 5.1 Add permission policy engine.
- [ ] 5.2 Classify model-requested tools as read/write/execute/destructive.
- [ ] 5.3 Add first-class approval records.
- [ ] 5.4 Add approval cards in UI.
- [ ] 5.5 Pause run while awaiting approval.
- [ ] 5.6 Add `fs.write`.
- [ ] 5.7 Add controlled `shell.run`.
- [ ] 5.8 Add `git.status`.
- [ ] 5.9 Add `git.diff`.
- [ ] 5.10 Add approval-gated `git.commit`.
- [ ] 5.11 Add command timeouts/output limits.
- [ ] 5.12 Add secret redaction.
- [ ] 5.13 Add idempotency protection for resumed write calls.
- [ ] 5.14 Bind local server to loopback by default and add origin/CSRF protection where applicable.
- [ ] 5.15 Add redaction registry + extended secret deny list.
- [ ] 5.16 Return structured denial results to the model.
- [ ] 5.17 Record file changes per write tool call.

**Checkpoint:** write action pauses → user approves → action executes exactly once → run resumes.

---

## Phase 6 — Goal/todo autonomous loop

- [ ] 6.1 Add model-visible goal/todo actions.
- [ ] 6.2 Add `todo.create`.
- [ ] 6.3 Add `todo.update`.
- [ ] 6.4 Add `todo.complete`.
- [ ] 6.5 Add `goal.update`.
- [ ] 6.6 Select next runnable todo deterministically.
- [ ] 6.7 Continue bounded loop after tool/todo completion.
- [ ] 6.8 Add blocked-state handling.
- [ ] 6.9 Add goal-completion check.
- [ ] 6.10 Add multi-step integration test using scripted provider + small coding task.
- [ ] 6.11 Add golden-trace assertion for one complete deterministic run.

**Checkpoint:** a three-todo coding goal progresses from start to completion with persistent state and reproducible trace ordering.

---

## Phase 7 — Lightweight memory

- [ ] 7.1 Add project memory CRUD.
- [ ] 7.2 Add pinned memory.
- [ ] 7.3 Add recent/pinned retrieval rules.
- [ ] 7.4 Add context budget accounting.
- [ ] 7.5 Add conversation summarization when needed.
- [ ] 7.6 Add SQLite FTS retrieval if simple recency/pinning is insufficient.
- [ ] 7.7 Add project-level memory UI.
- [ ] 7.8 Add retrieval tests.

**Checkpoint:** a decision saved in one conversation is available in a later relevant conversation without requiring a vector DB.

---

## Phase 8 — Plugin ecosystem + MCP

- [ ] 8.1 Add plugin config format and enable/disable list.
- [ ] 8.2 Add local folder/package plugin loading.
- [ ] 8.3 Add npm/Git package installation only after local plugin loading is solid.
- [ ] 8.4 Add plugin compatibility/API-version checks.
- [ ] 8.5 Add plugin status/errors/settings UI.
- [ ] 8.6 Add MCP server config format.
- [ ] 8.7 Add MCP stdio transport.
- [ ] 8.8 Add MCP tool discovery.
- [ ] 8.9 Wrap MCP tools in the normal plugin/tool registry.
- [ ] 8.10 Map MCP tools to harness risk/permission classes.
- [ ] 8.11 Add one MCP integration test.
- [ ] 8.12 Document third-party plugin authoring.
- [ ] 8.13 Allow plugins to register graph node types/executors through the public API without importing graph-editor code.

**Checkpoint:** install/enable one external plugin and one MCP adapter without changing core code; disabled plugins add no active runtime work.

---

## Phase 8.5 — Optional visual graph authoring

Implementation contract is defined in `GRAPH.md`.

- [ ] 8.5.1 Define a small versioned canonical JSON graph schema owned by Zet Harness.
- [ ] 8.5.2 Separate editor draft state, immutable semantic graph revisions, and compiled execution plans.
- [ ] 8.5.3 Define typed semantic ports independently from editor handles.
- [ ] 8.5.4 Separate data edges from control edges.
- [ ] 8.5.5 Add initial node language: Input, Transform, Model Call, Conditional, Loop, Join, Tool Call, Subgraph, Output.
- [ ] 8.5.6 Add graph validator + deterministic compiler.
- [ ] 8.5.7 Add graph executor adapter over the existing run engine and plugin registries.
- [ ] 8.5.8 Add compiler golden tests and invalid-graph/property tests.
- [ ] 8.5.9 Add React Flow only to the web/editor surface and lazy-load the graph editor.
- [ ] 8.5.10 Add graph run visualization using the same durable run events/traces.
- [ ] 8.5.11 Add save → reload → compile → execute integration test.

**Checkpoint:** create a small graph in the editor, reload it without semantic change, compile it deterministically, and execute it using plugin-provided model/tool nodes while the headless runtime remains free of React Flow dependencies.

---

## Phase 9 — External clients and event inputs

- [ ] 9.1 Define client session API.
- [ ] 9.2 Add authenticated message ingress.
- [ ] 9.3 Add outbound event stream.
- [ ] 9.4 Add webhook/event input abstraction.
- [ ] 9.5 Add safe run wake/resume rules.
- [ ] 9.6 Add Copycat/client bridge prototype.
- [ ] 9.7 Document how another AI client communicates with the harness without owning its state.
- [ ] 9.8 Add optional isolated-plugin worker design only if community/untrusted plugin execution is required.

**Checkpoint:** a second client can submit a task and receive events while the same harness state remains authoritative.

---

## Phase 10 — Provider/plugin expansion

Only after the core loop is stable:

- [ ] 10.1 Anthropic provider plugin.
- [ ] 10.2 Provider-specific reasoning controls.
- [ ] 10.3 Qwen-specific metadata/config where useful.
- [ ] 10.4 Local-model presets.
- [ ] 10.5 Model fallback/router policies.
- [ ] 10.6 Subscription/auth plugins where provider terms/APIs support them.

---

## Phase 11 — Packaging

- [ ] 11.1 Windows setup script.
- [ ] 11.2 Config wizard.
- [ ] 11.3 Backup/export/import.
- [ ] 11.4 Decide whether the existing desktop app becomes a client or is replaced before adding another desktop wrapper.
- [ ] 11.5 Release checklist.

---

## Rules while building

- Keep each implementation step small and testable.
- Protect the lightweight runtime budget.
- Built-ins should use public plugin registration paths wherever practical.
- Third-party plugins must depend on `@zet-harness/plugin-api`, not private `core` files.
- Disabled plugins should do no active work.
- The graph/editor is an optional authoring layer; it must not become the runtime contract.
- Do not pretend in-process plugins are security-sandboxed; they are trusted code.
- Do not store credentials or machine-specific secrets in Git.
- Do not bypass the permission layer from a model-requested tool implementation.
- Do not let provider-specific behavior leak into the core domain model.
- Do not add infrastructure merely because it may be useful later.
- Every side-effecting model/tool operation must be traceable.
- Every persistent state transition must be validated.
- Before marking a phase complete, run its checkpoint test.

## Next action

**0.13 — Add Next/React lint rules and type-checked TypeScript linting.**
