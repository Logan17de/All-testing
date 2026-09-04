import type { NodeDefinition, NodeManifest, NodeType, Version } from "@zet-harness/plugin-api";

import { TypedRegistry, type RegistryDisposer } from "./typed-registry.js";

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
 */
export class NodeCatalog {
  private readonly definitions = new TypedRegistry<NodeDefinition>();

  get size(): number {
    return this.definitions.size;
  }

  register(definition: NodeDefinition): RegistryDisposer {
    const { type, version } = definition.manifest;
    return this.definitions.register(nodeKey(type, version), definition);
  }

  has(type: NodeType, version: Version): boolean {
    return this.definitions.has(nodeKey(type, version));
  }

  getManifest(type: NodeType, version: Version): NodeManifest | undefined {
    return this.definitions.get(nodeKey(type, version))?.manifest;
  }

  requireManifest(type: NodeType, version: Version): NodeManifest {
    const manifest = this.getManifest(type, version);
    if (!manifest) {
      throw new Error(`Node definition "${type}@${version}" was not found.`);
    }
    return manifest;
  }

  listManifests(): readonly NodeManifest[] {
    return this.definitions.list().map(({ value }) => value.manifest);
  }

  /** Runtime access is explicit and separate from static manifest inspection. */
  getDefinition(type: NodeType, version: Version): NodeDefinition | undefined {
    return this.definitions.get(nodeKey(type, version));
  }
}
