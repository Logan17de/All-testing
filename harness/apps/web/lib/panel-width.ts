export function clampPanelWidth(value: unknown, fallback: number, min: number, max: number) {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : NaN;
  return Math.round(Math.min(max, Math.max(min, Number.isFinite(parsed) ? parsed : fallback)));
}
