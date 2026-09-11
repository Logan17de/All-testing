import type {
  AdapterInvocationContext,
  HarnessPlugin,
  JsonObject,
  JsonSchema,
  NodeBehavior,
  PluginContext,
  ToolAdapter,
  ToolResult,
} from "@zet-harness/plugin-api";
import { PLUGIN_API_VERSION } from "@zet-harness/plugin-api";

import { McpStdioClient, type McpServerConfig, type McpToolDescriptor } from "./mcp-client.js";

/**
 * Capability demanded by every MCP tool.
 *
 * One capability per configured server, so granting access to a filesystem MCP
 * server does not also authorize an unrelated one.
 */
export function mcpServerCapability(serverId: string): string {
  return `mcp:${serverId}`;
}

/** Lowercase, dot/dash-separated server id; it becomes part of tool ids. */
const SERVER_ID_PATTERN = /^[a-z0-9][a-z0-9-]*(?:[.][a-z0-9][a-z0-9-]*)*$/u;
const TOOL_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/u;
const DEFAULT_MAX_RESULT_CHARACTERS = 262_144; // 256 KiB of text

export interface McpServerRegistration extends McpServerConfig {
  /** Stable id for this server, used in capability and tool ids. */
  readonly id: string;
  /**
   * Trust the server's `readOnlyHint` annotation.
   *
   * Defaults to false. An annotation is a claim by the server, not a
   * guarantee, so by default every MCP tool is classified as an external write
   * with manual recovery. A host that has actually reviewed a server may opt
   * in, and that is a host decision, never the server's.
   */
  readonly trustReadOnlyHints?: boolean;
  readonly maxResultCharacters?: number;
}

/**
 * Behavior metadata for an MCP tool.
 *
 * The harness cannot know what a remote tool does, so the default is the
 * conservative classification: an external write that is not safe to repeat and
 * needs a human to reconcile after an interrupted attempt. Treating unknown
 * remote code as harmless would be the one assumption the recovery machinery
 * cannot undo later.
 */
function mcpToolBehavior(
  serverId: string,
  descriptor: McpToolDescriptor,
  trustReadOnlyHints: boolean,
): NodeBehavior {
  const readOnly = trustReadOnlyHints && descriptor.annotations?.readOnlyHint === true;

  return Object.freeze({
    primitiveFamily: "effect" as const,
    determinism: "nondeterministic" as const,
    effect: readOnly ? ("external-read" as const) : ("external-write" as const),
    idempotency: readOnly ? ("idempotent" as const) : ("unknown" as const),
    recovery: readOnly ? ("rerun" as const) : ("manual" as const),
    executionMode: "in-process" as const,
    requiredCapabilities: Object.freeze([mcpServerCapability(serverId)]),
  });
}

function sanitizeSchema(schema: Record<string, unknown>): JsonSchema {
  // The schema is server-supplied and only used for description and
  // validation, never executed. Copying it drops any prototype tricks.
  return JSON.parse(JSON.stringify(schema)) as JsonSchema;
}

/**
 * Translate one MCP tool descriptor into an ordinary tool adapter.
 *
 * This is the whole point of 10.4: an MCP tool joins the normal tool registry
 * and travels the same capability, approval and tracing path as a first-party
 * tool. There is no separate MCP execution engine and no bypass.
 */
export function createMcpToolAdapter(
  client: McpStdioClient,
  registration: McpServerRegistration,
  descriptor: McpToolDescriptor,
): ToolAdapter {
  const maxCharacters = registration.maxResultCharacters ?? DEFAULT_MAX_RESULT_CHARACTERS;

  return Object.freeze({
    manifest: Object.freeze({
      id: `mcp.${registration.id}.${descriptor.name}`,
      version: "1",
      title: descriptor.annotations?.title ?? descriptor.name,
      ...(descriptor.description === undefined ? {} : { description: descriptor.description }),
      inputSchema: sanitizeSchema(descriptor.inputSchema),
      // The protocol does not describe tool output shapes, so the harness
      // declares what it actually returns rather than inventing a schema.
      outputSchema: Object.freeze({
        type: "object",
        additionalProperties: false,
        required: ["text", "isError", "truncated"],
        properties: {
          text: { type: "string" },
          isError: { type: "boolean" },
          truncated: { type: "boolean" },
        },
      }),
      behavior: mcpToolBehavior(
        registration.id,
        descriptor,
        registration.trustReadOnlyHints === true,
      ),
    }),
    async invoke(input: JsonObject, context: AdapterInvocationContext): Promise<ToolResult> {
      context.signal.throwIfAborted();

      const result = await client.callTool(descriptor.name, { ...input });
      const joined = result.content
        .map((block) => block.text ?? "")
        .filter((text) => text.length > 0)
        .join("\n");
      const truncated = joined.length > maxCharacters;

      return Object.freeze({
        value: Object.freeze({
          text: truncated ? joined.slice(0, maxCharacters) : joined,
          isError: result.isError,
          truncated,
        }),
      });
    },
  });
}

export interface McpConnection {
  readonly client: McpStdioClient;
  readonly adapters: readonly ToolAdapter[];
  readonly close: () => Promise<void>;
}

/**
 * Connect to one MCP server and translate its tools.
 *
 * The caller owns the returned `close`; a plugin must attach it to the
 * activation cleanup stack so unloading never leaves an orphaned server.
 */
export async function connectMcpServer(
  registration: McpServerRegistration,
): Promise<McpConnection> {
  if (!SERVER_ID_PATTERN.test(registration.id)) {
    throw new TypeError(
      `MCP server id '${registration.id}' must be lowercase dot-separated segments.`,
    );
  }

  const client = new McpStdioClient(registration);
  try {
    await client.initialize();
    const descriptors = await client.listTools();

    const adapters: ToolAdapter[] = [];
    const seen = new Set<string>();
    for (const descriptor of descriptors) {
      // A hostile or buggy server must not be able to shadow another tool or
      // smuggle separators into a harness-visible identifier.
      if (!TOOL_NAME_PATTERN.test(descriptor.name)) continue;
      if (seen.has(descriptor.name)) continue;
      seen.add(descriptor.name);
      adapters.push(createMcpToolAdapter(client, registration, descriptor));
    }

    return Object.freeze({
      client,
      adapters: Object.freeze(adapters),
      close: () => client.close(),
    });
  } catch (error: unknown) {
    await client.close();
    throw error;
  }
}

export interface McpPluginOptions {
  readonly servers: readonly McpServerRegistration[];
  readonly pluginId?: string;
}

/**
 * A first-party plugin that publishes configured MCP servers' tools.
 *
 * Every server's capability is declared as demand. The host still decides what
 * to grant, so configuring a server does not authorize its tools.
 */
export function createMcpPlugin(options: McpPluginOptions): HarnessPlugin {
  const servers = Object.freeze([...options.servers]);

  return Object.freeze({
    manifest: Object.freeze({
      id: options.pluginId ?? "harness.mcp",
      name: "MCP servers",
      version: "1",
      apiVersion: PLUGIN_API_VERSION,
      capabilities: Object.freeze(
        servers.map((server) => Object.freeze({ id: mcpServerCapability(server.id) })),
      ),
    }),
    async activate(context: PluginContext): Promise<void> {
      for (const server of servers) {
        const connection = await connectMcpServer(server);
        // Registered before the disposer so a later failure still tears this
        // server down with the rest of the activation scope.
        context.onDispose(connection.close);
        for (const adapter of connection.adapters) {
          context.tools.register(adapter);
        }
      }
    },
  });
}
