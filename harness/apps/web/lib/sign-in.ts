/**
 * Signing in to OpenRouter from the Models page.
 *
 * OpenRouter sends the person back to this app with a one-time code. Its docs
 * name `localhost` for apps on a person's own machine, so the way back always
 * uses that name, on whatever port this app is served from.
 */

/** Where OpenRouter returns after the person approves this app. */
export const SIGN_IN_RETURN_PATH = "/models/openrouter";

export interface ConnectionView {
  readonly provider: "openrouter";
  readonly title: string;
  readonly connected: boolean;
  readonly connectedAtMs: number | null;
  /** How many configured models read their key from this sign-in. */
  readonly models: number;
  /** The address every model using this sign-in calls. */
  readonly apiBaseUrl: string;
}

export interface OpenRouterModel {
  readonly id: string;
  readonly name: string;
  readonly contextLength: number;
  /** When OpenRouter first listed it; the runtime sends them newest first. */
  readonly releasedAtMs: number;
}

/** The address OpenRouter should send the person back to. */
export function signInReturnUrl(origin: string): string {
  const url = new URL(origin);
  url.hostname = "localhost";
  url.pathname = SIGN_IN_RETURN_PATH;
  url.search = "";
  url.hash = "";
  return url.href;
}

export function isConnectionView(value: unknown): value is ConnectionView {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record["provider"] === "openrouter" &&
    typeof record["connected"] === "boolean" &&
    typeof record["apiBaseUrl"] === "string"
  );
}

export function isOpenRouterModel(value: unknown): value is OpenRouterModel {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record["id"] === "string" &&
    typeof record["name"] === "string" &&
    typeof record["contextLength"] === "number" &&
    typeof record["releasedAtMs"] === "number"
  );
}

/** The companies most people look for first, by OpenRouter's id prefix. */
export const MODEL_MAKERS = [
  { prefix: "", label: "All" },
  { prefix: "openai/", label: "OpenAI" },
  { prefix: "anthropic/", label: "Anthropic" },
  { prefix: "google/", label: "Google" },
  { prefix: "x-ai/", label: "xAI" },
] as const;

export type ModelMaker = (typeof MODEL_MAKERS)[number]["prefix"];

/** The models matching what a person typed and the maker they chose, in the order given. */
export function filterModels(
  models: readonly OpenRouterModel[],
  query: string,
  maker: ModelMaker,
): readonly OpenRouterModel[] {
  const words = query
    .toLowerCase()
    .split(/\s+/u)
    .filter((word) => word.length > 0);
  return models
    .filter((model) => model.id.startsWith(maker))
    .filter((model) => {
      const text = `${model.id} ${model.name}`.toLowerCase();
      return words.every((word) => text.includes(word));
    });
}

/** The year a model was listed, for the picker; empty when OpenRouter did not say. */
export function releaseYear(model: OpenRouterModel): string {
  return model.releasedAtMs > 0 ? new Date(model.releasedAtMs).toISOString().slice(0, 7) : "";
}

/** A short id for this harness, from OpenRouter's `maker/model` id. */
export function modelIdFromOpenRouter(id: string): string {
  const name = id.slice(id.indexOf("/") + 1);
  return name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^[^a-z0-9]+/u, "")
    .slice(0, 64)
    .replace(/[-._]+$/u, "");
}

/** The code OpenRouter returned, or the reason there is none. */
export function codeFromReturn(
  search: URLSearchParams,
): { readonly code: string } | { readonly reason: string } {
  const error = search.get("error");
  if (error !== null) {
    return {
      reason:
        error === "access_denied"
          ? "The sign-in was cancelled on OpenRouter."
          : `OpenRouter did not sign you in (${error.slice(0, 80)}).`,
    };
  }
  const code = search.get("code");
  if (code === null || code.length === 0 || code.length > 1_000) {
    return { reason: "OpenRouter sent no sign-in code back." };
  }
  return { code };
}
