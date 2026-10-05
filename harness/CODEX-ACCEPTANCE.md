# Standalone acceptance

The earlier vendor-runtime checklist is retired with that architecture.
Current independent acceptance targets are documented in
[STANDALONE-ARCHITECTURE.md](STANDALONE-ARCHITECTURE.md).

Native filesystem/process effects and model calls are checked with temporary workspaces
and scripted inference. These are offline integration tests, not live provider checks.
No real login, provider credentials, paid inference or external deployment is performed.

Official sign-in and search-only integration have separate account/preview requirements;
see [provider documentation](standalone-provider-auth.md).

## Independent native acceptance evidence

These categories describe inspected code and completed checks, not full Codex parity.
The focused independent run passed **6 files / 19 tests**, and runtime typecheck passed.
Provider and consent fixtures use scripted responses; they do not prove account entitlement.

| Capability | Implementation status | Verification | Remaining acceptance boundary |
| --- | --- | --- | --- |
| Native coding loop | Implemented using the existing graph model/tool loop, persisted conversations and run records | Scripted inference integration in `runtime-coding-service.test.ts` | Live configured provider inference requires user credentials and consent; no vendor CLI required |
| Sessions, model selection, context | Native session list/read/resume/archive/restore and per-turn configured model; existing token/byte budgets and automatic summaries | Native service and existing context/summary fixtures | Resuming a session does not restore volatile mutation consent; no unlimited context claim |
| Workspace read/list | Implemented with fixed credential-path exclusions, hardlink/symlink refusal and bounded descriptor-relative reads | Adapter security fixtures and workspace executor fixtures | Linux only; ordinary source text may contain secrets despite filename exclusions; no OS filesystem sandbox claim |
| File changes | Partial: explicit turn opt-in plus exact per-call approval, atomic UTF-8 file replacement/create up to 64 KiB | Seven mutation fixtures, including refusal paths | Linux only, existing parent directories required; no general mkdir/delete/patch/Git commit/push tool; directory movement by a hostile concurrent actor remains outside the application confinement guarantee |
| Process execution | Partial: fixed `node --version` and Git status inside a separate bubblewrap namespace; no host fallback | Sandbox boundary construction/failure fixtures | Live isolation is blocked by this cloud environment; Windows fails closed; general test/build/command execution is not implemented |
| Tool consent | Implemented volatile host-only queue with generation, exact arguments, single settlement, cancellation and two-minute expiry | Independent `runtime-coding-approval-security.test.ts` verifies concurrent starts, stale/duplicate replies, cancellation, expiry and scope revocation | Restart denies outstanding consent; this is separate from the existing durable DAG approval primitive |
| Child agents | Implemented separate explicit context, inherited fixed read tools, no recursive delegate tool, four children/run, two inference steps, three reads and a 30-second deadline | Five child-agent fixtures including noncooperative inference cancellation/deadline | Bounded depth-one delegated analysis; no unlimited autonomous/concurrent agent-team claim; live child inference untested |
| Streaming and cancellation | Existing native progress events and abort signals; child waits reject locally on cancellation | Existing streaming fixtures and child tests | Cancellation does not reverse completed writes or guarantee a provider stops server-side work |
| Instructions and skills | Bounded root `AGENTS.md` and local `.agents/skills` discovery | Instruction fixtures | Root-level discovery only; at most 20 skills and a 100-entry scan; workspace content does not grant permissions; not full Codex instruction discovery/precedence parity |
| MCP | Standalone stdio tools adapter, explicit configured server trust/capabilities, bounded replies and cancellation notification | **29 MCP tests**, including real local stdio subprocess cancellation fixture; MCP typecheck/lint passed | Remote cancellation is advisory; no standalone client elicitation/auth/roots/sampling claim; MCP server processes remain a separate trusted configuration boundary |
| OpenAI OAuth | Optional supported direct registration flow using documented dynamic client registration, PKCE/state/nonce, official JWKS signature/issuer/audience/expiry/subject/scope validation and volatile tokens | Mocked OAuth/controller tests; independent source and official-document review | No actual login/consent or persistent credentials created; requires stable host configuration and applicable account/preview availability |
| OpenAI inference/search | Supported public Responses API boundary, authenticated with the documented OAuth token flow; search bridge permits web search only | Mocked transport/search tests; official endpoint and scope docs reviewed | Live inference/search and account model entitlement untested; search does not grant local coding tools; provider adapter integration continues separately |
| Claude and Grok | Supported provider API authentication/configuration remains separate from OpenAI OAuth | Provider configuration/transport fixtures | No fabricated Claude/Grok subscription OAuth; user must provide supported credentials where required |
| Proprietary services | Not accepted as implemented native capabilities | No supporting native execution evidence | Vendor cloud services and undocumented subscription flows are not implied by this harness |

## Authentication review references

The current official [registration documentation](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
explicitly supports open-source dynamic registration with the application's actual name,
a stable host identifier, a subsequently issued client ID, and user authorization.
The [inference documentation](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
specifies the public `https://api.openai.com/v1/responses` endpoint, OAuth bearer tokens,
`store:false` and `stream:true`. This supports the implemented flow; it does not establish
that any particular account is entitled or that a mocked login is a successful real login.
The [MCP cancellation specification](https://modelcontextprotocol.io/specification/2025-06-18/basic/utilities/cancellation)
allows receivers to ignore cancellation and requires clients not to cancel initialization.
The client exposes cancellation only for tool requests and ignores their late responses.

The independent security review found no credential serialization or raw token logging in
the reviewed optional auth module. Tokens, refresh state and authorization attempts remain
private and volatile; official token/JWKS requests refuse redirects and have bounded responses.
No cookies, official-client impersonation or vendor-private backend endpoint is used.

## Native browser and local desktop checks (2026-10-05)

Scoped browser policy/driver/session/service/HTTP fixtures passed 71 tests. Native browser tools require an armed task and per-turn opt-in; inputs require exact human consent. The real sandbox-required browser probe refused launch because the system Chromium SUID helper is misconfigured. The official Chromium CDN download returned HTTP 403. No sandbox bypass, browser profile, login or external page was used.

Desktop controller, Windows bridge and consent UI use offline fixtures and synthetic PNGs. The default runtime status was verified disabled through the real guarded local HTTP server. Whole-monitor capture, Windows input and model image transmission remain unverified; export explicitly reports `transmission: not-sent`.

Final local repository suite: 216 files passed, 1818 tests passed and two skipped on Linux (one existing platform skip and the Windows-only compilation smoke). Full typecheck, lint, format, build, plugin smoke, runtime/web startup and numeric performance guards passed. Exact commit CI is tracked separately.
