import type {
  CapabilityId,
  JsonObject,
  JsonSchema,
  JsonValue,
  NodeBehavior,
  Version,
} from "./index.js";
import type { NodeSecretAccessor } from "./secret-contract.js";

/** The scheduler's shared budget; an adapter must report additional provider/SDK attempts. */
export interface AdapterRetryBudget {
  readonly maxAttempts: number;
  readonly repeatAuthorized: boolean;
  readonly usedAttempts: number;
  readonly remainingAttempts: number;
  reportInternalRetries(count?: number): number;
}

/** Supplied by the trusted invocation broker, never reconstructed from model arguments. */
export interface AdapterInvocationContext {
  readonly runId: string;
  readonly opIndex: number;
  readonly iteration: number;
  readonly attempt: number;
  readonly logicalEffectId: string;
  readonly signal: AbortSignal;
  readonly retryBudget: AdapterRetryBudget;
  readonly secrets?: NodeSecretAccessor;
}

export interface ModelTextPart {
  readonly kind: "text";
  readonly text: string;
}
/** Reference to host-managed image bytes. Resolution and transport encoding belong to the adapter. */
export interface ModelImagePart {
  readonly kind: "image";
  readonly artifactRef: string;
  readonly mediaType: string;
}
export interface ModelToolCallPart {
  readonly kind: "tool-call";
  readonly callId: string;
  readonly name: string;
  readonly arguments: JsonObject;
}
export interface ModelToolResultPart {
  readonly kind: "tool-result";
  readonly callId: string;
  readonly value: JsonValue;
  readonly isError?: boolean;
}
export type ModelMessagePart =
  ModelTextPart | ModelImagePart | ModelToolCallPart | ModelToolResultPart;
export interface ModelMessage {
  readonly role: "system" | "developer" | "user" | "assistant" | "tool";
  readonly parts: readonly ModelMessagePart[];
}
export interface ModelToolSpecification {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: JsonSchema;
}
export interface ModelRequest {
  readonly messages: readonly ModelMessage[];
  readonly model?: string;
  readonly maxOutputTokens?: number;
  readonly tools?: readonly ModelToolSpecification[];
  readonly outputSchema?: JsonSchema;
  /** Namespaced provider options; configuration cannot convey Harness authority. */
  readonly options?: JsonObject;
}
export interface AdapterUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly cachedInputTokens?: number;
  /** Omit when the provider exposes no monetary accounting; never invent a price. */
  readonly cost?: { readonly amountDecimal: string; readonly currency: string };
}
export interface ModelResult {
  readonly message: ModelMessage & { readonly role: "assistant" };
  readonly finishReason: "stop" | "length" | "tool-calls" | "content-filter" | "other";
  readonly usage?: AdapterUsage;
  readonly providerRequestId?: string;
}
/** Transient transport events. The completed result, not every delta, is the durable output. */
export type ModelStreamEvent =
  | { readonly type: "text-delta"; readonly text: string }
  | { readonly type: "tool-call"; readonly call: ModelToolCallPart }
  | { readonly type: "usage"; readonly usage: AdapterUsage }
  | { readonly type: "completed"; readonly result: ModelResult };

export interface ModelAdapterManifest {
  readonly id: string;
  readonly version: Version;
  readonly title: string;
  readonly requiredCapabilities: readonly CapabilityId[];
  readonly features: {
    readonly streaming: boolean;
    readonly tools: boolean;
    readonly vision: boolean;
    readonly structuredOutput: boolean;
    readonly contextWindowTokens?: number;
  };
}
/** One provider-neutral call; selection, authorization, and durable tracing remain host-owned. */
export interface ModelAdapter {
  readonly manifest: ModelAdapterManifest;
  readonly generate: (
    request: ModelRequest,
    context: AdapterInvocationContext,
  ) => Promise<ModelResult>;
  readonly stream?: (
    request: ModelRequest,
    context: AdapterInvocationContext,
  ) => AsyncIterable<ModelStreamEvent>;
}
export interface ToolManifest {
  readonly id: string;
  readonly version: Version;
  readonly title: string;
  readonly description?: string;
  readonly inputSchema: JsonSchema;
  readonly outputSchema: JsonSchema;
  /** Reuse node effect/recovery semantics rather than inventing a separate tool policy. */
  readonly behavior: NodeBehavior;
}
export interface ToolResult {
  readonly value: JsonValue;
  readonly usage?: AdapterUsage;
}
export interface ToolAdapter {
  readonly manifest: ToolManifest;
  readonly invoke: (input: JsonObject, context: AdapterInvocationContext) => Promise<ToolResult>;
}

/** Registration-only activation surfaces; no invocation or capability-grant API. */
export interface PluginModelRegistry {
  register(adapter: ModelAdapter): void;
}
export interface PluginToolRegistry {
  register(adapter: ToolAdapter): void;
}
