# Phase 5.10–5.16 — Durable approvals and protected local API

## Scope

This batch implements the approval, suspension, resume, denial, redaction, and browser-protection
boundaries together. The supported human gate is a linear, iteration-zero interrupt in a plain DAG.
A host must drain active attempts before requesting suspension. A persisted wait does not keep a
Promise, timer, or worker alive and can survive daemon shutdown.

The approval service completes the human gate and releases its durable downstream frontier; it
does not execute a downstream effect, grant a capability, or automatically launch a scheduler.
Automatic daemon dispatch into the gate and wake-up of the existing scheduler remain the explicit
Phase 5.17 integration follow-up in `TODO.md`. Do not present this batch as the complete visual
editor-to-tool execution product checkpoint.

## Implemented boundaries

- **5.10:** migration 6 adds immutable, first-class approval audit records with composite foreign
  keys to the run, compiled plan, logical invocation, and checkpoint. Migrations 1–5 are unchanged.
- **5.11:** `createHumanApprovalPlugin()` registers `harness.human-approval` through the same public
  host path as an external plugin. Its `interrupt` primitive lowers normally without changing the
  IR schema or hash domain. Direct plugin execution fails closed; the host owns human decisions.
- **5.12:** `RuntimeHumanApprovals.suspend()` and `RuntimeDaemon.suspendForApproval()` atomically
  persist an approval, invocation identity, audit events, checkpoint, and waiting run state.
- **5.13:** resume commits a decision, output, successful gate attempt, updated frontier, and run
  state together. Identical decisions/payloads are idempotent; conflicting repeats fail closed.
- **5.14:** scheduler and approval/API failures expose stable codes and remediation metadata.
  Invocation permission denials remain terminal before executor calls or attempt accounting.
- **5.15:** a host-owned redaction registry masks configured fields and known secret values.
  Secret resolution can register material before exposing it to node code. Approval persistence
  rejects protected material instead of silently changing execution data; daemon stream payloads
  are redacted before entering the replay buffer. Provider/observer exceptions cannot impersonate
  a safe error merely by using the exported error class.
- **5.16:** the API enforces loopback binding, exact Host and Origin checks, explicit UI-origin
  allowlisting, Fetch Metadata checks, session CSRF tokens, JSON-only mutations, bounded request
  bodies, and no-store token responses. Forwarded-host headers do not confer trust.

## Token and decision contract

Resume tokens use 32 random bytes encoded as base64url. SQLite stores only a domain-separated
SHA-256 token hash. Tokens never belong in URLs, event payloads, checkpoints, or ordinary approval
list/detail records. The initial suspension response delivers the token once; duplicate suspension
returns the original record with `resumeToken: null`.

The protected token endpoint can rotate a lost token without recreating the gate. Only the current
token is accepted. A successful decision records a canonical payload hash, so retrying the same
request after a lost HTTP response returns `duplicate: true`, even if the run subsequently advances.
Changing the decision or payload cannot reuse that resolved record. Rejected approvals cancel
unfinished work and sibling pending approvals without pretending their nodes executed.

Optional expiry is enforced before decision or token rotation. Expired requests remain visible for
inspection but cannot release work; there is no automatic expiry/renewal worker in this batch.
Approval requests and payloads are bounded JSON data. Limits also apply to redaction traversal.

## HTTP surface

```text
GET  /api/session
GET  /api/approvals?runId=<optional-run>
GET  /api/approvals/:approvalId
POST /api/approvals/:approvalId/token
POST /api/approvals/:approvalId/resume
```

`GET /api/session` returns the current process's `csrfToken`. Both mutation endpoints require
`Content-Type: application/json` and `x-zet-csrf: <csrfToken>`. The token endpoint accepts `{}`.
The resume endpoint accepts only:

```json
{
  "resumeToken": "<current approval token>",
  "decision": "approved",
  "payload": { "comment": "Reviewed" }
}
```

`decision` is `approved` or `rejected`. Payload is optional JSON data, not an authority object.
Approval IDs belong in the URL path only after URL encoding. Unknown fields, malformed JSON,
unsupported methods, missing/invalid tokens, and request bodies above 64 KiB are rejected.
The pending list is limited to 100 records per call and accepts an optional run filter.

A browser UI at a different local origin must be explicitly configured on the trusted host:

```ts
const daemon = new RuntimeDaemon({
  api: {
    host: "127.0.0.1",
    port: 3211,
    allowedOrigins: ["http://localhost:3000"],
  },
});
```

Allowlist entries are exact loopback HTTP(S) origins; wildcard or public-site origins are refused.
The allowlist is not a grant for filesystem, shell, model, or other executor capabilities.

## Host-owned redaction wiring

Share one registry between the daemon and secret resolution. The synchronous host observer is not
visible on the node-facing accessor:

```ts
const redaction = new RuntimeRedactionRegistry();
const daemon = new RuntimeDaemon({ redaction });
const secrets = createNodeSecretAccessor(bindings, provider, (value) => {
  redaction.registerSecret(value.revealText());
});
```

Registrations return idempotent disposers and duplicate registrations are reference-counted.
Keep secrets registered for the lifetime of any request/log buffer that could still contain them.
Persistence boundaries must use `assertSafe` before committing protected execution data. Direct
low-level database APIs remain host-owned; this registry is not automatic whole-process taint
tracking and does not recognize every possible encoding of a secret. Future model/tool adapters
must use these same sinks rather than arbitrary console or raw database writes.

## Preserved authority and compiler boundaries

The compiler still validates graph shape and semantics. Runtime recovery consumes persisted IR;
the new service is not a second graph compiler. The scheduler's existing invocation ordering,
retry accounting, cancellation, timeouts, and durable completion barrier are unchanged.

Permission evaluation uses the host-selected function and receiver captured at construction, with
fresh decisions on every invocation/resume. Revocation is observed without allowing a model,
plugin, retained options object, approval payload, or replaced method to select a new grant source.
Rejecting an approval remains possible after privilege revocation because rejection reduces work.
A downstream privileged effect still requires its own current permission check.

## Trust limits and remaining integration

These endpoints protect against unwanted browser-origin requests, not arbitrary local processes.
There is no authenticated human identity assertion here. Trusted local programs can call the API;
do not grant untrusted model/plugin code unrestricted access to the session/approval endpoints or
host authority objects. Native tool brokering and process/WASI isolation remain separate work.
In-process plugins are not an operating-system sandbox.

Structured router/join outcomes, loop iterations, subgraph interrupts, generic run submission,
automatic scheduler wake-up, approval UI cards, and cloud/local model adapters are not introduced by
this change. Phase 5.17 must connect the host dispatch lifecycle before the full Phase 5 checkpoint
is closed; Phase 6 adds adapters and Phase 7 adds the visual UI.

## Verification

The added tests cover atomic suspension, duplicate creation, caller mutation before queued writes,
file-backed close/reopen, concurrent identical resumes, conflicting decisions, token rotation,
expiry, current-host revocation, sibling cancellation, SQL fault-injection rollback, active-run
refusal, immutable audit records, secret rejection, forged provider errors, exact browser guards,
CSRF, JSON/body limits, compiler/plugin integration, and safe structured invocation denials.

The Host test uses native HTTP so it actually sends the forged header; Fetch normalizes Host to
its URL and cannot verify that wire-level case. No enforcement test was removed or relaxed.

The existing Linux and Windows CI gates remain authoritative: install, typecheck, lint, formatting,
tests, plugin smoke, startup smoke, build, and lightweight baseline. A format-failure diagnostic
prints a runner-local diff but does not change the branch or turn a failed format gate green.
