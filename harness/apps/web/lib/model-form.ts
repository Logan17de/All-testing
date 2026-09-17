/**
 * What the Models page sends when someone connects a model.
 *
 * The runtime checks all of this again before it stores anything; this exists so a
 * person is told what is wrong before a request, and so each kind of endpoint
 * starts from sensible values instead of an empty form.
 */

export const MODEL_PROFILES = [
  "openai",
  "anthropic",
  "gemini",
  "xai",
  "openrouter",
  "ollama",
  "llama-cpp",
  "custom",
] as const;
export type ModelProfile = (typeof MODEL_PROFILES)[number];

export type ModelCredential = "none" | "stored" | "environment" | "connection";

/** The providers a person can sign in to instead of pasting a key. */
export type ModelConnection = "openrouter";

export interface ModelView {
  readonly modelId: string;
  readonly title: string;
  readonly profile: ModelProfile;
  readonly baseUrl: string;
  readonly model: string;
  readonly credential: ModelCredential;
  readonly credentialEnv: string | null;
  /** Which sign-in supplies the key, when the credential is a sign-in. */
  readonly connection?: ModelConnection | null;
  readonly tools: boolean;
  readonly streaming: boolean;
  readonly contextWindowTokens: number;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export interface ModelPreset {
  readonly label: string;
  readonly hint: string;
  readonly baseUrl: string;
  readonly credential: ModelCredential;
  readonly credentialEnv: string;
  readonly modelPlaceholder: string;
  readonly contextWindowTokens: number;
}

/** Where each kind of endpoint usually lives, and whether it wants a key. */
export const MODEL_PRESETS: Readonly<Record<ModelProfile, ModelPreset>> = {
  openai: {
    label: "OpenAI",
    hint: "OpenAI's hosted API. It needs an API key.",
    baseUrl: "https://api.openai.com/v1",
    credential: "stored",
    credentialEnv: "OPENAI_API_KEY",
    modelPlaceholder: "gpt-4o-mini",
    contextWindowTokens: 128_000,
  },
  anthropic: {
    label: "Anthropic (Claude)",
    hint: "Claude through Anthropic's OpenAI-compatible API. It needs an API key from the Anthropic Console.",
    baseUrl: "https://api.anthropic.com/v1",
    credential: "stored",
    credentialEnv: "ANTHROPIC_API_KEY",
    modelPlaceholder: "claude-sonnet-5",
    contextWindowTokens: 200_000,
  },
  gemini: {
    label: "Google Gemini",
    hint: "Gemini through Google's OpenAI-compatible API. It needs an API key from Google AI Studio.",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    credential: "stored",
    credentialEnv: "GEMINI_API_KEY",
    modelPlaceholder: "gemini-2.5-flash",
    contextWindowTokens: 1_000_000,
  },
  xai: {
    label: "xAI (Grok)",
    hint: "Grok through xAI's API. It needs an API key from the xAI Console.",
    baseUrl: "https://api.x.ai/v1",
    credential: "stored",
    credentialEnv: "XAI_API_KEY",
    modelPlaceholder: "grok-4",
    contextWindowTokens: 256_000,
  },
  openrouter: {
    label: "OpenRouter",
    hint: "One key for models from OpenAI, Anthropic, Google, xAI and more. You can also sign in instead of pasting a key.",
    baseUrl: "https://openrouter.ai/api/v1",
    credential: "stored",
    credentialEnv: "OPENROUTER_API_KEY",
    modelPlaceholder: "anthropic/claude-sonnet-4",
    contextWindowTokens: 200_000,
  },
  ollama: {
    label: "Ollama",
    hint: "A local Ollama server on this machine. No key needed.",
    baseUrl: "http://127.0.0.1:11434/v1",
    credential: "none",
    credentialEnv: "",
    modelPlaceholder: "llama3.1:8b",
    contextWindowTokens: 8_192,
  },
  "llama-cpp": {
    label: "llama.cpp",
    hint: "llama.cpp's bundled server on this machine. No key needed.",
    baseUrl: "http://127.0.0.1:8080/v1",
    credential: "none",
    credentialEnv: "",
    modelPlaceholder: "local-model",
    contextWindowTokens: 8_192,
  },
  custom: {
    label: "Other compatible API",
    hint: "Any endpoint that speaks the OpenAI Chat Completions format, hosted or local.",
    baseUrl: "https://",
    credential: "stored",
    credentialEnv: "",
    modelPlaceholder: "model-name",
    contextWindowTokens: 32_000,
  },
};

export interface ModelDraft {
  readonly profile: ModelProfile;
  readonly modelId: string;
  readonly title: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly credential: ModelCredential;
  /** Typed only when adding a key, or replacing one; empty keeps a stored key on edit. */
  readonly apiKey: string;
  readonly credentialEnv: string;
  /** The sign-in that supplies the key; empty unless the credential is a sign-in. */
  readonly connection: ModelConnection | "";
  readonly tools: boolean;
  readonly contextWindowTokens: string;
}

export function draftFor(profile: ModelProfile): ModelDraft {
  const preset = MODEL_PRESETS[profile];
  return {
    profile,
    modelId: "",
    title: "",
    baseUrl: preset.baseUrl,
    model: "",
    credential: preset.credential,
    apiKey: "",
    credentialEnv: preset.credentialEnv,
    connection: "",
    tools: true,
    contextWindowTokens: String(preset.contextWindowTokens),
  };
}

/** A model reached through the OpenRouter sign-in, at the address the runtime reports. */
export function draftForSignIn(apiBaseUrl: string): ModelDraft {
  return {
    ...draftFor("openrouter"),
    baseUrl: apiBaseUrl,
    credential: "connection",
    credentialEnv: "",
    connection: "openrouter",
  };
}

/** The form for changing a model that is already configured. */
export function draftFromModel(model: ModelView): ModelDraft {
  return {
    profile: model.profile,
    modelId: model.modelId,
    title: model.title,
    baseUrl: model.baseUrl,
    model: model.model,
    credential: model.credential,
    apiKey: "",
    credentialEnv: model.credentialEnv ?? "",
    connection: model.connection ?? "",
    tools: model.tools,
    contextWindowTokens: String(model.contextWindowTokens),
  };
}

/** A model id derived from what someone typed as the model name. */
export function suggestModelId(model: string): string {
  return model
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^[^a-z0-9]+/u, "")
    .slice(0, 64)
    .replace(/[-._]+$/u, "");
}

export type ModelRequest = Readonly<Record<string, string | number | boolean>>;

export type ModelDraftCheck =
  | { readonly ok: true; readonly request: ModelRequest }
  | { readonly ok: false; readonly reason: string };

const MODEL_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * The request to send, or the reason this draft is not one.
 *
 * `editing` means the model already exists: an empty key field then keeps the key
 * that is stored rather than asking for it again.
 */
export function checkModelDraft(draft: ModelDraft, editing: boolean): ModelDraftCheck {
  const modelId = draft.modelId.trim();
  if (!MODEL_ID.test(modelId)) {
    return {
      ok: false,
      reason: "Give the model an id: lowercase letters, digits, dots, dashes or underscores.",
    };
  }
  const model = draft.model.trim();
  if (model.length === 0) return { ok: false, reason: "Name the model the endpoint serves." };

  let url: URL;
  try {
    url = new URL(draft.baseUrl.trim());
  } catch {
    return { ok: false, reason: "The endpoint must be a URL, such as https://api.example.com/v1." };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, reason: "The endpoint must be http or https." };
  }
  if (url.username.length > 0 || url.password.length > 0) {
    return { ok: false, reason: "Put the key in the key field, not in the URL." };
  }
  if (url.protocol === "http:" && draft.credential !== "none" && !LOOPBACK.has(url.hostname)) {
    return {
      ok: false,
      reason: "A key is only sent over https, or to a server on this machine.",
    };
  }

  const contextWindowTokens = Number(draft.contextWindowTokens);
  if (!Number.isSafeInteger(contextWindowTokens) || contextWindowTokens < 1) {
    return { ok: false, reason: "The context window is a whole number of tokens." };
  }

  const key = draft.apiKey.trim();
  if (draft.credential === "stored" && key.length === 0 && !editing) {
    return { ok: false, reason: "Paste the API key for this endpoint." };
  }
  if (/[\r\n]/u.test(key)) return { ok: false, reason: "An API key is a single line." };
  const env = draft.credentialEnv.trim();
  if (draft.credential === "environment" && !ENV_NAME.test(env)) {
    return { ok: false, reason: "Name the environment variable that holds the key." };
  }
  if (draft.credential === "connection" && draft.connection === "") {
    return { ok: false, reason: "Sign in first, then pick a model." };
  }

  const title = draft.title.trim();
  return {
    ok: true,
    request: {
      modelId,
      title: title.length > 0 ? title : model,
      profile: draft.profile,
      baseUrl: draft.baseUrl.trim(),
      model,
      credential: draft.credential,
      ...(draft.credential === "stored" && key.length > 0 ? { apiKey: key } : {}),
      ...(draft.credential === "environment" ? { credentialEnv: env } : {}),
      ...(draft.credential === "connection" ? { connection: draft.connection } : {}),
      tools: draft.tools,
      contextWindowTokens,
    },
  };
}

export function isModelView(value: unknown): value is ModelView {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record["modelId"] === "string" &&
    typeof record["baseUrl"] === "string" &&
    typeof record["credential"] === "string"
  );
}

/** A check's answer from the runtime, in words a person can act on. */
export function describeCheck(check: unknown): { readonly ok: boolean; readonly text: string } {
  if (typeof check !== "object" || check === null) {
    return { ok: false, text: "The runtime gave no answer." };
  }
  const record = check as Record<string, unknown>;
  const latency = typeof record["latencyMs"] === "number" ? record["latencyMs"] : undefined;
  if (record["ok"] === true) {
    return {
      ok: true,
      text: `It answered${latency === undefined ? "" : ` in ${String(latency)} ms`}.`,
    };
  }
  const code = typeof record["code"] === "string" ? record["code"] : "MODEL_CHECK_FAILED";
  const status = typeof record["status"] === "number" ? record["status"] : undefined;
  if (code === "MODEL_HTTP_ERROR" && status !== undefined) {
    return { ok: false, text: httpReason(status) };
  }
  return { ok: false, text: CHECK_REASONS[code] ?? `It did not answer (${code}).` };
}

function httpReason(status: number): string {
  if (status === 401 || status === 403)
    return `The endpoint refused the key (HTTP ${String(status)}).`;
  if (status === 404) {
    return "The endpoint answered 404: check the URL ends where the API starts (often /v1), and the model name.";
  }
  if (status === 429)
    return "The endpoint is rate limiting this key (HTTP 429). Try again shortly.";
  if (status >= 500) return `The endpoint had a server error (HTTP ${String(status)}).`;
  return `The endpoint refused the request (HTTP ${String(status)}); check the model name.`;
}

const CHECK_REASONS: Readonly<Record<string, string>> = {
  MODEL_CREDENTIAL_UNAVAILABLE:
    "No key was available: store one, sign in again, or set the environment variable and restart the runtime.",
  MODEL_NETWORK_ERROR: "The endpoint could not be reached. Is the server running at that URL?",
  MODEL_TIMEOUT: "The endpoint took too long to answer.",
  MODEL_RESPONSE_INVALID: "Something answered, but not in the Chat Completions format.",
  MODEL_CONFIGURATION_INVALID: "The runtime could not use this endpoint URL.",
  MODEL_NOT_REGISTERED: "The runtime has not loaded this model yet. Restart the runtime.",
};
