/** Data validation only, not JSON Schema reasoning or graph validation. */
export function assertModelJson(value: unknown, maxTextChars = Number.MAX_SAFE_INTEGER): void {
  const active = new WeakSet<object>();
  let remaining = 100_000;
  let textChars = 0;
  function invalid(): never {
    throw new TypeError("Model data must be bounded, finite, plain JSON.");
  }
  const text = (value: string): void => {
    textChars += value.length;
    if (textChars > maxTextChars) invalid();
  };
  const visit = (item: unknown, depth: number): void => {
    remaining -= 1;
    if (remaining < 0 || depth > 64) invalid();
    if (item === null || typeof item === "boolean") return;
    if (typeof item === "string") {
      text(item);
      return;
    }
    if (typeof item === "number") {
      if (!Number.isFinite(item)) invalid();
      return;
    }
    if (typeof item !== "object" || active.has(item)) invalid();
    const prototype: unknown = Object.getPrototypeOf(item);
    if (!Array.isArray(item) && prototype !== Object.prototype && prototype !== null) invalid();
    active.add(item);
    try {
      const keys = Reflect.ownKeys(item);
      const array = Array.isArray(item) ? (item as readonly unknown[]) : undefined;
      if (array !== undefined && keys.length !== array.length + 1) invalid();
      for (const key of keys) {
        if (array !== undefined && key === "length") continue;
        if (typeof key !== "string") invalid();
        if (
          array !== undefined &&
          (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= array.length)
        ) invalid();
        text(key);
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor))
          invalid();
        const child: unknown = descriptor.value;
        visit(child, depth + 1);
      }
    } finally {
      active.delete(item);
    }
  };
  visit(value, 0);
}
