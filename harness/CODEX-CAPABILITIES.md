# Supported coding paths and acceptance checklist

Reviewed 2026-10-05 against the checked-in implementation and official provider material.
This document supersedes the older OpenRouter sign-in sections of PLAN.md, TODO.md and
PHASE-6.6-6.11.md. Zet does not claim full proprietary Codex product parity.

## Provider/authentication decision

- **Codex:** the pinned official `@openai/codex` CLI is launched directly, with inherited terminal I/O.
  The official [SDK source](https://github.com/openai/codex/tree/main/sdk/typescript) also wraps this
  CLI; the [app-server source](https://github.com/openai/codex/tree/main/codex-rs/app-server) exposes
  a richer protocol. The CLI bridge and the native `/codex` page use these official transports rather than implementing a token exchange.
  [Authentication](https://developers.openai.com/codex/auth) supports ChatGPT login and API keys.
  Login is an explicit user action with `--confirm-persist-login` or the page's persistent-login checkbox; the user must complete real browser consent.
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

Implementation milestones above are complete for the supported integration scope. Validation:
186 test files passed (1,599 tests passed, one existing skip); lint, typecheck, production build
and both startup smoke checks passed using Node 24.20.0/npm 12.0.2. Native protocol/approval
and provider transport tests use fixtures. A separate real installed Codex 0.160.0 app-server
check initialized and read an unauthenticated account in a temporary home. The production
browser connected to that official server, displayed its actual model catalog, and verified
read-only defaults and explicit login gating. The Models page also verified a missing xAI
environment credential before any provider request. No subscription login, paid inference or
live authenticated provider tool loop was performed; those require user consent/credentials.

| Capability | Zet runtime | Official Codex bridge |
| --- | --- | --- |
| Coding agent loop | Bounded model/tool graph, durable goals/todos; `runtime-agent-loop.test.ts` | Native Codex loop through `/codex`, interactive `chat` or JSONL `exec` |
| Filesystem/shell | Native tools package, symlink/path boundaries, executable allowlist; host/plugin wiring required | Native CLI tools, default read-only, explicit `--write` |
| Sandbox/approvals | Capability policy and durable human gates; process allowlist is **not** an OS sandbox | Official CLI OS sandbox where supported, interactive `on-request` approvals |
| Sessions/resume | SQLite journal, restart recovery, replay/fork, conversation branches | Native stored sessions, web start/resume/read, explicit UUID CLI resume |
| Streaming | Adapter SSE parser, streamed agent turns, transient count-only progress events, final durable message | Native web events/transcript, `exec --json`, interactive output |
| Cancellation | Dispatcher abort signals and model transport cancellation tests | Web turn interruption; SIGINT/SIGTERM/SIGHUP forwarded to CLI |
| Model/provider switching | Models UI and capability-aware router, direct API/environment keys | Web model catalog/selection and `--model`; provider config stays with CLI |
| Context handling | Token/byte budgets, required sections, conversation summary, project memory | CLI owns native compaction and context accounting |
| Instructions/skills | Explicit agent system instructions; no automatic AGENTS.md/SKILL.md discovery | Native CLI instruction/skill discovery according to installed version/config |
| MCP | Optional local/remote MCP package and trust/capability tests | CLI's configured MCP integrations; configure through official CLI |
| Subagents | Durable subgraphs; no claim these are autonomous Codex-style subagents | Native capabilities only when enabled/supported by the installed CLI/account |
| Browser/computer | Can use an approved MCP/plugin; no built-in desktop/browser driver | Configure a supported MCP/browser tool; no proprietary desktop or hosted service entitlement claimed |
| Git workflow | Native status/diff/apply/commit tools, patch preview and approval policies | Native Git/filesystem tools inside CLI sandbox; review changes before pushing |
| Errors/secrets | Safe transport errors, redaction, per-model credential accessor, no keys in API model views | Credentials stay with CLI; terminal output/session files may contain private project content |
| UI/CLI | Local Next.js Models/projects/graph/run inspector; existing client API | Native `/codex` page plus CLI help/status/login/chat/exec/resume |

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

## Native Codex page

Open `/codex`, or choose **Codex agent** from Overview/Models. The runtime lazily launches the
pinned official app-server on stdio only; it has no externally listening app-server port.
The local guarded API exposes a fixed method list and applies the chosen workspace, sandbox
and user approval policy to every turn. Defaults are read-only; workspace-write requires an
explicit selection. Native workspace network and additional writable roots are disabled.

The page supports explicit ChatGPT login consent/cancellation, account/model/session refresh,
start/resume/read, streamed native events, task interruption, command/file approvals,
user-input questions, constrained MCP form elicitation and explicit HTTPS URL-mode consent.
MCP URL acceptance acknowledges consent, not verified completion or authentication, as the
[official MCP specification](https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation) requires. Native events are polled every
1.5 seconds with a bounded history. Command/file approvals are once only; stale requests,
unknown response IDs and invalid answers are refused. External consent is always the user's
real action; the harness does not obtain or replay browser tokens.

Codex sessions remain **separate from Zet graph runs**: the `/codex` page reads the official
session history, while the graph inspector reads Zet's SQLite journal. It does not mirror
Codex session data into SQLite. Native tool output/events may contain private project content;
Zet does not claim to redact arbitrary secret text produced by the native agent/MCP/hooks.
User-input answers are not journaled by the Zet client; native Codex owns its own session data.

Unsupported official server requests fail closed, including permission-profile grants, dynamic
client tools, external auth-token refresh, attestation and legacy approvals. MCP schemas beyond
the supported primitive/form constraints may require the official CLI. No hosted Codex Cloud,
proprietary connector, desktop control or account entitlement is fabricated. Configured MCP
servers and hooks retain their native trust/authority; process sandbox rules cannot constrain
side effects performed by a remote tool service.

## Provider validation boundary

No new credentials or OAuth grants were created during development. Live inference requires
user-approved credentials, provider billing/access and a writable official credential/session
store. Transport fixtures prove request/response, tool and streaming behavior but cannot prove
account entitlement, actual model availability or production provider compatibility. Do not
label a fixture result as a live provider result.

Current model examples are checked against the [Claude catalog](https://platform.claude.com/docs/en/models/overview)
and [xAI documentation](https://docs.x.ai/overview); provider access is account-dependent and
the API-key page accepts exact model IDs rather than pretending a placeholder proves availability.
