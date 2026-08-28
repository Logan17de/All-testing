# LLM Harness Plugins

Starter plugin pack for DeepSeek Harness (`dsh`). Each folder is independently installable into a Harness profile.

## Plugins

| Plugin | Purpose | Status |
|---|---|---|
| `github` | Read/search repositories and optionally create issues/write files | MVP |
| `memory` | Persistent local key/value memory with search | MVP |
| `scheduler` | Durable Session-local reminders using DSH's native scheduler | Harness-native wrapper |
| `google-workspace` | Drive search, Gmail search/read, Calendar event listing | MVP |
| `deep-search` | Exa-backed web search and page retrieval | MVP |
| `mcp` | Connect one MCP server over stdio or Streamable HTTP | Harness-native wrapper |

## Install

Run these from the repository root. Install only the plugins you want.

```bash
dsh plugin --profile web add ./llm/harness-plugins/github
dsh plugin --profile web add ./llm/harness-plugins/memory
dsh plugin --profile web add ./llm/harness-plugins/scheduler
dsh plugin --profile web add ./llm/harness-plugins/google-workspace
dsh plugin --profile web add ./llm/harness-plugins/deep-search
dsh plugin --profile web add ./llm/harness-plugins/mcp
```

Then restart:

```bash
dsh web
```

Inspect the composed plugin tree with:

```bash
dsh --profile web --dump-config
```

## Credentials

Put credentials in the environment or DSH `.env`; never commit secrets.

```env
# GitHub
GITHUB_TOKEN=
HARNESS_GITHUB_ALLOW_WRITE=0

# Google Workspace: either a short-lived access token OR OAuth refresh credentials
GOOGLE_ACCESS_TOKEN=
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REFRESH_TOKEN=

# Exa deep search
EXA_API_KEY=

# Memory
DSH_MEMORY_FILE=

# MCP stdio defaults to @modelcontextprotocol/server-memory
DSH_MCP_TRANSPORT=stdio
DSH_MCP_SERVER_NAME=memory
DSH_MCP_COMMAND=npx
DSH_MCP_ARGS_JSON=["-y","@modelcontextprotocol/server-memory@2026.7.4"]
DSH_MCP_ENV_JSON={}

# MCP Streamable HTTP alternative
# DSH_MCP_TRANSPORT=streamable-http
# DSH_MCP_URL=http://localhost:3000/mcp
# DSH_MCP_TOKEN=
```

## Design rules

- Keep model-facing tools small and atomic.
- Default integrations to read-only where practical; explicit environment flags enable writes.
- Keep secrets out of tool results.
- Prefer DSH-native services when the Harness already owns the lifecycle correctly.
- This repo tracks DSH developer-preview APIs, so compatibility may need updates as Harness changes.
