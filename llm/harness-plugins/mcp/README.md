# MCP plugin

Thin configurable bundle over DeepSeek Harness's first-party `@deepseek-ai/dsh-mcp-client`.

The upstream bridge discovers MCP tools and registers them as native Harness tools named:

```text
mcp__<serverName>__<toolName>
```

## Stdio server

Default configuration starts the MCP reference memory server through `npx`.

```env
DSH_MCP_TRANSPORT=stdio
DSH_MCP_SERVER_NAME=memory
DSH_MCP_COMMAND=npx
DSH_MCP_ARGS_JSON=["-y","@modelcontextprotocol/server-memory@2026.7.4"]
DSH_MCP_ENV_JSON={}
DSH_MCP_CWD=
DSH_MCP_FAIL_ON_STARTUP=0
```

For a GitHub MCP server, for example, change `DSH_MCP_ARGS_JSON` and pass its token through `DSH_MCP_ENV_JSON` rather than exposing the secret to the model.

## Streamable HTTP server

```env
DSH_MCP_TRANSPORT=streamable-http
DSH_MCP_SERVER_NAME=myserver
DSH_MCP_URL=http://localhost:3000/mcp
DSH_MCP_TOKEN=
```

Only one of the stdio/HTTP rows is enabled at a time. The first-party client owns discovery, tool-list updates, timeouts, and reconnect behavior.
