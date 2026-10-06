# Standalone harness architecture and acceptance

The harness owns execution. Model providers return inference results through model adapters;
no provider CLI, app-server or proprietary agent loop owns native execution.
An optional Codex research bridge uses the supported public Responses route with
web search as its sole hosted tool; it must not receive native tool permissions or execute rejected calls.
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

The current feature-by-feature checklist, implementation paths, offline test evidence and
public Codex references are in [CAPABILITY-MATRIX.md](CAPABILITY-MATRIX.md).

| Capability | Current native behavior | Remaining boundary |
| --- | --- | --- |
| Agent loop | Bounded graph model/tool loop, durable coding sessions, goals/todos | Live provider inference awaits user authorization |
| Sessions/resume | Conversation and run persistence; list/read/resume/archive/restore | Volatile consent is not restored; external effects are not exactly-once |
| Files | Linux bounded read/list; approved atomic UTF-8 create/replace, exact-text patch and single mkdir | No general delete/rename/recursive mkdir; source contents may contain secrets |
| Commands/sandbox | Fixed diagnostics and approved project test/build/typecheck/lint scripts in isolated snapshot with required Linux bubblewrap; no fallback | Live synthetic Linux namespace/project/worktree acceptance passes; default restricted execution refuses namespace creation; Windows AppContainer/JobObject fixed diagnostics implemented with mandatory kernel CI pending; unsupported commands fail closed; no unrestricted shell or workspace artifact writeback |
| Approvals | Exact per-call volatile consent with generation, expiry/cancellation; durable DAG gates separately | Restart denies pending tool consent; no provider auto-review service |
| Streams/cancellation | Native progress streams and abort signals, bounded child/provider waits | No undo of completed effects or guaranteed remote cancellation |
| Context | Token/byte budgets, summaries, memory, full supported Responses history | Encrypted Responses reasoning is retained in order and account/model bound; incompatible state requires explicit selection to reset, state-loss compaction fails closed; local output gate cannot cap provider spending |
| Instructions/skills | Bounded root-to-explicit-directory AGENTS.md chain and local skill catalog/selected bodies | Depth/context/scan limits; no home scan/inferred target or full ecosystem parity; text grants no execution authority |
| Installed plugins/graph scopes | Granted active registered tools are available by default; separate durable model-node and tool-execution tool restrictions, canonical owner/version rechecks and inherited child read scope | Scope only reduces host grants; exact-action consent still required; external implementation code remains a trusted boundary |
| MCP | Configured trusted stdio tools, bounded replies, cancellation notification | Advisory remote cancellation; no full auth/roots/sampling/elicitation claim |
| Subagents | Depth-one read-only children; four/run, two calls, three reads, 30 seconds | Scripted inference verification; no recursive teams or child mutations |
| Browser | Scoped ephemeral Playwright browser controller, domain/DNS policy, task and input consent, guarded HTTP/manual CLI | Offline driver fixtures; no persistent profiles, OS egress firewall or hosted-browser entitlement |
| Desktop | Optional Windows driver, selected monitor/window, bounded task/input consent and exact-destination screenshot transmission leases | Volatile images enter main ChatGPT steps only after separate human consent; synthetic fixtures pass, actual Windows capture/transmission pending |
| Git | Scoped status/diff/log; approved exact-path add and explicit-message/author commit in required sandbox | No push/network/PR/worktree/deletion staging; mocked sandbox runner verifies real temporary repo effects |
| UI/CLI | Native `/agent`, `npm run agent`, optional auth/approval UX; `npm run browser` manual host controller | CLI/browser consent does not prove autonomous model/browser or live OS integration |

## Provider authorization is separate

No login, persistent credentials or paid inference is performed during implementation.
OpenAI API/local model adapters supply inference. Official Sign in with ChatGPT plan usage
now has public third-party integration documentation; registration, client identity,
consent, preview constraints and direct inference must be followed without borrowing a
Codex client identity. Official Claude Agent SDK/CLI subscription paths and Grok Build CLI OIDC/ACP paths
exist. They do not establish permission to extract their credentials or reuse their client
identities for this independent native harness. Claude own-app token routing is constrained
by its credential policy; generic xAI third-party subscription registration/direct inference
has not been established. API-key integration remains separate and requires the user's
explicit credential/billing choice. Missing login support is not a reason to
retain a provider agent runtime.

Sources checked 2026-10-05: [OpenAI API authentication](https://developers.openai.com/api/reference/overview),
[Sign in with ChatGPT](https://developers.openai.com/siwc),
[Claude plan SDK](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan),
[Claude credential policy](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use),
[Grok Build authentication](https://docs.x.ai/build/enterprise#authentication),
[Grok ACP](https://docs.x.ai/build/cli/headless-scripting#acp).

File effects preceding a crash may require manual reconciliation; durable tool results
are not a guarantee of exactly-once external execution. Hosted cloud tasks, proprietary
connectors and provider desktop products are not recreated by this harness.

### Extended native boundaries checkpoint

MCP quarantines incompatible descriptors individually and exposes bounded diagnostics. Supported local schema references, tuples, conditions, dependencies and a conservative linear pattern subset have real stdio fixtures; recursive/external references and arbitrary regex remain refused.

Windows filesystem operations use fixed native interop and held ancestry/file handles. Its process bridge creates a temporary zero-network AppContainer, assigns a non-breakaway kill-on-close JobObject before resuming execution, and copies only bounded source and trusted runner files. Current supported commands are node version and configured trusted Git status; project script expansion remains separate. Real Windows tests run in CI against temporary test files and kernel probes, never desktop input or provider credentials.

Managed worktrees use detached exact commit IDs, a host-private journal outside the project, narrow container/Git metadata write mounts, fixed Git argv and exact approval. Repository and ownership changes fail closed. A creating journal record after uncertainty requires manual recovery; unrelated/preexisting worktrees are refused.
