# Zet Harness

A local-first, model-agnostic AI agent harness owned by us.

This project is intentionally separate from the existing DeepSeek Harness experiments under `llm/`. Those experiments remain useful reference implementations and provider bridges, but Zet Harness should not depend on DeepSeek Harness internally.

## Goal

Build one persistent runtime that can sit between a user and multiple AI models, tools, memories, projects, goals, and long-running tasks.

The harness owns:

- conversations and context assembly
- model/provider routing
- tools and permissions
- goals and todos
- memory
- workspace/files
- agent execution loop
- events and resumable runs
- logs, costs, usage, and failures

Models are replaceable workers. The harness is the stable system.

## v1 principles

1. **Local-first** — the core can run on one Windows/Linux/macOS machine.
2. **Model-agnostic** — OpenAI, Anthropic, Qwen, and OpenAI-compatible local endpoints use adapters.
3. **Tool-agnostic** — native tools, HTTP APIs, CLI commands, and MCP tools share one registry.
4. **Persistent state** — goals, todos, runs, tool calls, and memories survive restarts.
5. **Safe execution** — the harness enforces workspace boundaries and approval rules.
6. **Observable** — every model call and tool call has a run ID and trace.
7. **Simple first** — one process and SQLite before distributed workers or microservices.

## Planned v1 stack

- TypeScript
- Node.js
- Next.js web UI
- SQLite + Drizzle ORM
- Zod schemas
- provider adapters for OpenAI-compatible APIs first
- SSE for streamed events
- MCP client support after native tool execution works

A desktop wrapper can be added later with Tauri if we want a native app.

## Documentation

- [`PLAN.md`](./PLAN.md) — architecture, components, data model, API, milestones, and acceptance criteria.
- [`TODO.md`](./TODO.md) — exact implementation order. We complete these items one by one.

## Status

Planning only. No Zet Harness runtime code has been added yet.
