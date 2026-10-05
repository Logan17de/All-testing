# Supported coding paths and acceptance checklist

Reviewed 2026-10-05 against the checked-in implementation and official provider material.
This document supersedes the older OpenRouter sign-in sections of PLAN.md, TODO.md and
PHASE-6.6-6.11.md. Zet does not claim full proprietary Codex product parity.

## Provider/authentication decision

- **Codex:** the pinned official `@openai/codex` CLI is launched directly, with inherited terminal I/O.
  The official [SDK source](https://github.com/openai/codex/tree/main/sdk/typescript) also wraps this
  CLI; the [app-server source](https://github.com/openai/codex/tree/main/codex-rs/app-server) exposes
  a richer protocol. This milestone uses the CLI rather than implementing its token exchange.
  [Authentication](https://developers.openai.com/codex/auth) supports ChatGPT login and API keys.
  Login is an explicit user action with `--confirm-persist-login`; the user must complete consent.
  Zet never imports browser tokens or Codex credential files. The CLI owns credential persistence.
- **Claude:** direct Anthropic API credentials, using its documented
  [OpenAI compatibility API](https://platform.claude.com/docs/en/api/openai-sdk).
  The [Agent SDK policy](https://code.claude.com/docs/en/agent-sdk/overview) prohibits third-party
  claude.ai login/rate-limit access unless previously approved. No subscription OAuth is offered.
  Native Claude Agent SDK tools/computer use are not advertised by this compatibility adapter.
- **Grok:** direct xAI API credentials and documented OpenAI-compatible Chat Completions.
  [xAI docs](https://docs.x.ai/overview) document API keys and currently recommend Responses for
  new integrations. No supported third-party Grok subscription OAuth was found in the reviewed
  material. This is a documented API-key option, not a substitute subscription login.
- **OpenRouter:** removed from the Models picker, callback pages and token exchange. Legacy
  routes return 410; new OpenRouter profiles/shared connections are rejected. Existing database
  rows and keys are retained unchanged but never registered. Historical migration schemas and
  database readers remain to preserve upgrades. Delete obsolete models/keys explicitly if wanted.

## Milestones

1. Retire active OpenRouter sign-in and adapter registration without deleting saved work.
2. Add the official Codex CLI bridge; preserve native approvals, sandbox, session ownership and
   streaming; require explicit persistent-login consent. Validate direct Claude/Grok API profiles.
3. Run all repository checks, actual local UI and official CLI checks; commit/push checkpoints.
   Separate transport fixtures from live inference and publish precise integration limitations.

## Concrete capability evidence

| Capability | Zet runtime | Official Codex bridge |
| --- | --- | --- |
| Coding agent loop | Bounded model/tool graph, durable goals/todos; `runtime-agent-loop.test.ts` | Native Codex loop in interactive `chat` or JSONL `exec` |
| Filesystem/shell | Native tools package, symlink/path boundaries, executable allowlist; host/plugin wiring required | Native CLI tools, default read-only, explicit `--write` |
| Sandbox/approvals | Capability policy and durable human gates; process allowlist is **not** an OS sandbox | Official CLI OS sandbox where supported, interactive `on-request` approvals |
| Sessions/resume | SQLite journal, restart recovery, replay/fork, conversation branches | Native stored sessions; explicit UUID `resume`, no ambiguous `--last` |
| Streaming | Adapter SSE parser, transient stream sink, runtime event SSE; agent-model steps currently buffer replies | Native `exec --json` structured JSONL events, interactive output |
| Cancellation | Dispatcher abort signals and model transport cancellation tests | SIGINT/SIGTERM forwarded to CLI, child exit status preserved |
| Model/provider switching | Models UI and capability-aware router, direct API/environment keys | `--model`; additional native provider configuration stays with CLI |
| Context handling | Token/byte budgets, required sections, conversation summary, project memory | CLI owns native compaction and context accounting |
| Instructions/skills | Explicit agent system instructions; no automatic AGENTS.md/SKILL.md discovery | Native CLI instruction/skill discovery according to installed version/config |
| MCP | Optional local/remote MCP package and trust/capability tests | CLI's configured MCP integrations; configure through official CLI |
| Subagents | Durable subgraphs; no claim these are autonomous Codex-style subagents | Native capabilities only when enabled/supported by the installed CLI/account |
| Browser/computer | Can use an approved MCP/plugin; no built-in desktop/browser driver | Configure a supported MCP/browser tool; no proprietary desktop or hosted service entitlement claimed |
| Git workflow | Native status/diff/apply/commit tools, patch preview and approval policies | Native Git/filesystem tools inside CLI sandbox; review changes before pushing |
| Errors/secrets | Safe transport errors, redaction, per-model credential accessor, no keys in API model views | Credentials stay with CLI; terminal output/session files may contain private project content |
| UI/CLI | Local Next.js Models/projects/graph/run inspector; existing client API | `npm run codex -- help`, `status`, `login`, `chat`, `exec`, `resume` |

## Running Codex

From `harness/`, after `npm ci`:

```sh
npm run codex -- status
# Only the user runs this after consenting to persistent login:
npm run codex -- login --confirm-persist-login --device
npm run codex -- chat --workspace /absolute/repo --write
npm run codex -- exec --workspace /absolute/repo --prompt 'Review the current diff'
npm run codex -- resume --workspace /absolute/repo --session THREAD_UUID --write
```

The bridge accepts a small fixed option set and no sandbox-bypass/config-overwrite flags.
`chat` and `resume` preserve interactive approvals. `exec` runs noninteractively and cannot
satisfy an interactive escalation; switch to `chat` if approval is needed. Workspace network
access is disabled. Native CLI config, MCP connections and skills remain the user's trust
boundary; the bridge does not turn untrusted third-party servers/plugins into safe tools.

Codex runs are currently **separate from Zet graph runs**: their history is not mirrored into
SQLite and the web inspector does not render native Codex turns or approval requests. Integrating
app-server threads, typed approval requests, streaming and cancellation into that inspector is
remaining work. CLI-native features are available through the bridge, not reimplemented in Zet.

## Provider validation boundary

No new credentials or OAuth grants were created during development. Live inference requires
user-approved credentials, provider billing/access and a writable official credential/session
store. Transport fixtures prove request/response, tool and streaming behavior but cannot prove
account entitlement, actual model availability or production provider compatibility. Do not
label a fixture result as a live provider result.
