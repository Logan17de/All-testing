import { createHash } from "node:crypto";
import type {
  AdapterInvocationContext,
  AdapterUsage,
  JsonObject,
  ModelAdapter,
  ModelMessagePart,
  ModelRequest,
  ModelResult,
  ModelStreamEvent,
} from "@zet-harness/plugin-api";
import {
  ModelTransportError,
  abortable,
  immutable,
  parseJson,
  readModelJson,
  readModelSse,
  record,
} from "@zet-harness/models";

export interface ChatGPTImageArtifact {
  readonly bytes: Uint8Array;
  readonly mediaType: "image/png" | "image/jpeg" | "image/webp";
}
/** Trusted host lookup only: must enforce artifact ownership and explicit transmission consent. */
export type ChatGPTImageResolver = (
  artifactRef: string,
  context: AdapterInvocationContext,
) => Promise<ChatGPTImageArtifact>;
export interface ChatGPTModelOptions {
  id: string;
  model: string;
  accessToken: () => Promise<string>;
  fetch?: typeof globalThis.fetch;
  /** Absent by default. Never accepts arbitrary paths/URLs or adds model tool authority. */
  resolveImage?: ChatGPTImageResolver;
  /** Nonsecret stable SHA-256 account/client identity digest supplied by the host. */
  stateScope?: string;
  /** Host rechecks current run/account/desktop consent at the last synchronous outbound boundary. */
  validateImageAuthority?: (context: AdapterInvocationContext) => void;
}
const unsupported = (): never => {
  throw new ModelTransportError("MODEL_REQUEST_UNSUPPORTED");
};
function toolName(name: string): string {
  return `tool_${createHash("sha256").update(name).digest("hex").slice(0, 24)}`;
}
async function prepare(
  request: ModelRequest,
  model: string,
  context: AdapterInvocationContext,
  resolveImage?: ChatGPTImageResolver,
  stateScope?: string,
  validateImageAuthority?: (context: AdapterInvocationContext) => void,
  authorityContext: AdapterInvocationContext = context,
): Promise<{
  body: string;
  offered: Map<string, string>;
  droppedProviderStateCount: number;
  imageCount: number;
}> {
  if (request.model !== undefined && request.model !== model) unsupported();
  if (request.outputSchema !== undefined || request.options !== undefined) unsupported();
  // Plan route forbids max_output_tokens. The local postresponse gate below does not
  // promise a provider-side spending cap or prevent within-request overrun.
  if (
    request.maxOutputTokens !== undefined &&
    (!Number.isSafeInteger(request.maxOutputTokens) || request.maxOutputTokens < 1)
  )
    unsupported();
  if (
    request.providerStatePolicy !== undefined &&
    !["require", "omit-incompatible"].includes(request.providerStatePolicy)
  )
    unsupported();
  let droppedProviderStateCount = 0;
  const offered = new Map<string, string>();
  const tools = (request.tools ?? []).map((tool) => {
    if (!tool.name || tool.name.length > 256 || offered.has(toolName(tool.name))) unsupported();
    const encoded = toolName(tool.name);
    offered.set(encoded, tool.name);
    return {
      type: "function",
      name: encoded,
      ...(tool.description ? { description: tool.description } : {}),
      parameters: tool.inputSchema,
      strict: false,
    };
  });
  const input: unknown[] = [];
  let stateBytes = 0;
  const stateIds = new Set<string>();
  let imageBytes = 0;
  const maxImageBytes = 8_388_608;
  let imageCount = 0;
  const priorCalls = new Set<string>();
  const priorResults = new Set<string>();
  for (const message of request.messages) {
    if (!["system", "developer", "user", "assistant", "tool"].includes(message.role)) unsupported();
    const text: string[] = [];
    const flush = () => {
      if (text.length) {
        input.push({
          role: message.role === "system" ? "developer" : message.role,
          content: text.join(""),
        });
        text.length = 0;
      }
    };
    for (const part of message.parts) {
      if (part.kind === "text") {
        if (message.role === "tool") unsupported();
        text.push(part.text);
      } else if (part.kind === "tool-call") {
        flush();
        if (message.role !== "assistant" || !part.callId || priorCalls.has(part.callId))
          unsupported();
        priorCalls.add(part.callId);
        input.push({
          type: "function_call",
          namespace: "harness",
          name: toolName(part.name),
          call_id: part.callId,
          arguments: JSON.stringify(part.arguments),
        });
      } else if (part.kind === "tool-result") {
        flush();
        if (
          message.role !== "tool" ||
          !priorCalls.has(part.callId) ||
          priorResults.has(part.callId)
        )
          unsupported();
        priorResults.add(part.callId);
        input.push({
          type: "function_call_output",
          call_id: part.callId,
          output: JSON.stringify(part.value),
        });
      } else if (part.kind === "provider-state") {
        flush();
        if (
          message.role !== "assistant" ||
          part.provider !== "openai-responses" ||
          !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(part.model) ||
          !/^[a-f0-9]{64}$/u.test(part.scope) ||
          !/^[A-Za-z0-9_.:-]{1,200}$/u.test(part.id) ||
          stateIds.has(part.id) ||
          typeof part.encryptedContent !== "string" ||
          !part.encryptedContent ||
          /[\x00-\x20\x7f]/u.test(part.encryptedContent)
        )
          unsupported();
        const size = Buffer.byteLength(part.encryptedContent);
        if (size > 65_536) throw new ModelTransportError("MODEL_RESPONSE_LIMIT");
        if (part.model !== model || !stateScope || part.scope !== stateScope) {
          if (request.providerStatePolicy !== "omit-incompatible") unsupported();
          droppedProviderStateCount++;
          continue;
        }
        stateIds.add(part.id);
        if ((stateBytes += size) > 262_144) throw new ModelTransportError("MODEL_RESPONSE_LIMIT");
        input.push({
          type: "reasoning",
          id: part.id,
          encrypted_content: part.encryptedContent,
          summary: [],
        });
      } else if (part.kind === "image") {
        flush();
        if (
          message.role !== "user" ||
          !resolveImage ||
          !/^(?:artifact:)?[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/u.test(part.artifactRef) ||
          !["image/png", "image/jpeg", "image/webp"].includes(part.mediaType)
        )
          unsupported();
        if (++imageCount > 1) throw new ModelTransportError("MODEL_RESPONSE_LIMIT");
        context.signal.throwIfAborted();
        let artifact: ChatGPTImageArtifact;
        try {
          artifact = await abortable(
            resolveImage!(part.artifactRef, authorityContext),
            context.signal,
          );
        } catch {
          context.signal.throwIfAborted();
          throw new ModelTransportError("MODEL_REQUEST_UNSUPPORTED");
        }
        context.signal.throwIfAborted();
        if (
          !artifact ||
          typeof artifact !== "object" ||
          !(artifact.bytes instanceof Uint8Array) ||
          artifact.mediaType !== part.mediaType ||
          artifact.bytes.byteLength < 4
        )
          unsupported();
        if ((imageBytes += artifact.bytes.byteLength) > maxImageBytes)
          throw new ModelTransportError("MODEL_RESPONSE_LIMIT");
        try {
          validateImageAuthority?.(authorityContext);
        } catch {
          context.signal.throwIfAborted();
          unsupported();
        }
        const bytes = Buffer.from(artifact.bytes);
        const png =
          artifact.mediaType === "image/png" &&
          bytes.length >= 24 &&
          bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
          bytes.readUInt32BE(8) === 13 &&
          bytes.toString("ascii", 12, 16) === "IHDR";
        const jpeg =
          artifact.mediaType === "image/jpeg" &&
          bytes[0] === 255 &&
          bytes[1] === 216 &&
          bytes[2] === 255 &&
          bytes.at(-2) === 255 &&
          bytes.at(-1) === 217;
        const webp =
          artifact.mediaType === "image/webp" &&
          bytes.length >= 16 &&
          bytes.toString("ascii", 0, 4) === "RIFF" &&
          bytes.readUInt32LE(4) === bytes.length - 8 &&
          bytes.toString("ascii", 8, 12) === "WEBP" &&
          ["VP8 ", "VP8L", "VP8X"].includes(bytes.toString("ascii", 12, 16));
        if (!png && !jpeg && !webp) unsupported();
        input.push({
          role: "user",
          content: [
            {
              type: "input_image",
              image_url: `data:${artifact.mediaType};base64,${bytes.toString("base64")}`,
              detail: "auto",
            },
          ],
        });
      } else unsupported();
    }
    flush();
  }
  if (droppedProviderStateCount)
    input.unshift({
      role: "developer",
      content:
        "Encrypted provider context was omitted for an explicitly authorized model/account switch. Use the retained visible conversation and actual tool results.",
    });
  const payload = {
    model,
    input,
    ...(tools.length
      ? {
          tools: [
            {
              type: "namespace",
              name: "harness",
              description:
                "Tools offered by the independent harness. Execution and permission decisions remain in the harness.",
              tools,
            },
          ],
        }
      : {}),
    store: false,
    stream: true,
  };
  const body = JSON.stringify(payload);
  const nonImageBody = JSON.stringify({
    ...payload,
    input: input.map((item) => {
      const message = item as { content?: unknown };
      return Array.isArray(message.content)
        ? { ...message, content: [{ type: "input_image", detail: "auto" }] }
        : item;
    }),
  });
  if (Buffer.byteLength(nonImageBody) > 1_048_576 || Buffer.byteLength(body) > 12_582_912)
    throw new ModelTransportError("MODEL_RESPONSE_LIMIT");
  return { body, offered, droppedProviderStateCount, imageCount };
}
function parseUsage(value: unknown): AdapterUsage | undefined {
  if (value === undefined) return undefined;
  const source = record(value);
  const result: Record<string, number> = {};
  for (const [key, target] of [
    ["input_tokens", "inputTokens"],
    ["output_tokens", "outputTokens"],
    ["total_tokens", "totalTokens"],
  ] as const) {
    const number = source[key];
    if (number === undefined) continue;
    if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 0)
      throw new ModelTransportError("MODEL_RESPONSE_INVALID");
    result[target] = number;
  }
  return immutable(result);
}
function complete(
  value: unknown,
  offered: Map<string, string>,
  model: string,
  stateScope?: string,
): ModelResult {
  const response = record(value);
  if (response.status !== "completed" || !Array.isArray(response.output))
    throw new ModelTransportError("MODEL_RESPONSE_INVALID");
  const parts: ModelMessagePart[] = [];
  const calls = new Set<string>();
  const stateIds = new Set<string>();
  let stateBytes = 0;
  for (const raw of response.output) {
    const item = record(raw);
    if (item.type === "reasoning") {
      if (
        !stateScope ||
        typeof item.id !== "string" ||
        !/^[A-Za-z0-9_.:-]{1,200}$/u.test(item.id) ||
        stateIds.has(item.id) ||
        typeof item.encrypted_content !== "string" ||
        !item.encrypted_content ||
        /[\x00-\x20\x7f]/u.test(item.encrypted_content)
      )
        throw new ModelTransportError("MODEL_RESPONSE_INVALID");
      stateIds.add(item.id);
      const size = Buffer.byteLength(item.encrypted_content);
      if (size > 65_536 || (stateBytes += size) > 262_144)
        throw new ModelTransportError("MODEL_RESPONSE_LIMIT");
      parts.push({
        kind: "provider-state",
        provider: "openai-responses",
        model,
        scope: stateScope,
        id: item.id,
        encryptedContent: item.encrypted_content,
      });
      continue; // Never read or persist plaintext reasoning summaries/content.
    }
    if (item.type === "message") {
      if (item.role !== "assistant" || !Array.isArray(item.content))
        throw new ModelTransportError("MODEL_RESPONSE_INVALID");
      for (const rawPart of item.content) {
        const part = record(rawPart);
        if (part.type !== "output_text" || typeof part.text !== "string")
          throw new ModelTransportError("MODEL_RESPONSE_INVALID");
        parts.push({ kind: "text", text: part.text });
      }
    } else if (item.type === "function_call") {
      if (
        item.namespace !== "harness" ||
        typeof item.name !== "string" ||
        !offered.has(item.name) ||
        typeof item.call_id !== "string" ||
        !/^[A-Za-z0-9_.:-]{1,512}$/u.test(item.call_id) ||
        calls.has(item.call_id) ||
        typeof item.arguments !== "string"
      )
        throw new ModelTransportError("MODEL_RESPONSE_INVALID");
      calls.add(item.call_id);
      parts.push({
        kind: "tool-call",
        callId: item.call_id,
        name: offered.get(item.name)!,
        arguments: record(parseJson(item.arguments)) as JsonObject,
      });
    } else throw new ModelTransportError("MODEL_RESPONSE_INVALID"); // no hosted tools or unsolicited execution
  }
  const usage = parseUsage(response.usage);
  return immutable({
    message: { role: "assistant" as const, parts },
    finishReason: calls.size ? ("tool-calls" as const) : ("stop" as const),
    ...(usage ? { usage } : {}),
    ...(typeof response.id === "string" && /^[A-Za-z0-9_.:-]{1,200}$/u.test(response.id)
      ? { providerRequestId: response.id }
      : {}),
  });
}

export function createChatGPTPlanModelAdapter(options: ChatGPTModelOptions): ModelAdapter {
  if (!options.id || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(options.model))
    throw new ModelTransportError("MODEL_CONFIGURATION_INVALID");
  const fetch = options.fetch ?? globalThis.fetch;
  const model = options.model;
  const id = options.id;
  const credential = options.accessToken;
  const resolveImage = options.resolveImage;
  const stateScope = options.stateScope;
  const validateImageAuthority = options.validateImageAuthority;
  if (stateScope !== undefined && !/^[a-f0-9]{64}$/u.test(stateScope))
    throw new ModelTransportError("MODEL_CONFIGURATION_INVALID");
  async function* stream(
    request: ModelRequest,
    context: AdapterInvocationContext,
  ): AsyncIterable<ModelStreamEvent> {
    context.signal.throwIfAborted();
    const signal = AbortSignal.any([context.signal, AbortSignal.timeout(60_000)]);
    try {
      const prepared = await prepare(
        request,
        model,
        { ...context, signal },
        resolveImage,
        stateScope,
        validateImageAuthority,
        context,
      );
      const token = await abortable(credential(), signal);
      if (!token || /\s/u.test(token))
        throw new ModelTransportError("MODEL_CREDENTIAL_UNAVAILABLE");
      signal.throwIfAborted();
      if (prepared.imageCount) {
        try {
          validateImageAuthority?.(context);
        } catch {
          signal.throwIfAborted();
          unsupported();
        }
      }
      const response = await abortable(
        fetch("https://api.openai.com/v1/responses", {
          method: "POST",
          redirect: "error",
          signal,
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: prepared.body,
        }),
        signal,
      );
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        throw new ModelTransportError("MODEL_HTTP_ERROR", response.status);
      }
      let result: ModelResult | undefined;
      for await (const data of readModelSse(response, 2_097_152, signal)) {
        if (data === "[DONE]") continue;
        if (result) throw new ModelTransportError("MODEL_RESPONSE_INVALID");
        const event = record(parseJson(data));
        if (event.type === "response.output_text.delta") {
          if (typeof event.delta !== "string")
            throw new ModelTransportError("MODEL_RESPONSE_INVALID");
          yield { type: "text-delta", text: event.delta };
        } else if (
          event.type === "response.failed" ||
          event.type === "response.incomplete" ||
          event.type === "error"
        )
          throw new ModelTransportError("MODEL_RESPONSE_INVALID");
        else if (event.type === "response.completed")
          result = complete(event.response, prepared.offered, model, stateScope);
      }
      if (!result) throw new ModelTransportError("MODEL_STREAM_TRUNCATED");
      if (prepared.droppedProviderStateCount)
        result = immutable({
          ...result,
          droppedProviderStateCount: prepared.droppedProviderStateCount,
        });
      signal.throwIfAborted();
      if (
        request.maxOutputTokens !== undefined &&
        (result.usage?.outputTokens === undefined ||
          result.usage.outputTokens > request.maxOutputTokens)
      )
        throw new ModelTransportError("MODEL_RESPONSE_LIMIT");
      for (const part of result.message.parts)
        if (part.kind === "tool-call") yield { type: "tool-call", call: part };
      if (result.usage) yield { type: "usage", usage: result.usage };
      yield { type: "completed", result };
    } catch (error) {
      if (context.signal.aborted) throw context.signal.reason;
      if (signal.aborted) throw new ModelTransportError("MODEL_TIMEOUT");
      if (error instanceof ModelTransportError) throw error;
      throw new ModelTransportError("MODEL_NETWORK_ERROR");
    }
  }
  return Object.freeze({
    manifest: Object.freeze({
      id,
      version: "1",
      ...(stateScope
        ? {
            providerStateIdentity: Object.freeze({
              provider: "openai-responses" as const,
              model,
              scope: stateScope,
            }),
          }
        : {}),
      title: `ChatGPT plan: ${model}`,
      requiredCapabilities: Object.freeze([]),
      features: Object.freeze({
        streaming: true,
        tools: true,
        vision: resolveImage !== undefined,
        structuredOutput: false,
      }),
    }),
    stream,
    async generate(request: ModelRequest, context: AdapterInvocationContext) {
      for await (const event of stream(request, context))
        if (event.type === "completed") return event.result;
      throw new ModelTransportError("MODEL_STREAM_TRUNCATED");
    },
  });
}

/** Read only the authenticated account's visible model catalog; no guessed model entitlement. */
export async function listChatGPTPlanModels(options: {
  accessToken: () => Promise<string>;
  signal?: AbortSignal;
  fetch?: typeof globalThis.fetch;
}): Promise<readonly { slug: string; displayName: string }[]> {
  const signal = AbortSignal.any([
    AbortSignal.timeout(15_000),
    ...(options.signal ? [options.signal] : []),
  ]);
  try {
    const token = await abortable(options.accessToken(), signal);
    if (!token || /\s/u.test(token)) throw new ModelTransportError("MODEL_CREDENTIAL_UNAVAILABLE");
    const response = await abortable(
      (options.fetch ?? globalThis.fetch)("https://api.openai.com/v1/models", {
        redirect: "error",
        signal,
        headers: { Authorization: `Bearer ${token}` },
      }),
      signal,
    );
    if (!response.ok) throw new ModelTransportError("MODEL_HTTP_ERROR", response.status);
    const body = await readModelJson(response, 1_048_576, signal);
    if (!Array.isArray(body.models)) throw new ModelTransportError("MODEL_RESPONSE_INVALID");
    const result: { slug: string; displayName: string }[] = [];
    const slugs = new Set<string>();
    for (const value of body.models) {
      const model = record(value);
      if (model.visibility !== "list") continue;
      if (
        typeof model.slug !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(model.slug) ||
        typeof model.display_name !== "string" ||
        model.display_name.length > 200 ||
        slugs.has(model.slug)
      )
        throw new ModelTransportError("MODEL_RESPONSE_INVALID");
      slugs.add(model.slug);
      result.push({ slug: model.slug, displayName: model.display_name });
      if (result.length > 200) throw new ModelTransportError("MODEL_RESPONSE_LIMIT");
    }
    return immutable(result);
  } catch (error) {
    if (options.signal?.aborted) throw options.signal.reason;
    if (signal.aborted) throw new ModelTransportError("MODEL_TIMEOUT");
    if (error instanceof ModelTransportError) throw error;
    throw new ModelTransportError("MODEL_NETWORK_ERROR");
  }
}
