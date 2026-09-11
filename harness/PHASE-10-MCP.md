# Phase 10.3–10.5 — MCP servers as ordinary tools

## Delivered scope

`@zet-harness/mcp` connects to Model Context Protocol servers over stdio and publishes their tools
through the normal tool registry. Covers TODO 10.3, 10.4 and 10.5.

This matters for extensibility: MCP is where most third-party tools already live, so supporting it
means a large existing ecosystem works without anyone writing a Zet plugin at all.

## A client, not an SDK dependency

MCP's stdio transport is newline-delimited JSON-RPC 2.0 — one message per line, no embedded
newlines. That is the whole framing rule, so the client implements it directly rather than pulling
a vendor SDK and its transitive dependency tree into the harness.

The server is spawned with an argument vector and `shell: false`, and receives only the environment
the configuration supplies. The harness environment, which can hold provider credentials, is never
inherited.

The client deliberately advertises **no client capabilities**: it exposes no roots, sampling or
elicitation surface, so a server has nothing to call back into.

Robustness the tests pin down: a request to a silent server times out rather than hanging, a spawn
failure is reported rather than hanging, in-flight requests fail when the server exits, `close()`
is idempotent, and a malformed line is skipped rather than tearing down every pending request.
Writing to a dead child's stdin emits `EPIPE`, and an unhandled `error` event would take down the
whole harness process, so every stream carries a listener.

## Translation, not a second engine (10.4, 10.5)

Each MCP tool becomes an ordinary `ToolAdapter` with an id of `mcp.<server>.<tool>`. It is
registered through `PluginContext.tools.register` like any other tool and travels the same
capability, approval and tracing path. There is no MCP-specific execution route and no bypass.

Each server gets its own capability, `mcp:<id>`. Granting access to a filesystem MCP server
therefore does not also authorize an unrelated one.

A server-supplied tool name is validated before it becomes part of a harness-visible identifier, so
a buggy or hostile server cannot shadow another tool or smuggle separators into an id.

## Annotations are claims, not guarantees

MCP lets a server annotate a tool with `readOnlyHint`, `destructiveHint` and friends. The harness
records them but **does not trust them by default**.

Every MCP tool is classified as `external-write` with `unknown` idempotency and `manual` recovery,
because the harness cannot know what remote code does. Treating unknown remote code as harmless is
the one assumption the recovery machinery cannot undo afterwards.

A host that has actually reviewed a server may set `trustReadOnlyHints`, which downgrades only the
tools that carry the annotation. That is a host decision, never the server's — a test asserts an
annotated tool stays an external write until the host opts in, and that an unannotated tool stays a
write even then.

## Verification

Run from `harness/`:

```sh
npm run typecheck
npm run lint
npm run format:check
npm test
```

1144 tests pass, up from 1116. The 28 new tests run a real MCP server subprocess and exercise the
protocol end to end over actual stdio, rather than mocking the transport — the framing and
handshake are exactly the parts worth proving.

## Not included

- HTTP/SSE transport; stdio is the transport local servers actually use
- Server-initiated requests, sampling, roots, elicitation and prompts
- Resources and resource templates; only tools are translated so far
- Automatic MCP server configuration through the daemon, which belongs with the plugin config work
