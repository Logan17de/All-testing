/** Opaque provider replay state stays in durable engine history, never public DTOs/events. */
export function withoutPrivateModelState(value: unknown): unknown {
  if (Array.isArray(value))
    return value.filter((item) => !providerState(item)).map(withoutPrivateModelState);
  if (value && typeof value === "object") {
    if (providerState(value)) return null;
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key, item]) => key !== "encryptedContent" && !providerState(item))
        .map(([key, item]) => [key, withoutPrivateModelState(item)]),
    );
  }
  return value;
}
function providerState(value: unknown): boolean {
  return !!value && typeof value === "object" && "kind" in value && value.kind === "provider-state";
}
