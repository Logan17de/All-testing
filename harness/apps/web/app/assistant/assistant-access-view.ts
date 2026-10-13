export type AssistantPermission = "read" | "control";
export interface AssistantGrant {
  chatId: string;
  permissions: AssistantPermission[];
}
export interface AssistantAccess {
  binding: { assistantId: string; actorChatId: string; epoch: number };
  grants: AssistantGrant[];
  notice: string;
}
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const identifier = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 200 &&
  !/[\x00-\x1f\x7f]/u.test(value);
export function assistantPermissions(value: unknown): AssistantPermission[] | undefined {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > 2 ||
    new Set(value).size !== value.length ||
    value.some((permission: unknown) => permission !== "read" && permission !== "control")
  )
    return;
  return [...(value as AssistantPermission[])];
}
export function assistantAccess(value: unknown, assistantId: string): AssistantAccess | undefined {
  const data = object(value),
    binding = object(data.binding);
  if (
    binding.assistantId !== assistantId ||
    !identifier(binding.actorChatId) ||
    !Number.isSafeInteger(binding.epoch) ||
    Number(binding.epoch) < 0 ||
    !Array.isArray(data.grants)
  )
    return;
  const grants: AssistantGrant[] = [];
  for (const raw of data.grants) {
    const entry = object(raw);
    const permissions = assistantPermissions(entry.permissions);
    if (
      !identifier(entry.chatId) ||
      !permissions ||
      grants.some((grant) => grant.chatId === entry.chatId)
    )
      return;
    grants.push({ chatId: entry.chatId, permissions });
  }
  return {
    binding: { assistantId, actorChatId: binding.actorChatId, epoch: Number(binding.epoch) },
    grants,
    notice: typeof data.notice === "string" ? data.notice : "",
  };
}
