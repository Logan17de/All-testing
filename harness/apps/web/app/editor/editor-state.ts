export type Validation = "idle" | "checking" | "valid" | "invalid" | "unreachable";

/** A compiler result belongs only to the exact executable document it checked. */
export function currentValidation(
  empty: boolean,
  body: string | null,
  checkedBody: string | null,
  validation: Validation,
): Validation {
  if (empty) return "idle";
  return body === null || body !== checkedBody ? "checking" : validation;
}

export function canRequestRun(
  validation: Validation,
  paletteAvailable: boolean,
  running: boolean,
): boolean {
  return paletteAvailable && !running && (validation === "valid" || validation === "invalid");
}
