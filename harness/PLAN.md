# Zet Harness — Architecture Plan

## 1. Product definition

Zet Harness is a persistent agent runtime that sits between users, AI models, tools, files, and external systems.

The central rule is:

> The model does not own the workflow state. The harness does.

A model can reason, propose actions, call tools, and update task state, but goals, todos, permissions, tool history, memory, retries, and execution state are persisted by the harness.

---

## 2. v1 target

The first usable version should let us:

1. open a local web UI
2. create or select a project
3. create a goal
4. let the harness break it into todos
5. talk to an OpenAI-compatible model
6. let that model call safe local tools
7. persist all state in SQLite
8. stop and restart the app without losing progress
9. resume an interrupted agent run
10. inspect exactly what the model and tools did

v1 is deliberately single-user and local-first.

---

## 3. High-level architecture

The durable agent loop does **not** live inside Next.js. A small long-lived Node runtime daemon owns SQLite, the plugin host, scheduling, approvals, events, and resumable runs. The web app is a client over HTTP + SSE. This keeps long-running execution independent from request lifetimes and development HMR while avoiding Redis, queues, or a worker framework.

```text
┌──────────────────────────────┐
│          Web UI              │
│ chat • goals • todos • runs  │
└──────────────┬───────────────┘
               │ HTTP + SSE
               ▼
┌──────────────────────────────┐
│  Lightweight Node Runtime    │
│  API + Plugin Host           │
│  Agent Scheduler             │
│  Context / Goal / Todo       │
│  Permissions / Approvals     │
│  Events / Run Recorder       │
└───────┬─────────┬────────────┘
        │         └──────────────► node:sqlite
        ├────────────────────────► Model plugins
        └────────────────────────► Tool / capability plugins
```

The default target is one runtime process plus the web development process. A packaged release may serve the built UI from the runtime so end users still launch one application.

---

## 4. Repository layout

Planned structure:

```text
harness/
├── README.md
├── PLAN.md
├── TODO.md
├── package.json
├── apps/
│   └── web/
├── packages/
│   ├── core/
│   ├── db/
│   ├── models/
│   ├── tools/
│   └── shared/
├── data/
│   └── .gitkeep
└── tests/
```

We should avoid splitting into separate deployable services until we actually need that complexity.

---

## 5. Core domain objects

### Project

A persistent workspace boundary.

Fields:

```text
id
name
root_path
created_at
updated_at
```

### Conversation

A user/agent thread scoped to a project.

```text
id
project_id
title
created_at
updated_at
```

### Message

```text
id
conversation_id
parent_message_id     -- nullable; edit/retry branching
role
content_json          -- structured parts: text/tool_use/tool_result/reasoning
tool_call_id          -- nullable; links tool result messages
model
created_at
```

### Goal

```text
id
project_id
title
description
status
priority
created_at
updated_at
completed_at
```

Goal status:

```text
planned | active | blocked | completed | cancelled
```

### Todo

```text
id
goal_id
parent_todo_id
title
description
status
position
created_at
updated_at
completed_at
```

Todo status:

```text
pending | active | blocked | completed | cancelled
```

### Agent Run

One resumable execution loop.

```text
id
parent_run_id         -- nullable; keeps future sub-runs possible without enabling multi-agent now
project_id
conversation_id
goal_id
status
model_provider
model_id
started_at
finished_at
last_checkpoint_at
error
```

Run status:

```text
queued | running | waiting_for_approval | paused | completed | failed | cancelled
```

### Tool Call

```text
id
run_id
tool_name
arguments_json
result_json
status
idempotency_key
attempt
started_at
finished_at
```

### Approval

Approvals are first-class records rather than a flag embedded in a tool call.

```text
id
run_id
tool_call_id
project_id
requested_at
decision              -- pending | approved | denied
decided_at
scope                 -- once | run | project
expires_at
reason
```

### Memory

```text
id
project_id
scope
kind
content
importance
created_at
updated_at
```

Initial scopes:

```text
conversation | project | user
```

### Event

Append-only runtime event stream.

```text
id
run_id
type
schema_version
payload_json
created_at
```

Examples:

```text
message.created
model.started
model.token
model.completed
tool.requested
tool.approval_required
tool.started
tool.completed
todo.updated
goal.completed
run.paused
run.completed
run.failed
```

---

## 6. Agent execution loop

The first loop should be intentionally boring and deterministic.

```text
1. Load project + conversation + active goal + todos.
2. Build context within a token budget.
3. Call the selected model.
4. If normal response:
      save response
      end turn
5. If tool calls:
      validate arguments
      check permission policy
      request approval if needed
      execute allowed tools
      persist results
      feed results back to model
6. If goal/todo state changes:
      validate transition
      persist it
7. Repeat until:
      model returns final answer
      run requires approval
      run reaches safety/step limit
      run is paused/cancelled
      goal is completed
```

Hard limits should exist from day one:

- max agent steps per run
- max tool calls per step
- max output size
- tool timeout
- total run timeout
- model retry count

---

## 7. Context builder

Do not send the entire database to the model.

Context should be assembled in layers:

```text
system policy
project instructions
active goal
active + pending todos
recent conversation
relevant project memory
recent tool results
current user message
```

The context builder owns a token budget and can later add summarization/retrieval.

v1 can use simple recency plus manually pinned memory. Vector search is not required for the first working build.

---

## 8. Model abstraction

All providers expose one internal contract.

Conceptually:

```ts
interface ModelProvider {
  listModels(): Promise<ModelInfo[]>;
  generate(request: ModelRequest): AsyncIterable<ModelEvent>;
}
```

`ModelRequest` should support:

- messages
- system instructions
- tool definitions
- temperature when supported
- reasoning options when supported
- max output tokens
- abort signal

The internal API must not assume that all models support the same reasoning controls.

### First provider

Start with an OpenAI-compatible adapter because it lets us immediately test:

- OpenAI-compatible cloud APIs
- Qwen endpoints
- vLLM
- Ollama-compatible gateways where applicable
- our existing local/Colab bridge experiments

Provider-specific adapters come after the runtime works.

---

## 9. Tool system

Every tool uses one internal schema:

```ts
interface HarnessTool {
  name: string;
  description: string;
  inputSchema: unknown;
  risk: "read" | "write" | "execute" | "destructive";
  execute(ctx, input): Promise<ToolResult>;
}
```

### v1 native tools

1. `fs.list`
2. `fs.read`
3. `fs.write`
4. `shell.run`
5. `git.status`
6. `git.diff`
7. `git.commit`

Later:

- HTTP fetch
- Python runner
- browser automation
- MCP client
- GitHub
- Supabase
- Vercel
- ComfyUI
- Blender

---

## 10. Permission model

Permissions belong to the harness, not the model prompt.

Initial policy:

| Action | Default |
|---|---|
| Read files inside project | allow |
| List project files | allow |
| Write/create file inside project | ask |
| Run harmless read-only shell command | allow by allowlist |
| Install packages | ask |
| Git commit | ask |
| Network access | ask |
| Delete file | ask |
| Run arbitrary shell command | ask |
| Write outside project root | deny |
| Read known secret files | deny |

We can later add per-project remembered approvals.

Secrets must never be written into traces by default. Permission denials must return a structured machine-readable result (`code`, `reason`, and safe remediation metadata) so models can choose a different action instead of retrying blindly.

---

## 11. Workspace isolation

Each project has one canonical `root_path`.

All filesystem tools resolve real paths and verify they remain inside that root.

Reject:

- `../` path traversal
- symlink escapes
- direct access to known credential directories
- writes outside the workspace

Shell commands should execute with the project root as `cwd` and a controlled environment.

---

## 12. API surface

The long-lived runtime daemon owns the durable local API. Next.js must not own agent-run state; the web UI calls the runtime over loopback HTTP and subscribes through SSE.

Initial local API:

```text
GET    /api/health
GET    /api/projects
POST   /api/projects
GET    /api/projects/:id

GET    /api/projects/:id/goals
POST   /api/projects/:id/goals
PATCH  /api/goals/:id

GET    /api/goals/:id/todos
POST   /api/goals/:id/todos
PATCH  /api/todos/:id

POST   /api/conversations
GET    /api/conversations/:id/messages
POST   /api/conversations/:id/messages

POST   /api/runs
GET    /api/runs/:id
POST   /api/runs/:id/pause
POST   /api/runs/:id/resume
POST   /api/runs/:id/cancel
GET    /api/runs/:id/events

GET    /api/approvals
POST   /api/approvals/:id/approve
POST   /api/approvals/:id/deny
```

SSE is enough for v1 streaming. WebSockets are unnecessary until we have a concrete need.

---

## 13. UI screens

### Project home

- project picker
- active goals
- recent conversations
- recent runs

### Chat / agent view

- messages
- streamed model output
- visible tool calls
- approval cards
- active goal
- todo progress

### Goals view

- create goal
- ordered todo list
- status changes
- completion progress

### Run inspector

- timeline
- model calls
- tool calls
- errors
- token/usage metadata

### Settings

- model providers
- model selection
- local endpoint configuration
- execution limits
- permission defaults

---

## 14. Persistence strategy

Use SQLite first.

Reasons:

- zero external dependency
- perfect for local single-user v1
- easy backups
- easy inspection
- migration path to Postgres later

Use Node 24's built-in `node:sqlite` first, with a tiny ordered SQL migration runner and a `schema_migrations` table. Do not add an ORM until real schema complexity justifies it. Enable WAL mode and use the built-in SQLite backup capability early.

If we later need remote sync, multi-device access, or hosted workers, keep the domain contracts stable and move the persistence adapter to Postgres/Supabase.

---

## 15. Observability

Every run receives a stable ID.

Record:

- model provider/model
- request start/end
- usage if provider returns it
- tool request/result
- approvals
- todo transitions
- errors
- retries
- duration

Do not log API keys, OAuth tokens, auth headers, `.env` contents, or raw secrets.

---

## 16. Failure and resume behavior

A crash should not destroy progress.

Checkpoint after every durable event:

- user message saved
- model response saved
- tool call requested
- tool call completed
- todo changed
- approval requested

On restart, any `running` run is marked `paused_recovery` internally and can be resumed from its last completed event instead of blindly replaying a side-effecting tool call.

Idempotency matters for write tools.

---

## 17. Security boundaries for v1

v1 is a trusted-user local developer tool, not a multi-tenant cloud service.

Still required:

- no secrets in Git
- environment-based provider credentials
- project-root filesystem sandbox
- explicit destructive-action approvals
- command timeout
- output truncation
- secret redaction in traces
- no silent network access from tools
- no automatic privilege elevation

---

## 18. Milestones

### M0 — Skeleton

Deliver:

- monorepo/package setup
- local server
- `/api/health`
- SQLite connection
- migrations
- test runner

Acceptance:

```text
npm install
npm run dev
```

starts the harness and the health endpoint returns OK.

### M1 — Persistent project/task state

Deliver:

- projects
- goals
- todos
- CRUD API
- minimal UI

Acceptance:

Create a goal and todos, restart the server, and confirm state survives.

### M2 — Model chat

Deliver:

- provider registry
- OpenAI-compatible adapter
- streamed responses
- conversation/message persistence

Acceptance:

Select a configured model, send a message, stream a response, restart, and still see the conversation.

### M3 — Native read tools

Deliver:

- tool registry
- tool schemas
- `fs.list`
- `fs.read`
- read-only shell allowlist
- tool-call loop

Acceptance:

Ask the model to inspect the current project and have the action appear in the trace.

### M4 — Approval + write tools

Deliver:

- permission engine
- approval UI/API
- `fs.write`
- controlled `shell.run`
- Git tools

Acceptance:

A requested write pauses the run, waits for approval, executes once, then resumes the model.

### M5 — Goal-driven autonomous loop

Deliver:

- goal injection into context
- todo tool/actions
- bounded multi-step execution
- stop/pause/resume
- automatic next-todo selection

Acceptance:

Give the harness a small coding goal with three todos and let it complete the sequence while persisting every state transition.

### M6 — Memory

Deliver:

- project memory
- pinned memories
- relevance selection
- context budget management

Acceptance:

Persist a project decision, start a new conversation, and have the harness retrieve that decision when relevant.

### M7 — MCP

Deliver:

- MCP server configuration
- discovery
- MCP tool wrapping into the same registry
- permission mapping

Acceptance:

Connect one MCP server and call one MCP tool through the normal agent loop.

### M8 — External clients/events

Deliver:

- authenticated local/remote message endpoint
- event/webhook input
- client sessions
- safe wake/resume behavior

This is where a future ChatGPT/client bridge, Copycat integration, desktop event source, or phone frontend can connect.

### M9 — Packaging

Deliver:

- Windows-friendly install/start flow
- config wizard
- optional Tauri desktop package
- export/import/backup

---

## 19. Explicitly not in the first build

Do not add these before M5 works:

- Kubernetes
- Redis
- message queues
- microservices
- vector DB dependency
- multi-user auth
- cloud deployment
- dozens of provider adapters
- complex multi-agent hierarchies
- automatic computer control without approvals

They can be added later if real usage demands them.

---

## 20. Definition of success

Zet Harness v1 is successful when we can close the app in the middle of a real project, reopen it later, and the system still knows:

- what the project is
- what the goal is
- which todos are done
- which todo is next
- what the model already tried
- which tools ran
- what files changed
- what still needs approval

At that point we own the agent runtime instead of depending on one model or one third-party harness.
