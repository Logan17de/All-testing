import type { OpenAICompatibleModelOptions } from "./openai-compatible-model.js";

/**
 * Endpoint profiles.
 *
 * These are configuration shapes, not new transports. The OpenAI-compatible
 * adapter already speaks Chat Completions to any conforming endpoint; a profile
 * only records the few places where a specific server's behavior differs, which
 * is the whole of the provider-specific surface this harness is willing to
 * carry. Anything that could be expressed as ordinary configuration stays
 * ordinary configuration.
 *
 * A profile is never a claim that a server is installed or that a model exists.
 */

/** Fields a caller supplies; the profile fills in the endpoint-specific rest. */
export interface EndpointProfileInput {
  readonly id: string;
  /** Model name as the endpoint knows it, for example `llama3.1:8b`. */
  readonly model: string;
  /** Override the profile's default loopback URL. */
  readonly baseUrl?: string;
  readonly features?: OpenAICompatibleModelOptions["features"];
  readonly credentialPort?: string;
  readonly timeoutMs?: number;
  readonly fetch?: typeof globalThis.fetch;
}

function base(input: EndpointProfileInput, defaultBaseUrl: string): OpenAICompatibleModelOptions {
  return {
    id: input.id,
    model: input.model,
    baseUrl: input.baseUrl ?? defaultBaseUrl,
    ...(input.features === undefined ? {} : { features: input.features }),
    ...(input.credentialPort === undefined ? {} : { credentialPort: input.credentialPort }),
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
  };
}

/** Ollama's OpenAI-compatible endpoint. Defaults to its documented loopback port. */
export const OLLAMA_DEFAULT_BASE_URL = "http://127.0.0.1:11434/v1";

export function ollamaEndpointProfile(input: EndpointProfileInput): OpenAICompatibleModelOptions {
  return Object.freeze({
    ...base(input, OLLAMA_DEFAULT_BASE_URL),
    // Ollama's compatibility layer follows the legacy field name.
    tokenLimitField: "max_tokens" as const,
    includeStreamUsage: true,
  });
}

/** llama.cpp's bundled OpenAI-compatible server. */
export const LLAMA_CPP_DEFAULT_BASE_URL = "http://127.0.0.1:8080/v1";

export function llamaCppEndpointProfile(input: EndpointProfileInput): OpenAICompatibleModelOptions {
  return Object.freeze({
    ...base(input, LLAMA_CPP_DEFAULT_BASE_URL),
    tokenLimitField: "max_tokens" as const,
    includeStreamUsage: true,
  });
}

/** OpenAI's hosted API. */
export const OPENAI_DEFAULT_BASE_URL = "https://api.openai.com/v1";

/**
 * OpenAI's hosted Chat Completions endpoint.
 *
 * The one behavior that genuinely requires a provider-specific choice is the
 * token-limit field: current OpenAI models expect `max_completion_tokens`,
 * while the wider OpenAI-compatible ecosystem still expects `max_tokens`. That
 * single difference is what this profile encodes.
 */
export function openAIEndpointProfile(input: EndpointProfileInput): OpenAICompatibleModelOptions {
  return Object.freeze({
    ...base(input, OPENAI_DEFAULT_BASE_URL),
    tokenLimitField: "max_completion_tokens" as const,
    includeStreamUsage: true,
  });
}
