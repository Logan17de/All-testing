import type {
  CapabilityId,
  ModelAdapter,
  ModelAdapterManifest,
  ToolAdapter,
  ToolManifest,
  Version,
} from "@zet-harness/plugin-api";
import { checkNodeBehaviorPolicy } from "@zet-harness/plugin-api/node-behavior-policy";

import { snapshotModelManifest, snapshotToolManifest } from "./immutable-manifest.js";
import { TypedRegistry, type RegistryDisposer } from "./typed-registry.js";

export interface AdapterPluginPin {
  readonly id: string;
  readonly version: Version;
}
export interface AdapterResolution<M> {
  readonly manifest: M;
  readonly plugin: AdapterPluginPin;
}
interface VersionedManifest {
  readonly id: string;
  readonly version: Version;
  readonly title: string;
}
interface Registration<M, A> {
  readonly manifest: M;
  readonly adapter: A;
  readonly plugin?: AdapterPluginPin;
}

function identity(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    value.includes("\0")
  ) {
    throw new TypeError("Adapter identity must be a non-empty trimmed string without NUL.");
  }
}
function key(id: string, version: Version): string {
  identity(id);
  identity(version);
  return `${id}\0${version}`;
}
function capabilities(values: readonly CapabilityId[], ceiling?: readonly CapabilityId[]): void {
  if (!Array.isArray(values)) throw new TypeError("Adapter capabilities must be an array.");
  const seen = new Set<string>();
  for (const value of values as readonly unknown[]) {
    identity(value);
    if (seen.has(value)) throw new TypeError("Adapter capability requirements must be unique.");
    seen.add(value);
    if (ceiling !== undefined && !ceiling.includes(value)) {
      throw new Error(
        "Adapter requires a capability that its plugin did not declare. Declarations are not grants.",
      );
    }
  }
}

/** Host-only catalog storage. Invocation still requires the runtime broker's independent checks. */
class AdapterCatalog<M extends VersionedManifest, A> {
  readonly #registry = new TypedRegistry<Registration<M, A>>();
  get size(): number {
    return this.#registry.size;
  }
  has(id: string, version: Version): boolean {
    return this.#registry.has(key(id, version));
  }
  getManifest(id: string, version: Version): M | undefined {
    return this.#registry.get(key(id, version))?.manifest;
  }
  getAdapter(id: string, version: Version): A | undefined {
    return this.#registry.get(key(id, version))?.adapter;
  }
  requireAdapter(id: string, version: Version): A {
    return this.#registry.require(key(id, version)).adapter;
  }
  listManifests(): readonly M[] {
    return Object.freeze(this.#registry.list().map(({ value }) => value.manifest));
  }
  getResolution(id: string, version: Version): AdapterResolution<M> | undefined {
    const item = this.#registry.get(key(id, version));
    return item?.plugin === undefined
      ? undefined
      : Object.freeze({ manifest: item.manifest, plugin: item.plugin });
  }
  protected store(manifest: M, adapter: A, plugin?: AdapterPluginPin): RegistryDisposer {
    identity(manifest.title);
    if (plugin !== undefined) {
      identity(plugin.id);
      identity(plugin.version);
    }
    return this.#registry.register(
      key(manifest.id, manifest.version),
      Object.freeze({
        manifest,
        adapter,
        ...(plugin === undefined
          ? {}
          : { plugin: Object.freeze({ id: plugin.id, version: plugin.version }) }),
      }),
    );
  }
}

export class ModelCatalog extends AdapterCatalog<ModelAdapterManifest, ModelAdapter> {
  register(
    adapter: ModelAdapter,
    plugin?: AdapterPluginPin,
    ceiling?: readonly CapabilityId[],
  ): RegistryDisposer {
    const manifest = snapshotModelManifest(adapter.manifest);
    capabilities(manifest.requiredCapabilities, plugin === undefined ? undefined : (ceiling ?? []));
    const features = manifest.features;
    if (
      features === null ||
      typeof features !== "object" ||
      [features.streaming, features.tools, features.vision, features.structuredOutput].some(
        (v) => typeof v !== "boolean",
      )
    ) {
      throw new TypeError("Model feature flags must be explicit booleans.");
    }
    if (
      features.contextWindowTokens !== undefined &&
      (!Number.isSafeInteger(features.contextWindowTokens) || features.contextWindowTokens < 1)
    ) {
      throw new TypeError("Model context window must be a positive safe integer.");
    }
    const generate = adapter.generate;
    const stream = adapter.stream;
    if (
      typeof generate !== "function" ||
      features.streaming !== (typeof stream === "function") ||
      (stream !== undefined && typeof stream !== "function")
    ) {
      throw new TypeError("Model methods must match the inspected streaming declaration.");
    }
    const stored: ModelAdapter = Object.freeze({
      manifest,
      generate: generate.bind(adapter),
      ...(stream === undefined ? {} : { stream: stream.bind(adapter) }),
    });
    return this.store(manifest, stored, plugin);
  }
}

export class ToolCatalog extends AdapterCatalog<ToolManifest, ToolAdapter> {
  register(
    adapter: ToolAdapter,
    plugin?: AdapterPluginPin,
    ceiling?: readonly CapabilityId[],
  ): RegistryDisposer {
    const manifest = snapshotToolManifest(adapter.manifest);
    const behavior = manifest.behavior;
    capabilities(behavior.requiredCapabilities, plugin === undefined ? undefined : (ceiling ?? []));
    if (
      !["pure", "effect"].includes(behavior.primitiveFamily) ||
      !["deterministic", "nondeterministic"].includes(behavior.determinism) ||
      !["none", "external-read", "external-write"].includes(behavior.effect) ||
      !["not-applicable", "idempotent", "idempotency-key", "unknown"].includes(
        behavior.idempotency,
      ) ||
      !["rerun", "reuse", "reconcile", "manual"].includes(behavior.recovery) ||
      !["in-process", "process", "wasm"].includes(behavior.executionMode)
    ) {
      throw new TypeError("Tools require executable pure/effect behavior metadata.");
    }
    const policy = checkNodeBehaviorPolicy(behavior);
    if (!policy.valid)
      throw new TypeError(
        `Tool behavior policy rejected: ${policy.violations.map((v) => v.code).join(", ")}`,
      );
    if (
      behavior.timeoutMs !== undefined &&
      (!Number.isSafeInteger(behavior.timeoutMs) || behavior.timeoutMs < 1)
    ) {
      throw new TypeError("Tool timeout must be a positive safe integer.");
    }
    if (
      behavior.retry !== undefined &&
      (!Number.isSafeInteger(behavior.retry.maxAttempts) ||
        behavior.retry.maxAttempts < 1 ||
        (behavior.retry.backoffMs !== undefined &&
          (!Number.isSafeInteger(behavior.retry.backoffMs) || behavior.retry.backoffMs < 0)))
    ) {
      throw new TypeError("Tool retry defaults require safe non-negative bounds.");
    }
    // Shape only: schema compilation is owned by the future invocation broker, not this catalog.
    for (const schema of [manifest.inputSchema, manifest.outputSchema]) {
      if (
        typeof schema !== "boolean" &&
        (typeof schema !== "object" || schema === null || Array.isArray(schema))
      ) {
        throw new TypeError("Tool schemas must be boolean or object schemas.");
      }
    }
    const invoke = adapter.invoke;
    if (typeof invoke !== "function") throw new TypeError("Tool invoke must be a function.");
    return this.store(manifest, Object.freeze({ manifest, invoke: invoke.bind(adapter) }), plugin);
  }
}
