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
