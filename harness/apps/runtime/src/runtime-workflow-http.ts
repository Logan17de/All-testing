import type { IncomingMessage, ServerResponse } from "node:http";

import { readConversation } from "@zet-harness/db/durable-conversation-records";
import { SORTABLE_ID_PATTERN } from "@zet-harness/db/sortable-id";

import { RuntimeApiSecurityError, type RuntimeApiSecurity } from "./runtime-api-security.js";
import { writeRuntimeJson } from "./runtime-approval-http.js";
import type { RuntimeGraphHttpServices } from "./runtime-graph-http.js";
import {
  compileEditorGraph,
  createRunFromCompiledGraph,
  createStoredGraphResolver,
  type GraphSources,
} from "./runtime-graphs.js";
import {
  WORKFLOW_TEMPLATES,
  buildWorkflow,
  isWorkflowId,
  type WorkflowOptions,
  type WorkflowTemplate,
} from "./runtime-workflows.js";

const WORKFLOWS_PATH = /^\/api\/workflows$/u;
const WORKFLOW_PATH = /^\/api\/workflows\/([^/]+)$/u;
const REPLY_PATH = /^\/api\/conversations\/([^/]+)\/reply$/u;
const MAX_REPLY_BODY_BYTES = 32_768;
const REPLY_FIELDS: readonly string[] = ["workflow", "instructions", "modelId"];

class WorkflowRequestError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly diagnostics: unknown;

  constructor(code: string, message: string, statusCode: number, diagnostics?: unknown) {
    super(message);
    this.name = "WorkflowRequestError";
    this.code = code;
    this.statusCode = statusCode;
    this.diagnostics = diagnostics;
  }
}

/** Workflow paths this handler owns; checked before the conversation paths. */
export function isWorkflowHttpPath(pathname: string): boolean {
  return WORKFLOWS_PATH.test(pathname) || WORKFLOW_PATH.test(pathname) || REPLY_PATH.test(pathname);
}

function available(template: WorkflowTemplate, sources: GraphSources): boolean {
  return template.needs.every(
    (type) =>
      sources.host?.nodes.listManifests().some((manifest) => manifest.type === type) === true,
  );
}

function methodNotAllowed(response: ServerResponse, allowed: readonly string[]): void {
  response.setHeader("allow", allowed.join(", "));
  writeRuntimeJson(response, 405, { error: "method_not_allowed", allowed });
}

async function readReplyBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const part of request.iterator({ destroyOnReturn: false })) {
    const buffer = Buffer.isBuffer(part) ? part : Buffer.from(part as string);
    size += buffer.length;
    if (size > MAX_REPLY_BODY_BYTES) {
      request.resume();
      throw new RuntimeApiSecurityError("LOCAL_API_BODY_TOO_LARGE", "Request exceeds 32 KiB.", 413);
    }
    parts.push(buffer);
  }
  if (size === 0) return {};
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(parts).toString("utf8")) as unknown;
  } catch {
    throw new WorkflowRequestError(
      "WORKFLOW_REQUEST_INVALID",
      "Request body is not valid JSON.",
      400,
    );
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new WorkflowRequestError(
      "WORKFLOW_REQUEST_INVALID",
      "Request body must be a JSON object.",
      400,
    );
  }
  return value as Record<string, unknown>;
}

function optionalText(
  body: Record<string, unknown>,
  field: string,
  maxLength: number,
): string | undefined {
  const value = body[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length > maxLength) {
    throw new WorkflowRequestError(
      "WORKFLOW_REQUEST_INVALID",
      `${field} must be text of at most ${String(maxLength)} characters.`,
      400,
    );
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * Ready-made workflows, and answering a conversation with one.
 *
 * A reply is an ordinary run of an ordinary graph, compiled and checked like any
 * other and dispatched the same way; the answer lands in the conversation because
 * that is what the graph's agent steps do.
 */
export async function handleWorkflowHttp(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  security: RuntimeApiSecurity,
  services: RuntimeGraphHttpServices,
): Promise<void> {
  try {
    if (WORKFLOWS_PATH.test(url.pathname)) {
      if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
      const sources = services.sources();
      writeRuntimeJson(response, 200, {
        workflows: WORKFLOW_TEMPLATES.map((template) => ({
          id: template.id,
          title: template.title,
          description: template.description,
          available: available(template, sources),
        })),
      });
      return;
    }

    const workflowMatch = WORKFLOW_PATH.exec(url.pathname);
    if (workflowMatch !== null) {
      if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
      const id = decodeURIComponent(workflowMatch[1] ?? "");
      if (!isWorkflowId(id)) {
        throw new WorkflowRequestError("WORKFLOW_NOT_FOUND", "No workflow has this id.", 404);
      }
      const conversationId = url.searchParams.get("conversationId") ?? "";
      writeRuntimeJson(response, 200, { graph: buildWorkflow(id, conversationId) });
      return;
    }

    const replyMatch = REPLY_PATH.exec(url.pathname);
    if (replyMatch === null) {
      writeRuntimeJson(response, 404, { error: "not_found" });
      return;
    }
    if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
    security.checkMutation(request);
    const conversationId = decodeURIComponent(replyMatch[1] ?? "");
    const conversation = SORTABLE_ID_PATTERN.test(conversationId)
      ? readConversation(services.database.connection(), conversationId)
      : undefined;
    if (conversation === undefined) {
      throw new WorkflowRequestError(
        "CONVERSATION_NOT_FOUND",
        "No conversation exists with this id.",
        404,
      );
    }
    if (conversation.status !== "active") {
      throw new WorkflowRequestError(
        "CONVERSATION_ARCHIVED",
        "This conversation is archived; restore it to continue it.",
        409,
      );
    }

    const body = await readReplyBody(request);
    for (const field of Object.keys(body)) {
      if (!REPLY_FIELDS.includes(field)) {
        throw new WorkflowRequestError(
          "WORKFLOW_REQUEST_INVALID",
          `A reply has no '${field}' field.`,
          400,
        );
      }
    }
    const workflow = body["workflow"] ?? "chat";
    if (!isWorkflowId(workflow)) {
      throw new WorkflowRequestError("WORKFLOW_NOT_FOUND", "No workflow has this id.", 404);
    }
    const sources = services.sources();
    const template = WORKFLOW_TEMPLATES.find((candidate) => candidate.id === workflow);
    if (template === undefined || !available(template, sources)) {
      throw new WorkflowRequestError(
        "WORKFLOW_UNAVAILABLE",
        "This workflow needs a plugin that is not loaded.",
        409,
      );
    }
    const instructions = optionalText(body, "instructions", 20_000);
    const modelId = optionalText(body, "modelId", 64);
    const options: WorkflowOptions = {
      ...(instructions === undefined ? {} : { instructions }),
      ...(modelId === undefined ? {} : { modelId }),
    };

    const compiled = await compileEditorGraph(
      buildWorkflow(workflow, conversationId, options),
      { ...sources, graphs: createStoredGraphResolver(services.database) },
      services.capabilityAuthority(),
    );
    if (!compiled.valid) {
      throw new WorkflowRequestError(
        "WORKFLOW_INVALID",
        "The workflow could not be prepared for this conversation.",
        422,
        compiled.diagnostics,
      );
    }
    const created = await createRunFromCompiledGraph(services.database, compiled.compiled);
    services.dispatch?.(created.runId);
    writeRuntimeJson(response, 201, {
      runId: created.runId,
      workflow,
      dispatched: services.dispatch !== undefined,
    });
  } catch (error: unknown) {
    if (error instanceof WorkflowRequestError) {
      writeRuntimeJson(response, error.statusCode, {
        error: { code: error.code, reason: error.message },
        ...(error.diagnostics === undefined ? {} : { diagnostics: error.diagnostics }),
      });
      return;
    }
    throw error;
  }
}
