# Zet Harness

A lightweight, local-first, model-agnostic AI agent harness owned by us.

This project is intentionally separate from the existing DeepSeek Harness experiments under `llm/`. Those experiments remain useful reference implementations and provider bridges, but Zet Harness does not depend on DeepSeek Harness internally.

## Goal

Build one small persistent runtime that can sit between a user and multiple AI models, tools, plugins, memories, projects, goals, and long-running tasks.

The harness owns durable workflow state. Models and integrations are replaceable workers/extensions.

## v1 principles

1. **Lightweight core** — one Node.js process and one local SQLite file before any distributed machinery.
2. **Wide plugin door** — built-ins and third-party extensions use the same public registration APIs wherever practical.
3. **Local-first** — no Redis, Docker, database server, vector DB, or mandatory cloud service for the base install.
4. **Model-agnostic** — model providers register behind capability-aware contracts.
5. **Tool-agnostic** — native tools and plugin tools share the same execution, approval, and trace path.
6. **Persistent state** — goals, todos, runs, messages, tool calls, and memories survive restarts.
7. **Safe execution** — the harness enforces workspace boundaries and approval rules around model-requested actions.
8. **Observable** — important model/tool/state transitions are traceable.
9. **Lazy integrations** — disabled plugins should add effectively zero runtime work.
10. **Plain TypeScript first** — no agent framework, workflow engine, or multi-agent framework before the basic loop works extremely well.

## Planned v1 stack

- Node.js 24 LTS
- TypeScript
- lightweight long-lived Node runtime daemon using built-in APIs where practical
- Next.js local web UI as a client of the runtime
- built-in `node:sqlite` + small SQL repository/migration layer
- tiny native plugin kernel
- OpenAI-compatible model plugin first
- SSE for streamed events
- native files/shell/Git tools first
- optional MCP and external integrations through plugins later

The base runtime should not require Python, Docker, Redis, a native database addon, or a vector database.

## Plugin direction

The kernel owns only lifecycle/registration/configuration/security primitives. Plugins may eventually add:

- model providers
- tools
- auth/subscription providers
- services
- hooks/events
- memory providers
- settings
- API routes
- UI contributions
- external workers/event sources

A small public `@zet-harness/plugin-api` package will keep third-party plugins away from private core internals.

Trusted in-process plugins stay extremely cheap. A truly isolated plugin mode can be added later for untrusted/community extensions without forcing every plugin into a subprocess today.

## Documentation

- [`PLAN.md`](./PLAN.md) — consolidated architecture, components, data model, API, milestones, and acceptance criteria.
- [`LIGHTWEIGHT.md`](./LIGHTWEIGHT.md) — authoritative lightweight runtime profile.
- [`PLUGINS.md`](./PLUGINS.md) — plugin architecture and extension contract direction.
- [`RUNTIME.md`](./RUNTIME.md) — durable runtime ownership and process boundaries.
- [`GRAPH.md`](./GRAPH.md) — optional visual graph authoring contract.
- [`GAPS.md`](./GAPS.md) — gap review and deferred architectural decisions.
- [`TODO.md`](./TODO.md) — exact implementation order. We complete these items one by one.

Raw research is kept under `research/` as reference material only; accepted architecture is recorded in the documents above.

## Status

Phase 0 scaffold is in progress on `zet-harness-v1`. We are cleaning the foundation before starting persistent runtime state.
