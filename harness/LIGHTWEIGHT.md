# Zet Harness — Lightweight Runtime Profile

This document narrows the main architecture plan around one explicit goal:

> **Keep the base harness small, local-first, fast to start, and cheap to keep idle — while leaving a very wide extension door.**

The target is not the fewest lines of code. The target is the fewest moving parts required for a reliable agent runtime.

## Core runtime shape

Default v1:

```text
Browser
  ↕ HTTP + SSE
One Node.js process
  ├─ web UI + API
  ├─ plugin kernel
  ├─ agent loop
  ├─ model/tool registries
  └─ SQLite
       ↕
   one local DB file
```

Default rules:

- one application process;
- one local SQLite database;
- no Redis;
- no Docker requirement;
- no queue/broker;
- no separate API service;
- no vector database by default;
- no mandatory cloud dependency;
- no WebSocket unless SSE is proven insufficient;
- no multi-agent framework before the single-agent loop is excellent.

Heavy applications such as Ollama, vLLM, ComfyUI, Blender, browser automation, or a Colab GPU worker stay outside the core process and connect as optional providers/plugins.

## Dependency budget

Before the autonomous loop milestone, keep the runtime dependency graph deliberately small.

Before adding a production dependency, ask:

1. Can Node.js safely provide this already?
2. Can Next.js provide it already?
3. Is a small dependency materially safer or simpler than a tiny local implementation?
4. Will it still be useful after the first complete agent loop exists?

Do not add a framework only to avoid writing a small amount of plain TypeScript.

Development tooling can be richer than the runtime, but should still have a clear purpose.

## SQLite: built-in first

Use Node's built-in `node:sqlite` for v1 where the pinned Node version supports the required API.

Initial persistence stack:

```text
node:sqlite
+ prepared statements
+ small repository functions
+ ordered .sql migrations
+ schema_migrations table
```

Do not require an ORM initially.

Drizzle remains an escape hatch if the schema/query layer becomes difficult enough to justify it. It is not a Phase 1 prerequisite.

This keeps the install lighter and avoids a native SQLite addon/rebuild path on Windows.

## UI rule

Keep the existing Next.js shell for now because it gives us UI + local API + SSE in one process.

Do not add by default:

- Tailwind;
- a component framework;
- a client state-management framework;
- a form framework;
- a second backend framework.

Prefer Server Components and plain CSS. Add client components only where interaction requires them.

At the end of Phase 0, record startup time and idle memory. If the web framework dominates runtime cost enough to violate the lightweight goal, reconsider the shell before model/tool complexity arrives.

## Agent loop rule

The core loop remains plain TypeScript:

```text
build context
→ call model
→ receive response/tool request
→ validate
→ permission check
→ execute
→ persist event/state
→ continue or stop
```

No LangChain, graph framework, workflow engine, or multi-agent framework in v1.

An abstraction belongs in the core only when it makes the loop easier to inspect, test, resume, or extend.

## Tools and integrations are lazy

Optional integrations must not increase the base install cost when disabled.

Plugins should be loaded with dynamic imports only when enabled.

Prefer HTTP/subprocess boundaries for heavyweight external applications instead of importing their ecosystems into the harness runtime.

Examples:

```text
Base install:
  chat + SQLite + files + shell + git

Optional:
  MCP
  GitHub
  browser
  ComfyUI
  Blender
  Supabase
  Vercel
  Colab workers
```

## Memory stays simple first

Before advanced memory work:

- recent conversation window;
- pinned project notes;
- compact summaries;
- SQLite FTS where useful.

Do not add a vector database or embedding service until real usage proves that simple retrieval is insufficient.

## Package discipline

Internal packages are boundaries, not architecture decoration.

Do not create a new package unless it provides a real dependency/stability boundary. The plugin API is one such boundary because third-party extensions must not import private core internals.

Avoid circular dependencies and keep orchestration in `core` rather than spreading runtime control across packages.

## Soft performance targets

Measure these in production mode, excluding any external model process:

- one harness process;
- health endpoint available within a few seconds;
- idle RSS target under roughly 250 MB;
- zero continuous polling loops while idle;
- one long-lived/lazily opened DB connection, not repeated connect/disconnect churn;
- bounded in-memory event/tool output;
- disabled plugins consume effectively zero runtime work.

These are engineering targets, not promises. Profile before changing architecture.

## Lightweight success

A clean machine should eventually be able to run:

```text
git clone
npm ci
npm run build
npm start
```

and get a useful harness without installing a database server, Redis, Docker, Python, a vector DB, or a separate orchestration service.
