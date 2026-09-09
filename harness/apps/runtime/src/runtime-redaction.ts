export type SafeJson = null | boolean | number | string | SafeJson[] | { [key: string]: SafeJson };
export const REDACTED = "[REDACTED]" as const;
const MAX_JSON_BYTES = 65_536;
const MAX_JSON_DEPTH = 32;
const DEFAULT_FIELDS = [
  "authorization",
  "password",
  "secret",
  "apikey",
  "accesstoken",
  "refreshtoken",
  "resumetoken",
  "csrftoken",
  "cookie",
  "setcookie",
];

function normalizeField(value: string): string {
  return value.toLowerCase().replace(/[-_]/g, "");
}

/** Safe by construction: reject unsupported values rather than invoking getters or toJSON. */
export function canonicalRuntimeJson(value: unknown): string {
  const seen = new Set<object>();
  let nodes = 0;
  const visit = (item: unknown, depth: number): SafeJson => {
    if (++nodes > 10_000 || depth > MAX_JSON_DEPTH) {
      throw new TypeError("Runtime JSON exceeds structural limits.");
    }
    if (item === null || typeof item === "string" || typeof item === "boolean") return item;
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (typeof item !== "object" || item === null) {
      throw new TypeError("Runtime payload must contain only JSON values.");
    }
    const prototype: unknown = Object.getPrototypeOf(item);
    if (!Array.isArray(item) && prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Runtime payload must contain only plain JSON objects.");
    }
    if (seen.has(item)) throw new TypeError("Runtime payload cannot contain cycles.");
    seen.add(item);
    try {
      if (Array.isArray(item)) {
        const result: SafeJson[] = [];
        for (let i = 0; i < item.length; i += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(item, String(i));
          if (descriptor === undefined || !("value" in descriptor)) {
            throw new TypeError("Runtime JSON cannot contain sparse arrays or accessors.");
          }
          result.push(visit(descriptor.value, depth + 1));
        }
        return result;
      }
      const result: { [key: string]: SafeJson } = Object.create(null) as { [key: string]: SafeJson };
      for (const key of Reflect.ownKeys(item).sort((a, b) =>
        String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0,
      )) {
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (typeof key !== "string" || descriptor === undefined || !("value" in descriptor)) {
          throw new TypeError("Runtime JSON cannot contain symbols or accessors.");
        }
        if (!descriptor.enumerable) throw new TypeError("Runtime JSON must be enumerable data.");
        result[key] = visit(descriptor.value, depth + 1);
      }
      return result;
    } finally {
      seen.delete(item);
    }
  };
  const json = JSON.stringify(visit(value, 0));
  if (Buffer.byteLength(json) > MAX_JSON_BYTES) throw new TypeError("Runtime JSON exceeds 64 KiB.");
  return json;
}

/** Host-owned redaction registry. Rules and secret values never appear in enumerable fields. */
export class RuntimeRedactionRegistry {
  readonly #secrets = new Map<string, number>();
  readonly #fields = new Map<string, number>(DEFAULT_FIELDS.map((field) => [field, 1]));

  registerSecret(secret: string): () => void {
    if (typeof secret !== "string" || secret.length === 0) {
      throw new TypeError("A redaction secret must be a non-empty string.");
    }
    return this.register(this.#secrets, secret);
  }

  registerField(field: string): () => void {
    if (field.trim().length === 0) throw new TypeError("A redaction field must not be empty.");
    return this.register(this.#fields, normalizeField(field));
  }

  redact(value: unknown): SafeJson {
    let data: SafeJson;
    try {
      data = JSON.parse(canonicalRuntimeJson(value)) as SafeJson;
    } catch {
      return REDACTED;
    }
    const secrets = [...this.#secrets.keys()].sort((a, b) => b.length - a.length);
    const text = (value: string): string => {
      let result = value;
      for (const secret of secrets) result = result.split(secret).join(REDACTED);
      return result;
    };
    const visit = (item: SafeJson): SafeJson => {
      if (typeof item === "string") return text(item);
      if (item === null || typeof item !== "object") return item;
      if (Array.isArray(item)) return item.map(visit);
      const result: { [key: string]: SafeJson } = Object.create(null) as { [key: string]: SafeJson };
      for (const [key, child] of Object.entries(item)) {
        result[text(key)] = this.#fields.has(normalizeField(key)) ? REDACTED : visit(child);
      }
      return result;
    };
    return visit(data);
  }

  /** Never silently change persisted execution payloads. Reject secrets before a commit. */
  assertSafe(value: unknown): string {
    const json = canonicalRuntimeJson(value);
    const sanitized = canonicalRuntimeJson(this.redact(value));
    if (json !== sanitized) throw new TypeError("Runtime payload contains protected material.");
    return json;
  }

  private register(values: Map<string, number>, key: string): () => void {
    values.set(key, (values.get(key) ?? 0) + 1);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const remaining = (values.get(key) ?? 1) - 1;
      if (remaining === 0) values.delete(key);
      else values.set(key, remaining);
    };
  }
}
