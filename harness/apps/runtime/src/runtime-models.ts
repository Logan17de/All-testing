import { createNodeSecretAccessor } from "@zet-harness/core";
import type { SqliteDatabase } from "@zet-harness/db";
import {
  listModelConfigs,
  readModelApiKey,
  readModelConfig,
  type DurableModelRecord,
} from "@zet-harness/db/durable-model-records";
import {
  createOpenAICompatibleModelAdapter,
  llamaCppEndpointProfile,
  ollamaEndpointProfile,
  openAIEndpointProfile,
  type OpenAICompatibleModelOptions,
} from "@zet-harness/models";
import type { ModelAdapter } from "@zet-harness/plugin-api";
import { SecretValue, type NodeSecretAccessor } from "@zet-harness/plugin-api/secret-contract";

/** The single port a configured model's key arrives on. */
export const MODEL_CREDENTIAL_PORT = "authorization" as const;

/** Adapters are registered for as long as the returned disposer is not called. */
export type ModelRegistration = (adapter: ModelAdapter) => () => void;

export interface RuntimeModelsOptions {
  readonly database: SqliteDatabase;
  readonly register: ModelRegistration;
  /** Values seen here never appear in events, payloads or logs again. */
  readonly registerSecret?: (secret: string) => () => void;
  /** Defaults to this process's environment. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof globalThis.fetch;
}

function optionsFor(
  model: DurableModelRecord,
  credentialPort: string | undefined,
  transport: typeof globalThis.fetch | undefined,
): OpenAICompatibleModelOptions {
  const input = {
    id: model.modelId,
    model: model.model,
    baseUrl: model.baseUrl,
    features: {
      streaming: model.streaming,
      tools: model.tools,
      vision: false,
      structuredOutput: false,
      contextWindowTokens: model.contextWindowTokens,
    },
    ...(credentialPort === undefined ? {} : { credentialPort }),
    ...(transport === undefined ? {} : { fetch: transport }),
  };
  switch (model.profile) {
    case "openai":
      return { ...openAIEndpointProfile(input), title: model.title };
    case "ollama":
      return { ...ollamaEndpointProfile(input), title: model.title };
    case "llama-cpp":
      return { ...llamaCppEndpointProfile(input), title: model.title };
    case "custom":
      // Anything else conforming: the ecosystem's field name, and no assumptions.
      return { ...input, title: model.title, tokenLimitField: "max_tokens" };
  }
}

/**
 * The models a person configured, as adapters the harness can call.
 *
 * A configured model is an OpenAI-compatible endpoint plus, when it needs one, a
 * key. The key never travels through a graph, a run record or an event: the
 * adapter asks for it by port at the moment it builds a request, this class
 * resolves it from the database or the environment, and the value is registered
 * with the redactor on the way out, so it cannot appear in a journal afterwards.
 *
 * Adding a model registers it at once; removing one takes it away again. Nothing
 * here enables a model for a graph — a graph picks a model by id, or lets the
 * router choose among whatever is available.
 */
export class RuntimeModels {
  readonly #database: SqliteDatabase;
  readonly #register: ModelRegistration;
  readonly #registerSecret: ((secret: string) => () => void) | undefined;
  readonly #env: Readonly<Record<string, string | undefined>>;
  readonly #fetch: typeof globalThis.fetch | undefined;
  readonly #registered = new Map<string, () => void>();

  constructor(options: RuntimeModelsOptions) {
    this.#database = options.database;
    this.#register = options.register;
    this.#registerSecret = options.registerSecret;
    this.#env = options.env ?? process.env;
    this.#fetch = options.fetch;
  }

  /** Register every configured model. Called once the database is open. */
  load(): readonly string[] {
    for (const model of listModelConfigs(this.#database.connection())) this.#add(model);
    return [...this.#registered.keys()];
  }

  /** Register, or re-register, one model by id. */
  refresh(modelId: string): void {
    this.remove(modelId);
    const model = readModelConfig(this.#database.connection(), modelId);
    if (model !== undefined) this.#add(model);
  }

  /** Take a model away, so nothing new can be routed to it. */
  remove(modelId: string): void {
    const dispose = this.#registered.get(modelId);
    if (dispose === undefined) return;
    this.#registered.delete(modelId);
    dispose();
  }

  /** Stop offering every configured model; the catalog keeps whatever plugins added. */
  clear(): void {
    for (const modelId of [...this.#registered.keys()]) this.remove(modelId);
  }

  /**
   * The key for one model, as a node-scoped accessor bound to a single port.
   *
   * A model that needs no key has no accessor at all, which is what a local
   * endpoint wants: nothing is looked up and no header is added.
   */
  secretsFor(modelId: string): NodeSecretAccessor | undefined {
    const model = readModelConfig(this.#database.connection(), modelId);
    if (model === undefined || model.credential === "none") return undefined;
    return createNodeSecretAccessor(
      [{ port: MODEL_CREDENTIAL_PORT, secretRef: `model:${modelId}` }],
      {
        resolve: (reference) => {
          if (reference !== `model:${modelId}`) return undefined;
          const value = this.#keyFor(model);
          return value === undefined ? undefined : new SecretValue(value);
        },
      },
      (value) => {
        this.#registerSecret?.(value.revealText());
      },
    );
  }

  #keyFor(model: DurableModelRecord): string | undefined {
    if (model.credential === "environment") {
      const name = model.credentialEnv;
      if (name === null) return undefined;
      const value = this.#env[name];
      return value === undefined || value.length === 0 ? undefined : value;
    }
    return readModelApiKey(this.#database.connection(), model.modelId);
  }

  #add(model: DurableModelRecord): void {
    const adapter = createOpenAICompatibleModelAdapter(
      optionsFor(
        model,
        model.credential === "none" ? undefined : MODEL_CREDENTIAL_PORT,
        this.#fetch,
      ),
    );
    this.#registered.set(model.modelId, this.#register(adapter));
  }
}
