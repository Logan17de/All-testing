export type RegistryDisposer = () => void;

export interface RegistryEntry<T> {
  readonly id: string;
  readonly value: T;
}

function assertRegistryId(id: string): void {
  if (id.trim().length === 0) {
    throw new Error("Registry id must be a non-empty string.");
  }
}

/**
 * Small typed registry for plugin-provided capabilities.
 *
 * Registrations are unique by stable string id. `register` returns an
 * idempotent disposer so a plugin activation scope can hand ownership to the
 * host without exposing registry internals. Disposal is identity-safe: an old
 * disposer cannot remove a newer registration that reused the same id.
 */
export class TypedRegistry<T> {
  private readonly entriesById = new Map<string, RegistryEntry<T>>();

  get size(): number {
    return this.entriesById.size;
  }

  has(id: string): boolean {
    return this.entriesById.has(id);
  }

  get(id: string): T | undefined {
    return this.entriesById.get(id)?.value;
  }

  require(id: string): T {
    const entry = this.entriesById.get(id);
    if (!entry) {
      throw new Error(`Registry entry "${id}" was not found.`);
    }

    return entry.value;
  }

  ids(): readonly string[] {
    return [...this.entriesById.keys()];
  }

  list(): readonly RegistryEntry<T>[] {
    return [...this.entriesById.values()];
  }

  register(id: string, value: T): RegistryDisposer {
    assertRegistryId(id);

    if (this.entriesById.has(id)) {
      throw new Error(`Registry entry "${id}" is already registered.`);
    }

    const entry: RegistryEntry<T> = { id, value };
    this.entriesById.set(id, entry);

    let disposed = false;
    return (): void => {
      if (disposed) {
        return;
      }

      disposed = true;
      if (this.entriesById.get(id) === entry) {
        this.entriesById.delete(id);
      }
    };
  }
}
