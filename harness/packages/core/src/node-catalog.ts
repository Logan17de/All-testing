import type { NodeDefinition, NodeManifest, NodeType, Version } from "@zet-harness/plugin-api";

import { TypedRegistry, type RegistryDisposer } from "./typed-registry.js";

export interface NodeCatalogPluginPin {
  readonly id: string;
  readonly version: Version;
}

export interface NodeCatalogResolution {
  readonly manifest: NodeManifest;
  readonly plugin: NodeCatalogPluginPin;
}

interface RegisteredNodeDefinition {
  readonly definition: NodeDefinition;
  readonly plugin?: NodeCatalogPluginPin;
}

function assertNodeIdentity(type: NodeType, version: Version): void {
  if (type.trim().length === 0) {
    throw new Error("Node type must be a non-empty string.");
  }
  if (version.trim().length === 0) {
    throw new Error("Node version must be a non-empty string.");
  }
}

function nodeKey(type: NodeType, version: Version): string {
  assertNodeIdentity(type, version);
  return `${type}\u0000${version}`;
}

/**
 * Registry of versioned node definitions with manifest-only inspection APIs.
 *
 * The catalog never invokes `NodeDefinition.execute` while registering or
 * inspecting nodes. This gives the compiler/editor a static metadata path that
 * is independent from node execution.
 *
 * Registrations made through PluginHost also carry the active plugin id/version
 * that contributed the node. Direct catalog registrations remain supported for
 * low-level tests and internal construction, but they intentionally have no
 * plugin provenance and therefore cannot satisfy compiler pinning on their own.
 */
export class NodeCatalog {
  private readonly definitions = new TypedRegistry<RegisteredNodeDefinition>();

  get size(): number {
    return this.definitions.size;
  }

  register(definition: NodeDefinition, plugin?: NodeCatalogPluginPin): RegistryDisposer {
    const { type, version } = definition.manifest;
    return this.definitions.register(nodeKey(type, version), {
      definition,
      ...(plugin === undefined ? {} : { plugin }),
    });
  }

  has(type: NodeType, version: Version): boolean {
    return this.definitions.has(nodeKey(type, version));
  }

  getManifest(type: NodeType, version: Version): NodeManifest | undefined {
    return this.definitions.get(nodeKey(type, version))?.definition.manifest;
  }

  /**
   * Resolve the exact manifest together with its plugin provenance.
   *
   * Undefined means either the node is not registered or it was registered
   * directly without an owning plugin. Graph normalization requires provenance
   * so a compiled revision can pin both node and plugin versions explicitly.
   */
  getResolution(type: NodeType, version: Version): NodeCatalogResolution | undefined {
    const registration = this.definitions.get(nodeKey(type, version));
    if (registration?.plugin === undefined) {
      return undefined;
    }

    return {
      manifest: registration.definition.manifest,
      plugin: registration.plugin,
    };
  }

  requireManifest(type: NodeType, version: Version): NodeManifest {
    const manifest = this.getManifest(type, version);
    if (!manifest) {
      throw new Error(`Node definition "${type}@${version}" was not found.`);
    }
    return manifest;
  }

  listManifests(): readonly NodeManifest[] {
    return this.definitions.list().map(({ value }) => value.definition.manifest);
  }

  /** Runtime access is explicit and separate from static manifest inspection. */
  getDefinition(type: NodeType, version: Version): NodeDefinition | undefined {
    return this.definitions.get(nodeKey(type, version))?.definition;
  }
}
