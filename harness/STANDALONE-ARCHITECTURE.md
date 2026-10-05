# Standalone harness architecture and acceptance

The harness owns execution. Model providers return inference results through model adapters;
no provider CLI, app-server or proprietary agent loop owns native execution.
An optional Codex bridge is limited to web search if official search-only isolation
can be established; it must not receive native tool permissions or execute rejected calls.
The earlier Codex bridge architecture has been retired. Its history remains in Git.

## Implementation milestones

1. Remove the Codex package, CLI transport, login controls and daemon wiring; keep useful
   native filesystem safety and generic MCP form validation where they apply.
2. Expose native coding sessions through `/api/agent`, `/agent` and `npm run agent`.
   Reuse durable projects/conversations, graph compilation, dispatcher, context budgets,
   summaries, run events, recovery and approval records. Do not introduce an unrelated loop.
3. Wire scoped native filesystem and bounded process tools, explicit human consent,
   cancellation and instruction discovery. Verify actual effects on temporary workspaces
   with scripted inference; label these checks as offline, not live provider acceptance.
4. Verify UI/CLI, independent safety regressions and exact-head Ubuntu/Windows CI.

## Capability boundaries

| Capability | Existing native foundation | Acceptance required for coding workflow |
| --- | --- | --- |
| Agent loop | Durable bounded graph model/tool loop, goals/todos | Native coding-session integration |
| Sessions/resume | SQLite projects, conversations, runs, checkpoints, replay/fork | Restart and continued coding-turn checks |
| Tools | Workspace FS, bounded argv process runner, Git adapters | Explicit scoped tool wiring; mutations require human authority |
| Approvals | Durable graph human gates, host capability checks | Agent-loop per-tool consent must be tested separately |
| Sandbox | Application path confinement and command allowlist | No claim of OS or network isolation |
| Streaming/cancellation | Model stream consumer, progress events, dispatcher signals | Cancel active model and process; no further authorized writes |
| Context | Model-specific budgets, summaries, memory | Native workflow uses these controls |
| Instructions/skills | Bounded workspace AGENTS.md and `.agents/skills/*/SKILL.md` discovery | Text is context, never permission authority; no home scan |
| MCP | Native stdio client, tool adapters, server-specific capabilities | Configured trusted server only; remote cancellation is advisory |
| Subagents | Structured subgraphs | Autonomous isolated subagents remain incomplete until implemented/tested |
| Browser/computer | Trusted MCP/plugin tools can supply integrations | No built-in desktop driver or hosted browser entitlement |
| Git | Read and commit adapters | Commit/push disabled without a genuine human gate |
| UI/CLI | Local Next UI and guarded runtime client | Native coding workbench and CLI |

## Provider authorization is separate

No login, persistent credentials or paid inference is performed during implementation.
OpenAI API/local model adapters supply inference. Official Sign in with ChatGPT plan usage
now has public third-party integration documentation; registration, client identity,
consent, preview constraints and direct inference must be followed without borrowing a
Codex client identity. Claude subscription login requires Anthropic approval; no supported
Grok subscription OAuth has been established. Claude/xAI billed integration remains
inactive pending the user's explicit decision. Missing login support is not a reason to
retain a provider agent runtime.

Sources checked 2026-10-05: [OpenAI API authentication](https://developers.openai.com/api/reference/overview),
[Sign in with ChatGPT](https://developers.openai.com/siwc),
[Claude Agent SDK policy](https://code.claude.com/docs/en/agent-sdk/overview),
[xAI API](https://docs.x.ai/overview).

File effects preceding a crash may require manual reconciliation; durable tool results
are not a guarantee of exactly-once external execution. Hosted cloud tasks, proprietary
connectors and provider desktop products are not recreated by this harness.
