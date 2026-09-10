import {
  PLUGIN_API_VERSION,
  type AdapterInvocationContext,
  type AdapterUsage,
  type HarnessPlugin,
  type JsonObject,
  type ModelAdapter,
  type ModelAdapterManifest,
  type ModelImagePart,
  type ModelMessage,
  type ModelMessagePart,
  type ModelRequest,
  type ModelResult,
  type ModelStreamEvent,
  type ModelToolCallPart,
} from "@zet-harness/plugin-api";

import {
  ModelTransportError,
  abortable,
  createModelHttp,
  immutable,
  limit,
  parseJson,
  readModelJson,
  readModelSse,
  record,
  type ModelHttpOptions,
} from "./model-http.js";
import { assertModelJson } from "./model-json.js";

export interface OpenAICompatibleModelOptions extends ModelHttpOptions {
  readonly id: string;
  readonly version?: string;
  readonly title?: string;
  /** One pinned endpoint model per adapter; route elsewhere to change model identity. */
  readonly model: string;
  readonly features?: Partial<ModelAdapterManifest["features"]>;
  /** Host-managed artifact resolution only. Arbitrary image URLs are never forwarded. */
  readonly resolveImage?: (image: ModelImagePart, signal: AbortSignal) => Promise<Uint8Array>;
  readonly maxImageBytes?: number;
  readonly tokenLimitField?: "max_completion_tokens" | "max_tokens";
  readonly includeStreamUsage?: boolean;
}

function requestError(): never {
  throw new ModelTransportError("MODEL_REQUEST_UNSUPPORTED");
}

function name(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(value)) requestError();
  return value;
}

function nonempty(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    value.includes("\0")
  ) requestError();
  return value;
}

function schema(value: unknown): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) requestError();
  return value as JsonObject;
}

function numericOption(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    requestError();
  }
  return value;
}

/** Only generation options cross this boundary; no URL/header/authority override. */
function generationOptions(options: JsonObject | undefined): Record<string, unknown> {
  if (options === undefined) return {};
  if (Object.keys(options).some((key) => key !== "openai")) requestError();
  const provider = options.openai === undefined ? {} : schema(options.openai);
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(provider)) {
    switch (key) {
      case "temperature":
        result[key] = numericOption(value, 0, 2);
        break;
      case "top_p":
        result[key] = numericOption(value, 0, 1);
        break;
      case "presence_penalty":
      case "frequency_penalty":
        result[key] = numericOption(value, -2, 2);
        break;
      case "seed":
        if (typeof value !== "number" || !Number.isSafeInteger(value)) requestError();
        result[key] = value;
        break;
      case "reasoning_effort":
        if (
          typeof value !== "string" ||
          !["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value)
        ) requestError();
        result[key] = value;
        break;
      case "stop":
        if (
          typeof value !== "string" &&
          !(Array.isArray(value) && value.length <= 4 && value.every((item) => typeof item === "string"))
        ) requestError();
        result[key] = value;
        break;
      default:
        requestError();
    }
  }
  return result;
}

function encodeImage(bytes: Uint8Array, mediaType: string): string {
  let encoded = "";
  const stride = 3 * 8192;
  for (let offset = 0; offset < bytes.length; offset += stride) {
    encoded += btoa(String.fromCharCode(...bytes.subarray(offset, offset + stride)));
  }
  return `data:${mediaType};base64,${encoded}`;
}

function usage(value: unknown): AdapterUsage | undefined {
  if (value === undefined || value === null) return undefined;
  const source = record(value);
  const token = (item: unknown): number | undefined => {
    if (item === undefined) return undefined;
    if (typeof item !== "number" || !Number.isSafeInteger(item) || item < 0) {
      throw new ModelTransportError("MODEL_RESPONSE_INVALID");
    }
    return item;
  };
  const inputTokens = token(source.prompt_tokens);
  const outputTokens = token(source.completion_tokens);
  const totalTokens = token(source.total_tokens);
  const cachedInputTokens = token(
    source.prompt_tokens_details == null
      ? undefined
      : record(source.prompt_tokens_details).cached_tokens,
  );
  return immutable({
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
  });
}

function finish(value: unknown): ModelResult["finishReason"] {
  if (typeof value !== "string" || value.length === 0) {
    throw new ModelTransportError("MODEL_RESPONSE_INVALID");
  }
  switch (value) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "tool_calls":
      return "tool-calls";
    case "content_filter":
      return "content-filter";
    default:
      return "other";
  }
}

function requestId(response: Response, bodyId: unknown): string | undefined {
  const value = response.headers.get("x-request-id") ?? bodyId;
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,200}$/.test(value) ? value : undefined;
}

interface CollectedCall {
  id: string;
  name: string;
  arguments: string;
}

function toolCall(call: CollectedCall, offered: ReadonlySet<string>): ModelToolCallPart {
  if (!call.id || call.id.length > 512 || !offered.has(call.name)) {
    throw new ModelTransportError("MODEL_RESPONSE_INVALID");
  }
  const args = record(parseJson(call.arguments));
  return immutable({
    kind: "tool-call",
    callId: call.id,
    name: call.name,
    arguments: args as JsonObject,
  });
}

function buildResult(
  parts: readonly ModelMessagePart[],
  finishReason: ModelResult["finishReason"],
  measuredUsage: AdapterUsage | undefined,
  providerRequestId: string | undefined,
): ModelResult {
  const hasCalls = parts.some((part) => part.kind === "tool-call");
  if ((finishReason === "tool-calls") !== hasCalls) {
    throw new ModelTransportError("MODEL_RESPONSE_INVALID");
  }
  return immutable({
    message: { role: "assistant", parts: [...parts] },
    finishReason,
    ...(measuredUsage === undefined ? {} : { usage: measuredUsage }),
    ...(providerRequestId === undefined ? {} : { providerRequestId }),
  });
}

/** One Chat Completions HTTP attempt; never invokes returned tools. */
export function createOpenAICompatibleModelAdapter(
  options: OpenAICompatibleModelOptions,
): ModelAdapter {
  const http = createModelHttp(options, "chat/completions");
  const model = nonempty(options.model);
  const resolveImage = options.resolveImage;
  const maxImageBytes = limit(options.maxImageBytes, 4 * 1024 * 1024);
  const tokenLimitField = options.tokenLimitField ?? "max_completion_tokens";
  if (!["max_tokens", "max_completion_tokens"].includes(tokenLimitField)) requestError();
  const includeStreamUsage = options.includeStreamUsage ?? true;
  const features = immutable({
    streaming: options.features?.streaming ?? true,
    tools: options.features?.tools ?? false,
    vision: options.features?.vision ?? false,
    structuredOutput: options.features?.structuredOutput ?? false,
    ...(options.features?.contextWindowTokens === undefined
      ? {}
      : { contextWindowTokens: limit(options.features.contextWindowTokens, 1) }),
  });
  if (
    [features.streaming, features.tools, features.vision, features.structuredOutput, includeStreamUsage]
      .some((flag) => typeof flag !== "boolean")
  ) requestError();
  if (features.vision && resolveImage === undefined) requestError();
  const manifest: ModelAdapterManifest = immutable({
    id: nonempty(options.id),
    version: nonempty(options.version ?? "1"),
    title: nonempty(options.title ?? options.id),
    requiredCapabilities: [http.capability],
    features,
  });

  const prepare = async (original: ModelRequest, stream: boolean, signal: AbortSignal) => {
    // Snapshot before credential/image awaits; reject accessors rather than invoke them.
    let request: ModelRequest;
    try {
      assertModelJson(original, http.maxRequestBytes);
      const json = JSON.stringify(original);
      if (new TextEncoder().encode(json).byteLength > http.maxRequestBytes) requestError();
      request = JSON.parse(json) as ModelRequest;
    } catch {
      requestError();
    }
    if (request.model !== undefined && request.model !== model) requestError();
    if (!Array.isArray(request.messages) || request.messages.length === 0) requestError();
    const body: Record<string, unknown> = {
      ...generationOptions(request.options), model, stream, n: 1, store: false,
    };
    if (request.maxOutputTokens !== undefined) {
      if (!Number.isSafeInteger(request.maxOutputTokens) || request.maxOutputTokens < 1) requestError();
      body[tokenLimitField] = request.maxOutputTokens;
    }
    const offered = new Set<string>();
    if (request.tools !== undefined && request.tools.length > 0) {
      if (!features.tools || request.tools.length > 128) requestError();
      body.tools = request.tools.map((tool) => {
        const toolName = name(tool.name);
        if (offered.has(toolName)) requestError();
        offered.add(toolName);
        return {
          type: "function",
          function: {
            name: toolName,
            ...(tool.description === undefined ? {} : { description: tool.description }),
            parameters: schema(tool.inputSchema),
          },
        };
      });
    }
    if (request.outputSchema !== undefined) {
      if (!features.structuredOutput) requestError();
      body.response_format = {
        type: "json_schema",
        json_schema: { name: "harness_output", schema: schema(request.outputSchema), strict: true },
      };
    }
    const messages: Record<string, unknown>[] = [];
    let imageBytes = 0;
    for (const message of request.messages as readonly ModelMessage[]) {
      signal.throwIfAborted();
      if (!["system", "developer", "user", "assistant", "tool"].includes(message.role)) requestError();
      if (!Array.isArray(message.parts)) requestError();
      const content: Record<string, unknown>[] = [];
      const calls: Record<string, unknown>[] = [];
      if (message.role === "tool") {
        if (!features.tools || message.parts.length === 0) requestError();
        for (const part of message.parts as readonly ModelMessagePart[]) {
          if (part.kind !== "tool-result") requestError();
          messages.push({
            role: "tool",
            tool_call_id: nonempty(part.callId),
            content: JSON.stringify(part.isError ? { isError: true, value: part.value } : part.value),
          });
        }
        continue;
      }
      for (const part of message.parts as readonly ModelMessagePart[]) {
        if (part.kind === "text") {
          if (typeof part.text !== "string") requestError();
          content.push({ type: "text", text: part.text });
        } else if (part.kind === "image") {
          if (message.role !== "user" || !features.vision || resolveImage === undefined) requestError();
          if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(part.mediaType)) requestError();
          nonempty(part.artifactRef);
          const bytes = await abortable(resolveImage(immutable(part), signal), signal);
          if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > maxImageBytes) requestError();
          imageBytes += 4 * Math.ceil(bytes.byteLength / 3);
          if (imageBytes > http.maxRequestBytes) requestError();
          content.push({ type: "image_url", image_url: { url: encodeImage(bytes, part.mediaType) } });
        } else if (part.kind === "tool-call") {
          if (message.role !== "assistant" || !features.tools) requestError();
          calls.push({
            type: "function",
            id: nonempty(part.callId),
            function: { name: name(part.name), arguments: JSON.stringify(schema(part.arguments)) },
          });
        } else {
          requestError();
        }
      }
      messages.push({
        role: message.role,
        content: content.every((part) => part.type === "text")
          ? content.map((part) => part.text).join("")
          : content,
        ...(calls.length === 0 ? {} : { tool_calls: calls }),
      });
    }
    body.messages = messages;
    if (stream && includeStreamUsage) body.stream_options = { include_usage: true };
    return { body: JSON.stringify(body), offered };
  };

  const generate: ModelAdapter["generate"] = async (request, context) => {
    const session = http.session(context);
    try {
      const prepared = await prepare(request, false, session.signal);
      const response = await session.send(prepared.body);
      const body = await readModelJson(response, http.maxResponseBytes, session.signal);
      if (body.error !== undefined || !Array.isArray(body.choices) || body.choices.length !== 1) {
        throw new ModelTransportError("MODEL_RESPONSE_INVALID");
      }
      const choice = record(body.choices[0]);
      if (choice.index !== undefined && choice.index !== 0) {
        throw new ModelTransportError("MODEL_RESPONSE_INVALID");
      }
      const message = record(choice.message);
      if (message.role !== "assistant") throw new ModelTransportError("MODEL_RESPONSE_INVALID");
      const parts: ModelMessagePart[] = [];
      if (message.content != null) {
        if (typeof message.content !== "string") throw new ModelTransportError("MODEL_RESPONSE_INVALID");
        parts.push({ kind: "text", text: message.content });
      }
      if (message.refusal != null) {
        if (typeof message.refusal !== "string") throw new ModelTransportError("MODEL_RESPONSE_INVALID");
        parts.push({ kind: "text", text: message.refusal });
      }
      if (message.tool_calls !== undefined) {
        if (!Array.isArray(message.tool_calls) || message.tool_calls.length > 128) {
          throw new ModelTransportError("MODEL_RESPONSE_INVALID");
        }
        const ids = new Set<string>();
        for (const raw of message.tool_calls) {
          const item = record(raw);
          const fn = record(item.function);
          if (
            item.type !== "function" || typeof item.id !== "string" ||
            typeof fn.name !== "string" || typeof fn.arguments !== "string" || ids.has(item.id)
          ) throw new ModelTransportError("MODEL_RESPONSE_INVALID");
          ids.add(item.id);
          parts.push(toolCall({ id: item.id, name: fn.name, arguments: fn.arguments }, prepared.offered));
        }
      }
      return buildResult(
        parts,
        message.refusal ? "content-filter" : finish(choice.finish_reason),
        usage(body.usage),
        requestId(response, body.id),
      );
    } catch (error) {
      throw session.normalize(error);
    } finally {
      session.close();
    }
  };

  const stream = async function* (
    request: ModelRequest,
    context: AdapterInvocationContext,
  ): AsyncIterable<ModelStreamEvent> {
    const session = http.session(context);
    try {
      const prepared = await prepare(request, true, session.signal);
      const response = await session.send(prepared.body);
      const text: string[] = [];
      const calls = new Map<number, CollectedCall>();
      let measuredUsage: AdapterUsage | undefined;
      let providerRequestId: string | undefined;
      let finishReason: ModelResult["finishReason"] | undefined;
      let refused = false;
      let done = false;
      for await (const data of readModelSse(response, http.maxResponseBytes, session.signal)) {
        session.signal.throwIfAborted();
        if (data === "[DONE]") {
          done = true;
          break;
        }
        const body = record(parseJson(data));
        if (body.error !== undefined || !Array.isArray(body.choices)) {
          throw new ModelTransportError("MODEL_RESPONSE_INVALID");
        }
        providerRequestId ??= requestId(response, body.id);
        if (body.usage != null) {
          if (measuredUsage !== undefined) throw new ModelTransportError("MODEL_RESPONSE_INVALID");
          measuredUsage = usage(body.usage);
          if (measuredUsage !== undefined) yield { type: "usage", usage: measuredUsage };
        }
        if (body.choices.length === 0) continue;
        if (body.choices.length !== 1 || finishReason !== undefined) {
          throw new ModelTransportError("MODEL_RESPONSE_INVALID");
        }
        const choice = record(body.choices[0]);
        if (choice.index !== 0) throw new ModelTransportError("MODEL_RESPONSE_INVALID");
        const delta = record(choice.delta);
        if (delta.role !== undefined && delta.role !== "assistant") {
          throw new ModelTransportError("MODEL_RESPONSE_INVALID");
        }
        for (const field of ["content", "refusal"]) {
          if (delta[field] == null) continue;
          if (typeof delta[field] !== "string") throw new ModelTransportError("MODEL_RESPONSE_INVALID");
          const value = delta[field];
          if (field === "refusal") refused = true;
          text.push(value);
          if (value !== "") yield { type: "text-delta", text: value };
        }
        if (delta.tool_calls !== undefined) {
          if (!Array.isArray(delta.tool_calls)) throw new ModelTransportError("MODEL_RESPONSE_INVALID");
          for (const raw of delta.tool_calls) {
            const item = record(raw);
            const index = item.index;
            if (
              typeof index !== "number" || !Number.isSafeInteger(index) || index < 0 || index >= 128 ||
              (item.type !== undefined && item.type !== "function")
            ) throw new ModelTransportError("MODEL_RESPONSE_INVALID");
            const call = calls.get(index) ?? { id: "", name: "", arguments: "" };
            if (item.id !== undefined) {
              if (typeof item.id !== "string" || (call.id !== "" && call.id !== item.id)) {
                throw new ModelTransportError("MODEL_RESPONSE_INVALID");
              }
              call.id = item.id;
            }
            if (item.function !== undefined) {
              const fn = record(item.function);
              for (const field of ["name", "arguments"] as const) {
                if (fn[field] !== undefined) {
                  if (typeof fn[field] !== "string") throw new ModelTransportError("MODEL_RESPONSE_INVALID");
                  call[field] += fn[field];
                }
              }
            }
            calls.set(index, call);
          }
        }
        if (choice.finish_reason != null) finishReason = finish(choice.finish_reason);
      }
      if (!done || finishReason === undefined) throw new ModelTransportError("MODEL_STREAM_TRUNCATED");
      const parts: ModelMessagePart[] = [];
      if (text.length > 0) parts.push({ kind: "text", text: text.join("") });
      const ids = new Set<string>();
      const completedCalls = [...calls].sort(([left], [right]) => left - right).map(([, call]) => {
        if (ids.has(call.id)) throw new ModelTransportError("MODEL_RESPONSE_INVALID");
        ids.add(call.id);
        return toolCall(call, prepared.offered);
      });
      parts.push(...completedCalls);
      const result = buildResult(
        parts, refused ? "content-filter" : finishReason, measuredUsage, providerRequestId,
      );
      for (const call of completedCalls) {
        session.signal.throwIfAborted();
        yield { type: "tool-call", call };
      }
      session.signal.throwIfAborted();
      yield { type: "completed", result };
    } catch (error) {
      throw session.normalize(error);
    } finally {
      session.close();
    }
  };

  return Object.freeze({ manifest, generate, ...(features.streaming ? { stream } : {}) });
}

export function createOpenAICompatiblePlugin(options: OpenAICompatibleModelOptions): HarnessPlugin {
  const adapter = createOpenAICompatibleModelAdapter(options);
  const plugin: HarnessPlugin = {
    manifest: immutable({
      id: `harness.model.${adapter.manifest.id}`,
      name: adapter.manifest.title,
      version: adapter.manifest.version,
      apiVersion: PLUGIN_API_VERSION,
      capabilities: adapter.manifest.requiredCapabilities.map((id) => ({ id })),
    }),
    activate(context) {
      context.models.register(adapter);
    },
  };
  return Object.freeze(plugin);
}
