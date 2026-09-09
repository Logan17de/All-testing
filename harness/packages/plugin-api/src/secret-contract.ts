export const SECRET_REDACTED_TEXT = "[REDACTED]" as const;

/** Opaque provider-specific locator. It is safe to persist; the resolved value is not. */
export type SecretReference = string;

/**
 * Secret material that stays outside Harness JSON/durability surfaces.
 *
 * The actual text lives in a JavaScript private slot, so ordinary reflection,
 * object spread, JSON serialization, and structured cloning do not reveal it.
 * Integrations must call `revealText()` explicitly at the final provider/tool
 * boundary where plaintext is genuinely required.
 */
export class SecretValue {
  readonly #text: string;

  constructor(text: string) {
    if (typeof text !== "string") {
      throw new TypeError("Secret material must be a string.");
    }

    this.#text = text;
    Object.freeze(this);
  }

  revealText(): string {
    return this.#text;
  }

  toJSON(): typeof SECRET_REDACTED_TEXT {
    return SECRET_REDACTED_TEXT;
  }

  toString(): typeof SECRET_REDACTED_TEXT {
    return SECRET_REDACTED_TEXT;
  }

  [Symbol.toPrimitive](): typeof SECRET_REDACTED_TEXT {
    return SECRET_REDACTED_TEXT;
  }
}

/** Host-owned provider. Plugins receive scoped accessors, never this authority object. */
export interface SecretProvider {
  resolve(reference: SecretReference): SecretValue | undefined | Promise<SecretValue | undefined>;
}

/** Node-scoped secret surface. Provider references are deliberately not exposed. */
export interface NodeSecretAccessor {
  readonly ports: readonly string[];
  has(port: string): boolean;
  get(port: string): Promise<SecretValue>;
  getAll(port: string): Promise<readonly SecretValue[]>;
}

/** Validate the portable opaque-reference syntax without interpreting provider schemes. */
export function assertSecretReference(reference: string): SecretReference {
  if (reference.length === 0 || reference !== reference.trim()) {
    throw new TypeError("Secret reference must be a non-empty trimmed string.");
  }

  return reference;
}
