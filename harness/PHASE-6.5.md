# Phase 6.5 — Bounded OpenAI-compatible model transport

## Delivered scope

`@zet-harness/models` now exports `createOpenAICompatibleModelAdapter` and
`createOpenAICompatiblePlugin`. They implement the existing provider-neutral `ModelAdapter`
contract over Chat Completions HTTP, without importing a provider SDK or changing Graph JSON,
Execution IR, compiler identity, the scheduler, or database migrations.

The plugin uses the ordinary `PluginContext.models.register` path. Registration and manifest
inspection do not make network requests. The host catalog retains exact version identity and
plugin provenance and removes the registration when the plugin unloads.

This is the transport checkpoint, not a claim that the complete Phase 6 runtime is connected.
The adapter supports the transport portions of 6.7, 6.8, 6.10, and 6.11. Automatic adapter-node
brokering, secret-binding injection, routing traces, durable usage integration, native Responses,
and actual cloud/Ollama/llama.cpp model qualification remain explicit follow-up work.

## Host configuration

Configure one endpoint and one model per adapter. Do not create this configuration by copying
model-generated options, graph input, a tool response, or an untrusted URL.

```ts
import { PluginHost } from "@zet-harness/core";
import { createOpenAICompatiblePlugin } from "@zet-harness/models";

const host = new PluginHost();
await host.activate(
  createOpenAICompatiblePlugin({
    id: "local-chat",
    model: "your-configured-model",
    baseUrl: "http://127.0.0.1:8080/v1",
    tokenLimitField: "max_tokens",
    includeStreamUsage: true,
    features: {
      streaming: true,
      tools: false,
      vision: false,
      structuredOutput: false,
    },
  }),
);
```

The example is a configuration shape, not a claim that a server or model is installed. Supply
features verified for the selected endpoint/model. Streaming defaults to true; tools, vision,
and schema output default to false. A positive `contextWindowTokens` may be declared but is
metadata, not a tokenizer or context-budget enforcement mechanism.

The transport appends `/chat/completions` to the supplied API base. HTTPS is supported for
host-approved endpoints; plain HTTP is restricted to exact loopback hostnames `localhost`,
`127.0.0.1`, and `[::1]`. Userinfo, query strings, fragments, and backslash-containing URLs are
rejected. Redirects are rejected and browser cookies are omitted. The host must separately
control which destinations are trusted; the protocol capability is not a hostname allowlist
or a defense against hostile in-process code.

Endpoint, model, fetch implementation, credential port, feature declarations, limits, and image
resolver are captured at construction. A request may omit `model` or repeat the pinned model;
it cannot select a different model behind the same declared features.

## Credentials and permission ownership

Set `credentialPort` only when authentication is needed. The adapter resolves that port from
`AdapterInvocationContext.secrets` using the existing node-scoped secret accessor. It does not
read environment variables, enumerate secret references, accept credentials in request options,
or fall back to another credential source. The resolved text is used only for the Authorization
header. Missing access, invalid material, and provider failures become safe transport errors.

The host should construct the accessor from compiled secret-reference bindings and register
resolved material with the shared redaction registry before handing it to node code. This patch
does not automatically inject secret bindings into the daemon's executor.

The plugin declares `network:http` or `network:https` as demand. It does not grant that capability.
The host must authorize the invocation before entering the adapter. The integration tests use
`PlainDagRun` to prove denial before transport entry and scheduler-owned retry accounting.
Calling the adapter directly from privileged host code is not a second permission broker.

## Request and response mapping

Supported message roles are system, developer, user, assistant, and tool. Text, assistant function
calls, and tool results map to their corresponding Chat Completions fields. Multiple tool results
become separate tool messages. Returned calls are data only; the adapter never executes a tool.

Tool support is opt-in. Requests may offer at most 128 uniquely named function tools with object
JSON Schemas. Responses must name an offered tool, carry unique call IDs, and contain finite JSON
object arguments. Tool arguments are not validated against their schemas here: that belongs to
the tool invocation boundary. Unsupported tool kinds are not silently converted.

Schema output is opt-in and sends `response_format.type = "json_schema"` with `strict: true`.
Only object schema documents are accepted. The endpoint must support the requested schema subset;
the adapter does not prove arbitrary schema implication or claim to validate returned output
against that schema. Consumers must validate execution data before acting on it.

Vision is opt-in and requires a trusted `resolveImage(image, signal)` callback. It receives the
opaque artifact reference and returns bytes. The adapter sends an inline data URI, never an
arbitrary image URL or the artifact reference itself. Supported declared media types are PNG,
JPEG, WebP, and GIF. File access, image decoding, content validation, and artifact authorization
remain the host resolver's responsibility.

`maxOutputTokens` maps to `max_completion_tokens` by default. A trusted host may select the legacy
`max_tokens` field for an endpoint that requires it. Request `options.openai` supports only the
bounded generation fields implemented in the transport: temperature, top_p, presence/frequency
penalties, seed, reasoning_effort, and stop. Other namespaces and override keys are rejected.
Accepting an option does not guarantee the configured provider/model implements it.

Each request pins `n: 1` and `store: false`. The latter is a provider storage opt-out parameter,
not a zero-retention guarantee or a substitute for the provider's data-handling policy.

## Resource and streaming contract

Defaults are a 120-second total invocation timeout, 8 MiB serialized request, 8 MiB response,
4 MiB per image, and at most 1 MiB per SSE event. Cumulative base64 image data also counts against
the request budget. Host overrides are positive safe integers within the native timer range.
JSON traversal rejects cycles, accessors, non-plain objects, sparse arrays, non-finite numbers,
depth above 64, and more than 100,000 visited values. Request data is copied before asynchronous
image or credential resolution, so retained caller mutations cannot change the pending body.

The SSE reader handles fragmented UTF-8, LF/CRLF boundaries, comments, and multiline data. It
emits transient text deltas and provider-reported usage. Interleaved tool arguments are assembled
by call index. A normal finish reason and `[DONE]` are both required before completed tool-call
events and the final result can be published. Truncation, malformed JSON, invalid indexes, or
inconsistent finish/tool-call state fail closed. A length/content-filter response cannot expose
apparently complete tool arguments for execution.

Consumers may break the async iterator to stop generation. Reader cleanup cancels the body and
releases its lock; session cleanup clears the timer and aborts the transport. External cancellation
preserves the caller's original AbortSignal reason. Cancellation and timeouts also settle the
adapter when an injected async fetch or resolver ignores its signal, although JavaScript cannot
forcibly terminate arbitrary uncooperative code.

## Retry, usage, and logging

Each invocation makes exactly one HTTP attempt. There are no SDK retries, automatic endpoint
fallbacks, or internal retry-budget charges. A timeout or transient HTTP error is descriptive
metadata, not authorization to repeat an effect. Outer retry policy and the shared scheduler
budget remain authoritative. A provider may bill another request even when retrying is otherwise
safe for external state; cost limits remain separate host policy.

Usage maps prompt, completion, total, and cached input token counts when reported. Missing values
remain absent. No token counts, prices, currency conversion, or monetary cost are invented. This
adapter does not journal every token or write SQLite; the future broker must route stream events
to transient sinks and final result/usage into the established durable completion path.

Transport errors expose a closed code, optional HTTP status, and retryability hint. Provider
bodies, URLs, credentials, and nested exceptions are not copied into errors. Error provenance uses
private object identity rather than trusting a forged prototype. Responses can still contain
sensitive user/model data; the host must apply existing redaction and persistence checks at its
sinks. This is not whole-process taint tracking.

## Verification and remaining work

Portable unit tests cover serialization, scoped credentials, option pinning, feature gates,
malformed/oversized data, fragmented streams, tool assembly, cancellation, and error safety.
Integration tests use the actual PluginHost and scheduler, plus a real loopback HTTP listener.
That listener is a protocol fixture, not an installed Ollama/llama.cpp model or a paid cloud test.

Run from `harness/`:

```sh
npm run typecheck
npm run lint
npm run format:check
npm test
```

The normal Windows and Ubuntu workflows also run smoke tests, builds, and the unchanged baseline.
Next is the provider-specific boundary in 6.6, followed by adapter-node/broker wiring and routing.
Responses-native conversation/reasoning state, provider-built-in tools, automatic model selection,
real model endpoint qualification, and native filesystem/shell/git tools are not implemented here.

Protocol references used for the implementation are OpenAI's official Chat Completions create
reference and its streaming and Responses migration guides. The implementation intentionally
uses the Chat Completions contract rather than pretending Responses is an interchangeable URL.
