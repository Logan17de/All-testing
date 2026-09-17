import { AGENT_MODEL_NODE_TYPE, AGENT_TOOLS_NODE_TYPE, LOOP_NODE_TYPE } from "@zet-harness/core";
import { GRAPH_JSON_VERSION, type GraphJsonV1 } from "@zet-harness/graph";

/**
 * Ready-made workflows a conversation can be answered with.
 *
 * Each is an ordinary graph — the same Loop, model step and tools step anyone can
 * draw — built for one conversation, so a chat needs no drawing at all and the
 * editor can open the very graph a reply ran. Nothing here is a special path: a
 * reply is a run like any other, with a timeline, a replay and a fork button.
 */

export const DEFAULT_CHAT_INSTRUCTIONS =
  "You are a helpful assistant. Answer clearly and briefly, and say so when you are not sure.";

/** The node a GitHub component is, when the GitHub plugin is loaded. */
export const GITHUB_COMPONENT_NODE_TYPE = "github.component" as const;

export const WORKFLOW_IDS = ["chat", "chat-github"] as const;
export type WorkflowId = (typeof WORKFLOW_IDS)[number];

export interface WorkflowTemplate {
  readonly id: WorkflowId;
  readonly title: string;
  readonly description: string;
  /** Node types the workflow uses beyond the built-in ones; offered only when present. */
  readonly needs: readonly string[];
}

export const WORKFLOW_TEMPLATES: readonly WorkflowTemplate[] = Object.freeze([
  Object.freeze({
    id: "chat",
    title: "Chat",
    description:
      "A normal conversation: the model answers each message, using the project's goals, todos and memory when it helps.",
    needs: [],
  }),
  Object.freeze({
    id: "chat-github",
    title: "Chat with GitHub",
    description:
      "The same conversation, with a GitHub component wired in, so the model can read repositories, issues, pull requests and files.",
    needs: [GITHUB_COMPONENT_NODE_TYPE],
  }),
]);

export interface WorkflowOptions {
  /** What the model is told before the conversation. */
  readonly instructions?: string;
  /** A configured model's id; otherwise any model that can call tools. */
  readonly modelId?: string;
}

export function isWorkflowId(value: unknown): value is WorkflowId {
  return typeof value === "string" && (WORKFLOW_IDS as readonly string[]).includes(value);
}

/**
 * The graph a workflow runs for one conversation.
 *
 * One revision per conversation and version of the template: a run is bound to
 * the exact plan it started from, and two conversations' plans differ in which
 * conversation they read.
 */
export function buildWorkflow(
  id: WorkflowId,
  conversationId: string,
  options: WorkflowOptions = {},
): GraphJsonV1 {
  const template = WORKFLOW_TEMPLATES.find((candidate) => candidate.id === id);
  if (template === undefined) throw new TypeError(`Unknown workflow '${id}'.`);
  const withGitHub = id === "chat-github";
  const instructions = options.instructions?.trim() ?? "";
  const model = {
    conversationId,
    systemPrompt: instructions.length > 0 ? instructions : DEFAULT_CHAT_INSTRUCTIONS,
    reserveOutputTokens: 1_024,
    ...(options.modelId === undefined ? {} : { modelId: options.modelId }),
  };

  return {
    schemaVersion: GRAPH_JSON_VERSION,
    graphId: id,
    revisionId: `1:${conversationId}`,
    metadata: { title: template.title, description: template.description },
    inputs: [],
    outputs: [],
    nodes: [
      ...(withGitHub
        ? [
            {
              id: "github",
              type: GITHUB_COMPONENT_NODE_TYPE,
              version: "1",
              config: {},
            },
          ]
        : []),
      { id: "conversation", type: LOOP_NODE_TYPE, version: "1", config: { maxIterations: 6 } },
      { id: "reply", type: AGENT_MODEL_NODE_TYPE, version: "1", config: model },
      { id: "use-tools", type: AGENT_TOOLS_NODE_TYPE, version: "1", config: { conversationId } },
    ],
    edges: [
      ...(withGitHub
        ? [
            {
              id: "start",
              kind: "control" as const,
              from: { nodeId: "github" },
              to: { nodeId: "conversation", port: "in" },
            },
            {
              id: "github-to-reply",
              kind: "data" as const,
              from: { nodeId: "github", port: "tools" },
              to: { nodeId: "reply", port: "tools" },
            },
            {
              id: "github-to-tools",
              kind: "data" as const,
              from: { nodeId: "github", port: "tools" },
              to: { nodeId: "use-tools", port: "tools" },
            },
          ]
        : []),
      {
        id: "each-turn",
        kind: "control",
        from: { nodeId: "conversation", port: "body" },
        to: { nodeId: "reply" },
      },
      { id: "then-tools", kind: "control", from: { nodeId: "reply" }, to: { nodeId: "use-tools" } },
      {
        id: "go-round",
        kind: "control",
        from: { nodeId: "use-tools" },
        to: { nodeId: "conversation", port: "repeat" },
      },
      {
        id: "more-to-do",
        kind: "data",
        from: { nodeId: "reply", port: "again" },
        to: { nodeId: "conversation", port: "again" },
      },
    ],
    entrypoints: [
      withGitHub
        ? { id: "main", nodeId: "github" }
        : { id: "main", nodeId: "conversation", port: "in" },
    ],
    policies: {
      maxNodeExecutions: 40,
      maxParallelism: 1,
      capabilities: { required: [], optional: [], deny: [] },
    },
    options: { defaultEntrypoint: "main" },
    editor: {
      nodes: {
        ...(withGitHub ? { github: { position: { x: 40, y: 200 } } } : {}),
        conversation: { position: { x: withGitHub ? 320 : 60, y: 60 } },
        reply: { position: { x: withGitHub ? 320 : 60, y: 260 } },
        "use-tools": { position: { x: withGitHub ? 600 : 340, y: 260 } },
      },
    },
  };
}
