# Phase 6.6–6.11 — Endpoint profiles, model routing, streaming and usage

## Delivered scope

`@zet-harness/models` gains endpoint profiles. `@zet-harness/core` gains deterministic
capability-based model routing, a transient stream sink, and exact usage accumulation.

This covers TODO 6.6, 6.7, 6.8, 6.10 and 6.11, and the decision-producing half of 6.9. **6.12
remains open on purpose** — see below. Graph JSON, Execution IR, compiler identity, the scheduler
and database migrations are unchanged.

## Endpoint profiles (6.6, 6.7, 6.12 configuration)

A profile is a configuration shape, not a new transport. The OpenAI-compatible adapter already
speaks Chat Completions to any conforming endpoint, so a profile only records the places where one
server's behavior actually differs. That is the entire provider-specific surface this harness
carries, which is what 6.6 asks for.

In practice there is exactly one real difference today:

| Profile | Base URL | Token limit field |
|---|---|---|
| `openAIEndpointProfile` | `https://api.openai.com/v1` | `max_completion_tokens` |
| `ollamaEndpointProfile` | `http://127.0.0.1:11434/v1` | `max_tokens` |
| `llamaCppEndpointProfile` | `http://127.0.0.1:8080/v1` | `max_tokens` |

Current OpenAI models expect `max_completion_tokens` while the wider OpenAI-compatible ecosystem
still expects `max_tokens`. Encoding that one difference is cheaper and more honest than a
provider abstraction layer. Base URL and credential port both pass through, which is 6.7.

## Capability-based routing (6.9)

`routeModel` selects a model from declared manifest features and records why.

Selection is **deterministic**: eligible candidates are ordered by host preference and then
lexicographically, never by registration order, so a replayed trace can reach the same model. A
test asserts that reversing the catalog does not change the result.

Two decisions worth naming:

- An **undeclared context window is not treated as unlimited**. Guessing would route work to a
  model that silently truncates it, so the candidate is rejected with `unknown-context-window`.
- An **explicit pin never falls back**. If the pinned model is absent or fails a requirement, the
  outcome is `no-eligible-model`, not a quiet substitution.

A capability policy may be supplied, in which case a model whose demanded capabilities are not
granted is not eligible — routing can never select something the broker would then refuse. This
function chooses; it does not authorize.

The decision record is JSON-safe and self-contained, listing every candidate and every rejection
reason, so a trace read later explains the choice without the catalog that existed at the time.

**What is not done:** `MODEL_ROUTING_DECISION_EVENT_TYPE` is defined and the record is produced,
but nothing writes it into the durable journal yet. That waits on the model-node executor, which is
the same wiring the rest of Phase 6 waits on.

## Streaming without a token log (6.10)

The adapter contract already says the completed result, not every delta, is the durable output.
`consumeModelStream` enforces it: deltas are forwarded to a transient observer and then dropped,
and what survives is the final result plus **counts only** — delta count, character count, tool-call
count. A test asserts the statistics object contains no fragment of the streamed text.

A stream that never completes is an error rather than a silently partial result, and a second
completed event is refused. An observer callback that throws is contained, because a host display
callback must not be able to fail an execution or strand the transport mid-stream.

## Usage and cost (6.11)

`accumulateUsage` totals provider reports with two rules that matter:

- **Missing stays missing.** A provider that does not report cached tokens has not reported zero,
  so totals carry a `costIncomplete` flag and a `reportCount` rather than pretending.
- **Money is summed as decimal strings**, via scaled `BigInt`, never as binary floats. A test sums
  ten reports of `0.01` and asserts `0.10`; the naive float sum of `0.1 + 0.2` is
  `0.30000000000000004`.

Mixing currencies throws rather than converting. This code has no exchange rate and must not
invent one, exactly as it must not invent a price for a local model that reports none.

## Why 6.12 is still unchecked

6.12 says *prove* llama.cpp/Ollama through local OpenAI-compatible configuration. The
configuration exists and is tested against a real loopback HTTP server that implements the Chat
Completions response contract — model pinning, the correct token-limit field, usage parsing, and
no invented cost.

That fixture is a protocol conformance test, not an installed Ollama or llama.cpp build and not a
language model. Marking 6.12 complete would claim something a mock cannot establish, so it stays
open until someone runs it against a real local model. This follows the caveat `PHASE-6.5.md`
already set.

## Since then — connecting a model from the app

Until now the harness could speak to any OpenAI-compatible endpoint but a person had no way to tell
it which one: nothing registered a model unless a plugin did, and nothing handed a model its key.
Both now exist.

- **Configured models.** Migration 20 adds `model_configs`: an id, a profile (`openai`, `ollama`,
  `llama-cpp` or `custom`), the endpoint, the model name the endpoint knows, whether it can call
  tools, its context window, and where its key comes from — nowhere, a key stored in this database,
  or a named environment variable. The runtime registers each one as an OpenAI-compatible adapter
  at start, and re-registers or removes it the moment it changes, so no restart is needed.
- **Keys on the designed path.** The adapter already asked for its key by credential port at the
  moment it built a request; nothing supplied one. A configured model's step now gets a node-scoped
  secret accessor bound to that single port, resolved from the database or the environment, and
  every value it resolves is registered with the redactor before the adapter sees it. A key is
  never part of a graph, a run record, an event or an API answer, and is never sent in the clear to
  another machine: plain http is allowed only for a loopback endpoint when a key is involved.
- **Authority.** A plugin's model is still offered only when the plugin was granted the network
  capability it needs. A model a person configured is offered on its own: typing that endpoint and
  that key is the grant.
- **Checking.** `POST /api/models/:id/check` sends a one-token request through the same credential
  path a run uses and answers with the transport's own code and, for an HTTP refusal, the status —
  so a wrong key or model name is found on the Models page rather than in the middle of a run.
- **The page.** `/models` lists configured models, adds one from a preset for each profile, edits
  one without re-entering its key, checks, and removes.

Covered by `durable-model-records.test.ts`, `runtime-model-http.test.ts` — including an agent step
that runs against a loopback endpoint through the daemon, sends the stored key, writes the reply
into the conversation and leaves the key out of the run — and `model-form.test.ts` and
`model-routes.test.ts` on the web side. Checked in the browser: a wrong key reported as refused
(HTTP 401), the corrected key answering, a rename keeping the stored key, an unreachable local
server reported as such, and a model removed.

6.12 is still unchecked for the reason above: every endpoint in those checks was a fixture. The
difference now is that proving it takes a person with Ollama or llama.cpp one form and one **Check**.

### Signing in instead of pasting a key

Profiles now also cover Anthropic, Google Gemini, xAI and OpenRouter, each at its
OpenAI-compatible address, and a model's key can come from a sign-in.

- **Why OpenRouter.** OpenAI, Anthropic, Google and xAI keep their account sign-ins (Codex, Claude
  Code, Gemini CLI, Grok) for their own apps, so a third-party harness cannot use them. OpenRouter
  publishes an OAuth PKCE flow for apps, and one sign-in reaches all of those models.
- **Migration 22** adds `provider_connections` (one row per provider, holding the issued key) and
  rebuilds `model_configs` with the new profiles, a `connection` credential and a `connection`
  column, keeping every existing row and the identity trigger. A model whose credential is
  `connection` reads the key from that row at request time, so signing in again takes effect
  without re-registering anything, and signing out leaves the model configured but keyless.
- **The flow.** `POST /api/connections/openrouter/start` accepts only a loopback callback, keeps a
  random verifier in memory for ten minutes and answers with OpenRouter's authorize URL (S256
  challenge, `key_label=Zet Harness`). `POST .../complete` spends that verifier on the first
  attempt, exchanges the code at `/api/v1/auth/keys`, registers the key with the redactor and
  stores it. `POST .../sign-out` deletes it. `GET /api/connections` reports whether a sign-in
  exists, how many models use it and the one address those models may call — never the key.
  `GET .../models` lists OpenRouter's models that support tools, cached for ten minutes.
- **The key stays with its provider.** Saving a model that uses the OpenRouter sign-in is refused
  unless its endpoint has OpenRouter's origin. `OPENROUTER_URL` moves that origin for tests.
- **The page.** `/models` offers **API key** or **Sign in (OAuth)**. Signing in goes to OpenRouter
  and back to `/models/openrouter`, which hands the code over once, removes it from the address
  bar and returns to the model picker (search plus maker filters). Cards say whether a
  sign-in model currently has its key.

Covered by `durable-model-records.test.ts` (reading a key through a sign-in, losing it on sign-out,
upgrading a version-20 database), `runtime-connection-http.test.ts` against a stand-in OpenRouter
that checks the PKCE proof (a key only for the right verifier, a model check sending it, refusals
for foreign callbacks, unstarted and reused codes, and a model pointed elsewhere), and
`sign-in.test.ts`, `model-form.test.ts` and `workspace-routes.test.ts` on the web side. Checked in
the browser against the same kind of stand-in, not the real openrouter.ai: signing in and coming
back, picking a model by maker, save and check, a chat reply answered through that model with the
key absent from the run, editing, signing out (the card then says it needs the sign-in and the
check says no key is available), signing in again, a cancelled sign-in and a forged code.

## Verification

Run from `harness/`:

```sh
npm run typecheck
npm run lint
npm run format:check
npm test
```

945 tests pass, up from 877. New coverage is 27 routing tests, 27 stream and usage tests, 9 profile
configuration tests, and 5 loopback conformance tests.

The loopback conformance test lives in `scripts/`, not in `@zet-harness/models`. That package is
deliberately free of Node type dependencies so the transport stays portable, and adding them for a
test fixture would have quietly weakened that boundary.

## Not included

- Writing the routing decision into the durable journal (needs the model-node executor)
- Automatic adapter-node brokering and secret-binding injection, still open from 6.5
- Native Responses-API conversation/reasoning state and provider built-in tools
- Any qualification against a paid cloud endpoint or an installed local model
