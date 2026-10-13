export type ArchivedChat = { id: string; title: string; archivedAt?: number };
const sessionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function archivedChats(value: unknown): ArchivedChat[] | null {
  if (!value || typeof value !== "object" || !("data" in value) || !Array.isArray(value.data))
    return null;
  const chats: ArchivedChat[] = [];
  const seen = new Set<string>();
  for (const item of value.data as unknown[]) {
    if (
      !item ||
      typeof item !== "object" ||
      !("id" in item) ||
      !("preview" in item) ||
      typeof item.id !== "string" ||
      !sessionIdPattern.test(item.id) ||
      typeof item.preview !== "string" ||
      seen.has(item.id)
    )
      return null;
    seen.add(item.id);
    const archivedAt =
      "archivedAt" in item &&
      typeof item.archivedAt === "number" &&
      Number.isFinite(item.archivedAt) &&
      item.archivedAt >= 0 &&
      item.archivedAt <= 8_640_000_000_000_000
        ? item.archivedAt
        : undefined;
    chats.push({
      id: item.id,
      title: item.preview,
      ...(archivedAt === undefined ? {} : { archivedAt }),
    });
  }
  return chats;
}

export function retentionDays(value: string): number | null {
  const normalized = value.trim();
  if (!/^-?\d+$/.test(normalized)) return null;
  const days = Number(normalized);
  return Number.isSafeInteger(days) && (days === -1 || days > 0) ? days : null;
}

export function savedRetentionDays(value: unknown): number | null {
  if (
    !value ||
    typeof value !== "object" ||
    !("retention" in value) ||
    !value.retention ||
    typeof value.retention !== "object" ||
    !("days" in value.retention) ||
    typeof value.retention.days !== "number"
  )
    return null;
  return retentionDays(String(value.retention.days));
}

export function confirmedChatDeletion(value: unknown, sessionId: string): boolean {
  return Boolean(
    value &&
    typeof value === "object" &&
    "deleted" in value &&
    value.deleted === true &&
    "sessionId" in value &&
    value.sessionId === sessionId,
  );
}
