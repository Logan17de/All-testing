# Zet Harness — Ordered TODO

We implement this list in order. Do not jump ahead unless an earlier item is blocked.

## Phase 0 — Project skeleton

- [x] 0.1 Create `harness/package.json` and workspace layout.
- [x] 0.2 Add TypeScript, linting, formatting, and test configuration.
- [x] 0.3 Create `apps/web` Next.js app.
- [x] 0.4 Create `packages/core`, `packages/db`, `packages/models`, `packages/tools`, and `packages/shared`.
- [x] 0.5 Add `.env.example` with placeholders only.
- [x] 0.6 Add `.gitignore` rules for local DB, runtime state, logs, and secrets.
- [x] 0.7 Add `/api/health`.
- [ ] 0.8 Add basic startup test.

**Checkpoint:** `npm install && npm run dev` starts successfully.

---

## Phase 1 — Database and persistent task state

- [ ] 1.1 Add SQLite + Drizzle.
- [ ] 1.2 Create schema for projects.
- [ ] 1.3 Create schema for conversations/messages.
- [ ] 1.4 Create schema for goals/todos.
- [ ] 1.5 Create schema for runs/tool calls/events/approvals.
- [ ] 1.6 Add migrations.
- [ ] 1.7 Add project CRUD API.
- [ ] 1.8 Add goal CRUD API.
- [ ] 1.9 Add todo CRUD API.
- [ ] 1.10 Add valid status-transition guards.
- [ ] 1.11 Add minimal project/goals/todos UI.
- [ ] 1.12 Add persistence restart test.

**Checkpoint:** create goal → add todos → restart → state is unchanged.

---

## Phase 2 — Model provider layer

- [ ] 2.1 Define internal model/provider types.
- [ ] 2.2 Add provider registry.
- [ ] 2.3 Add OpenAI-compatible provider adapter.
- [ ] 2.4 Support custom base URL and API key through environment/config.
- [ ] 2.5 Add model capability metadata instead of assuming every model has the same options.
- [ ] 2.6 Add streamed generation events.
- [ ] 2.7 Persist conversations/messages.
- [ ] 2.8 Add chat UI.
- [ ] 2.9 Add abort/cancel support.
- [ ] 2.10 Add provider error normalization and retry policy.

**Checkpoint:** chat with one OpenAI-compatible model and preserve the conversation after restart.

---

## Phase 3 — Run engine

- [ ] 3.1 Add run creation.
- [ ] 3.2 Add append-only run events.
- [ ] 3.3 Add run status machine.
- [ ] 3.4 Add step counter and hard limits.
- [ ] 3.5 Add pause/cancel support.
- [ ] 3.6 Add context builder.
- [ ] 3.7 Inject active goal and todos into context.
- [ ] 3.8 Add run inspector UI.
- [ ] 3.9 Add recovery behavior for interrupted runs.

**Checkpoint:** a model run can be started, inspected, cancelled, and recovered without losing durable state.

---

## Phase 4 — Tool registry and safe read tools

- [ ] 4.1 Define `HarnessTool` contract.
- [ ] 4.2 Add Zod argument validation.
- [ ] 4.3 Add tool registry.
- [ ] 4.4 Add project-root path resolver.
- [ ] 4.5 Add symlink/path-traversal protection.
- [ ] 4.6 Add `fs.list`.
- [ ] 4.7 Add `fs.read`.
- [ ] 4.8 Add safe read-only command allowlist.
- [ ] 4.9 Persist every tool request/result.
- [ ] 4.10 Feed tool results back into the model loop.
- [ ] 4.11 Add tool-call tests.

**Checkpoint:** model can inspect the project through harness tools and every action appears in the trace.

---

## Phase 5 — Permissions and write tools

- [ ] 5.1 Add permission policy engine.
- [ ] 5.2 Classify tools as read/write/execute/destructive.
- [ ] 5.3 Add approval records.
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
- [ ] 6.10 Add multi-step integration test using a small coding task.

**Checkpoint:** a three-todo coding goal can progress from start to completion with persistent state and trace history.

---

## Phase 7 — Memory

- [ ] 7.1 Add project memory CRUD.
- [ ] 7.2 Add pinned memory.
- [ ] 7.3 Add memory retrieval rules.
- [ ] 7.4 Add context token-budget accounting.
- [ ] 7.5 Add conversation summarization when needed.
- [ ] 7.6 Add project-level memory UI.
- [ ] 7.7 Add retrieval tests.

**Checkpoint:** a decision saved in one conversation is available in a later relevant conversation.

---

## Phase 8 — MCP

- [ ] 8.1 Add MCP server config format.
- [ ] 8.2 Add MCP stdio transport.
- [ ] 8.3 Add MCP tool discovery.
- [ ] 8.4 Wrap MCP tools in the normal tool registry.
- [ ] 8.5 Map MCP tools to harness risk/permission classes.
- [ ] 8.6 Persist MCP tool traces normally.
- [ ] 8.7 Add one MCP integration test.

**Checkpoint:** one MCP server works through the same agent/tool/approval loop as native tools.

---

## Phase 9 — External clients and event inputs

- [ ] 9.1 Define client session API.
- [ ] 9.2 Add authenticated message ingress.
- [ ] 9.3 Add outbound event stream.
- [ ] 9.4 Add webhook/event input abstraction.
- [ ] 9.5 Add safe run wake/resume rules.
- [ ] 9.6 Add Copycat/client bridge prototype.
- [ ] 9.7 Document how another AI client can communicate with the harness without owning its state.

**Checkpoint:** a second client can submit a message/task and receive harness events while the same goal/todo state remains authoritative.

---

## Phase 10 — Provider expansion

Only after the core loop is stable:

- [ ] 10.1 Anthropic adapter.
- [ ] 10.2 Provider-specific reasoning controls.
- [ ] 10.3 Qwen-specific metadata/config where useful.
- [ ] 10.4 Local-model presets.
- [ ] 10.5 Model fallback/router policies.
- [ ] 10.6 Cost/usage reporting.

---

## Phase 11 — Packaging

- [ ] 11.1 Windows setup script.
- [ ] 11.2 Config wizard.
- [ ] 11.3 Backup/export/import.
- [ ] 11.4 Optional Tauri desktop wrapper.
- [ ] 11.5 Release checklist.

---

## Rules while building

- Keep each implementation step small and testable.
- One concern per commit when practical.
- Do not store credentials or machine-specific secrets in Git.
- Do not bypass the permission layer from a tool implementation.
- Do not let provider-specific behavior leak into the core domain model.
- Do not add infrastructure just because it may be useful later.
- Every side-effecting operation must be traceable.
- Every persistent state transition must be validated.
- Before marking a phase complete, run its checkpoint test.

## Next action

**0.8 — Add basic startup test.**
