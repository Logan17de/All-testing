import type { NodeManifest, PluginManifest } from "@zet-harness/plugin-api";

/**
 * Clone host-inspected plugin metadata away from plugin-owned object references.
 *
 * Public manifest types are data-only, but TypeScript `readonly` does not stop a
 * JavaScript plugin from mutating the original objects after registration. The
 * host therefore owns an immutable structured-clone snapshot before trusting
 * capability declarations, compiler metadata, or plugin provenance.
 */
export function snapshotPluginManifest(manifest: PluginManifest): PluginManifest {
  return immutableStructuredClone(manifest);
}

/** Immutable host-owned snapshot of one node manifest. */
export function snapshotNodeManifest(manifest: NodeManifest): NodeManifest {
  return immutableStructuredClone(manifest);
}

function immutableStructuredClone<T>(value: T): T {
  return deepFreeze(structuredClone(value), new WeakSet<object>());
}

function deepFreeze<T>(value: T, seen: WeakSet<object>): T {
  if (typeof value !== "object" || value === null) {
    return value;
  }

  const object = value as object;
  if (seen.has(object)) {
    return value;
  }
  seen.add(object);

  for (const key of Reflect.ownKeys(object)) {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (descriptor !== undefined && "value" in descriptor) {
      deepFreeze(descriptor.value, seen);
    }
  }

  return Object.freeze(value);
}
