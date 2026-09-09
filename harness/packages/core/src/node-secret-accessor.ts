import {
  SecretValue,
  assertSecretReference,
  type NodeSecretAccessor,
  type SecretProvider,
  type SecretReference,
} from "@zet-harness/plugin-api/secret-contract";

export type NodeSecretResolutionErrorCode =
  | "SECRET_PORT_UNBOUND"
  | "SECRET_PORT_CARDINALITY"
  | "SECRET_PROVIDER_FAILED"
  | "SECRET_REFERENCE_UNAVAILABLE"
  | "SECRET_PROVIDER_INVALID_VALUE";

export interface NodeSecretBinding {
  readonly port: string;
  readonly secretRef: SecretReference;
}

export class NodeSecretResolutionError extends Error {
  constructor(
    readonly code: NodeSecretResolutionErrorCode,
    readonly port: string,
    message: string,
  ) {
    super(message);
    this.name = "NodeSecretResolutionError";
  }
}

function assertPort(port: string): void {
  if (port.length === 0 || port !== port.trim()) {
    throw new TypeError("Secret binding port must be a non-empty trimmed string.");
  }
}

/**
 * Create one host-owned secret accessor scoped to a node's already-compiled bindings.
 *
 * The provider and opaque provider references remain captured in closures. Node
 * code can discover only bound port names and resolve material for those ports;
 * it cannot enumerate the provider or ask for an arbitrary reference. Resolution
 * is lazy and cached per reference for the lifetime of this accessor.
 *
 * The optional host observer registers material with a log/payload redactor before
 * it is exposed to node code. It is captured at construction and never appears on
 * the node-facing accessor. Observer failure fails closed with a safe error.
 */
export function createNodeSecretAccessor(
  bindings: readonly NodeSecretBinding[],
  provider: SecretProvider,
  onResolve?: (value: SecretValue) => void,
): NodeSecretAccessor {
  const refsByPort = new Map<string, SecretReference[]>();

  for (const binding of bindings) {
    assertPort(binding.port);
    const reference = assertSecretReference(binding.secretRef);
    const references = refsByPort.get(binding.port);
    if (references === undefined) {
      refsByPort.set(binding.port, [reference]);
    } else {
      references.push(reference);
    }
  }

  const ports = Object.freeze([...refsByPort.keys()]);
  const cache = new Map<SecretReference, Promise<SecretValue>>();

  const resolveReference = (port: string, reference: SecretReference): Promise<SecretValue> => {
    const cached = cache.get(reference);
    if (cached !== undefined) {
      return cached;
    }

    const resolution = Promise.resolve()
      .then(() => provider.resolve(reference))
      .then((value) => {
        if (value === undefined) {
          throw new NodeSecretResolutionError(
            "SECRET_REFERENCE_UNAVAILABLE",
            port,
            `Secret for port '${port}' is unavailable.`,
          );
        }
        if (!(value instanceof SecretValue)) {
          throw new NodeSecretResolutionError(
            "SECRET_PROVIDER_INVALID_VALUE",
            port,
            `Secret provider returned an invalid value for port '${port}'.`,
          );
        }
        onResolve?.(value);
        return value;
      })
      .catch((error: unknown) => {
        if (error instanceof NodeSecretResolutionError) {
          throw error;
        }
        throw new NodeSecretResolutionError(
          "SECRET_PROVIDER_FAILED",
          port,
          `Secret provider failed for port '${port}'.`,
        );
      });

    cache.set(reference, resolution);
    return resolution;
  };

  const getReferences = (port: string): readonly SecretReference[] => {
    assertPort(port);
    const references = refsByPort.get(port);
    if (references === undefined) {
      throw new NodeSecretResolutionError(
        "SECRET_PORT_UNBOUND",
        port,
        `No secret is bound to port '${port}'.`,
      );
    }
    return references;
  };

  return Object.freeze({
    ports,
    has(port: string): boolean {
      assertPort(port);
      return refsByPort.has(port);
    },
    async get(port: string): Promise<SecretValue> {
      const references = getReferences(port);
      if (references.length !== 1) {
        throw new NodeSecretResolutionError(
          "SECRET_PORT_CARDINALITY",
          port,
          `Secret port '${port}' has ${String(references.length)} bindings; use getAll().`,
        );
      }
      return resolveReference(port, references[0]!);
    },
    async getAll(port: string): Promise<readonly SecretValue[]> {
      const references = getReferences(port);
      return Object.freeze(
        await Promise.all(references.map((reference) => resolveReference(port, reference))),
      );
    },
  });
}
